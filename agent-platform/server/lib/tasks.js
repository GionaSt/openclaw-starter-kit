// Task per business: persistenza data/tasks/<tenant>.json + tool MCP per gli agenti CEO.
import { randomUUID } from 'crypto';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { readJson, writeJson, DATA_DIR, SERVER_DIR, safeSegment } from './store.js';
import { touchedFilesForTask } from './runs.js';
import { logAudit, reviewNotesByTask } from './audit.js';
import { listActivity } from './activity.js';
import { addTaskMessage } from './taskchat.js';
import { previewLinksForTask, formatPreviewLinks } from './previews.js';
import { RESULT_TYPES, RISK_LEVELS, artifactsForTask } from './artifacts.js';

const TASKS_DIR = join(DATA_DIR, 'tasks');
// "revisione" = task riaperta con una nota di correzione e rilanciata verso
// l'agente assegnato (Sprint 10: riapertura di Owner su una task done; quality
// gate 539c05b9: bocciatura di manager/CEO su una consegna, vedi gateRejection).
// "review_manager"/"review_ceo" = quality gate a due livelli (decisione di
// Owner, task board 539c05b9): un operativo che finisce non chiude più la task
// da solo, la consegna al gate. Il dispatcher instrada la review al reviewer
// giusto (vedi server/lib/dispatcher.js); l'esito si dichiara col tool
// submit_review, mai con update_task (che rifiuta status "done" per gli agenti).
export const TASK_STATUSES = ['todo', 'in_progress', 'needs_input', 'ready_for_owner', 'review_manager', 'review_ceo', 'revisione', 'done', 'archived'];
// Urgenza: guida l'ordine di lavorazione del dispatcher autonomo (Sprint 6).
export const TASK_URGENCIES = ['bassa', 'media', 'alta', 'critica'];
export const DEFAULT_URGENCY = 'media';
export const DEFAULT_RESULT_TYPE = 'general';
export const DEFAULT_RISK_LEVEL = 'R1';
// Anti-loop del quality gate: oltre questo numero di bocciature allo stesso
// livello, la task va in needs_input invece di tornare all'operativo.
export const MAX_GATE_REJECTIONS = 2;
// Rank per ordinamento: critica prima di tutto.
export const urgencyRank = (u) => {
  const i = TASK_URGENCIES.indexOf(u ?? DEFAULT_URGENCY);
  return i === -1 ? TASK_URGENCIES.indexOf(DEFAULT_URGENCY) : i;
};

const tasksFile = (tenantId) => join(TASKS_DIR, `${safeSegment(tenantId)}.json`);

export function listTasks(tenantId) {
  return readJson(tasksFile(tenantId), []);
}

function saveTasks(tenantId, tasks) {
  writeJson(tasksFile(tenantId), tasks);
}

// onChange(task, action): hook per notifiche (WS/push), impostato da index.js.
let onChange = null;
export function setTaskChangeListener(fn) { onChange = fn; }

// 'agent:<id>' o '<id>' -> 'agent:<id>' (null/'' -> null).
export const normalizeAssignee = (v) => {
  const id = String(v ?? '').replace(/^agent:/, '').trim();
  return id ? `agent:${id}` : null;
};

// Blocker non risolti di una task: gli id in blockedBy la cui task non è done.
// Id inesistenti (task rimosse a mano dal file) non bloccano.
export function openBlockers(task, tasks) {
  return (task.blockedBy ?? []).filter((id) => {
    const dep = tasks.find((t) => t.id === id);
    return dep && !['done', 'archived'].includes(dep.status);
  });
}

// list_tasks (tool MCP, task board 521ccde0): board grandi con description
// intere sforavano il limite token del tool (330K caratteri su 113 task, vedi
// evidenza sulla task) — ogni agente che chiamava list_tasks senza filtri
// veniva troncato dal runtime. Default "compact" + paginazione: vedi tool più
// sotto. DEFAULT_LIST_LIMIT tarato per stare comodi sotto ~25K caratteri anche
// con descriptionPreview su ogni riga; SEVEN_DAYS_MS taglia le "done" vecchie
// dal default (restano quelle recenti, servono all'anti-duplicati).
export const DEFAULT_LIST_LIMIT = 50;
export const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
const DESCRIPTION_PREVIEW_CHARS = 150;

function descriptionPreview(description) {
  const d = String(description ?? '');
  return d.length > DESCRIPTION_PREVIEW_CHARS ? `${d.slice(0, DESCRIPTION_PREVIEW_CHARS)}…` : d;
}

// Payload compatto (default di list_tasks): solo i campi utili a orientarsi
// sulla board senza portare in contesto ogni descrizione intera. Chi ha
// bisogno del dettaglio lo chiede mirato (status/assignedTo + fields:"full").
function compactTaskView(t, all) {
  const { id, title, status, urgency, updatedAt, assignedTo, blockedBy, description, resultType, riskLevel } = t;
  return {
    id, title, status, urgency, resultType: resultType ?? DEFAULT_RESULT_TYPE, riskLevel: riskLevel ?? DEFAULT_RISK_LEVEL, assignedTo,
    blockedBy: blockedBy ?? [], openBlockers: openBlockers({ blockedBy }, all), updatedAt,
    descriptionPreview: descriptionPreview(description),
  };
}

// Payload "full": stesso identico shape restituito da list_tasks prima del
// fix 521ccde0 — mantenuto invariato per chi lo chiede esplicitamente
// (fields:"full").
function fullTaskView(t, all) {
  const {
    id, title, status: s, urgency, resultType, riskLevel, description, updatedAt, createdBy: by, assignedTo, blockedBy, note, revisionNote, ask,
    workerId, managerRejections, ceoRejections, gateRejection,
  } = t;
  return {
    id, title, status: s, urgency, resultType: resultType ?? DEFAULT_RESULT_TYPE, riskLevel: riskLevel ?? DEFAULT_RISK_LEVEL, description, updatedAt, createdBy: by, assignedTo,
    blockedBy: blockedBy ?? [], openBlockers: openBlockers({ blockedBy }, all), note, revisionNote, ask: ask ?? null,
    workerId, managerRejections: managerRejections ?? 0, ceoRejections: ceoRejections ?? 0, gateRejection: gateRejection ?? null,
  };
}

// Task 212d9b82, poi 81ea4965 (osservabilità, requisito 4): quante task, cross-
// tenant, hanno il flag di blocco tecnico dispatchExhausted (retry di dispatch
// esauriti) — mai una vera domanda ask_owner, quella ha task.ask valorizzato.
// Da 81ea4965 il flag NON sposta più la task in needs_input (resta lavorabile
// nel suo stato, in attesa del reset automatico dopo il raffreddamento): il
// conteggio guarda solo il flag, non lo status. Alimenta il contatore in
// "Agenti live" (concurrencyView, index.js) e la riga dedicata nel digest
// serale (digest.js).
export function countDispatchExhausted(tenants) {
  let count = 0;
  for (const t of tenants) count += listTasks(t.id).filter((x) => x.dispatchExhausted).length;
  return count;
}

function validateBlockedBy(blockedBy, tasks, selfId = null) {
  if (!Array.isArray(blockedBy)) throw new Error('blockedBy deve essere un array di id task');
  const ids = [...new Set(blockedBy.map(String))];
  for (const id of ids) {
    if (id === selfId) throw new Error('una task non può bloccare se stessa');
    if (!tasks.some((t) => t.id === id)) throw new Error(`blockedBy: task ${id} non trovata sulla board`);
  }
  return ids;
}

