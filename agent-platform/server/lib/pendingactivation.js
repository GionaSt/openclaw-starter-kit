// "Done" != "live" — superficie SERVER (task madre 61aea764, questa task 2e6fb2e5).
// Il processo Node carica i moduli ESM UNA VOLTA al boot (server/index.js,
// BOOT_TIME). Una task marcata "done" può toccare file server/** che restano
// SOLO su disco finché non arriva un restart: il codice vivo continua a
// ignorare il fix/feature, e Owner/il CEO non hanno modo di saperlo senza
// controllare a mano `ps`/mtime. Due funzioni, stesso pattern deterministico e
// a zero-LLM di lib/autorecover.js:
//   1. listPendingActivation — quali task "done" hanno file server/** più
//      recenti del boot (coda "Da attivare", esposta in concurrencyView/digest).
//   2. runObsoleteAskSweep    — chiude da sola le ask a Owner la cui premessa
//      "serve un restart per attivare X" è deterministicamente decaduta (i file
//      citati sono ORMAI tutti più vecchi del boot corrente: un restart li ha
//      già caricati, l'ask non ha più senso).
//
// Design conservativo (mai rispondere per conto di Owner a un'ask ancora
// valida): dati insufficienti (nessun file server/** noto tra touchedFiles ∪
// ask.activationFiles) -> si presume NON decaduta, si lascia intatta. Meglio un
// falso negativo (ask non chiusa, resta visibile a Owner) che un falso positivo
// (auto-close di una decisione ancora aperta).
//
// Funzioni pure, statFn/deps iniettabili -> testabili senza I/O reale e a zero
// quota (vedi scripts/pending-activation-check.mjs).
import { statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { listTasks, updateTask } from './tasks.js';
import { touchedFilesForTask } from './runs.js';
import { logAudit } from './audit.js';
import { addTaskMessage } from './taskchat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// server/lib/pendingactivation.js -> server/lib -> server -> repo root.
export const REPO_ROOT = dirname(dirname(__dirname));

export const PLATFORM_TENANT = 'platform';
// Cap difensivo sulla lista esposta in concurrencyView/digest (task board:
// "cap ~25"): la piattaforma resta operativa anche se si accumulassero molte
// task done non ancora live, qui è solo osservabilità, non deve esplodere.
export const PENDING_LIST_CAP = 25;
// Premessa "serve un restart" citata nell'ask: regex conservativa. Falso
// negativo (non riconosce una premessa di restart scritta in modo insolito) è
// accettabile; un falso positivo (matcha testo che non parla di restart)
// rischierebbe di guardare file irrilevanti, ma comunque non chiude nulla se
// la condizione sui file non è soddisfatta — doppia guardia.
export const RESTART_PREMISE_RE = /riavvi|restart|ripart|caricare le route|per attivare/i;
// File server sorgente eseguibile: stessa portata di server/** guardata dal
// check "commit-before-gate" (runs.js toTrackedRepoPath) ristretta a server/ e
// alle estensioni che il processo Node carica davvero (esclude json/config,
// coerente con newestLibMtime in index.js).
const SERVER_JS_RE = /^server\/.*\.(m?js)$/;

// Stat di default: path repo-relative (es. "server/lib/x.js") -> assoluto
// sotto REPO_ROOT. Iniettabile nei test (statFn(path) -> {mtimeMs}) per zero
// I/O reale e indipendenza dal working tree di chi lancia il check.
export function defaultStatFn(path) {
  return statSync(join(REPO_ROOT, path));
}

// Filtra `files` (repo-relative) a quelli sotto server/** con estensione
// eseguibile e mtime > bootTimeMs. statFn può lanciare (file rinominato/
// cancellato dopo il commit): trattato come "non rilevante", mai un crash.
export function serverFilesNewerThanBoot(files, bootTimeMs, statFn = defaultStatFn) {
  const out = [];
  for (const f of files ?? []) {
    if (!SERVER_JS_RE.test(f)) continue;
    let st;
    try { st = statFn(f); } catch { continue; }
    const mtimeMs = st?.mtimeMs;
    if (typeof mtimeMs === 'number' && mtimeMs > bootTimeMs) out.push({ path: f, mtimeMs });
  }
  return out;
}

// Una task è "pending activation" se ALMENO un file server/** tra quelli
// toccati è più recente del boot del processo vivo: il codice caricato in
// memoria non lo vede ancora, a prescindere da quanti file "vecchi" ci siano.
export function computePendingActivation(touchedFiles, bootTimeMs, statFn = defaultStatFn) {
  const files = serverFilesNewerThanBoot(touchedFiles, bootTimeMs, statFn);
  return { pending: files.length > 0, files };
}

// Scandisce le task "done" di TUTTI i tenant passati e ritorna quelle il cui
// codice server non è ancora live (coda "Da attivare"). Cap difensivo: oltre
// PENDING_LIST_CAP smette di aggiungere (osservabilità, non deve rallentare
// l'endpoint su board molto grandi).
// deps iniettabili per i test: { listTasks, touchedFilesForTask, statFn, cap }.
export function listPendingActivation(tenants, bootTimeMs, deps = {}) {
  const listTasksFn = deps.listTasks ?? listTasks;
  const touchedFn = deps.touchedFilesForTask ?? touchedFilesForTask;
  const statFn = deps.statFn ?? defaultStatFn;
  const cap = deps.cap ?? PENDING_LIST_CAP;
  const out = [];
  for (const tenant of tenants ?? []) {
    for (const task of listTasksFn(tenant.id)) {
      if (task.status !== 'done') continue;
      const touched = touchedFn(tenant.id, task.id);
      if (!touched?.length) continue; // niente tracciato -> non sappiamo, non segnaliamo
      const { pending, files } = computePendingActivation(touched, bootTimeMs, statFn);
      if (!pending) continue;
      out.push({ tenant: tenant.id, taskId: task.id, title: task.title, files: files.map((f) => f.path) });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// ---- Auto-close ask "serve un restart" decadute ----------------------------

// File server/** che un restart deve caricare per soddisfare un'ask "serve un
// restart per attivare X". DUE fonti, unite e deduplicate (task df2247a9):
//  1) touchedFilesForTask(tenantId, taskId): i file che le run DI QUESTA task
//     hanno scritto — fonte primaria, automatica.
//  2) task.ask.activationFiles: elenco ESPLICITO di path repo-relative dichiarato
//     da chi apre l'ask (ipotesi (a)). Serve quando il file è stato committato da
//     UN'ALTRA task senza legame blockedBy/touchedFiles (caso ed218e53:
//     server/lib/ceomail.js committato da a5a5e758) — senza questo dato l'ask
//     resta non valutabile e quindi mai decaduta. Preferito su (b) blockedBy e
//     (c) matching del path nel testo dell'ask: entrambe fragili qui (ed218e53
//     NON ha blockedBy verso a5a5e758; il testo dell'ask non contiene il path
//     esatto e la descrizione cita anzi path irrilevanti). Un campo esplicito è
//     il dato deterministico più semplice e non introduce euristiche fragili.
// Filtrati a server/**.(m)js: web/, json e path malformati vengono ignorati.
export function restartAskServerFiles(task, touchedFilesFn, tenantId) {
  const touched = (touchedFilesFn ?? touchedFilesForTask)(tenantId, task?.id) ?? [];
  const declared = Array.isArray(task?.ask?.activationFiles) ? task.ask.activationFiles : [];
  const out = [];
  const seen = new Set();
  for (const f of [...touched, ...declared]) {
    if (typeof f === 'string' && SERVER_JS_RE.test(f) && !seen.has(f)) { seen.add(f); out.push(f); }
  }
  return out;
}

// true SOLO se la premessa "serve un restart per attivare X" è deterministicamente
// decaduta:
//  - status 'needs_input' con un ask valorizzato,
//  - la premessa cita esplicitamente un restart (regex sopra) in goal/question/context,
//  - la task ha ALMENO un file server/** REALE tra touchedFiles ∪ ask.activationFiles
//    (altrimenti non sappiamo a cosa si riferisca l'ask -> NON decaduta, intatta),
//  - NESSUNO di quei file è più recente del boot corrente (= sono già tutti
//    stati caricati da un restart successivo alla loro scrittura).
export function isRestartAskDecayed(task, bootTimeMs, statFn, touchedFilesFn, tenantId) {
  if (task.status !== 'needs_input' || !task.ask) return false;
  const askText = [task.ask.goal, task.ask.question, task.ask.context].filter(Boolean).join('\n');
  if (!RESTART_PREMISE_RE.test(askText)) return false;
  const serverFiles = restartAskServerFiles(task, touchedFilesFn, tenantId);
  if (!serverFiles.length) return false; // non sappiamo quali file riguardi -> non tocchiamo
  const resolveStat = statFn ?? defaultStatFn;
  // Guardia esistenza: un file DICHIARATO in activationFiles ma inesistente
  // (typo, file rinominato) NON deve valere come "già caricato" e far scattare
  // una chiusura -> lo scartiamo. Se dopo lo scarto non resta alcun file reale,
  // il dato è inaffidabile -> conservativo: NON decaduta.
  const existing = serverFiles.filter((f) => { try { resolveStat(f); return true; } catch { return false; } });
  if (!existing.length) return false;
  const newer = serverFilesNewerThanBoot(existing, bootTimeMs, resolveStat);
  return newer.length === 0; // nessun file ancora "da attivare" -> premessa decaduta
}

// Stato lavorabile a cui tornare: stesso criterio semplice di autorecover.js
// (recoveryTargetFor), senza la variante gate_exhausted — qui il blocco non è
// una bocciatura del gate, è un'ask la cui premessa è decaduta da sola.
function reopenTarget(task) {
  return ['todo', 'revisione'].includes(task.dispatchedFrom) ? task.dispatchedFrom : 'todo';
}

const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

// System job (registrato in index.js, stesso pattern di runAutoRecover): per
// ogni ask "serve un restart per attivare X" la cui premessa è decaduta, la
// chiude da sola (status -> lavorabile, ask: null, nota + audit + messaggio
// in task). NON tocca ask ancora valide: isRestartAskDecayed è la ownly guardia
// e resta conservativa (vedi sopra). deps iniettabili per i test:
// { listTasks, updateTask, touchedFilesForTask, logAudit, addTaskMessage, statFn }.
export function runObsoleteAskSweep({ tenants, bootTimeMs, now = Date.now(), statFn = defaultStatFn, deps = {} }) {
  const listTasksFn = deps.listTasks ?? listTasks;
  const updateTaskFn = deps.updateTask ?? updateTask;
  const touchedFn = deps.touchedFilesForTask ?? touchedFilesForTask;
  const logAuditFn = deps.logAudit ?? logAudit;
  const addTaskMessageFn = deps.addTaskMessage ?? addTaskMessage;
  const AUTHOR = 'system:pending-activation-sweep';

  let closed = 0;
  for (const tenant of tenants ?? []) {
    for (const task of listTasksFn(tenant.id)) {
      if (!isRestartAskDecayed(task, bootTimeMs, statFn, touchedFn, tenant.id)) continue;
      const files = restartAskServerFiles(task, touchedFn, tenant.id);
      const target = reopenTarget(task);
      const note = `Auto-close: premessa "serve restart per attivare X" decaduta (boot ${hhmm(bootTimeMs)} > mtime file ${files.join(', ')}) — task rimessa lavorabile.`;
      updateTaskFn(tenant.id, task.id, { status: target, ask: null, note }, AUTHOR);
      logAuditFn({
        user: AUTHOR, tenant: tenant.id, event: 'ask_premise_decayed_autoclosed',
        detail: { taskId: task.id, title: task.title, files, bootTime: new Date(bootTimeMs).toISOString() },
      });
      addTaskMessageFn(tenant.id, task.id, { author: AUTHOR, authorName: 'Sistema', text: note });
      closed += 1;
    }
  }
  if (closed) {
    logAuditFn({ user: AUTHOR, tenant: PLATFORM_TENANT, event: 'pending_activation_sweep_run', detail: { closed, now } });
  }
  return { closed };
}
