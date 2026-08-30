// Agenti schedulati: data/schedules.json {id, cron, tenantId, agentId, prompt, enabled}.
// Scheduler in-process senza dipendenze: tick ogni 20s, al massimo una run per minuto
// per schedulazione. Ogni run crea una sessione normale, visibile in "Agenti attivi".
import { randomUUID } from 'crypto';
import { join } from 'path';
import { readJson, writeJson, DATA_DIR } from './store.js';
import { parseCron, cronMatches, isValidCron } from './cron.js';
import { logAudit } from './audit.js';
import { scheduleRun } from './concurrency.js';

const SCHEDULES_FILE = join(DATA_DIR, 'schedules.json');

let schedules = readJson(SCHEDULES_FILE, []);
const persist = () => writeJson(SCHEDULES_FILE, schedules);

export function listSchedules(tenantId) {
  return schedules.filter((s) => !tenantId || s.tenantId === tenantId);
}

// ---- System job: schedulazioni cron interne che eseguono una funzione JS in
// process invece di far partire una run LLM (es. il backup delle 04:00). Girano
// sullo STESSO tick e con la stessa dedup al minuto degli agenti schedulati:
// riusano il motore Schedules senza sprecare una run agente per un cron di sistema.
const systemJobs = []; // { cron, name, fn, enabled, lastMinute }

export function registerSystemJob({ cron, name, fn, enabled = true }) {
  if (!isValidCron(cron)) throw new Error(`espressione cron non valida per il system job ${name}`);
  if (typeof fn !== 'function') throw new Error('fn del system job richiesta');
  systemJobs.push({ cron, name, fn, enabled: enabled !== false, lastMinute: null });
}

// Elenco dei system job registrati (nome + cron), per l'endpoint admin che li
// lista/triggera manualmente. Il "name" è l'id stabile del job.
export function listSystemJobs() {
  return systemJobs.map((j) => ({ name: j.name, cron: j.cron, enabled: j.enabled !== false }));
}

// Lettura di un singolo system job (usata dall'API generica agent-jobs, task
// c5ff7ad3, per leggere cron/enabled correnti prima di calcolare la prossima
// esecuzione). null se non registrato.
export function getSystemJob(name) {
  const job = systemJobs.find((j) => j.name === name);
  return job ? { name: job.name, cron: job.cron, enabled: job.enabled !== false } : null;
}

// Riprogrammazione A CALDO di un system job già registrato: muta cron/enabled
// in place, effettivo dal tick successivo (max 20s) — nessun secondo timer da
// riavviare, il tick condiviso legge sempre job.cron/job.enabled correnti.
// Usata dall'API generica agent-jobs (task c5ff7ad3) per code-quality,
// pm-platform e futuri job configurabili da UI senza restart del server.
export function updateSystemJob(name, { cron, enabled } = {}) {
  const job = systemJobs.find((j) => j.name === name);
  if (!job) throw new Error(`system job non trovato: ${name}`);
  if (cron !== undefined) {
    if (!isValidCron(cron)) throw new Error('espressione cron non valida');
    job.cron = cron;
  }
  if (enabled !== undefined) job.enabled = Boolean(enabled);
  return { name: job.name, cron: job.cron, enabled: job.enabled !== false };
}

// Esecuzione immediata di un system job by id (name), fuori dal cron: STESSO
// codice del tick schedulato (job.fn), ma source distinguibile nel journal
// (audit event system_job_run con detail.source='manual'). Ritorna la promise
// del job così il chiamante può, se vuole, attenderne l'esito; l'endpoint
// admin risponde subito (fire-and-forget) come fa il tick del cron.
export function runSystemJobNow(name, { source = 'manuale', user = null } = {}) {
  const job = systemJobs.find((j) => j.name === name);
  if (!job) throw new Error(`system job non trovato: ${name}`);
  const now = new Date();
  logAudit({ user, tenant: 'platform', event: 'system_job_run', detail: { name: job.name, source } });
  return runJobSafely(job, now);
}

// Invariante (task e7422c02): OGNI invocazione di job.fn() che sfugge ai
// guardrail interni del job stesso (budget/singleton/pausa — già journalizzati
// dentro fn come '<job>_skip' o 'job_singleton_skip'/'job_paused_skip') deve
// comunque finire nel journal audit, MAI solo in console.error. Prima di questo
// fix il tick chiamava `job.fn(now).catch(err => console.error(...))`: un'
// eccezione (findAgent fallito, spawn in errore, qualunque throw pre-journal)
// spariva nel nulla — system_job_run risultava loggato ma senza alcun esito
// tracciato (run né skip), lo scatto "orfano" diagnosticato dall'evidenza
// (pm-platform 26/27-07, code-quality 27-07, digest 26-07). Punto unico
// riusato da tick cron e run-now manuale, così nessuno dei due percorsi può
// perdere l'errore.
function runJobSafely(job, now) {
  return Promise.resolve()
    .then(() => job.fn(now))
    .catch((err) => {
      console.error(`[scheduler] system job ${job.name} fallito:`, err.message);
      logAudit({
        user: job.name, tenant: 'platform', event: 'system_job_error',
        detail: { name: job.name, reason: 'error', message: err.message },
      });
    });
}

