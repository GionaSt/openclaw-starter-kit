// Dispatcher autonomo delle task (Sprint 6, esteso Sprint 10, esteso quality
// gate 539c05b9): sul tick dello scheduler prende le task eleggibili ("todo",
// "revisione", "review_manager", "review_ceo", senza blocker aperti) in
// ordine di urgenza (poi per data di creazione), le marca in_progress e avvia
// una run come l'agente giusto — l'assegnatario per il lavoro vero e proprio,
// il manager/CEO per le fasi di review — riusando runAgentTurn: la run entra
// nel journal come tutte le altre → watchdog, pausa, stop, pagina globale
// "Agenti live". A fine run riconcilia (bug false-done 1c04b1b9): nessuna run
// autonoma chiude mai una task in "done" — a done si arriva SOLO dal quality
// gate (submit_review approvato dal CEO). Una run completata CON consegna
// esplicita ha già portato la task in review_manager da sola (qui non passa);
// una run completata SENZA consegna torna in todo/revisione con nota + retry;
// una run fallita (retry del watchdog esauriti) torna nello stato di partenza
// con nota + push a Owner. Le run morte sul limite Max restano "interrupted"
// (usage_limit) e la task resta in lavorazione fino al reset — mai done.
//
// Quality gate a due livelli (decisione di Owner, task board 539c05b9): un
// operativo che finisce non chiude più la task da solo (update_task rifiuta
// status "done" per gli agenti, vedi tasks.js) — consegna con status
// "review_manager" e una nota. Il dispatcher instrada la review al manager
// del worker (campo agente "managerId" in tenants.json); se il worker non ha
// un manager reale configurato (la maggior parte dei business oggi: CEO +
// operativi diretti, nessun livello intermedio) il livello si salta in
// automatico, SENZA lanciare una run, e la task passa dritta a "review_ceo".
// Il CEO fa sempre l'ultimo check; se approva → "done" (push a Owner
// invariata). Ogni bocciatura (submit_review nel tool MCP, tasks.js) registra
// la nota nel journal/audit e torna al worker originale ("revisione" con
// gateRejection valorizzato); dopo MAX_GATE_REJECTIONS bocciature allo stesso
// livello la task va in needs_input invece di un altro giro automatico.
import {
  listTasks, updateTask, urgencyRank, openBlockers, MAX_GATE_REJECTIONS,
} from './tasks.js';
import { listRuns } from './runs.js';
import { logAudit } from './audit.js';
import { autonomyLimitFor } from './settings.js';
import { scheduleRun, isQueued } from './concurrency.js';
import { isRateLimited } from './ratelimit.js';
import { isPlatformPaused } from './platformpause.js';
import { isTenantBlocked } from './tenantblock.js';
import { budgetPolicy as computeBudgetPolicy } from './budget.js';
import {
  SLOT_OCCUPYING_STATES, INTERACTIVE_ACTIVE_STATES, REVIEW_STATES, DISPATCHABLE_STATES,
} from './runstates.js';

// Quante ALTRE task (non ancora done) dipendono da questa (la elencano in
// blockedBy): completarla per prima sblocca il resto → più throughput
// (requisito A.3, "sblocca altre task").
function unblockCount(task, tasks) {
  return tasks.filter((t) => t.status !== 'done' && (t.blockedBy ?? []).includes(task.id)).length;
}

// Stima di costo/lunghezza della task per l'ordinamento (requisito A.3, "task
// brevi prima a parità di priorità"): euristica leggera sulla dimensione di
// titolo+descrizione (più testo ≈ più lavoro). Nessuna chiamata al modello:
// serve solo un ordine relativo stabile, non una stima assoluta di token.
function costEstimate(task) {
  return (task.title?.length ?? 0) + (task.description?.length ?? 0);
}

// Ordinamento della coda dispatcher (requisito A.3): urgenza desc, poi "sblocca
// altre task" desc, poi stima di costo asc (brevi prima), poi FIFO per data.
function dispatchOrder(a, b, tasks) {
  const u = urgencyRank(b.urgency) - urgencyRank(a.urgency);
  if (u !== 0) return u;
  const ub = unblockCount(b, tasks) - unblockCount(a, tasks);
  if (ub !== 0) return ub;
  const c = costEstimate(a) - costEstimate(b);
  if (c !== 0) return c;
  return a.createdAt < b.createdAt ? -1 : 1;
}

// Filtro budget-aware (requisito B.4): dato lo stato della policy, decide se una
// task è lanciabile ORA. Le run di review (quality gate) sono sempre ammesse
// finché non siamo al muro (shouldHaltAll): il margine riservato serve proprio a non
// lasciare task appese in revisione senza token.
function budgetAllowsLaunch(task, budgetPolicy) {
  if (!budgetPolicy.known) return true;
  const isReview = REVIEW_STATES.includes(task.status);
  if (isReview) return true; // il gate ha sempre precedenza sul margine riservato
  if (budgetPolicy.shouldReserveForReview) return false; // <=RESERVE_PCT: solo review, esecuzione ferma
  if (budgetPolicy.shouldThrottle && urgencyRank(task.urgency) < urgencyRank('alta')) return false; // <=LOW_PCT: solo critiche/alte
  return true;
}

