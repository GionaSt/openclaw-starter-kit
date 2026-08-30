// Singleton per job periodico (task board 01ed5b8d, segnalazione Owner 2026-07-27).
// Problema: i job schedulati (code-quality, digest, pm-platform, …) si accodavano
// più volte — se la run precedente era ancora in corso o in coda, lo scatto
// successivo ne lanciava/accodava un'altra, accumulando agenti che fanno lo stesso
// lavoro e mangiano gli slot di concorrenza.
//
// Regola: una sola istanza attiva per chiave di job (tenantId + agentId + source,
// dove source === jobId). scheduleRun (concurrency.js) consulta questo modulo per
// la parte "run già in corso nel journal"; la parte "già in coda" la controlla da
// sé sulla propria coda in memoria. Questo modulo NON importa concurrency.js:
// evita il ciclo di import (concurrency → jobsingleton → concurrency).
//
// Guardia anti-impianto: una run "attiva" da più di STALE_MEDIAN_MULT volte la sua
// durata mediana storica (o STALE_FALLBACK_MS se non c'è storia) è considerata una
// zombie e NON blocca il nuovo scatto — altrimenti una run bloccata terrebbe il
// job fermo per sempre.
import { listRuns } from './runs.js';
import { SLOT_OCCUPYING_STATES } from './runstates.js';

// Multiplo della durata mediana oltre il quale una run "attiva" è considerata
// impiantata (zombie) e non blocca più il job.
export const STALE_MEDIAN_MULT = 3;
// Fallback quando non c'è storia di run completate per la chiave (primo avvio):
// oltre 1h una run periodica di questi job (che di norma dura minuti) è quasi
// certamente bloccata.
export const STALE_FALLBACK_MS = 60 * 60 * 1000;

// Durata mediana (ms) delle run COMPLETATE con questa chiave, o null se non ce ne
// sono. Base per la soglia di stallo (3x mediana).
export function medianCompletedDurationMs(tenantId, agentId, source) {
  const durs = listRuns(tenantId)
    .filter((r) => r.agentId === agentId && r.source === source && r.status === 'completed')
    .map((r) => Date.parse(r.updatedAt) - Date.parse(r.startedAt))
    .filter((d) => Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);
  if (!durs.length) return null;
  const mid = Math.floor(durs.length / 2);
  return durs.length % 2 ? durs[mid] : Math.round((durs[mid - 1] + durs[mid]) / 2);
}

// Soglia oltre cui una run attiva è considerata stale: 3x mediana storica, o il
// fallback se non c'è storia.
export function staleThresholdMs(tenantId, agentId, source) {
  const median = medianCompletedDurationMs(tenantId, agentId, source);
  return median != null ? median * STALE_MEDIAN_MULT : STALE_FALLBACK_MS;
}

// Stato dell'istanza di un job periodico nel journal (la parte "in coda" la
// valuta il chiamante):
//   { state: 'active', run, elapsedMs, thresholdMs } — c'è una run che occupa uno
//        slot e NON è stale: il nuovo scatto va saltato.
//   { state: 'stale',  run, elapsedMs, thresholdMs } — l'unica run occupante è una
//        zombie oltre soglia: il nuovo scatto è permesso (e il chiamante logga
//        l'override per visibilità).
//   { state: 'idle' } — nessuna run occupante: via libera.
// "Occupante" = running | resumed | interrupted | paused (SLOT_OCCUPYING_STATES):
// gira ora o ripartirà da sola senza un nuovo spawn.
export function activeJobRun({ tenantId, agentId, source }, now = Date.now()) {
  const occupying = listRuns(tenantId)
    .filter((r) => r.agentId === agentId && r.source === source && SLOT_OCCUPYING_STATES.includes(r.status))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  if (!occupying.length) return { state: 'idle' };
  const run = occupying[0];
  const elapsedMs = Math.max(0, now - Date.parse(run.startedAt));
  const thresholdMs = staleThresholdMs(tenantId, agentId, source);
  if (elapsedMs > thresholdMs) return { state: 'stale', run, elapsedMs, thresholdMs };
  return { state: 'active', run, elapsedMs, thresholdMs };
}

// Durata leggibile per i log/journal ("2 min", "1h 5m", "30s").
export function humanDuration(ms) {
  const s = Math.round((ms ?? 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
