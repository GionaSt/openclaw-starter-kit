// Cap globale di agenti attivi in tutta la piattaforma (decisione Owner,
// sprint concorrenza): agganciato al selettore "agenti paralleli" di Agenti
// live. I lanci AUTONOMI (dispatcher task board, agenti schedulati via cron,
// check periodico CEO) passano da scheduleRun() invece di chiamare runFn
// direttamente: se il numero di run attive su TUTTI i tenant (comprese le
// run esterne registrate via /api/runs/register, governance.md) ha già
// raggiunto il cap, il lancio NON fallisce — entra in coda FIFO con
// priorità di urgenza e riparte da solo al primo slot libero (drainQueue,
// richiamata dal tick unico dello scheduler ogni 20s, più subito dopo ogni
// variazione del cap per un effetto immediato quando lo si alza).
//
// La chat interattiva (utente che parla con un agente) NON passa da qui:
// resta sempre immediata, il cap regola solo gli spawn autonomi ("i manager
// spawnano operativi liberamente, ma il totale attivo resta sotto il cap").
//
// Coda SOLO in memoria (non persistita su disco): i chiamanti (dispatcher/
// scheduler/board-check) ri-derivano il lavoro da fare dal loro stato
// sorgente (task board, schedules.json) a ogni tick, quindi un riavvio del
// server la ricostruisce da sola invece di rischiare doppi lanci da una
// coda stantia serializzata.
import { join } from 'path';
import { readJson, writeJson, DATA_DIR } from './store.js';
import { listRuns } from './runs.js';
import { urgencyRank } from './tasks.js';
import { isRateLimited } from './ratelimit.js';
import { isWeeklyBudgetHalted } from './weeklybudget.js';
import { isPlatformPaused } from './platformpause.js';
import { isTenantBlocked } from './tenantblock.js';
import {
  hasMemoryHeadroom, readMemoryStatus, reserveSpawnMemory, reservedSpawnMb,
} from './mem.js';
import { SLOT_OCCUPYING_STATES } from './runstates.js';
import { activeJobRun, humanDuration } from './jobsingleton.js';
import { logAudit } from './audit.js';

const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

export const GLOBAL_CAP_MIN = 1;
export const GLOBAL_CAP_MAX = 50;
export const GLOBAL_CAP_FACTORY_DEFAULT = 2;

function load() {
  return readJson(SETTINGS_FILE, {});
}

function validCap(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= GLOBAL_CAP_MIN && n <= GLOBAL_CAP_MAX ? n : null;
}

export function getGlobalCap() {
  return validCap(load().globalAgentCap) ?? GLOBAL_CAP_FACTORY_DEFAULT;
}

let onCapChange = null;
export function setCapChangeListener(fn) { onCapChange = fn; }

export function setGlobalCap(v) {
  const n = validCap(v);
  if (n === null) throw new Error(`il cap deve essere un intero tra ${GLOBAL_CAP_MIN} e ${GLOBAL_CAP_MAX}`);
  const all = load();
  all.globalAgentCap = n;
  writeJson(SETTINGS_FILE, all);
  onCapChange?.(n);
  return n;
}

// Stati che "occupano" un agente nel conteggio globale: chi sta girando ora
// (running/resumed) o tornerà a girare da solo senza un nuovo spawn
// (interrupted in attesa di retry, paused) — stessa logica già usata dal
// dispatcher per i limiti per-tenant (SLOT_OCCUPYING_STATES, runstates.js:
// fonte unica, task 81c7bbc8). Le run esterne (journalRegisterExternal)
// condividono lo stesso journal e hanno anch'esse status "running": rientrano
// già qui (requisito 5).

// Il conteggio globale = run journaled attive (dispatcher, chat, cron, esterne)
// PIÙ i sub-agenti in volo (vedi sotto): la chat passa da runAgentTurn →
// journalStart, quindi ha già una entry "running" ed è contata qui; i sub-
// agenti no (li spawna il claude-cli figlio, fuori dal journal) e vanno sommati
// a parte perché consumano RAM come una run vera (task 19577ebf).
export function activeAgentCount() {
  return listRuns().filter((r) => SLOT_OCCUPYING_STATES.includes(r.status)).length
    + activeSubAgentCount();
}