// Max run autonome in parallelo per tenant: settabile da Owner via UI
// (settings.json, default globale + override per tenant, range 1-8), letto
// a ogni tick con autonomyLimitFor. Contano anche interrupted/paused:
// torneranno attive da sole, non vanno raddoppiate nel frattempo.
// (SLOT_OCCUPYING_STATES importato da runstates.js — fonte unica, task 81c7bbc8)
// Una run interattiva (chat utente) attiva nel tenant blocca nuovi lanci
// autonomi in quel tick: le run interattive hanno precedenza.
// (INTERACTIVE_ACTIVE_STATES importato da runstates.js — fonte unica, task 81c7bbc8)
// Run di sistema, mai "interattive": non bloccano il dispatcher.
const SYSTEM_SOURCES = ['dispatcher', 'board_check', 'external'];
// Anti-loop: una task tornata todo dopo un fallimento viene ritentata al
// massimo fino a questo totale di lanci autonomi. Esportata: lib/blocked.js
// (task board 03a5a645) la usa per mostrare "tentativo N/MAX" nella lista
// "Bloccate", senza duplicare la costante.
export const MAX_DISPATCH_ATTEMPTS = 3;

// Task 212d9b82, poi 81ea4965 (rilancio, CRITICO): run che finiscono senza
// consegna esauriscono i tentativi (MAX_DISPATCH_ATTEMPTS). Prima, esauriti,
// la task andava in "needs_input" — SEMANTICAMENTE SBAGLIATO (decisione CEO
// 2026-07-25): needs_input vuol dire "Owner deve decidere", ma qui non c'è
// nessuna domanda. Ora la task resta nel suo stato dispatchable (todo/
// revisione/review_manager/review_ceo): il blocco è tecnico, segnalato solo
// dal flag dispatchExhausted + una nota con la causa (vedi reconcileNoDelivery
// e rescueExhaustedDispatchable sotto). Il dispatcher stesso, senza bisogno di
// un umano, resetta dispatchAttempts/dispatchExhausted dopo un raffreddamento
// (resetExhaustedDispatch) e SEMPRE ad ogni update_task sulla task (tasks.js,
// updateTask: qualunque tocco non-dispatcher azzera). Nessun tetto ai cicli di
// auto-retry: "mai needs_input senza domanda" è incondizionato, non solo per i
// primi due cicli — molti casi reali sono transitori (l'agente si è
// dimenticato la consegna una volta, il prompt rinforzato sotto lo corregge
// quasi sempre al retry successivo), e se il problema persiste la task resta
// comunque visibile in coda con la causa in nota, non sparisce mai davvero.
// Cooldown configurabile via env (default 30 min): AGENT_PLATFORM_DISPATCH_COOLDOWN_MIN.
const DISPATCH_EXHAUST_COOLDOWN_MIN = (() => {
  const n = Number(process.env.AGENT_PLATFORM_DISPATCH_COOLDOWN_MIN);
  return Number.isFinite(n) && n > 0 ? n : 30;
})();
const DISPATCH_EXHAUST_COOLDOWN_MS = DISPATCH_EXHAUST_COOLDOWN_MIN * 60 * 1000;

// Stati eleggibili al lancio autonomo: todo (lavoro nuovo), revisione (task
// riaperta da Owner o rimandata da una bocciatura del gate, rilanciata verso
// l'agente assegnato) e le due fasi del quality gate.
// (REVIEW_STATES / DISPATCHABLE_STATES importati da runstates.js — fonte unica, task 81c7bbc8)

function taskPrompt(tenant, task, agent) {
  const lines = [
    `Sei ${agent.name} (${agent.role}) di ${tenant.name} (${tenant.description}).`,
    `Ti è stata assegnata in autonomia questa task dalla board:`,
    '',
    `Titolo: ${task.title}`,
    `Urgenza: ${task.urgency ?? 'media'}`,
    task.description ? `Descrizione:\n${task.description}` : 'Descrizione: (nessuna)',
    '',
    `Id della task sulla board: ${task.id}`,
  ];
  if (task.status === 'revisione' && task.gateRejection) {
    // Bocciatura del quality gate (submit_review), non una riapertura umana.
    lines.push(
      '',
      `ATTENZIONE: la tua consegna è stata BOCCIATA dal quality gate (livello ${task.gateRejection.by === 'manager' ? 'MANAGER' : 'CEO'}).`,
      `Nota della bocciatura: ${task.gateRejection.note}`,
      'Correggi/integra secondo la nota, senza rifare da zero ciò che era già buono.',
    );
  } else if (task.status === 'revisione') {
    lines.push(
      '',
      'ATTENZIONE: questa task era già stata consegnata, ma Owner l\'ha riaperta in REVISIONE.',
      `Nota di revisione: ${task.revisionNote ?? task.note ?? '(nessuna nota: rileggi la descrizione e migliora la consegna)'}`,
      'Correggi/integra il lavoro secondo la nota, senza rifare da zero ciò che era già buono.',
    );
  }
  if (task.pendingDeliveryReminder) {
    // Task 212d9b82 (bug critico): il tentativo precedente è FINITO senza che
    // l'agente chiamasse update_task -> review_manager, quindi il dispatcher
    // l'ha rimessa in coda scartando il lavoro come non consegnato. Rinforzo
    // esplicito nel prompt (requisito 1), non solo nella nota della board.
    lines.push(
      '',
      `⚠️ ATTENZIONE (tentativo ${task.dispatchAttempts ?? '?'}/${MAX_DISPATCH_ATTEMPTS}): il tentativo precedente su QUESTA task è terminato SENZA consegna esplicita — nessuna chiamata a update_task con status "review_manager". Il dispatcher l'ha considerata fallita e il lavoro va rifatto: ${task.note ?? ''}`,
      `Dopo ${MAX_DISPATCH_ATTEMPTS} tentativi senza consegna la task resta bloccata (tecnico) finché non scade il raffreddamento automatico: non sprecare questo tentativo, chiudi SEMPRE con update_task a review_manager (anche parziale, con nota su cosa manca) invece di terminare la run senza dire nulla.`,
    );
  }
  lines.push(
    '',
    'Lavora la task fino in fondo con i tuoi tool.',
    'Consegna: NON chiudere da solo. update_task a status "review_manager" con nota COMPATTA a bullet (cosa fatto, come verificato, file toccati). Il quality gate a due livelli (manager → CEO) la porta a "done"; la push a Owner parte solo dopo l\'ok finale del CEO. Se il gate boccia, correggi e riconsegna uguale.',
    'Se serve una decisione/dato di Owner: usa il tool ask_owner (mai un update_task a status "needs_input" a mano — senza una domanda strutturata finisce tra le task "Bloccate", non da Owner) e fermati.',
    'REGOLA DURA: la run NON è considerata finita finché non hai chiamato update_task (o, se bloccato, ask_owner). Una run che finisce senza quella chiamata viene trattata come fallita: il lavoro fatto in questa run rischia di andare perso e va ripetuto da capo al tentativo successivo.',
  );
  return lines.join('\n');
}