export function createTask(tenantId, { title, description = '', status = 'todo', urgency = DEFAULT_URGENCY, resultType = DEFAULT_RESULT_TYPE, riskLevel = DEFAULT_RISK_LEVEL, assignedTo = null, blockedBy = [], ask = null }, createdBy) {
  if (!title?.trim()) throw new Error('title richiesto');
  if (!TASK_STATUSES.includes(status)) throw new Error(`status non valido (${TASK_STATUSES.join('|')})`);
  if (!TASK_URGENCIES.includes(urgency)) throw new Error(`urgency non valida (${TASK_URGENCIES.join('|')})`);
  if (!RESULT_TYPES.includes(resultType)) throw new Error(`resultType non valido (${RESULT_TYPES.join('|')})`);
  if (!RISK_LEVELS.includes(riskLevel)) throw new Error(`riskLevel non valido (${RISK_LEVELS.join('|')})`);
  const tasks = listTasks(tenantId);
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    tenantId,
    title: title.trim(),
    description,
    status,
    urgency,
    resultType,
    riskLevel,
    createdBy, // 'user:<username>' oppure 'agent:<agentId>'
    assignedTo: normalizeAssignee(assignedTo), // 'agent:<agentId>': il dispatcher lancia la run come questo agente
    blockedBy: validateBlockedBy(blockedBy, tasks), // id di task che devono essere done prima del dispatch
    note: null,           // nota di lavorazione (es. esito/errore dal dispatcher)
    // Richiesta circoscritta a Owner (task board 69413a7e): quando una task va in
    // needs_input tramite il tool ask_owner, qui c'è { question, context, options,
    // title, askedBy, askedByName, askedAt }. Alimenta la push (domanda secca nel
    // testo) e il popup dedicato. null = needs_input generica (fallback: title/note).
    ask: ask ?? null,
    // Bloccate vs Da decidere (task board 03a5a645): quando la task è needs_input
    // SENZA ask, blockCause dice PERCHÉ (letto dal chiamante quando lo sa, es.
    // l'escalation del gate) — alimenta la traduzione italiana in lib/blocked.js.
    // Calcolato/aggiornato in applyStatusTransition a ogni transizione verso/da
    // needs_input, non solo qui alla creazione.
    blockCause: null,
    revisionNote: null,   // nota di revisione (Owner o bocciatura del gate), inclusa nel prompt di rilancio
    dispatched: false,    // true = in lavorazione autonoma via dispatcher
    dispatchAttempts: 0,  // lanci autonomi consumati (limite anti-loop)
    // Task 212d9b82 (bug "run senza consegna -> bloccata a 3/3 per sempre):
    // dispatchExhausted = true quando i tentativi di dispatch sono esauriti
    // SENZA una consegna reale (mai a manina) -> la task va in needs_input
    // invece di restare in todo silenziosa. dispatchAutoRetries conta i
    // ritentativi automatici del dispatcher dopo il raffreddamento (vedi
    // DISPATCH_EXHAUST_COOLDOWN_MS in dispatcher.js): esauriti anche quelli,
    // serve un umano. Un tocco umano reale (update_task/riassegnazione) su
    // questa task azzera entrambi insieme a dispatchAttempts (vedi sotto).
    dispatchExhausted: false,
    dispatchAutoRetries: 0,
    // Bonifica automatica ricorrente (task board 2e2d918f): quante volte
    // lib/autorecover.js ha già recuperato in automatico una needs_input SENZA
    // ask di questa task, e quando (se mai) l'ha segnalata come "cronica" al
    // CEO platform. Azzerati da retryBlockedTask (un intervento umano è sempre
    // un nuovo inizio).
    autoRecoverCount: 0,
    chronicEscalatedAt: null,
    // true = il PROSSIMO dispatch di questa task deve ricordare esplicitamente
    // nel prompt che il tentativo precedente è finito senza consegna (one-shot,
    // il dispatcher lo rispegne al lancio successivo). Vedi dispatcher.js.
    pendingDeliveryReminder: false,
    // ---- Quality gate a due livelli (task board 539c05b9) ----
    workerId: null,          // 'agent:<id>' dell'operativo che ha consegnato (a chi torna se bocciata)
    managerRejections: 0,    // bocciature subite a livello manager (max MAX_GATE_REJECTIONS)
    ceoRejections: 0,        // bocciature subite a livello CEO (max MAX_GATE_REJECTIONS)
    gateRejection: null,     // { by: 'manager'|'ceo', note, at } — ultima bocciatura del gate (per il prompt di rilancio e la UI); null se la "revisione" è una riapertura umana
    createdAt: now,
    updatedAt: now,
  };
  tasks.push(task);
  saveTasks(tenantId, tasks);
  logAudit({ user: createdBy, tenant: tenantId, event: 'task_created', detail: { taskId: task.id, title: task.title, urgency, assignedTo: task.assignedTo, blockedBy: task.blockedBy } });
  onChange?.(task, 'created');
  return task;
}

// Verifica automatica al gate (task 30f8a474, regola "commit prima di consegnare"):
// alla consegna a review_manager controlla che l'albero di lavoro non abbia
// modifiche sorgente NON committate sotto server/ web/ docs/. NON blocca la
// consegna (git può mancare, o il lavoro può essere volutamente escluso): se
// trova roba non committata restituisce una riga di WARNING compatta che
// updateTask appende alla nota, così il manager la vede in review. Skip nei
// test (data dir isolata) per non generare falsi warning dal repo di sviluppo.
// Puro e testabile: dato l'insieme dei file toccati DALLA RUN (repo-relative) e
// i file dirty del working tree, restituisce il warning SOLO sull'intersezione
// (o null). È qui che si spegne il falso positivo strutturale (task a1cce86c):
// i file sporchi che NON appartengono a questa run/task (lavoro in volo di altre
// run concorrenti sul working tree condiviso) non vengono più attribuiti a chi
// consegna. Intersezione vuota → nessun warning.
export function computeUncommittedWarning(runFiles, dirtyFiles) {
  if (!runFiles?.length || !dirtyFiles?.length) return null;
  const set = new Set(runFiles);
  const own = dirtyFiles.filter((f) => set.has(f));
  if (!own.length) return null;
  const shown = own.slice(0, 10).join(', ');
  const more = own.length > 10 ? ` (+${own.length - 10} altri)` : '';
  return `⚠️ COMMIT MANCANTE alla consegna: ${own.length} file sorgente non committati [${shown}${more}]. Regola (task 30f8a474): committa il tuo lavoro PRIMA di consegnare al gate.`;
}