// --- Sub-agenti in volo (task 19577ebf) ---
// Spawn via tool "Task"/"Agent" DENTRO una run SDK (un manager/dev che fa
// fan-out di operativi). NON hanno una entry nel journal — li lancia il processo
// claude-cli figlio, non runAgentTurn — quindi bypassavano del tutto cap e
// memoria: un fan-out sfondava la RAM ignorando l'admission control (buco
// diagnosi ab256fba §4). Li contabilizziamo qui, per (runId, toolUseId):
// streamTurn (runturn/stream.js) chiama subAgentStart al tool_use e subAgentEnd
// al tool_result; runAgentTurnInner chiama subAgentEndRun nel finally per
// ripulire i residui se la run muore a metà fan-out. Registro solo in memoria:
// al riavvio i processi figli muoiono col padre, quindi non c'è nulla da
// persistere (come la coda).
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
export function isSubAgentTool(name) { return SUBAGENT_TOOLS.has(name); }

const subAgents = new Set(); // chiavi `${runId}:${toolUseId}`

export function subAgentStart(runId, toolUseId) {
  if (!runId || !toolUseId) return;
  const k = `${runId}:${toolUseId}`;
  if (subAgents.has(k)) return;
  subAgents.add(k);
  // Come per uno spawn autonomo: prenota la memoria del sub-agente in volo — il
  // suo RSS non è ancora cresciuto, così la prossima admission lo vede occupato
  // (anti thundering-herd, stesso meccanismo di scheduleRun).
  reserveSpawnMemory();
  onQueueChange?.();
}

export function subAgentEnd(runId, toolUseId) {
  if (subAgents.delete(`${runId}:${toolUseId}`)) onQueueChange?.();
}

// Cleanup di tutti i sub-agenti ancora aperti per una run che sta terminando
// (o che è morta prima di ricevere i tool_result): evita conteggi fantasma.
export function subAgentEndRun(runId) {
  let changed = false;
  const prefix = `${runId}:`;
  for (const k of subAgents) {
    if (k.startsWith(prefix)) { subAgents.delete(k); changed = true; }
  }
  if (changed) onQueueChange?.();
}

export function activeSubAgentCount() { return subAgents.size; }
// Solo per gli script di check: azzera il registro tra un caso e l'altro.
export function resetSubAgents() { subAgents.clear(); }

// Coda in-process: { id, tenantId, agentId, taskId, urgency, source, enqueuedAt, seq, run, deferReason }.
// "run" è la thunk che avvia realmente il lavoro (chiude su runFn + args).
// "deferReason" = perché NON è partito subito al momento dell'accodamento
// ('rate_limit' | 'cap' | 'memory' — task 16edce3a, requisito 3 di
// osservabilità): 'memory' quando il cap avrebbe dato via libera ma il
// margine di memoria libera del container era sotto soglia.
let queue = [];
let seq = 0;
let onQueueChange = null;
export function setQueueChangeListener(fn) { onQueueChange = fn; }

// Motivo per cui un nuovo spawn autonomo NON può partire ORA, o null se può
// partire. Un solo punto di ammissione condiviso da scheduleRun/drainQueue:
// il cap di Owner resta il tetto massimo (controllato per primo), la memoria
// può solo restringerlo ulteriormente, mai alzarlo oltre il cap.
// Esportata (task 9181275b, requisito 4 trasparenza): stesso identico motivo
// che decide se un nuovo spawn parte o va in coda, riusato dall'endpoint
// /api/settings/concurrency per dire a Owner IL PERCHÉ in una frase sola
// ("6 in coda, limite: memoria disponibile") invece di lasciarle dedurlo da
// più contatori (cap/active/memAvailableMb) senza un verdetto esplicito.
export function admissionBlockReason() {
  if (isRateLimited()) return 'rate_limit';
  if (isWeeklyBudgetHalted()) return 'weekly_budget';
  if (activeAgentCount() >= getGlobalCap()) return 'cap';
  if (!hasMemoryHeadroom()) return 'memory';
  return null;
}