// Prompt per il reviewer di una fase del quality gate (manager o CEO):
// diverso dal prompt di lavoro, guida verso submit_review invece che update_task.
function reviewPrompt(tenant, task, reviewer, stage, worker) {
  const lines = [
    `Sei ${reviewer.name} (${reviewer.role}) di ${tenant.name} (${tenant.description}).`,
    stage === 'manager'
      ? `Fai da MANAGER nel quality gate a due livelli (decisione di Owner): rivedi il lavoro consegnato da ${worker.name} (${worker.role}) prima che passi al CEO.`
      : `Fai da CEO nel quality gate a due livelli (decisione di Owner): sei l'ultimo check prima che la task vada in "done" e Owner riceva la push.`,
    '',
    `Titolo: ${task.title}`,
    `Urgenza: ${task.urgency ?? 'media'}`,
    task.description ? `Descrizione/criteri di completamento:\n${task.description}` : 'Descrizione: (nessuna)',
    '',
    `Nota di consegna di ${worker.name}: ${task.note ?? '(nessuna nota)'}`,
    (task.managerRejections || task.ceoRejections)
      ? `Bocciature già avvenute su questa task: manager ${task.managerRejections ?? 0}, CEO ${task.ceoRejections ?? 0} (max ${MAX_GATE_REJECTIONS} per livello, poi va a Owner).`
      : null,
    '',
    `Id della task sulla board: ${task.id}`,
    '',
    stage === 'manager'
      ? 'Controlla che il lavoro rispetti i criteri di completamento della descrizione; esegui/verifica dove possibile (leggi i file toccati, prova quello che è ragionevole provare — non fidarti solo della nota).'
      : 'Il check tecnico l\'ha già fatto il manager: valuta la coerenza con l\'obiettivo di business e le priorità del momento, non rifare la verifica tecnica.',
    'Poi chiama SEMPRE il tool submit_review (mai update_task): decision "approve" con nota compatta se va bene, oppure "reject" con nota concreta (bullet: cosa manca/va corretto) — tornerà a chi ha consegnato.',
    'REGOLA DURA: la run NON è considerata finita finché non hai chiamato submit_review. Una run che finisce senza quella chiamata viene trattata come una review non fatta: il dispatcher ti ri-assegna la stessa review da capo.',
  ].filter((l) => l !== null);
  return lines.join('\n');
}

// Agente che deve lavorare la task: assignedTo se è un agente del tenant,
// altrimenti il CEO (fallback storico). Usato per todo/in_progress/revisione;
// per le fasi di review vedi reviewerForTask.
function agentForTask(tenant, task, ceo) {
  const id = String(task.assignedTo ?? '').replace(/^agent:/, '');
  return tenant.agents.find((a) => a.id === id) ?? ceo;
}

// Worker originale della consegna in review (chi torna a lavorarci se bocciata).
function workerAgentFor(tenant, task, ceo) {
  const id = String(task.workerId ?? '').replace(/^agent:/, '');
  return tenant.agents.find((a) => a.id === id) ?? ceo;
}

// Manager di un worker: campo opzionale per-agente "managerId" in tenants.json
// (chi fa la review di livello 1 del suo lavoro). Nessun manager configurato,
// o managerId che punta al worker stesso -> nessun livello 1 reale (la
// maggior parte dei business oggi: CEO + operativi diretti, vedi
// docs/model-tiering.md sul perché i "Responsabile X" restano operativi).
function managerAgentFor(tenant, worker) {
  if (!worker?.managerId || worker.managerId === worker.id) return null;
  return tenant.agents.find((a) => a.id === worker.managerId) ?? null;
}