function gateUncommittedWarning(tenantId, taskId) {
  try {
    // Fonte per-task: i file che I TOOL DI QUESTA RUN hanno toccato (journal).
    // Se la run non ha tracciato nulla (es. consegna REST manuale, o solo Bash
    // non di scrittura) → niente da segnalare, e NON tocchiamo nemmeno git.
    const runFiles = touchedFilesForTask(tenantId, taskId);
    if (!runFiles.length) return null;
    // NB: trim() SOLO sull'array di righe, non sulla stringa intera prima dello
    // split — .trim() sulla stringa mangerebbe lo spazio iniziale della prima
    // riga (" M file" -> "M file"), disallineando lo slice(3) a larghezza fissa
    // e troncando di un carattere il primo file mostrato (bug osservato: "erver/..."
    // invece di "server/...").
    const out = execFileSync('git', ['status', '--porcelain', '--', 'server', 'web', 'docs'], {
      cwd: join(SERVER_DIR, '..'), encoding: 'utf8', timeout: 5000,
    });
    if (!out.trim()) return null;
    const dirty = out.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''));
    return computeUncommittedWarning(runFiles, dirty);
  } catch {
    return null; // git assente/errore: mai bloccare la consegna
  }
}

// ---- updateTask: estratto in 3 passi (task complessità 2404033e, MOVE puri,
// zero cambi di comportamento — vedi commenti originali riportati fedelmente).

// Passo (a): validazione/policy del gate, PRIMA di toccare la task. Solleva le
// due regole dure con gli stessi messaggi; muta patch.note per il warning
// "commit non committati" (stesso side-effect di prima: il chiamante lo vede
// nella nota salvata). opts.viaReview = true SOLO quando la chiamata arriva
// da submitReview (unico percorso legittimo verso "done" per un agente).
function assertPatchAllowed(tenantId, task, patch, updatedBy, opts) {
  if (patch.status === undefined) return;
  if (!TASK_STATUSES.includes(patch.status)) throw new Error(`status non valido (${TASK_STATUSES.join('|')})`);
  const byAgent = String(updatedBy ?? '').startsWith('agent:');
  // ---- Regola dura #1 (bug false-done 1c04b1b9, decisione Owner): un agente
  // non può portare una task in "done" con un update di stato diretto. L'unico
  // percorso è il quality gate a due livelli — submitReview approvato dal CEO,
  // che chiama updateTask con viaReview:true. Blocca ogni scorciatoia
  // todo/in_progress -> done, comprese eventuali regressioni del dispatcher.
  if (patch.status === 'done' && byAgent && !opts.viaReview) {
    throw new Error('un agente non può chiudere una task in "done": si arriva a done SOLO col quality gate (submit_review approvato dal CEO)');
  }
  // ---- Regola dura #2 (requisito 3): una consegna al gate richiede una nota
  // di consegna NON vuota (cosa fatto, come verificato). Vale per gli agenti
  // (l'operativo che consegna); Owner/REST può muovere gli stati a mano.
  if (patch.status === 'review_manager' && byAgent && !String(patch.note ?? '').trim()) {
    throw new Error('per consegnare al quality gate (review_manager) serve una nota di consegna non vuota: scrivi cosa hai fatto e come l\'hai verificato');
  }
  // Verifica automatica "commit prima di consegnare" (task 30f8a474): non
  // blocca, ma se ci sono sorgenti non committati lo segnala in coda alla nota
  // così il manager lo vede al gate (e chi consegna la prossima volta committa).
  if (patch.status === 'review_manager' && byAgent) {
    const warn = gateUncommittedWarning(tenantId, task.id);
    if (warn) patch.note = `${String(patch.note ?? '').trim()}\n\n${warn}`;
  }
}

// Passo (b): side-effect della transizione di stato sulla task già validata.
// Le regole di reset stanno qui, in un solo posto (erano la fonte del bug
// e248a568: il chiamante doveva sapere a memoria quali status ri-scrivere).
function applyStatusTransition(task, patch, updatedBy) {
  task.status = patch.status;
  // Ogni transizione di stato conclude un'eventuale run dispacciata in volo:
  // azzera il marcatore "in lavorazione autonoma" (fix bug e248a568 — il
  // reconcile del dispatcher ora individua le run terminate da task.dispatched,
  // non dallo status, quindi una task che va in done/needs_input/review_ceo
  // NON deve restare dispatched o verrebbe ri-processata/riaperta). L'unico a
  // volere dispatched=true insieme a un cambio di stato è il lancio del
  // dispatcher stesso, che lo ri-afferma esplicitamente più sotto (patch.dispatched).
  task.dispatched = false;
  if (patch.status === 'revisione' && updatedBy !== 'dispatcher') {
    // Riapertura da Owner/CEO O bocciatura del quality gate (submitReview
    // chiama updateTask con updatedBy = 'agent:<reviewer>'): in entrambi i
    // casi torna eleggibile per il dispatcher verso l'agente assegnato, con
    // contatore tentativi azzerato e nota di revisione. Il dispatcher che
    // RIMETTE in revisione una task fallita non passa di qui: non deve
    // azzerare i tentativi (anti-loop) né toccare la nota di revisione.
    task.revisionNote = patch.note ?? task.revisionNote ?? null;
    task.dispatchAttempts = 0;
    task.dispatchExhausted = false;
    task.dispatchAutoRetries = 0;
  }
  if (patch.status === 'todo' && updatedBy !== 'dispatcher') {
    // Task 212d9b82: riapertura esplicita a "todo" da un umano/CEO (es. da
    // needs_input dopo un'escalation di retry esauriti, o riassegnazione)
    // — NON dal dispatcher, che rimette in "todo" la propria task fallita
    // senza consegna e NON deve azzerare l'anti-loop (altrimenti il limite
    // di MAX_DISPATCH_ATTEMPTS non avrebbe mai effetto). Un intervento
    // umano dà sempre un budget fresco di tentativi.
    task.dispatchAttempts = 0;
    task.dispatchExhausted = false;
    task.dispatchAutoRetries = 0;
  }
  if (patch.status === 'review_manager') {
    // Nuova consegna dal worker (mai dal dispatcher: l'auto-skip verso
    // review_ceo quando non c'è un manager reale passa per 'review_ceo'
    // direttamente, non riattraversa qui). Cattura chi consegna come
    // worker originale (a chi torna in caso di bocciatura) e pulisce la
    // bocciatura precedente: è un giro pulito del gate, con un budget
    // fresco di tentativi tecnici di dispatch (non l'anti-loop delle
    // bocciature, che è governato da managerRejections/ceoRejections).
    if (updatedBy?.startsWith('agent:')) task.workerId = updatedBy;
    task.gateRejection = null;
    task.dispatchAttempts = 0;
    task.dispatchExhausted = false;
    task.dispatchAutoRetries = 0;
  }
  if (patch.status === 'review_ceo') {
    // Approvazione del manager (o skip automatico del dispatcher quando il
    // worker non ha un manager reale): nuovo giro di dispatch, stesso reset.
    task.dispatchAttempts = 0;
    task.dispatchExhausted = false;
    task.dispatchAutoRetries = 0;
  }
  // Se esce da done (es. riaperta), una futura chiusura rigenera la push.
  if (patch.status !== 'done') task.doneNotifiedAt = null;

  // "Bloccate" vs "Da decidere" (task board 03a5a645, decisione Owner 2026-07-25):
  // needs_input CON ask = richiesta vera (resta in "Da decidere"); needs_input
  // SENZA ask = blocco tecnico (va in "Bloccate", niente push per task, vedi
  // index.js/lib/blocked.js). patch.ask riflette qui l'eventuale ask che questa
  // stessa chiamata sta impostando (applicato al task solo più sotto, nel loop
  // dei PUBLIC_DIRECT_FIELDS): va letto dal patch, non da task.ask che è ancora
  // il valore precedente in questo punto. patch.blockCause (opzionale, es.
  // l'escalation del gate qui sotto) dà una causa nota al chiamante; altrimenti
  // 'manual' = needs_input impostata a mano senza passare da ask_owner.
  if (patch.status === 'needs_input') {
    const effectiveAsk = patch.ask !== undefined ? patch.ask : task.ask;
    task.blockCause = effectiveAsk ? null : (patch.blockCause ?? task.blockCause ?? 'manual');
  } else {
    task.blockCause = null;
  }
}