// Etichette umane del motivo di blocco, in italiano, per l'UI (task 9181275b).
// null = nessun blocco: il prossimo spawn autonomo parte subito, se richiesto.
export const BLOCK_REASON_LABELS = {
  rate_limit: 'limite Claude raggiunto, in attesa del reset',
  weekly_budget: 'budget settimanale agenti raggiunto, in attesa del reset',
  cap: 'cap globale di agenti paralleli raggiunto',
  memory: 'memoria disponibile insufficiente per un altro agente',
};

// Vista sintetica della memoria per l'endpoint /api/settings/concurrency
// (task 16edce3a, requisito 3): quante run in coda sono lì SOLO per il
// margine di memoria (il cap le avrebbe fatte partire).
export function memoryView() {
  const { limitMb, currentMb, availableMb } = readMemoryStatus();
  return {
    memLimitMb: limitMb,
    memAvailableMb: availableMb,
    memCurrentMb: currentMb,
    memReservedMb: reservedSpawnMb(), // prenotato dagli spawn in volo (anti herd)
    deferredForMemory: queue.filter((q) => q.deferReason === 'memory').length,
  };
}

function sortQueue() {
  // Urgenza decrescente, poi FIFO (ordine di arrivo) a parità di urgenza.
  queue.sort((a, b) => {
    const d = urgencyRank(b.urgency) - urgencyRank(a.urgency);
    return d !== 0 ? d : a.seq - b.seq;
  });
}

// Vista pubblica della coda (per API/UI): senza la thunk, con la posizione
// (1 = il prossimo a partire).
export function queueSnapshot() {
  sortQueue();
  return queue.map(({ run, seq: _seq, ...rest }, i) => ({ ...rest, position: i + 1 }));
}

export function queueLength() { return queue.length; }
// Kill switch PER-TENANT (task 6116efe1): al block-time toglie dalla coda gli
// spawn in attesa di slot di quel tenant (non sono ancora run attive, quindi
// non passano per lo stop). Torna quanti item ha rimosso (per l'audit).
export function dropQueuedForTenant(tenantId) {
  let dropped = 0;
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].tenantId === tenantId) { queue.splice(i, 1); dropped += 1; }
  }
  if (dropped > 0) onQueueChange?.();
  return dropped;
}
// Usato dal dispatcher: una task già in coda per il cap globale non ha ancora
// un run nel journal, non va trattata come "run sparita = fallita" nel reconcile.
export function isQueued(taskId) {
  return taskId != null && queue.some((q) => q.taskId === taskId);
}
// Usato dal board-check: evita di accodare un secondo check per lo stesso
// tenant mentre il precedente aspetta ancora uno slot.
export function isTenantSourceQueued(tenantId, source) {
  return queue.some((q) => q.tenantId === tenantId && q.source === source);
}

// runFn = funzione che avvia davvero l'agente (es. runAgentTurn); args = i
// suoi parametri (può includere anche taskId/urgency/source, usati solo qui
// per la coda e ignorati da runAgentTurn). Non fallisce mai: o parte subito
// (stessa Promise di runFn, comportamento identico a prima), o entra in coda
// e ripartirà da sola (Promise già risolta per il chiamante fire-and-forget).
// Log dello skip singleton nel journal (audit) + console — così Owner vede che
// il job è VIVO ma saltato, non morto (requisito visibilità). L'evento finisce
// in `<source>_skip` (job_singleton_skip) così lastRunOutcome (agentjobs.js) lo
// mostra come esito "skipped_singleton" nella card del job.
function logSingletonSkip({ tenantId, agentId, source }, { where, elapsedMs = null, since = null }) {
  const msg = where === 'queue'
    ? `job ${source} saltato: istanza precedente ancora in coda in attesa di slot`
    : `job ${source} saltato: istanza precedente ancora in corso da ${humanDuration(elapsedMs)}`;
  console.log(`[singleton] ${msg}`);
  logAudit({
    user: source, tenant: tenantId, agent: agentId, event: 'job_singleton_skip',
    detail: { reason: 'singleton', where, elapsedMs, since, message: msg },
  });
}