// Agente e prompt per il dispatch di una task, secondo lo stato: lavoro vero
// e proprio (todo/in_progress/revisione) vs le due fasi del quality gate.
function dispatchFor(tenant, task, ceo) {
  if (task.status === 'review_manager') {
    const worker = workerAgentFor(tenant, task, ceo);
    const manager = managerAgentFor(tenant, worker) ?? ceo; // già garantito non-null dall'auto-skip del tick
    return { agent: manager, message: reviewPrompt(tenant, task, manager, 'manager', worker) };
  }
  if (task.status === 'review_ceo') {
    const worker = workerAgentFor(tenant, task, ceo);
    return { agent: ceo, message: reviewPrompt(tenant, task, ceo, 'ceo', worker) };
  }
  // Bocciatura del gate (revisione con gateRejection): la correzione torna
  // all'operativo che ha consegnato (workerId), NON all'assignedTo — che il
  // dispatch della fase di review ha impostato sul reviewer (manager/CEO). La
  // riapertura umana di Owner (gateRejection null) resta invece sull'agente
  // assegnato, comportamento preesistente (Sprint 10).
  if (task.status === 'revisione' && task.gateRejection) {
    const worker = workerAgentFor(tenant, task, ceo);
    return { agent: worker, message: taskPrompt(tenant, task, worker) };
  }
  const agent = agentForTask(tenant, task, ceo);
  return { agent, message: taskPrompt(tenant, task, agent) };
}

// Ultima run autonoma associata alla task (per il reconcile).
function latestRunForTask(tenantRuns, taskId) {
  return tenantRuns
    .filter((r) => r.source === 'dispatcher' && r.taskId === taskId)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0] ?? null;
}

// ---- Quality gate: auto-skip dei livelli senza un reviewer reale ----
// Gratuito (nessuna run, nessuno slot consumato), sempre eseguito prima
// del lancio: un worker senza manager configurato ("managerId" in
// tenants.json) salta dritto a review_ceo; se il worker è lui stesso il
// CEO (task assegnata al CEO) non ha senso farlo auto-revisionare, chiude
// diretto in done.
function autoSkipEmptyGateLevels(tenant, ceo) {
  for (const task of listTasks(tenant.id)) {
    // Una review già in corso (dispatched) mantiene ora il suo stato coerente
    // (review_manager/review_ceo): NON va auto-skippata mentre il reviewer
    // lavora — il pre-pass agisce solo su consegne fresche non ancora lanciate.
    if (task.dispatched) continue;
    if (task.status === 'review_manager') {
      const worker = workerAgentFor(tenant, task, ceo);
      if (managerAgentFor(tenant, worker)) continue; // manager reale: dispatchable normalmente
      updateTask(tenant.id, task.id, { status: 'review_ceo' }, 'dispatcher');
      logAudit({ user: 'dispatcher', tenant: tenant.id, agent: worker.id, event: 'task_review_manager_skipped', detail: { taskId: task.id, reason: 'nessun manager configurato per il worker' } });
    } else if (task.status === 'review_ceo') {
      const worker = workerAgentFor(tenant, task, ceo);
      if (worker.id !== ceo.id) continue;
      updateTask(tenant.id, task.id, { status: 'done', note: 'consegna del CEO stesso: nessuna auto-review necessaria' }, 'dispatcher');
      logAudit({ user: 'dispatcher', tenant: tenant.id, agent: ceo.id, event: 'task_review_ceo_self_skipped', detail: { taskId: task.id } });
    }
  }
}

// ---- Reconcile: esito delle run autonome già lanciate ----
// Il marcatore "in lavorazione autonoma" è task.dispatched, NON lo status: le
// task di lavoro restano "in_progress", quelle in review MANTENGONO il loro
// stato (review_manager/review_ceo) per tutta la durata della run (fix bug
// e248a568), così submit_review funziona al primo colpo senza dover risolvere
// il livello da dispatchedFrom. Il reconcile individua le run terminate
// guardando dispatched, non lo status. I tre esiti possibili (review non
// chiusa da submit_review, run completata senza consegna, run fallita/sparita)
// sono isolati in altrettante funzioni: stesso comportamento, un ramo alla
// volta invece di un unico if/else annidato (bug false-done 1c04b1b9 ed
// e248a568 nascevano qui).

// Run di review completata ma la task è ancora in una fase di review: il
// reviewer non ha chiamato submit_review (dimenticanza/errore del modello,
// non ha detto né approve né reject). NON possiamo chiudere automaticamente
// in "done" come per una run di lavoro: bypasserebbe il gate. Lo stato di
// review è già quello giusto (lo abbiamo lasciato coerente): basta liberare
// il marcatore dispatched e il prossimo tick ritenta (stesso anti-loop
// tecnico di dispatchAttempts già in uso per todo/revisione).
function reconcileIncompleteReview(tenant, task, worker, run) {
  updateTask(tenant.id, task.id, {
    dispatched: false,
    note: `${worker.name} ha finito la run senza chiamare submit_review: ridispaccio (tentativo ${task.dispatchAttempts ?? 1}/${MAX_DISPATCH_ATTEMPTS})`,
  }, 'dispatcher');
  logAudit({ user: 'dispatcher', tenant: tenant.id, agent: worker.id, event: 'task_review_incomplete', detail: { taskId: task.id, runId: run.id } });
}