export function createSchedule({ cron, tenantId, agentId, prompt, enabled = true }, createdBy) {
  if (!isValidCron(cron)) throw new Error('espressione cron non valida (5 campi, es. "0 8 * * 1-5")');
  if (!prompt?.trim()) throw new Error('prompt richiesto');
  const schedule = {
    id: randomUUID(),
    cron,
    tenantId,
    agentId,
    prompt: prompt.trim(),
    enabled: Boolean(enabled),
    createdBy,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
  };
  schedules.push(schedule);
  persist();
  logAudit({ user: createdBy, tenant: tenantId, agent: agentId, event: 'schedule_created', detail: { id: schedule.id, cron } });
  return schedule;
}

export function updateSchedule(id, patch, updatedBy) {
  const s = schedules.find((x) => x.id === id);
  if (!s) throw new Error('schedulazione non trovata');
  if (patch.cron !== undefined) {
    if (!isValidCron(patch.cron)) throw new Error('espressione cron non valida');
    s.cron = patch.cron;
  }
  if (patch.prompt !== undefined && patch.prompt.trim()) s.prompt = patch.prompt.trim();
  if (patch.enabled !== undefined) s.enabled = Boolean(patch.enabled);
  persist();
  logAudit({ user: updatedBy, tenant: s.tenantId, agent: s.agentId, event: 'schedule_updated', detail: { id, enabled: s.enabled } });
  return s;
}

export function deleteSchedule(id, deletedBy) {
  const s = schedules.find((x) => x.id === id);
  if (!s) throw new Error('schedulazione non trovata');
  schedules = schedules.filter((x) => x.id !== id);
  persist();
  logAudit({ user: deletedBy, tenant: s.tenantId, agent: s.agentId, event: 'schedule_deleted', detail: { id } });
  return s;
}

// runFn({tenantId, agentId, sessionId, message, username}) — iniettata da index.js.
// onTick (opzionale): callback eseguita a ogni tick, usata dal watchdog delle
// run interrotte (stesso battito dello scheduler, nessun secondo timer).
export function startScheduler(runFn, onTick, { runLegacySchedules = true } = {}) {
  const timer = setInterval(() => {
    try { onTick?.(); } catch (err) { console.error('[watchdog] tick fallito:', err.message); }
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
    for (const s of runLegacySchedules ? schedules : []) {
      if (!s.enabled || s.lastMinute === minuteKey) continue;
      let matches = false;
      try { matches = cronMatches(parseCron(s.cron), now); } catch { continue; }
      if (!matches) continue;
      s.lastMinute = minuteKey;
      s.lastRunAt = now.toISOString();
      persist();
      const sessionId = `sched-${s.id.slice(0, 8)}-${now.toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
      logAudit({ user: 'scheduler', tenant: s.tenantId, agent: s.agentId, event: 'schedule_run', detail: { id: s.id, sessionId } });
      // scheduleRun: rispetta anch'essa il cap globale di Agenti live, in coda
      // se saturo (mai un fail, riparte da sola al primo slot libero).
      scheduleRun(runFn, {
        tenantId: s.tenantId,
        agentId: s.agentId,
        sessionId,
        message: s.prompt,
        username: 'scheduler',
        source: 'schedule',
      }).catch((err) => {
        console.error(`[scheduler] run ${s.id} fallita:`, err.message);
        // Stesso invariante dei system job (vedi runJobSafely più sotto):
        // un'eccezione qui non deve sparire, altrimenti lo scatto della
        // schedulazione risulta "orfano" (schedule_run loggato, nessuna run).
        logAudit({
          user: 'scheduler', tenant: s.tenantId, agent: s.agentId, event: 'schedule_run_error',
          detail: { id: s.id, reason: 'error', message: err.message },
        });
      });
    }
    // System job (backup ecc.): stessa dedup al minuto, esecuzione in process.
    for (const job of systemJobs) {
      if (job.enabled === false) continue; // in pausa (agent-jobs API): non schedula ma resta registrato
      if (job.lastMinute === minuteKey) continue;
      let matches = false;
      try { matches = cronMatches(parseCron(job.cron), now); } catch { continue; }
      if (!matches) continue;
      job.lastMinute = minuteKey;
      logAudit({ user: 'scheduler', tenant: 'platform', event: 'system_job_run', detail: { name: job.name, source: 'schedule' } });
      runJobSafely(job, now);
    }
  }, 20000);
  timer.unref?.();
  return timer;
}
