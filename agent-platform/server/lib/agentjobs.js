// API generica "agent job" (task board c5ff7ad3): job agente configurabili da
// UI a runtime, senza restart del server — cron/preset ed enabled (pausa),
// riprogrammati A CALDO sul system job condiviso (scheduler.js) e persistiti in
// config/platform.json. Design parametrico per jobId, estendibile a futuri job
// oltre ai due iniziali:
//   - code-quality (task aabd54ca): review qualità codice, 1x/giorno di default.
//   - pm-platform  (task 5352926c): manager proattivo, 1x/giorno di default.
// Un nuovo job agente si registra a boot con registerAgentJob({...}) e compare
// da solo in GET/PUT /api/agent-jobs: zero cambi all'endpoint.
import { join } from 'path';
import { readJson, writeJson, CONFIG_DIR } from './store.js';
import { isValidCron, nextRunAt, minGapMinutes } from './cron.js';
import { registerSystemJob, updateSystemJob, getSystemJob } from './scheduler.js';
import { listRuns } from './runs.js';
import { logAudit, readAuditEvents } from './audit.js';
import { findOrphanSystemJobRuns } from './jobhealth.js';

const PLATFORM_CONFIG_FILE = join(CONFIG_DIR, 'platform.json');

// Guardrail budget (requisito task): nessun job agente può girare più spesso
// di una volta ogni 3h, preset o cron custom che sia.
export const MIN_INTERVAL_HOURS = 3;
export const MIN_INTERVAL_MINUTES = MIN_INTERVAL_HOURS * 60;

// Preset esposti in UI: builder(opts) -> espressione cron. "hour"/"hours" per
// i preset a orario configurabile (default ragionevoli se omessi).
export const PRESETS = {
  daily: ({ hour } = {}) => `0 ${clampHour(hour, 5)} * * *`,
  twiceDaily: ({ hour, hour2 } = {}) => `0 ${clampHour(hour, 8)},${clampHour(hour2, 20)} * * *`,
  every6h: () => '0 */6 * * *',
  every3h: () => '0 */3 * * *',
};