// Run "completata" ma la task è ancora in_progress: l'agente NON ha
// consegnato esplicitamente (nessun update_task -> review_manager con nota).
// Requisito (c) del bug false-done 1c04b1b9: MAI done (bypassa il gate), MAI
// review senza una consegna reale da verificare — torna nello stato di
// partenza (todo/revisione) con nota + retry entro l'anti-loop. NB: una run
// "completata" che era in realtà il banner di limite Max qui non arriva più
// (Fix B in runAgentTurn la dirotta su interrupted usage_limit, che resta in
// SLOT_OCCUPYING_STATES).
function reconcileNoDelivery(tenant, task, worker, run) {
  const attempts = task.dispatchAttempts ?? 1;
  const exhausted = attempts >= MAX_DISPATCH_ATTEMPTS;
  const backTo = DISPATCHABLE_STATES.includes(task.dispatchedFrom) ? task.dispatchedFrom : 'todo';
  // Task 81ea4965 (rilancio, CRITICO): esaurita o no, la task torna SEMPRE nel
  // suo stato dispatchable — MAI needs_input senza una domanda vera. Esaurita:
  // resta lì con dispatchExhausted:true (blocco tecnico + causa in nota), fuori
  // dal filtro di eleggibilità (dispatchAttempts>=MAX) finché non arriva un
  // reset (cooldown automatico sotto, o qualunque update_task sulla task).
  updateTask(tenant.id, task.id, {
    status: backTo,
    dispatched: false,
    dispatchExhausted: exhausted,
    pendingDeliveryReminder: !exhausted,
    note: exhausted
      ? `Dispatch: tentativi di lavorazione esauriti (${attempts}/${MAX_DISPATCH_ATTEMPTS}) — ${worker.name} ha finito ${MAX_DISPATCH_ATTEMPTS} run senza consegnare (nessun update_task a review_manager). Blocco tecnico temporaneo: il dispatcher la riprova da solo tra ~${DISPATCH_EXHAUST_COOLDOWN_MIN} min, o subito se qualcuno la tocca (riassegnazione, nota, riapertura).`
      : `run completata da ${worker.name} senza consegna esplicita (nessun update_task a review_manager): rimessa in coda (tentativo ${attempts}/${MAX_DISPATCH_ATTEMPTS}); il done passa solo dal quality gate`,
  }, 'dispatcher');
  logAudit({ user: 'dispatcher', tenant: tenant.id, agent: worker.id, event: 'task_autonomous_no_delivery', detail: { taskId: task.id, runId: run.id, attempts, exhausted } });
}

// Task 212d9b82, poi 81ea4965 (rilancio, CRITICO — punto 1a/2): reset
// automatico del blocco tecnico dispatchExhausted dopo un raffreddamento di
// DISPATCH_EXHAUST_COOLDOWN_MS (default 30 min, configurabile via env). Da
// 81ea4965 le task esaurite NON sono più in needs_input (restano nel loro
// stato dispatchable, vedi reconcileNoDelivery/rescueExhaustedDispatchable):
// qui si scandisce quel flag direttamente, senza filtrare per status. Nessun
// tetto ai cicli automatici (decisione CEO: "mai needs_input senza domanda" è
// incondizionato) — se il problema è persistente la task resta comunque
// visibile in coda con la causa in nota ad ogni ciclo, mai silenziosa e mai
// scalata a una needs_input fittizia.
function resetExhaustedDispatch(tenant) {
  const now = Date.now();
  for (const task of listTasks(tenant.id)) {
    if (!task.dispatchExhausted || task.dispatched) continue;
    if (!DISPATCHABLE_STATES.includes(task.status)) continue; // toccata nel frattempo da altra via: non tocchiamo
    const age = now - Date.parse(task.updatedAt ?? task.createdAt ?? now);
    if (!(age >= DISPATCH_EXHAUST_COOLDOWN_MS)) continue;
    const autoRetries = (task.dispatchAutoRetries ?? 0) + 1;
    updateTask(tenant.id, task.id, {
      dispatchAttempts: 0,
      dispatchExhausted: false,
      dispatchAutoRetries: autoRetries,
      note: `Dispatch: reset automatico dopo raffreddamento di ${DISPATCH_EXHAUST_COOLDOWN_MIN} min (ciclo ${autoRetries}) — tentativi riazzerati, torna eleggibile per il dispatcher.`,
    }, 'dispatcher');
    logAudit({ user: 'dispatcher', tenant: tenant.id, event: 'task_dispatch_cooldown_retry', detail: { taskId: task.id, autoRetries, status: task.status } });
  }
}

// Task 212d9b82 (casi osservati in produzione: 7f8b4e9b/bc5358da su
// business-a/business-b): task con status "in_progress" ma dispatched=false.
// "in_progress" NON è in DISPATCHABLE_STATES — è lo stato che il lancio del
// dispatcher assegna insieme a dispatched:true nella STESSA updateTask
// (dispatchTask sopra), quindi in condizioni normali non esiste un momento in
// cui è in_progress senza essere anche dispatched. Se ci finisce per un'altra
// via (creazione diretta con status:"in_progress", o un'incoerenza residua)
// nessun filtro di eleggibilità la rimette mai in coda: bloccata per sempre.
// Grazia di ORPHAN_IN_PROGRESS_GRACE_MS prima di toccarla, per non correre
// contro una task appena creata così da un umano/agente.
const ORPHAN_IN_PROGRESS_GRACE_MS = 15 * 60 * 1000;
function requeueOrphanInProgress(tenant) {
  const now = Date.now();
  for (const task of listTasks(tenant.id)) {
    if (task.status !== 'in_progress' || task.dispatched) continue;
    const age = now - Date.parse(task.updatedAt ?? task.createdAt ?? now);
    if (age < ORPHAN_IN_PROGRESS_GRACE_MS) continue;
    updateTask(tenant.id, task.id, {
      status: 'todo',
      note: 'task "in_progress" orfana (nessuna lavorazione autonoma associata): rimessa in coda automaticamente dal dispatcher',
    }, 'dispatcher');
    logAudit({ user: 'dispatcher', tenant: tenant.id, event: 'task_orphan_requeued', detail: { taskId: task.id } });
  }
}