// Passo (c): applicazione piatta del patch, in tabelle invece di if ripetuti.
// PUBLIC = esposti sul tool update_task (API/MCP); INTERNAL = scritti solo da
// dispatcher/submitReview, mai passati dal chiamante esterno del tool.
const PUBLIC_DIRECT_FIELDS = ['description', 'note', 'ask'];
// autoRecoverCount/chronicEscalatedAt (task board 2e2d918f, bonifica automatica
// ricorrente): quante volte lib/autorecover.js ha già recuperato in automatico
// questa needs_input senza ask, e quando l'ha segnalata al CEO platform come
// "cronica" (una volta sola, vedi escalateChronic) — mai esposti sul tool
// update_task, scritti solo dal job.
const INTERNAL_DIRECT_FIELDS = ['workerId', 'managerRejections', 'ceoRejections', 'gateRejection', 'dispatchAttempts', 'dispatchAutoRetries', 'dispatchedFrom', 'doneNotifiedAt', 'autoRecoverCount', 'chronicEscalatedAt'];
const INTERNAL_BOOLEAN_FIELDS = ['dispatched', 'dispatchExhausted', 'pendingDeliveryReminder'];

// opts.viaReview = true SOLO quando la chiamata arriva da submitReview (unico
// percorso legittimo verso "done" per un agente). Vedi assertPatchAllowed.
export function updateTask(tenantId, taskId, patch, updatedBy, opts = {}) {
  const tasks = listTasks(tenantId);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error('task non trovata');
  assertPatchAllowed(tenantId, task, patch, updatedBy, opts);
  if (patch.status === 'review_manager' && task.resultType && task.resultType !== DEFAULT_RESULT_TYPE) {
    const deliverables = artifactsForTask(tenantId, taskId);
    const ready = deliverables.some((artifact) => artifact.status === 'ready_for_review' && artifact.validation?.passed);
    if (!ready) throw new Error(`questa task richiede un artefatto ${task.resultType} valido in ready_for_review prima della consegna al gate`);
  }
  if (patch.status !== undefined) applyStatusTransition(task, patch, updatedBy);
  if (patch.urgency !== undefined) {
    if (!TASK_URGENCIES.includes(patch.urgency)) throw new Error(`urgency non valida (${TASK_URGENCIES.join('|')})`);
    task.urgency = patch.urgency;
  }
  // Task 212d9b82 poi 81ea4965 (retry esauriti = task morta per sempre): QUALSIASI
  // update_task su questa task fatto da un umano/agente (NON dal dispatcher, che
  // altrimenti aggirerebbe da solo il proprio anti-loop) le dà un budget fresco di
  // tentativi. Prima si azzerava solo su un sottoinsieme di campi "sostanziali"
  // (assignedTo/urgency/title/description/blockedBy): una task a 3/3 toccata SOLO
  // con una nota (es. rilancio via chat, o un ask_owner che aggiorna solo l'ask)
  // restava bloccata lo stesso. Ora è "ad ogni update_task" senza eccezioni sui
  // campi — coperto anche il caso status:'todo' sopra. Guardia su >0/exhausted per
  // non scrivere/loggare a vuoto sulla stragrande maggioranza delle update.
  const humanTouch = updatedBy !== 'dispatcher';
  if (humanTouch && ((task.dispatchAttempts ?? 0) > 0 || task.dispatchExhausted)) {
    task.dispatchAttempts = 0;
    task.dispatchExhausted = false;
    task.dispatchAutoRetries = 0;
    task.pendingDeliveryReminder = false;
  }
  if (patch.title !== undefined && patch.title.trim()) task.title = patch.title.trim();
  if (patch.assignedTo !== undefined) task.assignedTo = normalizeAssignee(patch.assignedTo);
  if (patch.blockedBy !== undefined) task.blockedBy = validateBlockedBy(patch.blockedBy, tasks, task.id);
  for (const f of PUBLIC_DIRECT_FIELDS) if (patch[f] !== undefined) task[f] = patch[f];
  // Quality gate (interni: settati da submitReview/dispatcher, non esposti sul tool update_task).
  for (const f of INTERNAL_DIRECT_FIELDS) if (patch[f] !== undefined) task[f] = patch[f];
  // Campi interni di dispatcher/notifiche (non esposti su API/MCP).
  for (const f of INTERNAL_BOOLEAN_FIELDS) if (patch[f] !== undefined) task[f] = Boolean(patch[f]);
  task.updatedAt = new Date().toISOString();
  saveTasks(tenantId, tasks);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'task_updated', detail: { taskId, status: task.status, urgency: task.urgency } });
  onChange?.(task, 'updated');
  return task;
}

// Esito di una review del quality gate (task board 539c05b9): unico modo per
// far avanzare una task "review_manager"/"review_ceo". reviewedBy = 'agent:<id>'
// di chi ha fatto la review (registrato nell'audit e come updatedBy).
//
// approve: review_manager -> review_ceo; review_ceo -> done.
// reject: torna sempre all'agente originale (workerId) in stato "revisione"
//   con la nota della bocciatura, TRANNE quando il livello ha già accumulato
//   MAX_GATE_REJECTIONS bocciature: a quel punto va in needs_input, mai un
//   terzo giro automatico (anti-loop, decisione di Owner).
function hasOutcomeEvidence(task, reviewNote) {
  if (!task.outcome && !/^OUTCOME:/mi.test(String(task.description ?? ''))) return true;
  const evidence = `${String(task.note ?? '')}\n${String(reviewNote ?? '')}`;
  return /OUTPUT:/i.test(evidence)
    && /AMBIENTE:/i.test(evidence)
    && /PROVA:/i.test(evidence)
    && /GAP:\s*nessuno\b/i.test(evidence);
}