export function scheduleRun(runFn, args) {
  // Kill switch globale (task 16fb8517): piattaforma in pausa → nessun nuovo
  // lancio AUTONOMO. Tutti gli spawn autonomi (dispatcher, cron/schedulati,
  // system job digest/code-quality/pm-platform, board-check) passano da qui:
  // un solo gate li ferma. NON accodiamo (eviteremmo un herd al resume ed è
  // semantica sbagliata per i cron: lo scatto saltato non si accumula, si
  // riparte al prossimo, come lo skip singleton) — skip pulito e non-fallimento.
  // La chat interattiva NON passa da qui: è gestita a parte in /api/chat.
  if (isPlatformPaused()) {
    // Skip journalizzato (task e7422c02): prima mancava del tutto — uno scatto
    // di job/schedule durante una pausa piattaforma si risolveva in silenzio
    // (nessuna run, nessun audit), indistinguibile da uno scatto perso per bug.
    // Stessa convenzione di logSingletonSkip: evento 'job_..._skip' con reason.
    if (args.source) {
      logAudit({
        user: args.source, tenant: args.tenantId ?? 'platform', agent: args.agentId ?? null,
        event: 'job_paused_skip', detail: { reason: 'paused' },
      });
    }
    return Promise.resolve({ skipped: true, reason: 'paused' });
  }
  // Kill switch PER-TENANT (task 6116efe1): tenant bloccato → nessun spawn
  // AUTONOMO per quel tenant (cron/schedulati, system job digest/code-quality/
  // pm-platform, board-check, spawn di operativi via dispatcher). Un solo gate
  // qui li ferma tutti. Skip pulito e journalizzato (non-fallimento), stessa
  // convenzione del pause globale. La chat al CEO NON passa da qui (gestita in
  // /api/chat con l'eccezione Owner→CEO). Il dispatcher salta già il tenant a
  // monte (non brucia tentativi); questo è il gate per gli altri spawn.
  if (args.tenantId && isTenantBlocked(args.tenantId)) {
    if (args.source) {
      logAudit({
        user: args.source, tenant: args.tenantId, agent: args.agentId ?? null,
        event: 'job_tenant_blocked_skip', detail: { reason: 'tenant blocked' },
      });
    }
    return Promise.resolve({ skipped: true, reason: 'tenant_blocked' });
  }
  // Singleton per job periodico (task 01ed5b8d): un solo agente attivo per chiave
  // (tenant+agent+source). Se ne esiste già uno in coda o running/occupante nel
  // journal, NON accodare nulla → skip loggato, nessun catch-up (lo scatto saltato
  // non si accumula, si riparte al prossimo). Guardia anti-impianto: una run
  // "attiva" oltre 3x la durata mediana è zombie e non blocca il nuovo scatto.
  if (args.singleton && args.source) {
    const key = { tenantId: args.tenantId, agentId: args.agentId, source: args.source };
    const queued = queue.some(
      (q) => q.source === key.source && q.tenantId === key.tenantId && q.agentId === key.agentId,
    );
    if (queued) {
      logSingletonSkip(key, { where: 'queue' });
      return Promise.resolve({ skipped: true, reason: 'singleton', where: 'queue' });
    }
    const inst = activeJobRun(key);
    if (inst.state === 'active') {
      logSingletonSkip(key, { where: 'run', elapsedMs: inst.elapsedMs, since: inst.run.startedAt });
      return Promise.resolve({ skipped: true, reason: 'singleton', where: 'run', elapsedMs: inst.elapsedMs });
    }
    if (inst.state === 'stale') {
      // Zombie oltre soglia: permetti il nuovo scatto, ma logga l'override così è
      // tracciato perché una run risultava "attiva" e non ha bloccato.
      logAudit({
        user: key.source, tenant: key.tenantId, agent: key.agentId, event: 'job_stale_override',
        detail: {
          runId: inst.run.id, elapsedMs: inst.elapsedMs, thresholdMs: inst.thresholdMs,
          message: `job ${key.source}: run precedente ${inst.run.id} marcata stale (attiva da ${humanDuration(inst.elapsedMs)} > ${humanDuration(inst.thresholdMs)}), nuovo scatto permesso`,
        },
      });
    }
  }
  // Muro del limite Claude attivo (task ca71d849) o cap saturo: NON partire,
  // accoda. Margine di memoria del container sotto soglia (task 16edce3a,
  // evidenza pm-platform: oom_kill 188, 3 run SIGKILL a 5/5 tentativi): stesso
  // trattamento, stessa coda — mai un lancio che il kernel ucciderebbe subito.
  // Al reset/liberazione slot/rientro memoria, drainQueue li fa ripartire per
  // urgenza. Non fallisce mai (requisito 3 ca71d849, esteso al 16edce3a).
  const block = admissionBlockReason();
  if (!block) {
    // Prenota la memoria dello spawn PRIMA di lanciarlo: la prossima lettura
    // di hasMemoryHeadroom() la vedrà già "occupata" anche se il RSS del
    // processo non è ancora cresciuto (anti thundering-herd, task ab256fba).
    reserveSpawnMemory();
    return runFn(args);
  }
  queue.push({
    id: `q-${seq}`,
    tenantId: args.tenantId,
    agentId: args.agentId,
    taskId: args.taskId ?? null,
    urgency: args.urgency ?? 'media',
    source: args.source ?? null,
    runTitle: args.runTitle ?? null,   // riassunto breve per la card "in attesa di slot"
    enqueuedAt: new Date().toISOString(),
    seq: seq++,
    deferReason: block,
    run: () => runFn(args),
  });
  onQueueChange?.();
  return Promise.resolve();
}