// Task 66ea084a (bug critico cross-tenant: review/revisione ferme al gate per
// ~17h su business-a mentre platform girava). Root cause: reconcileFailedRun
// (run interrotta/fallita all'ultimo tentativo — tipico sotto muro di quota) e
// reconcileIncompleteReview (review chiusa senza submit_review) lasciano la task
// nel suo stato DISPATCHABLE_STATES (todo/revisione/review_manager/review_ceo) con
// dispatchAttempts==MAX senza marcarla: il filtro di eleggibilità (dispatchAttempts
// <MAX) la esclude allora PER SEMPRE dai lanci, ma senza dispatchExhausted anche
// resetExhaustedDispatch la ignora — invisibile e mai più lanciata. Rete di
// sicurezza generale (indipendente da quale ramo di reconcile ha portato alla
// trappola): una task in stato dispatchable, non dispatched, con i tentativi
// esauriti e NON già marcata dispatchExhausted, riceve SOLO il flag (nessun
// cambio di status: 81ea4965, mai needs_input senza domanda) così
// resetExhaustedDispatch le dà il cooldown automatico. Resta visibile e
// lavorabile nel suo stato normale, con la causa in nota.
function rescueExhaustedDispatchable(tenant) {
  for (const task of listTasks(tenant.id)) {
    if (task.dispatched || task.dispatchExhausted) continue;
    if (!DISPATCHABLE_STATES.includes(task.status)) continue;
    if ((task.dispatchAttempts ?? 0) < MAX_DISPATCH_ATTEMPTS) continue;
    updateTask(tenant.id, task.id, {
      dispatchExhausted: true,
      note: `Dispatch: tentativi di lavorazione esauriti (${task.dispatchAttempts ?? '?'}/${MAX_DISPATCH_ATTEMPTS}) con la task rimasta in "${task.status}" — run interrotte/fallite (tipico sotto muro di quota) o review chiuse senza submit_review. Blocco tecnico temporaneo: il dispatcher la riprova da solo tra ~${DISPATCH_EXHAUST_COOLDOWN_MIN} min.`,
    }, 'dispatcher');
    logAudit({ user: 'dispatcher', tenant: tenant.id, event: 'task_dispatch_rescued_exhausted', detail: { taskId: task.id, status: task.status, attempts: task.dispatchAttempts ?? null } });
  }
}

// failed (retry del watchdog esauriti) o run sparita: torna nello stato di
// partenza con nota; l'assegnatario resta. Per una review lo stato è già
// quello di partenza (l'abbiamo lasciato coerente): non tocchiamo lo status
// (riscriverlo ri-triggererebbe i side-effect di updateTask sulle transizioni
// di review — reset di workerId/gateRejection/attempts).
function reconcileFailedRun(tenant, task, worker, run, isReview, notify) {
  const why = run ? `run fallita: ${String(run.lastError ?? 'errore sconosciuto').slice(0, 200)}` : 'run non più presente nel journal';
  updateTask(tenant.id, task.id, {
    ...(isReview ? {} : { status: DISPATCHABLE_STATES.includes(task.dispatchedFrom) ? task.dispatchedFrom : 'todo' }),
    dispatched: false,
    note: `lavorazione autonoma non riuscita (tentativo ${task.dispatchAttempts ?? 1}/${MAX_DISPATCH_ATTEMPTS}) — ${why}`,
  }, 'dispatcher');
  logAudit({ user: 'dispatcher', tenant: tenant.id, agent: worker.id, event: 'task_autonomous_failed', detail: { taskId: task.id, runId: run?.id ?? null, why } });
  notify(tenant.id, {
    title: `Task autonoma non riuscita — ${tenant.name}`,
    body: `"${task.title}": ${why.slice(0, 100)}`,
    tag: `task-dispatch-${task.id}`,
  }).catch(() => {});
}

// Passa in rassegna le task dispatched del tenant e chiude l'esito della loro
// ultima run (i tre rami sopra). Muta la board (updateTask); il chiamante sa
// che dopo questa chiamata la board va riletta (vedi eligibleTasksFor).
function reconcileDispatchedTasks(tenant, ceo, tenantRuns, tasks, notify) {
  for (const task of tasks) {
    if (!task.dispatched) continue;
    // Ancora in coda per il cap globale di agenti attivi (Agenti live):
    // nessun run nel journal ancora, non è un fallimento, aspetta il turno.
    if (isQueued(task.id)) continue;
    const run = latestRunForTask(tenantRuns, task.id);
    if (run && SLOT_OCCUPYING_STATES.includes(run.status)) continue; // ancora in corso (o in pausa)
    if (run?.status === 'stopped') continue; // fermata da un umano: decide lui
    const worker = run ? tenant.agents.find((a) => a.id === run.agentId) ?? ceo : agentForTask(tenant, task, ceo);
    const isReview = REVIEW_STATES.includes(task.status);
    if (run?.status === 'completed' && isReview) {
      reconcileIncompleteReview(tenant, task, worker, run);
    } else if (run?.status === 'completed') {
      reconcileNoDelivery(tenant, task, worker, run);
    } else {
      reconcileFailedRun(tenant, task, worker, run, isReview, notify);
    }
  }
}