export function submitReview(tenantId, taskId, { decision, note }, reviewedBy) {
  if (decision !== 'approve' && decision !== 'reject') throw new Error('decision deve essere "approve" o "reject"');
  const tasks = listTasks(tenantId);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error('task non trovata');
  // Percorso normale (fix bug e248a568): durante la run di review il dispatcher
  // NON cambia più lo stato — la task resta "review_manager"/"review_ceo" per
  // tutta la durata, quindi qui task.status È già la fase di review giusta e
  // submit_review funziona al primo colpo. Fallback difensivo: se per qualche
  // motivo lo stato fosse "in_progress" con un dispatch da una fase di review
  // (vecchie task in volo al momento del deploy, REST/test che marcano
  // in_progress a mano), il livello si risolve da dispatchedFrom. Uno
  // "in_progress" di lavoro normale (dispatchedFrom=todo/revisione) non è una
  // fase di review: submit_review lì fallisce, corretto.
  const reviewFrom = task.status === 'in_progress' ? task.dispatchedFrom : task.status;
  const stage = reviewFrom === 'review_manager' ? 'manager' : reviewFrom === 'review_ceo' ? 'ceo' : null;
  if (!stage) throw new Error(`la task non è in una fase di review (stato attuale: "${task.status}"): submit_review si usa solo su task "review_manager" o "review_ceo"`);
  const cleanNote = String(note ?? '').trim() || (decision === 'approve' ? 'approvata, nessuna nota' : 'bocciata, nessuna nota');

  if (decision === 'approve') {
    if (stage === 'ceo' && !hasOutcomeEvidence(task, cleanNote)) {
      throw new Error('una task outcome non può andare a done senza OUTPUT, AMBIENTE, PROVA e GAP: nessuno nella consegna o nella review');
    }
    if (stage === 'ceo' && ['R2', 'R3'].includes(task.riskLevel ?? DEFAULT_RISK_LEVEL)) {
      const approved = artifactsForTask(tenantId, taskId).some((artifact) =>
        ['approved', 'published'].includes(artifact.status) && artifact.validation?.passed,
      );
      if (!approved) throw new Error(`la task ${task.riskLevel} richiede l’approvazione umana di un artefatto valido prima della chiusura`);
    }
    const nextStatus = stage === 'manager' ? 'review_ceo' : 'done';
    logAudit({ user: reviewedBy, tenant: tenantId, event: 'task_review_approved', detail: { taskId, stage, note: cleanNote } });
    // viaReview: unico percorso legittimo verso "done" (regola dura #1 in updateTask).
    return updateTask(tenantId, taskId, { status: nextStatus, note: cleanNote }, reviewedBy, { viaReview: true });
  }

  // reject
  const field = stage === 'manager' ? 'managerRejections' : 'ceoRejections';
  const count = task[field] ?? 0;
  if (count >= MAX_GATE_REJECTIONS) {
    logAudit({ user: reviewedBy, tenant: tenantId, event: 'task_review_escalated', detail: { taskId, stage, rejections: count, note: cleanNote } });
    return updateTask(tenantId, taskId, {
      status: 'needs_input',
      blockCause: 'gate_exhausted', // niente ask formale: va in "Bloccate", non in "Da decidere" (task board 03a5a645)
      note: `Quality gate: ${count + 1}ª bocciatura a livello ${stage === 'manager' ? 'manager' : 'CEO'}, serve una decisione di Owner. Ultima nota: ${cleanNote}`,
    }, reviewedBy);
  }
  logAudit({ user: reviewedBy, tenant: tenantId, event: 'task_review_rejected', detail: { taskId, stage, rejections: count + 1, note: cleanNote } });
  return updateTask(tenantId, taskId, {
    status: 'revisione',
    note: cleanNote,
    [field]: count + 1,
    gateRejection: { by: stage, note: cleanNote, at: new Date().toISOString() },
  }, reviewedBy);
}