// Fa partire quanti più lanci in coda possibile finché c'è capienza sotto il
// cap. Chiamata dal tick unico dello scheduler (ogni 20s: stessa cadenza di
// dispatcher/watchdog/board-check) e subito dopo un innalzamento del cap, per
// un effetto immediato "a caldo" (requisito 4) invece di aspettare il tick.
export function drainQueue() {
  if (queue.length === 0) return;
  if (isPlatformPaused()) return; // kill switch globale (task 16fb8517): la coda aspetta il resume
  if (isRateLimited()) return; // muro Claude attivo: la coda aspetta il reset
  if (isWeeklyBudgetHalted()) return; // budget settimanale agenti: la coda aspetta il reset
  let started = false;
  sortQueue();
  // Scaglionamento (task ab256fba, intervento 3): ogni item ammesso prenota
  // RUN_MEM_ESTIMATE_MB via reserveSpawnMemory(), quindi admissionBlockReason()
  // vede subito meno memoria e la raffica si ferma da sola appena il margine
  // (al netto del prenotato) scende sotto soglia — gli spawn si distribuiscono
  // sui tick successivi invece di partire tutti nello stesso tick. Sotto il
  // solo vincolo del cap (memoria abbondante) drena fino al cap come prima.
  while (queue.length > 0 && !admissionBlockReason()) {
    // Kill switch PER-TENANT (task 6116efe1): al block-time dropQueuedForTenant
    // svuota già la coda del tenant, ma se un item fosse comunque presente non
    // lo lanciamo — lo scartiamo (non è una run attiva, non va fermata via
    // stop). Belt-and-suspenders: scheduleRun non accoda più item di un tenant
    // bloccato, quindi nel caso normale questo ramo non scatta.
    const idx = queue.findIndex((q) => !q.tenantId || !isTenantBlocked(q.tenantId));
    if (idx === -1) break; // in coda solo item di tenant bloccati: niente da drenare
    const item = queue.splice(idx, 1)[0];
    started = true;
    reserveSpawnMemory();
    item.run().catch((err) => {
      console.error('[concurrency] run in coda fallita:', err.message);
      // Stesso invariante di scheduler.js/runJobSafely: un lancio ripreso dalla
      // coda che fallisce PRIMA di journalStart (es. findAgent) non deve sparire
      // — altrimenti lo scatto originario (già in coda con un audit event) resta
      // senza esito tracciato una volta ripreso (task e7422c02).
      logAudit({
        user: item.source ?? 'scheduler', tenant: item.tenantId, agent: item.agentId,
        event: 'queued_run_error', detail: { reason: 'error', source: item.source, taskId: item.taskId, message: err.message },
      });
    });
  }
  if (started) onQueueChange?.();
}