// ---- Lancio: nuove run autonome nei limiti di concorrenza ----

// Predicato di eleggibilità al lancio (isolato per testabilità) + ordinamento
// per urgenza. Rilegge la board (il reconcile sopra può averla mutata).
function eligibleTasksFor(tenant, budgetPolicy) {
  const fresh = listTasks(tenant.id); // reconcile può aver mutato la board
  return fresh
    .filter((t) => DISPATCHABLE_STATES.includes(t.status)
      && !t.dispatched // già in lavorazione (run in volo o appena finita, in attesa di reconcile): non ri-lanciare
      && (t.dispatchAttempts ?? 0) < MAX_DISPATCH_ATTEMPTS
      && openBlockers(t, fresh).length === 0 // le bloccate aspettano il done dei blocker
      && budgetAllowsLaunch(t, budgetPolicy)) // budget-aware: throttle/riserva margine per il gate
    .sort((a, b) => dispatchOrder(a, b, fresh));
}

// Marca la task come in lavorazione/review e lancia la run (via scheduleRun,
// che mette in coda da solo se il cap globale di Agenti live è saturo).
function dispatchTask(tenant, task, ceo, runFn) {
  const { agent, message } = dispatchFor(tenant, task, ceo);
  const attempts = (task.dispatchAttempts ?? 0) + 1;
  const isReview = REVIEW_STATES.includes(task.status);
  updateTask(tenant.id, task.id, {
    // Review: NON tocchiamo lo status (già review_manager/review_ceo) — resta
    // coerente per tutta la run così submit_review passa al primo colpo (fix
    // bug e248a568); il marcatore di lavorazione è dispatched:true. Passare
    // di nuovo lo stesso status di review ri-triggererebbe i side-effect di
    // updateTask (reset di workerId/gateRejection/dispatchAttempts). Lavoro
    // normale: in_progress come prima.
    ...(isReview ? {} : { status: 'in_progress' }),
    assignedTo: `agent:${agent.id}`,
    dispatched: true,
    dispatchedFrom: task.status, // per rimetterla lì se la run di lavoro fallisce
    dispatchAttempts: attempts,
    // Il reminder "consegna esplicita" (task 212d9b82) è già stato iniettato
    // nel prompt sopra (dispatchFor -> taskPrompt legge il flag): one-shot,
    // non deve restare acceso sui prossimi giri dopo che questo è partito.
    pendingDeliveryReminder: false,
    note: isReview
      ? `in review (${agent.name}, livello ${task.status === 'review_manager' ? 'manager' : 'CEO'}), lancio ${attempts}/${MAX_DISPATCH_ATTEMPTS}`
      : `in lavorazione autonoma (${agent.name}), lancio ${attempts}/${MAX_DISPATCH_ATTEMPTS}`,
  }, 'dispatcher');
  const sessionId = `task-${task.id.slice(0, 8)}-${Date.now()}`;
  logAudit({
    user: 'dispatcher', tenant: tenant.id, agent: agent.id,
    event: isReview ? 'task_review_dispatched' : 'task_dispatched',
    detail: { taskId: task.id, urgency: task.urgency, sessionId, attempt: attempts, revision: task.status === 'revisione', reviewStage: isReview ? task.status : null },
  });
  // scheduleRun: se il cap globale di Agenti live è saturo il lancio va in
  // coda (priorità = urgenza della task) e riparte da solo — mai un fail.
  scheduleRun(runFn, {
    tenantId: tenant.id,
    agentId: agent.id,
    sessionId,
    message,
    username: 'dispatcher',
    source: 'dispatcher',
    taskId: task.id,
    urgency: task.urgency,
    // Riassunto breve mostrato in "Agenti live": il titolo della task (per le
    // fasi di review lo prefissiamo, così si distingue dal lavoro vero e
    // proprio). Il server lo tronca a ~10 parole (summarizeRunTitle).
    runTitle: isReview
      ? `${task.status === 'review_manager' ? '🧭 Review' : '🌟 Review'}: ${task.title}`
      : task.title,
  }).catch((err) => {
    // L'errore è già nel journal (interrupted): watchdog e reconcile fanno il resto.
    console.error(`[dispatcher] run task ${task.id} (${tenant.id}):`, err.message);
  });
}

// Lancia le task eleggibili del tenant nei limiti di concorrenza: slot liberi
// (cap per tenant), nessuna run interattiva in corso (ha precedenza), poi in
// ordine di urgenza fino a saturare gli slot.
function launchEligibleTasks(tenant, ceo, tenantRuns, budgetPolicy, runFn) {
  const occupied = tenantRuns.filter((r) => r.source === 'dispatcher' && SLOT_OCCUPYING_STATES.includes(r.status)).length;
  let slots = autonomyLimitFor(tenant.id) - occupied;
  if (slots <= 0) return;
  // Precedenza alle run interattive: se un utente sta lavorando in chat nel
  // tenant, questo tick non lancia nulla (si riprova al prossimo).
  const interactiveBusy = tenantRuns.some((r) => !SYSTEM_SOURCES.includes(r.source) && r.username !== 'scheduler' && INTERACTIVE_ACTIVE_STATES.includes(r.status));
  if (interactiveBusy) return;

  const eligible = eligibleTasksFor(tenant, budgetPolicy);
  for (const task of eligible) {
    if (slots <= 0) break;
    slots -= 1;
    dispatchTask(tenant, task, ceo, runFn);
  }
}

