// Blocco (e) di runAgentTurnInner (task 829e29c2, God-function
// server/index.js): persistenza dell'esito del turno — completed/stopped/
// interrupted/failed — e chiusura del journal. MOVE puro dal blocco
// try/catch esterno di runAgentTurnInner: stessa logica, stesse variabili
// (err.streamedText/err.modelTier attaccati da streamTurn, vedi stream.js) —
// zero cambi di comportamento.
//
// Task 0c814377 (follow-up di 1eed85e7): finalizeTurn era ~109 righe (criterio
// "nessun helper >50 righe" non centrato). MOVE puro dei tre rami in helper
// dedicati — finalizeSuccess / finalizeIfAlreadyTerminal / finalizeInterrupted —
// più classifyInterrupt (PURA: classifica usage_limit/oom/error e calcola il
// retry, testabile senza side-effect, vedi scripts/finalize-classify-check.mjs).
// finalizeTurn resta il dispatcher a 3 rami: stessa logica, stesse variabili.
import {
  journalComplete, journalInterrupt, getRun,
  isUsageLimitError, usageLimitRetryAt, parseUsageLimitReset, isOomError,
} from '../runs.js';
import { isTerminalStatus, isStickyStatus } from '../runstates.js';
import { noteLimitEvent } from '../budget.js';
import { noteUsageLimit } from '../ratelimit.js';
import { touchSession } from '../status.js';
import { notifyTenant, LONG_RUN_THRESHOLD_MS } from '../push.js';
import { appendHistory } from '../history.js';
import { loadUsers, userCanTenant } from '../auth.js';

const pushDeps = { loadUsers, userCanTenant };

// Ramo successo: journal completo, sessione 'completed', push SOLO per run
// lunghe (l'utente ha probabilmente chiuso la schermata). Ritorna `result`.
function finalizeSuccess(ctx, result) {
  const { tenantId, key, runId, agent } = ctx;
  journalComplete(runId);
  touchSession(key, { status: 'completed', lastError: null });
  if (result.durationMs >= LONG_RUN_THRESHOLD_MS) {
    notifyTenant(tenantId, {
      title: `${agent.name} ha completato`,
      body: result.fullText.slice(0, 120) || 'Run completata',
      tag: key,
    }, pushDeps).catch(() => {});
  }
  return result;
}

// Run già finalizzata FUORI dal loop di streaming, prima che l'errore di
// terminazione arrivasse qui:
//  - stop/pausa manuale (sticky): l'utente l'ha fermata, journalInterrupt è
//    no-op su di essa;
//  - timeout wall-clock (task 019ab89d): il deadline timer l'ha marcata failed
//    (reason 'timeout', terminale) e ha interrotto la query SDK.
// In entrambi i casi lo stato è GIÀ definitivo: non ri-journalare (tornerebbe
// interrupted → auto-resume su un punto morto). Persisti solo il parziale su
// stop; sul timeout notifica (non è stato l'utente a fermarla). Ritorna true se
// lo stato era già definitivo (gestito qui), false se va journalato interrupted.
function finalizeIfAlreadyTerminal(ctx, err) {
  const { tenantId, agentId, sessionId, key, runId, agent } = ctx;
  const finalized = getRun(runId)?.status;
  if (!(isStickyStatus(finalized) || isTerminalStatus(finalized))) return false;
  if (finalized === 'stopped' && err.streamedText) {
    appendHistory(tenantId, agentId, sessionId, {
      role: 'assistant', text: err.streamedText, model: err.modelTier, partial: true, stoppedBy: getRun(runId)?.stoppedBy ?? null,
    });
  }
  const timedOut = finalized === 'failed' && getRun(runId)?.reason === 'timeout';
  touchSession(key, { status: finalized, lastError: timedOut ? getRun(runId)?.lastError ?? err.message : null });
  if (timedOut) {
    notifyTenant(tenantId, {
      title: `${agent.name}: run scaduta`,
      body: String(getRun(runId)?.lastError ?? 'timeout wall-clock').slice(0, 120),
      tag: key,
    }, pushDeps).catch(() => {});
  }
  return true;
}

// Pura: classifica l'errore di terminazione e calcola l'orario di retry. Il
// muro Max ha priorità sull'OOM (mutuamente esclusivi, più specifico/frequente):
//  - usage_limit (limite Max, task 16edce3a/ca71d849): retryAt = reset del limite;
//  - oom (task 16edce3a): SIGKILL/exit 137 del kernel, non errore applicativo;
//  - error: qualunque altro errore applicativo.
// Nessun side-effect → testabile in isolamento (scripts/finalize-classify-check.mjs).
export function classifyInterrupt(message) {
  const usageLimit = isUsageLimitError(message);
  const oom = !usageLimit && isOomError(message);
  const retryAt = usageLimit ? usageLimitRetryAt(message) : null;
  const reason = usageLimit ? 'usage_limit' : oom ? 'oom' : 'error';
  return { usageLimit, oom, reason, retryAt };
}

// Ramo interrupted: la run resta nel journal come "interrupted", sarà il
// watchdog a riprenderla (con backoff) o a marcarla failed dopo troppi
// tentativi. Sul limite Max il retry aspetta il reset e non consuma tentativi,
// e si alza il muro GLOBALE della piattaforma (task ca71d849): la subscription
// Max è una quota sola, finché non scade il reset nessun altro lancio autonomo
// parte (anti-raffica) e la UI mostra il banner. resumeAt = stesso nextRetryAt.
function finalizeInterrupted(ctx, err) {
  const { tenantId, agentId, key, runId, agent } = ctx;
  const { usageLimit, reason, retryAt } = classifyInterrupt(err.message);
  journalInterrupt(runId, reason === 'usage_limit'
    ? { reason, error: err.message, nextRetryAt: retryAt }
    : { reason, error: err.message });
  if (usageLimit) {
    noteUsageLimit({ resumeAt: retryAt, tenantId, agentId, message: err.message });
    // Limit event per il budget empirico (task b8b98175): registra quanti token
    // la finestra aveva accumulato quando ha sbattuto sul muro + l'orario di
    // reset reale (parsato, non il retry con buffer). Con 2-3 muri la stima del
    // budget della finestra si calibra e si raffina nel tempo.
    const parsedReset = parseUsageLimitReset(err.message);
    noteLimitEvent({ resetAt: parsedReset ? parsedReset.toISOString() : retryAt, message: err.message });
  }
  touchSession(key, { status: 'interrupted', lastError: err.message });
  notifyTenant(tenantId, {
    title: `${agent.name}: errore`,
    body: String(err.message).slice(0, 120),
    tag: key,
  }, pushDeps).catch(() => {});
}

// ctx: { tenantId, agentId, sessionId, key, runId, agent }
// outcome: { ok: true, result: {fullText, durationMs} } oppure { ok: false, err }
// (err porta err.streamedText/err.modelTier, attaccati da streamTurn).
//
// Su successo ritorna `result`; su fallimento rilancia `err` dopo aver
// persistito lo stato (sticky/interrupted) — il chiamante (runAgentTurnInner)
// deve propagare l'eccezione esattamente come prima.
export async function finalizeTurn(ctx, outcome) {
  if (outcome.ok) return finalizeSuccess(ctx, outcome.result);
  const { err } = outcome;
  if (finalizeIfAlreadyTerminal(ctx, err)) throw err;
  finalizeInterrupted(ctx, err);
  throw err;
}