function clampHour(h, fallback) {
  const n = Number.isInteger(h) ? h : parseInt(h, 10);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

// jobId -> { jobId, label, tenantId, agentId, configKey, defaultCron, extra }
const defs = new Map();

function readPlatformConfig() { return readJson(PLATFORM_CONFIG_FILE, {}); }
function writePlatformConfig(cfg) { writeJson(PLATFORM_CONFIG_FILE, cfg); }

// Registrazione a boot (index.js), una per job. cron/enabled iniziali letti da
// config/platform.json[configKey] (fallback a defaultCron/abilitato) — stessa
// fonte usata finora dai job hardcoded, così i valori esistenti non si perdono.
// `extra` opzionale: fn(now) -> oggetto merge-ato nella describeJob (es. per
// code-quality espone il focus del giorno corrente, task board 50494a0d).
export function registerAgentJob({ jobId, label, tenantId, agentId, configKey, defaultCron, defaultEnabled = true, fn, extra }) {
  if (defs.has(jobId)) throw new Error(`agent job già registrato: ${jobId}`);
  if (!isValidCron(defaultCron)) throw new Error(`defaultCron non valido per ${jobId}`);
  const saved = readPlatformConfig()[configKey] ?? {};
  const cron = isValidCron(saved.cron) ? saved.cron : defaultCron;
  const enabled = typeof saved.enabled === 'boolean' ? saved.enabled : defaultEnabled;
  registerSystemJob({ cron, name: jobId, fn, enabled });
  defs.set(jobId, { jobId, label, tenantId, agentId, configKey, defaultCron, defaultEnabled, extra });
}

export function listAgentJobDefs() {
  return Array.from(defs.keys());
}

export function listAgentJobs() {
  const now = new Date();
  return Array.from(defs.values()).map((def) => describeJob(def, now));
}

export function getAgentJob(jobId) {
  const def = defs.get(jobId);
  return def ? describeJob(def, new Date()) : null;
}

function describeJob(def, now) {
  const sys = getSystemJob(def.jobId) ?? { cron: def.defaultCron, enabled: def.defaultEnabled };
  let nextRun = null;
  if (sys.enabled) {
    try { nextRun = nextRunAt(sys.cron, now)?.toISOString() ?? null; } catch { nextRun = null; }
  }
  return {
    jobId: def.jobId,
    label: def.label,
    tenantId: def.tenantId,
    agentId: def.agentId,
    cron: sys.cron,
    enabled: sys.enabled,
    minIntervalHours: MIN_INTERVAL_HOURS,
    nextRunAt: nextRun,
    lastRun: lastRunOutcome(def),
    // Scatti senza esito tracciato (bug scheduler, task e7422c02) negli ultimi
    // 7 giorni per QUESTO job: dopo il fix deve restare sempre 0 — resta come
    // segnale visibile in card se una regressione lo riporta > 0.
    orphanScatti7d: findOrphanSystemJobRuns({ names: [def.jobId] }).length,
    ...(typeof def.extra === 'function' ? def.extra(now) : {}),
  };
}

// Esito ultima run del job: cerca nel journal run (lib/runs.js) l'ultima run
// dell'agente del job lanciata da questa infrastruttura (source === jobId,
// impostato dal fn del job via scheduleRun) E l'ultimo skip per budget (audit
// log: fn del job logga `user: jobId, event: '<prefisso>_skip'` PRIMA di
// scheduleRun quando salta — nessuna run journaled in quel caso, task board
// 50494a0d). Torna il più recente dei due, null se il job non ha mai girato.
function lastRunOutcome(def) {
  const candidates = listRuns(def.tenantId).filter(
    (r) => r.agentId === def.agentId && r.source === def.jobId,
  );
  let last = null;
  if (candidates.length) {
    candidates.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    const r = candidates[0];
    last = { status: r.status, startedAt: r.startedAt, updatedAt: r.updatedAt, runId: r.id };
  }

  const skips = readAuditEvents((e) => e.user === def.jobId && e.event?.endsWith('_skip'));
  const lastSkip = skips[skips.length - 1]; // append-only: l'ultimo è il più recente
  if (lastSkip && (!last || new Date(lastSkip.ts) > new Date(last.startedAt))) {
    // reason distingue lo skip per budget (finestra Max quasi esaurita) da quello
    // singleton (istanza precedente ancora in corso, task 01ed5b8d). Default
    // 'budget' per retro-compatibilità con gli eventi <job>_skip storici.
    const reason = lastSkip.detail?.reason ?? 'budget';
    return {
      status: `skipped_${reason}`,
      startedAt: lastSkip.ts,
      updatedAt: lastSkip.ts,
      runId: null,
      pctRemaining: lastSkip.detail?.pctRemaining ?? null,
      elapsedMs: lastSkip.detail?.elapsedMs ?? null,
    };
  }
  return last;
}

// PUT: preset (con eventuale orario) OPPURE cron esplicito, più enabled
// opzionale (pausa/riattiva indipendentemente dalla frequenza). Valida e
// applica il guardrail dei 3h minimi, riprogramma a caldo, persiste, audita.
export function updateAgentJob(jobId, { preset, hour, hour2, cron, enabled } = {}, updatedBy) {
  const def = defs.get(jobId);
  if (!def) throw new Error(`agent job non trovato: ${jobId}`);
  if (preset !== undefined && cron !== undefined) {
    throw new Error('passa preset OPPURE cron, non entrambi');
  }

  let nextCron;
  if (preset !== undefined) {
    const builder = PRESETS[preset];
    if (!builder) throw new Error(`preset non valido: ${preset} (validi: ${Object.keys(PRESETS).join(', ')})`);
    nextCron = builder({ hour, hour2 });
  } else if (cron !== undefined) {
    if (!isValidCron(cron)) throw new Error('espressione cron non valida (5 campi, es. "0 */3 * * *")');
    nextCron = cron;
  }

  if (nextCron !== undefined) {
    const gap = minGapMinutes(nextCron);
    if (gap < MIN_INTERVAL_MINUTES) {
      throw new Error(
        `frequenza minima ${MIN_INTERVAL_HOURS}h tra le run (guardrail budget): la schedulazione proposta ripete ogni ~${gap} minuti`,
      );
    }
  }

  const patch = {};
  if (nextCron !== undefined) patch.cron = nextCron;
  if (enabled !== undefined) patch.enabled = Boolean(enabled);
  if (!Object.keys(patch).length) throw new Error('nessuna modifica: passa preset, cron o enabled');

  updateSystemJob(jobId, patch); // a caldo: effettivo dal tick successivo (max 20s), nessun restart

  const cfg = readPlatformConfig();
  cfg[def.configKey] = { ...(cfg[def.configKey] ?? {}), ...patch };
  writePlatformConfig(cfg); // sopravvive al restart: boot successivo rilegge da qui

  logAudit({
    user: updatedBy ?? null, tenant: def.tenantId, agent: def.agentId,
    event: 'agent_job_updated', detail: { jobId, ...patch },
  });

  return describeJob(def, new Date());
}