// Tenant per cui abbiamo già loggato lo skip da blocco (task 6116efe1): evita
// di riempire l'audit a ogni tick. Azzerato quando il tenant torna non-bloccato.
const blockSkipLogged = new Set();

// runFn = runAgentTurn (iniettata da index.js); notify(tenantId, payload) = push.
export function dispatcherTick({ tenants, runFn, notify }) {
  // Policy budget-aware valutata UNA volta per tick: il budget della finestra
  // Max è globale di piattaforma (quota condivisa da tutti i tenant), non
  // per-tenant. budgetHaltLogged evita di riempire l'audit quando siamo al muro.
  const budgetPolicy = computeBudgetPolicy();
  let budgetHaltLogged = false;
  for (const tenant of tenants) {
    const ceo = tenant.agents.find((a) => a.role === 'CEO');
    if (!ceo) continue;

    // Kill switch PER-TENANT (task 6116efe1): tenant bloccato → il dispatcher
    // NON tocca affatto questo tenant. Salta TUTTO il corpo (reconcile,
    // auto-skip del gate, launch): nessun dispatch di task, nessun
    // auto-avanzamento del quality gate (review_manager → review_ceo), e —
    // scelta deliberata — nemmeno il reconcile, così le run fermate al
    // block-time (requisito 5) NON bruciano dispatchAttempts né mandano la
    // task in fallimento (requisito 3: "le task restano nel loro stato").
    // Al POST /unblock il tick riprende e reconcilia da solo, senza restart.
    // Log una sola volta per episodio di blocco (blockSkipLogged), non a ogni
    // tick (sarebbe spam nell'audit): l'entry si azzera quando il tenant torna
    // non-bloccato, così un blocco successivo rilogga.
    if (isTenantBlocked(tenant.id)) {
      if (!blockSkipLogged.has(tenant.id)) {
        logAudit({ user: 'dispatcher', tenant: tenant.id, event: 'tenant_blocked_skip', detail: { reason: 'tenant blocked' } });
        blockSkipLogged.add(tenant.id);
      }
      continue;
    }
    blockSkipLogged.delete(tenant.id);

    const tenantRuns = listRuns(tenant.id);
    const tasks = listTasks(tenant.id);

    reconcileDispatchedTasks(tenant, ceo, tenantRuns, tasks, notify);
    autoSkipEmptyGateLevels(tenant, ceo);
    // Task 212d9b82, poi 81ea4965: reti di sicurezza aggiuntive, gratuite (nessuna
    // run) — reset automatico del blocco tecnico dopo il raffreddamento (mai
    // needs_input senza domanda), e recupero delle task "in_progress" orfane
    // (mai più bloccate per sempre).
    resetExhaustedDispatch(tenant);
    requeueOrphanInProgress(tenant);
    // Task 66ea084a: rete di sicurezza per le task esaurite lasciate in uno stato
    // dispatchable da reconcileFailedRun/reconcileIncompleteReview (mai più
    // invisibili al filtro di eleggibilità). Prima di resetExhaustedDispatch al
    // prossimo tick, così il ciclo blocco tecnico → cooldown → reset le recupera.
    rescueExhaustedDispatchable(tenant);

    // Kill switch globale (task 16fb8517): piattaforma in pausa → non lanciare
    // NULLA di nuovo. Come per il muro Claude, le task eleggibili restano
    // todo/revisione (mai marcate in_progress: il criterio di done esige
    // "la task resta todo"), NON falliscono, non si perdono. Reconcile e
    // auto-skip del gate sopra restano attivi: le run già in corso finiscono il
    // loro giro e vengono riconciliate. Al resume il tick riprende normalmente.
    if (isPlatformPaused()) continue;
    // Muro del limite Claude attivo (task ca71d849): non lanciare nuovo lavoro
    // (le task restano in todo/revisione, non le marchiamo nemmeno in_progress).
    // Reconcile e auto-skip del gate sopra restano attivi. Al reset il tick
    // riprende normalmente e ordina per urgenza come sempre (requisito 4).
    if (isRateLimited()) continue;
    // Policy budget-aware (task b8b98175, requisito B.4): al muro stimato del
    // budget (residuo <HALT%) ci fermiamo in modo ordinato PRIMA di sbatterci
    // sul limite reale — niente nuovi lanci, le task in coda aspettano il reset
    // con l'auto-ripresa (come per isRateLimited). Sotto le altre soglie il
    // filtro budgetAllowsLaunch restringe cosa parte (solo critiche, o solo
    // review per riservare il margine al gate). Il budget è globale di
    // piattaforma (quota Max condivisa): stessa policy per ogni tenant.
    if (budgetPolicy.shouldHaltAll) {
      if (!budgetHaltLogged) {
        logAudit({ user: 'dispatcher', event: 'budget_halt', detail: { pctRemaining: budgetPolicy.pctRemaining, pctRemainingRaw: budgetPolicy.pctRemainingRaw } });
        budgetHaltLogged = true;
      }
      continue;
    }
    launchEligibleTasks(tenant, ceo, tenantRuns, budgetPolicy, runFn);
  }
}
