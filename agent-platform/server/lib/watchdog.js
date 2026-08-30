// Watchdog delle run interrotte: gira nel tick dello scheduler (20s).
// Riprende le run "interrupted" (o "running" con heartbeat stantio = processo
// morto) usando il resume della sessione SDK salvato nel journal, con backoff
// esponenziale; dopo MAX_RESUME_ATTEMPTS la run diventa "failed" + push a Owner.
import {
  listResumable, journalUpdate, journalFail, MAX_RESUME_ATTEMPTS,
  OOM_MAX_RESUME_ATTEMPTS, failStaleExternal,
} from './runs.js';
import { touchSession, pushSessionEvent } from './status.js';
import { logAudit } from './audit.js';
import { isRateLimited } from './ratelimit.js';
import { isWeeklyBudgetHalted } from './weeklybudget.js';
import { hasMemoryHeadroom } from './mem.js';

const MAX_PARALLEL_RESUME_PER_TICK = 2; // niente valanga di resume dopo un restart

function continuationPrompt(run) {
  return [
    'Sei stato interrotto mentre stavi lavorando a questo compito:',
    '',
    `"""${run.prompt}"""`,
    '',
    'Riprendi da dove eri rimasto e porta a termine il lavoro.',
    'Se avevi già completato tutto, riepiloga brevemente il risultato finale.',
  ].join('\n');
}

// runFn = runAgentTurn (iniettata da index.js); notify(tenantId, payload) = push.
export function watchdogTick({ runFn, notify }) {
  // Run esterne (registrate via /api/runs/register) col heartbeat perso:
  // processo morto senza /complete → failed + push. Non sono riprendibili
  // dal server (il processo non è suo), quindi niente resume.
  for (const dead of failStaleExternal()) {
    logAudit({
      user: 'watchdog', tenant: dead.tenantId, agent: dead.agentId,
      event: 'external_run_stale', detail: { runId: dead.id },
    });
    notify(dead.tenantId, {
      title: 'Agente esterno sparito',
      body: `${dead.agentId}: heartbeat perso (${String(dead.prompt ?? '').slice(0, 80)})`,
      tag: `run-stale-${dead.id}`,
    }).catch(() => {});
  }

  // Muro del limite Claude attivo (task ca71d849): non tentare NESSUN resume
  // nella finestra — ripartirebbe solo per rimorire sul muro, bruciando i primi
  // token del reset (requisito 3). Le run interrotte per usage_limit hanno già
  // nextRetryAt = orario di reset, quindi non maturerebbero comunque; questa
  // guardia copre le ALTRE interrotte (reason 'error') il cui backoff scade
  // durante la finestra. Al reset (isRateLimited torna false) il tick riprende.
  if (isRateLimited() || isWeeklyBudgetHalted()) return;

  const resumable = listResumable();
  let launched = 0;
  for (const run of resumable) {
    // Pausa a tempo maturata: ripresa "pulita", non consuma né conta tentativi.
    const timedPause = run.status === 'paused';
    // OOM (task 16edce3a): il kernel ha già ucciso il processo per mancanza
    // di memoria — un backoff cieco a parità di condizioni fallisce di nuovo
    // per lo stesso motivo (evidenza: 3 run, 5/5 tentativi, usage 0 su ogni
    // tentativo). Un solo retry, contro i 5 delle altre interruzioni.
    const isOom = run.reason === 'oom';
    const maxAttempts = isOom ? OOM_MAX_RESUME_ATTEMPTS : MAX_RESUME_ATTEMPTS;
    // Tentativi esauriti: failed definitivo + notifica push al tenant.
    if (!timedPause && (run.attempts ?? 0) >= maxAttempts) {
      journalFail(run.id, run.lastError ?? 'tentativi di resume esauriti');
      touchSession(run.sessionKey, {
        status: 'failed',
        runId: run.id,
        lastError: `resume fallito dopo ${maxAttempts} tentativi: ${run.lastError ?? 'errore sconosciuto'}`,
      });
      logAudit({
        user: 'watchdog', tenant: run.tenantId, agent: run.agentId,
        event: 'run_failed', detail: {
          runId: run.id, attempts: run.attempts, lastError: run.lastError, reason: run.reason,
        },
      });
      notify(run.tenantId, {
        title: 'Run agente fallita definitivamente',
        body: `${run.agentId}: resume fallito ${maxAttempts} volte (${String(run.lastError ?? '').slice(0, 80)})`,
        tag: `run-failed-${run.id}`,
      }).catch(() => {});
      continue;
    }

    // OOM: non ritentare finché l'admission control a memoria (lib/mem.js,
    // stesso check di concurrency.js) non dà via libera — altrimenti si
    // rispawnerebbe nello stesso container già al limite, ripetendo il
    // crash a vuoto. Non consuma il tentativo: ci riprova al prossimo tick.
    if (!timedPause && isOom && !hasMemoryHeadroom()) continue;

    if (launched >= MAX_PARALLEL_RESUME_PER_TICK) break;
    launched += 1;

    // L'attesa per il limite Max non consuma tentativi: al reset si riprova
    // come se fosse la prima volta. Idem la pausa a tempo (azzera i tentativi).
    const usageLimit = run.reason === 'usage_limit';
    const attempts = timedPause ? 0 : usageLimit ? (run.attempts ?? 0) : (run.attempts ?? 0) + 1;
    journalUpdate(run.id, { attempts, status: 'resumed', pausedBy: null, resumeAt: null });
    touchSession(run.sessionKey, { status: 'resumed', runId: run.id });
    pushSessionEvent(run.sessionKey, {
      type: 'resume',
      text: timedPause
        ? 'watchdog: pausa a tempo scaduta, riprendo la run'
        : usageLimit
          ? 'watchdog: limite Max resettato, riprendo la run'
          : `watchdog: riprendo la run interrotta (tentativo ${attempts}/${maxAttempts})`,
    });
    logAudit({
      user: 'watchdog', tenant: run.tenantId, agent: run.agentId,
      event: 'run_resume', detail: { runId: run.id, attempt: attempts, reason: run.reason },
    });

    runFn({
      tenantId: run.tenantId,
      agentId: run.agentId,
      sessionId: run.sessionId,
      message: continuationPrompt(run),
      username: 'watchdog',
      resumeSessionId: run.sdkSessionId ?? undefined,
      resumeOfRunId: run.id,
    }).catch((err) => {
      // L'errore è già stato journaled (journalInterrupt) da runAgentTurn:
      // il prossimo tick riproverà al maturare del backoff.
      console.error(`[watchdog] resume run ${run.id} fallito (tentativo ${attempts}):`, err.message);
    });
  }
}