// ---- Report task completate (sezione "Completate" della PWA, task adb782e9) ----
// Nessuna generazione LLM: solo dati già presenti sulla task + trail di review
// dal journal audit. La "nota di consegna" dell'operativo è, per convenzione
// (istruzioni operativi), appesa in coda alla description con un marcatore
// "--- CONSEGNA ..."; la si separa dalla descrizione originale per non mischiarle.
// Header del blocco di consegna, case-SENSITIVE uppercase: le occorrenze
// minuscole di "consegna" nella description sono prosa, non marcatori. Forme
// reali osservate: "--- NOTA DI CONSEGNA (…", "=== CONSEGNA (…", "[CONSEGNA
// CTO…", "CONSEGNA CTO (…". Deve essere a inizio riga (eventuale separatore
// -/=/[ ) e seguito da "(" o da una MAIUSCOLA (firma ruolo/data), così non
// scatta su "CONSEGNA" a metà frase.
const DELIVERY_MARK = /(^|\n)[ \t]*(?:[-=]{2,}[ \t]*\n?[ \t]*|\[)?(?:NOTA DI[ \t]+)?CONSEGNA\b(?=[ \t]*[(A-Z\]])/;
function splitDelivery(description) {
  const text = String(description ?? '');
  const m = text.match(DELIVERY_MARK);
  if (!m) return { baseDescription: text.trim(), deliveryNote: '' };
  const inner = m[0].match(/(?:NOTA DI[ \t]+)?CONSEGNA\b/);
  const wordStart = m.index + inner.index;
  return {
    baseDescription: text.slice(0, m.index).trim(),
    deliveryNote: text.slice(wordStart).trim(),
  };
}

// Sintesi compatta "cosa fatto + come verificato" per la card: appiattisce il
// testo già esistente (consegna operativo, o ultima review approvata, o nota),
// niente LLM. Tronca per stare in una card.
function compactReport({ deliveryNote, reviewNotes, note }) {
  const source = deliveryNote
    || [...reviewNotes].reverse().find((r) => r.decision === 'approve')?.note
    || note || '';
  const flat = String(source)
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 360 ? `${flat.slice(0, 359).trimEnd()}…` : flat;
}

// tenantId + filtri opzionali { from, to (ISO o YYYY-MM-DD), agentId, limit, offset }.
// Ritorna { count (totale filtrato), limit, offset, items } ordinati per data di
// completamento desc. agentId matcha assignedTo O workerId (chi ha consegnato).
export function completedTasksReport(tenantId, { from, to, agentId, limit = 20, offset = 0 } = {}) {
  const lim = Math.min(Math.max(1, Number(limit) || 20), 100);
  const off = Math.max(0, Number(offset) || 0);
  const wantAgent = agentId ? normalizeAssignee(agentId) : null;
  // Date-only "to" → fine giornata inclusiva (confronto lessicografico su ISO).
  const toBound = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to;

  // Fonte primaria della nota di consegna: l'evento "done" del feed Attività
  // (index.js, task board 31797bb5), che stasha task.note a review_manager
  // PRIMA che il gate lo sovrascriva con la nota del reviewer — stesso identico
  // problema di splitDelivery (marcatore "CONSEGNA" quasi mai presente, gli
  // operativi scrivono la nota nel campo note, non in description) già
  // risolto lì. Qui riusiamo quel risultato già persistito invece di
  // rifare la stessa estrazione (QA task 56e23f97 / board 9ab39022): niente
  // dipendenza dal marcatore, niente doppio consumo dello stash one-shot
  // (già preso da quel listener al momento del "done"). Una task riaperta e
  // richiusa genera un nuovo evento "done": listActivity è già ordinata
  // desc, quindi il primo match per taskId è il più recente.
  const doneNoteByTask = new Map();
  for (const e of listActivity(tenantId)) {
    if (e.kind === 'done' && !doneNoteByTask.has(e.taskId)) doneNoteByTask.set(e.taskId, e.note);
  }
  // Trail review di TUTTE le task in una sola lettura del journal (perf: prima
  // chiamava taskReviewNotes(t.id) dentro il .map() sotto → una readFileSync +
  // parse dell'intero audit.jsonl per ogni task done, N volte invece di 1).
  const notesByTask = reviewNotesByTask();

  let items = listTasks(tenantId)
    .filter((t) => t.status === 'done')
    .map((t) => {
      const completedAt = t.doneNotifiedAt ?? t.updatedAt ?? t.createdAt ?? null;
      const { baseDescription, deliveryNote: markerNote } = splitDelivery(t.description);
      // Fallback sul marcatore legacy solo se l'evento Attività manca (task
      // completate prima del feed, o oltre il tetto di MAX_EVENTS_PER_TENANT).
      const deliveryNote = doneNoteByTask.get(t.id) || markerNote;
      const reviewNotes = notesByTask.get(t.id) ?? [];
      return {
        id: t.id,
        title: t.title,
        description: baseDescription,
        urgency: t.urgency ?? DEFAULT_URGENCY,
        assignedTo: t.assignedTo ?? null,
        workerId: t.workerId ?? null,
        completedAt,
        deliveryNote,
        reviewNotes,
        // "file toccati se registrati": non ancora tracciati sulla task → [].
        filesTouched: Array.isArray(t.filesTouched) ? t.filesTouched : [],
        report: compactReport({ deliveryNote, reviewNotes, note: t.note }),
      };
    });

  if (wantAgent) items = items.filter((i) => i.assignedTo === wantAgent || i.workerId === wantAgent);
  if (from) items = items.filter((i) => i.completedAt && i.completedAt >= from);
  if (toBound) items = items.filter((i) => i.completedAt && i.completedAt <= toBound);
  items.sort((a, b) => (a.completedAt < b.completedAt ? 1 : a.completedAt > b.completedAt ? -1 : 0));

  return { count: items.length, limit: lim, offset: off, items: items.slice(off, off + lim) };
}

// ---- Tool MCP esposti agli agenti del tenant (CEO in chat, chiunque via dispatcher) ----
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
// list_tasks compatto/paginato (task board 521ccde0): JSON minificato invece
// che indentato a 2 spazi — l'agente lo fa comunque solo il parsing, e la sola
// indentazione costa ~4-5K caratteri extra su una board di un centinaio di
// task, budget che qui è la risorsa scarsa (limite token del tool). Nessun
// impatto sugli altri tool: usa `ok` normale (payload piccoli, leggibilità
// preferibile quando lo spazio non è il vincolo).
const okMin = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

// Validazione formato ask_owner (task board ab8328d2, root cause: task c4574283
// business-a — procedure multi-step ficcate nella "question", perché omesso).
// Funzione pura ed esportata (testabile senza passare dall'MCP server): valida e
// normalizza l'input del tool ask_owner, o lancia un Error con messaggio
// esplicativo che l'agente legge nel content dell'errore e usa per riformulare
// la chiamata nella stessa run. "goal" obbligatorio (perché serve la risposta),
// "question" una sola domanda secca max ~200 char senza elenchi numerati, gli
// eventuali passaggi di procedura vanno in "steps" (renderizzato a parte).
export function buildAskOwner({ goal, question, context, steps, options, title, askedBy, askedByName }) {
  const g = String(goal ?? '').trim();
  if (!g) {
    throw new Error('goal mancante: scrivi 1 riga secca su A COSA SERVE la risposta (es. "Per dare al CTO accesso ai repo Lovable"). Riformula e ritenta.');
  }
  if (g.length > 160) {
    throw new Error(`goal troppo lungo (${g.length} caratteri, max 160): è 1 riga sintetica, non una spiegazione. Riformula e ritenta.`);
  }
  const q = String(question ?? '').trim();
  if (!q) throw new Error('question richiesta: scrivi la domanda secca da porre a Owner. Riformula e ritenta.');
  if (q.length > 200) {
    throw new Error(`question troppo lunga (${q.length} caratteri, max ~200): deve essere UNA domanda secca. Sposta dettagli/contesto in "context" e le procedure in "steps". Riformula e ritenta.`);
  }
  if (/(?:^|[\s(])[1１][.)][\s\S]*[2２][.)]/.test(q)) {
    throw new Error('question contiene un elenco numerato ("1)...2)..."): non è ammesso, deve essere UNA sola domanda. Sposta i passaggi della procedura nel campo "steps" (array di stringhe) e lascia in "question" solo la domanda. Riformula e ritenta.');
  }
  const qMarks = (q.match(/\?/g) ?? []).length;
  if (qMarks > 1) {
    throw new Error('question contiene più di un punto interrogativo: deve essere UNA sola domanda. Spezza le altre domande o spostale in "context"/"steps". Riformula e ritenta.');
  }
  // Task board d873668c (bug critico: step troncati a metà parola, es. "...(sourc").
  // Root cause: qui sotto uno slice(0, 200) silenzioso per ogni step, senza
  // segnalazione — Owner leggeva istruzioni mozzate credendole complete. Regola:
  // MAI troncare in silenzio. O il testo passa intero, o la chiamata è respinta
  // con errore esplicito che l'agente legge e usa per riformulare (stesso
  // pattern già in uso sopra per goal/question). STEP_MAX_CHARS generoso
  // (molto oltre le ~2 righe di un passaggio tipico) per non forzare a
  // spezzare procedure legittimamente dettagliate (es. blocchi di permessi
  // GitHub con motivazione), ma abbastanza basso da bloccare un intero "muro
  // di testo" infilato in un solo step.
  const STEP_MAX_CHARS = 1000;
  const CONTEXT_MAX_CHARS = 500;
  const rawSteps = (steps ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (rawSteps.length > 10) {
    throw new Error(`troppi step (${rawSteps.length}, max 10): consolida i passaggi affini o dividi la richiesta. Riformula e ritenta.`);
  }
  rawSteps.forEach((s, i) => {
    if (s.length > STEP_MAX_CHARS) {
      throw new Error(`step ${i + 1} troppo lungo (${s.length} caratteri, max ${STEP_MAX_CHARS}): spezzalo in più step invece di infilare un muro di testo in uno solo. Riformula e ritenta.`);
    }
  });
  const ctx = context ? String(context).trim() : '';
  if (ctx.length > CONTEXT_MAX_CHARS) {
    throw new Error(`context troppo lungo (${ctx.length} caratteri, max ${CONTEXT_MAX_CHARS}): è contesto minimo (max 2 righe), non un muro di testo — sposta i dettagli procedurali in "steps". Riformula e ritenta.`);
  }
  return {
    goal: g,
    question: q,
    context: ctx,
    steps: rawSteps,
    options: (options ?? []).slice(0, 4).map((o) => ({
      label: String(o.label).slice(0, 40),
      value: (o.value ?? o.label).toString().slice(0, 40),
      style: o.style ?? 'neutral',
    })),
    title: title ? String(title).trim().slice(0, 80) : undefined,
    askedBy,
    askedByName,
    askedAt: new Date().toISOString(),
  };
}

// tenant = oggetto tenant di tenants.json (serve la lista agenti per assignedTo);
// notify (opzionale) = fn(payload) che manda una push a Owner/utenti del tenant.
// Definizioni dei tool (array di oggetti { name, description, inputSchema, handler }
// prodotti da tool()), separate da buildTasksMcpServer sullo stesso pattern di
// wikiTools/buildWikiMcpServer in lib/wiki.js: permette agli script di verifica
// di chiamare .handler(...) direttamente (stesso codice di una run reale, senza
// dover far girare un agente via SDK) — usato da task board 521ccde0 per
// dimostrare a quota zero la dimensione dell'output di list_tasks.
export function tasksTools(tenant, agentId, { notify } = {}) {
  const tenantId = tenant.id;
  const createdBy = `agent:${agentId}`;
  const agentName = tenant.agents.find((a) => a.id === agentId)?.name ?? agentId;
  const agentIds = tenant.agents.map((a) => a.id);
  const roster = tenant.agents.map((a) => `${a.id} (${a.role} — ${a.name})`).join(', ');
  const checkAssignee = (assignedTo) => {
    if (assignedTo === undefined || assignedTo === null) return;
    const id = String(assignedTo).replace(/^agent:/, '');
    if (!agentIds.includes(id)) throw new Error(`assignedTo non valido: agenti disponibili → ${agentIds.join(', ')}`);
  };
  return [
      tool(
        'create_task',
        `Crea una task sulla board del business per tracciare un lavoro discusso o deciso. Per una vera domanda a Owner usa il tool ask_owner (non lo status "needs_input" qui a mano: senza una domanda strutturata finisce tra le task "Bloccate", non da Owner). Imposta urgency in base a priorità operativa (sblocca altre task?) e impatto sul fatturato. Con assignedTo la task viene lavorata in autonomia dall'agente indicato; agenti disponibili in questo business: ${roster}. Con blockedBy la task parte solo quando le task indicate sono done. Per ogni task che promette un risultato esterno, descrivi obbligatoriamente OUTCOME, AMBIENTE finale, PROVA richiesta, OWNER dell'ultimo miglio e DEFINITION OF DONE. Copy, wiki, preview e codice non pubblicato vanno nominati Artifact/Preparazione: non chiamarli implementazione o done.`,
        {
          title: z.string().describe('Titolo breve della task'),
          description: z.string().optional().describe('Dettagli, contesto, criteri di completamento'),
          status: z.enum(TASK_STATUSES).optional().describe('Stato iniziale (default: todo)'),
          urgency: z.enum(TASK_URGENCIES).optional().describe('Urgenza della task (default: media)'),
          resultType: z.enum(RESULT_TYPES).optional().describe('Deliverable canonico della task (default: general)'),
          riskLevel: z.enum(RISK_LEVELS).optional().describe('Rischio R0-R3: determina il gate di approvazione (default: R1)'),
          assignedTo: z.string().optional().describe(`Id dell'agente che deve lavorare la task (${agentIds.join(', ')})`),
          blockedBy: z.array(z.string()).optional().describe('Id di task che devono essere done prima che questa parta'),
        },
        async ({ title, description, status, urgency, resultType, riskLevel, assignedTo, blockedBy }) => {
          checkAssignee(assignedTo);
          return ok(createTask(tenantId, {
            title, description: description ?? '', status: status ?? 'todo',
            urgency: urgency ?? DEFAULT_URGENCY, resultType: resultType ?? DEFAULT_RESULT_TYPE, riskLevel: riskLevel ?? DEFAULT_RISK_LEVEL, assignedTo: assignedTo ?? null, blockedBy: blockedBy ?? [],
          }, createdBy));
        },
      ),
      tool(
        'update_task',
        'Aggiorna stato, urgenza, assegnatario, dipendenze o contenuto di una task esistente della board. Se la task ha un resultType diverso da general, prima di status "review_manager" crea un deliverable valido con create_artifact e portalo a ready_for_review. A lavoro finito da operativo, metti status "review_manager" con una nota di consegna (cosa fatto, come verificato): NON puoi chiudere una task in "done" direttamente, il quality gate a due livelli (manager poi CEO) la chiude in automatico dopo l\'approvazione — usa il tool submit_review per approvare/bocciare una task che stai revisionando.',
        {
          taskId: z.string().describe('Id della task (da list_tasks)'),
          status: z.enum(TASK_STATUSES).optional(),
          urgency: z.enum(TASK_URGENCIES).optional(),
          title: z.string().optional(),
          description: z.string().optional(),
          assignedTo: z.string().optional().describe(`Id dell'agente a cui assegnare la task (${agentIds.join(', ')})`),
          blockedBy: z.array(z.string()).optional().describe('Id di task che devono essere done prima che questa parta'),
          note: z.string().optional().describe('Nota di lavorazione/consegna. OBBLIGATORIA quando consegni al gate (status "review_manager"): sintetizza cosa hai fatto e come l\'hai verificato. Facoltativa altrimenti.'),
        },
        async ({ taskId, ...patch }) => {
          if (patch.status === 'done') throw new Error('update_task non può chiudere una task in "done": il quality gate la chiude in automatico dopo l\'approvazione del CEO (tool submit_review sulla review "review_ceo").');
          checkAssignee(patch.assignedTo);
          // Integrazione consegna preview (task 9d1b6ebb): se la task consegnata al
          // gate ha una preview pubblicata (publish_preview con questo taskId),
          // l'URL entra nella nota di consegna — così compare nel feed Attività e,
          // via stashDeliveryNote, resta la traccia del deliverable. Idempotente:
          // non ri-appende se l'URL è già nella nota.
          if (patch.status === 'review_manager') {
            const links = previewLinksForTask(tenantId, taskId);
            const block = formatPreviewLinks(links);
            if (block && !String(patch.note ?? '').includes(links[0].url)) {
              patch.note = patch.note ? `${patch.note}\n\n${block}` : block;
            }
          }
          return ok(updateTask(tenantId, taskId, patch, createdBy));
        },
      ),
      tool(
        'submit_review',
        `Esito della review di qualità (quality gate a due livelli, decisione di Owner) su una task in fase "review_manager" o "review_ceo". decision "approve" fa avanzare la task al livello successivo (o a "done" se sei tu il CEO che approva); decision "reject" la rimanda a chi l'ha consegnata con la tua nota (cosa correggere). Dopo ${MAX_GATE_REJECTIONS} bocciature allo stesso livello la task va in automatico in needs_input: non bocciare oltre, escalation a Owner.`,
        {
          taskId: z.string().describe('Id della task in review (da list_tasks)'),
          decision: z.enum(['approve', 'reject']).describe('approve = passa al livello successivo/a done; reject = torna a chi ha consegnato'),
          note: z.string().describe('Nota: sintesi di cosa hai controllato se approvi; correzioni concrete e puntuali richieste se bocci'),
        },
        async ({ taskId, decision, note }) => ok(submitReview(tenantId, taskId, { decision, note }, createdBy)),
      ),
      tool(
        'list_tasks',
        `Elenca le task della board del business. DEFAULT (senza parametri): campi COMPATTI (id, title, status, urgency, assignedTo, blockedBy, openBlockers, updatedAt, descriptionPreview) + total/hasMore, max ${DEFAULT_LIST_LIMIT} task, ed esclude sempre le task "archived" e le task "done" più vecchie di 7 giorni (le done recenti restano, servono all'anti-duplicati) — pensato per stare sotto il limite token del tool anche con board grandi. Parametri: status (filtra stato: se passi "done" esplicitamente vedi TUTTE le done, senza il taglio a 7 giorni), assignedTo (filtra assegnatario), limit/offset per paginare oltre la prima pagina (usa "total"/"hasMore" della risposta per sapere se richiamare con offset più alto), fields:"full" per il payload completo di oggi (descrizione intera, note, ask, stato del gate — usalo su un sottoinsieme piccolo, es. combinato con status o assignedTo, non su tutta la board).`,
        {
          status: z.enum(TASK_STATUSES).optional().describe('Filtra per stato. Con "done" esplicito: TUTTE le done, senza il taglio a 7 giorni del default.'),
          assignedTo: z.string().optional().describe(`Filtra per assegnatario (${agentIds.join(', ')})`),
          fields: z.enum(['compact', 'full']).optional().describe('compact (default): id/title/status/urgency/assignedTo/blockedBy/openBlockers/updatedAt/descriptionPreview. full: payload completo di oggi (descrizione intera, note, revisionNote, ask, stato del gate) — su un sottoinsieme piccolo, non su tutta la board.'),
          limit: z.number().int().positive().optional().describe(`Quante task per pagina (default ${DEFAULT_LIST_LIMIT}).`),
          offset: z.number().int().nonnegative().optional().describe('Da quale indice iniziare (paginazione, default 0).'),
        },
        async ({ status, assignedTo, fields, limit, offset }) => {
          const all = listTasks(tenantId);
          let tasks = all.filter((t) => status ? t.status === status : t.status !== 'archived');
          if (assignedTo) {
            const norm = normalizeAssignee(assignedTo);
            tasks = tasks.filter((t) => normalizeAssignee(t.assignedTo) === norm);
          }
          const useFull = fields === 'full';

          // Retrocompatibilità stretta (criterio di completamento): fields:"full" SENZA
          // limit/offset riproduce byte-per-byte il comportamento di prima di questo fix
          // (solo filtro status, nessun taglio età, nessuna paginazione).
          if (useFull && limit === undefined && offset === undefined) {
            return ok(tasks.map((t) => fullTaskView(t, all)));
          }

          // Default anti-esplosione (solo quando lo status non è esplicito: uno status
          // esplicito, incluso "done", è già una richiesta mirata e va rispettata per intero).
          if (!status) {
            const cutoff = Date.now() - SEVEN_DAYS_MS;
            tasks = tasks.filter((t) => !(t.status === 'done' && Date.parse(t.updatedAt) < cutoff));
          }

          const total = tasks.length;
          const off = offset ?? 0;
          const lim = limit ?? DEFAULT_LIST_LIMIT;
          const page = tasks.slice(off, off + lim);
          const view = useFull ? (t) => fullTaskView(t, all) : (t) => compactTaskView(t, all);
          return okMin({
            tasks: page.map(view), total, count: page.length, offset: off, limit: lim,
            hasMore: off + page.length < total,
          });
        },
      ),
      tool(
        'notify_owner',
        'Manda una notifica push a Owner (e agli utenti del business). Usala SOLO quando serve una sua decisione o attenzione (task needs_input ferme, blocchi, risultati importanti): mai per routine senza novità.',
        {
          title: z.string().describe('Titolo breve della notifica'),
          body: z.string().describe('Cosa deve sapere/decidere Owner, in 1-2 frasi'),
        },
        async ({ title, body }) => {
          if (!notify) return ok({ sent: false, reason: 'notifiche push non disponibili in questo contesto' });
          await notify({ title: `${tenant.name}: ${title}`.slice(0, 100), body: String(body).slice(0, 300), tag: `ceo-notify-${tenantId}` });
          logAudit({ user: createdBy, tenant: tenantId, event: 'agent_notify_owner', detail: { title } });
          return ok({ sent: true });
        },
      ),
      tool(
        'ask_owner',
        `Chiedi a Owner una decisione o un input e METTI la task in attesa (needs_input). Gli arriva subito come PUSH con la domanda nel testo e un popup dedicato dove risponde in un tap. REGOLA DURA sul formato, validata dal server (chiamata non conforme viene RESPINTA con errore — riformula e ritenta nella stessa run): "goal" OBBLIGATORIO, 1 riga secca su A COSA SERVE la risposta (es. "Per dare al CTO accesso ai repo Lovable"); "question" è UNA sola domanda secca, max ~200 caratteri, MAI un elenco numerato ("1)...2)...3)" — se ti serve descrivere una procedura multi-step usa il campo "steps" (array di stringhe), non la question. Dai anche una frase di contesto (max 2 righe) in "context", e dove possibile 2-4 "options" a bottone (es. Approva/Rifiuta, oppure opzione A/opzione B). Owner può comunque rispondere a testo libero. La sua risposta torna a te sulla task (che riparte in revisione con la risposta nel prompt). Usalo al posto di scrivere paragrafi in needs_input.`,
        {
          taskId: z.string().optional().describe('Id della task in corso a cui legare la domanda (di norma quella che stai lavorando). Se omesso ne crea una nuova.'),
          goal: z.string().describe('OBBLIGATORIO. 1 riga secca: a cosa serve la risposta / cosa sblocca (es. "Per dare al CTO accesso ai repo Lovable"). Max ~160 caratteri.'),
          question: z.string().describe('La domanda secca e circoscritta, UNA sola, max ~200 caratteri. Niente elenchi numerati ("1)...2)...3)"): per le procedure usa "steps".'),
          context: z.string().optional().describe('Contesto minimo, max 2 righe. Niente muri di testo.'),
          steps: z.array(z.string()).optional().describe('Passaggi di una eventuale procedura (es. permessi GitHub da concedere), UNO per elemento. Renderizzati a parte dalla question. Max 10 passaggi.'),
          options: z.array(z.object({
            label: z.string().describe('Testo del bottone, es. "Approva", "Opzione A"'),
            value: z.string().optional().describe('Valore tecnico (default = label)'),
            style: z.enum(['primary', 'danger', 'neutral']).optional().describe('primary = azione positiva, danger = rifiuto/stop, neutral = alternativa'),
          })).optional().describe('2-4 opzioni secche a bottone, quando la risposta è a scelta chiusa'),
          title: z.string().optional().describe('Titolo breve = cosa serve (default: la domanda)'),
        },
        async ({ taskId, goal, question, context, steps, options, title }) => {
          const ask = buildAskOwner({ goal, question, context, steps, options, title, askedBy: createdBy, askedByName: agentName });
          // Task board ac3067d0 (dettaglio + thread chat): la domanda dell'agente
          // deve essere VISIBILE nel thread di chat della task (lib/taskchat.js),
          // non solo nel campo ask/journal — è la metà "agente" dello scambio
          // botta e risposta con Owner (l'altra metà, la risposta di Owner, la
          // scrive già il POST /api/tasks/:id/messages). Vale sia sulla task
          // esistente sia su quella appena creata (prima domanda del thread).
          if (taskId) {
            const updated = updateTask(tenantId, taskId, { status: 'needs_input', ask, note: ask.question }, createdBy);
            addTaskMessage(tenantId, taskId, { author: createdBy, authorName: agentName, text: ask.question });
            return ok(updated);
          }
          const created = createTask(tenantId, {
            title: (title ?? ask.question).slice(0, 80), description: context ?? '', status: 'needs_input', ask,
          }, createdBy);
          addTaskMessage(tenantId, created.id, { author: createdBy, authorName: agentName, text: ask.question });
          return ok(created);
        },
      ),
  ];
}

export function buildTasksMcpServer(tenant, agentId, opts = {}) {
  return createSdkMcpServer({ name: 'tasks', version: '1.0.0', tools: tasksTools(tenant, agentId, opts) });
}

export const TASKS_MCP_TOOLS = [
  'mcp__tasks__create_task',
  'mcp__tasks__update_task',
  'mcp__tasks__submit_review',
  'mcp__tasks__list_tasks',
  'mcp__tasks__notify_owner',
  'mcp__tasks__ask_owner',
];
