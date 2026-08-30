// Rilevamento scatti "orfani" dei job schedulati (task board e7422c02): uno
// scatto system_job_run che non ha prodotto NÉ una run nel journal NÉ un
// evento di skip esplicito (`<job>_skip`, `job_singleton_skip`,
// `job_paused_skip`, `system_job_error`, `digest_empty`) prima del PROSSIMO
// scatto dello stesso job è un bug — indica un'eccezione sfuggita ai
// guardrail interni del job (findAgent, spawn, errore imprevisto
// pre-journal). Con l'invariante applicata in scheduler.js/concurrency.js
// (runJobSafely + logAudit sui path di errore/pausa/coda) questa funzione
// dovrebbe restituire SEMPRE [] da ora in poi: resta come query di verifica
// storica/retroattiva e come base per una eventuale segnalazione (digest,
// card /api/agent-jobs).
//
// Finestra di correlazione = [scatto, prossimo scatto dello stesso job) invece
// di un margine fisso: un job può restare in coda (cap/memoria/rate-limit) e
// partire con ritardo anche di decine di minuti — è un ESITO valido (la run
// journaled esiste, solo posticipata), non un'anomalia. Verificato sui dati
// reali: il digest del 2026-07-25 è scattato alle 21:00:19 ma la run è
// partita alle 21:56:00 (56 min di coda) — un margine fisso di 5 min lo
// avrebbe segnalato come falso positivo.
import { readAuditEvents } from './audit.js';
import { listRuns } from './runs.js';

// Sotto questa soglia dallo scatto, l'assenza di esito NON è ancora
// un'anomalia: il job potrebbe essere ancora in coda/in corso.
export const ORPHAN_GRACE_MS = 5 * 60 * 1000;

// I 3 job LLM su cui questa diagnosi è mirata (task e7422c02): ognuno lancia
// una run via scheduleRun (journaled, campo `source`), che per digest-serale
// NON coincide col nome del system job (name='digest-serale', run.source=
// 'digest' — vedi lib/digest.js). backup-giornaliero e bonifica-needs-input
// sono job deterministici in-process SENZA run journaled né skip `_skip`
// (fuori scope, NON-GOALS: non toccarli) — esclusi di default per non generare
// falsi positivi strutturali.
export const TRACKED_JOB_RUN_SOURCE = {
  'digest-serale': 'digest',
  'code-quality': 'code-quality',
  'pm-platform': 'pm-platform',
};

const OUTCOME_EVENTS = (e) => e.event?.endsWith('_skip') || e.event === 'system_job_error' || e.event === 'digest_empty';

// Elenco degli scatti system_job_run privi di esito tracciato, in una finestra
// [sinceMs, nowMs]. `names` limita ai job di interesse (default: i 3 job LLM
// sopra). Ritorna [{name, ts, source}] ordinato cronologicamente.
export function findOrphanSystemJobRuns({
  sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000, nowMs = Date.now(),
  names = Object.keys(TRACKED_JOB_RUN_SOURCE),
} = {}) {
  const allScatti = readAuditEvents((e) => e.event === 'system_job_run' && names.includes(e.detail?.name));
  const outcomes = readAuditEvents(OUTCOME_EVENTS);
  const runs = listRuns();

  const byName = new Map();
  for (const s of allScatti) {
    const name = s.detail?.name;
    const t = Date.parse(s.ts);
    if (!name || Number.isNaN(t)) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ ...s, _t: t });
  }

  const orphans = [];
  for (const [name, list] of byName) {
    list.sort((a, b) => a._t - b._t);
    const runSource = TRACKED_JOB_RUN_SOURCE[name] ?? name;
    for (let i = 0; i < list.length; i += 1) {
      const s = list[i];
      if (s._t < sinceMs) continue;
      if (nowMs - s._t < ORPHAN_GRACE_MS) continue; // troppo recente, dagli tempo
      // Finestra di correlazione: fino al prossimo scatto dello stesso job, o
      // 24h se è l'ultimo scatto conosciuto (i cron di questi 3 job sono
      // giornalieri: oltre 24h di ritardo è comunque un'anomalia da segnalare).
      const windowEnd = i + 1 < list.length ? list[i + 1]._t : Math.min(nowMs, s._t + 24 * 60 * 60 * 1000);

      const hasOutcome = outcomes.some((e) => {
        const et = Date.parse(e.ts);
        if (Number.isNaN(et) || et < s._t || et >= windowEnd) return false;
        return e.user === name || e.user === runSource || e.detail?.name === name;
      });
      if (hasOutcome) continue;

      const hasRun = runs.some((r) => r.source === runSource && r.startedAt
        && Date.parse(r.startedAt) >= s._t && Date.parse(r.startedAt) < windowEnd);
      if (hasRun) continue;

      orphans.push({ name, ts: s.ts, source: s.detail?.source ?? null });
    }
  }
  orphans.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return orphans;
}
