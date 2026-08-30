// Bonifica automatica ricorrente (task board 2e2d918f, decisione CEO 2026-07-25):
// oggi il CEO ha dovuto ripulire A MANO 9 task su 10 nella coda di Owner — in
// realtà needs_input SENZA campo ask (blocco TECNICO, mai una vera domanda,
// vedi lib/blocked.js), finite lì per esaurimento tentativi di dispatch o
// bocciature del quality gate (gate_exhausted, tasks.js submitReview). Non deve
// più servire un umano che clicca "Riprova" a mano: system job periodico (ogni
// 20 min, registrato in index.js — vedi lib/scheduler.js/registerSystemJob) che
// su TUTTI i tenant:
//   1) trova ogni needs_input SENZA ask (stesso filtro di listBlockedTasks);
//   2) la rimette in lavorazione da sola: stato precedente todo/revisione,
//      tentativi di dispatch azzerati (stesso reset "tocco umano" già presente
//      in updateTask), motivo del recupero registrato nell'audit journal
//      (evento task_auto_recovered — alimenta il digest serale, vedi digest.js);
//   3) se la STESSA task viene recuperata più di CHRONIC_THRESHOLD volte senza
//      MAI arrivare a "done", smette di ririlanciarla in automatico (anti-loop):
//      crea una task per il CEO platform ("task che non riesce a partire", con
//      l'ultimo errore noto) invece di continuare a girare o di scaricarla su
//      Owner — regola di prodotto (decisione 2026-07-25): "Da decidere" contiene
//      SOLO task con un ask valorizzato, mai un blocco tecnico.
// Nessuna run LLM: puro codice deterministico (come il giorno vuoto del digest),
// costo trascurabile anche ogni 20 minuti.
import { listTasks, updateTask, createTask } from './tasks.js';
import { translateBlockCause, latestErrorForTask } from './blocked.js';
import { logAudit, readAuditEvents } from './audit.js';

export const PLATFORM_TENANT = 'platform';
export const CEO_PLATFORM_AGENT = 'ceo-platform';
// Oltre questo numero di recuperi automatici senza mai arrivare a "done", la
// task è "cronica": si ferma il loop e si segnala al CEO platform.
export const CHRONIC_THRESHOLD = 3;

// Stato dispatchable a cui tornare (requisito 2, "stato precedente: todo o
// revisione"): 'revisione' per una bocciatura del gate esaurita (gate_exhausted,
// tasks.js) — stessa semantica del reject normale sotto soglia, il worker
// originale deve correggere; altrimenti lo stato dispatchable da cui era
// partita l'ultima run (dispatchedFrom, popolato dal dispatcher a ogni lancio)
// o 'todo' come fallback sicuro se non è noto.
export function recoveryTargetFor(task) {
  if (task.blockCause === 'gate_exhausted') return 'revisione';
  return ['todo', 'revisione'].includes(task.dispatchedFrom) ? task.dispatchedFrom : 'todo';
}

// Recupera UNA task bloccata: la rimette in lavorazione, azzera i tentativi
// (updatedBy NON 'dispatcher' -> stesso reset "tocco umano" di updateTask),
// registra il motivo nell'audit journal. Per un rientro in "revisione" da
// gate_exhausted ricostruisce anche gateRejection (altrimenti il prompt di
// rilancio del dispatcher non mostrerebbe la nota della bocciatura, vedi
// dispatcher.js taskPrompt).
function recoverTask(tenant, task, now) {
  const cause = translateBlockCause(task);
  const target = recoveryTargetFor(task);
  const attempt = (task.autoRecoverCount ?? 0) + 1;
  const patch = {
    status: target,
    dispatchAttempts: 0,
    dispatchExhausted: false,
    dispatchAutoRetries: 0,
    autoRecoverCount: attempt,
    note: `Bonifica automatica: rimessa in "${target}" (era bloccata: ${cause}) — recupero ${attempt}/${CHRONIC_THRESHOLD}.`,
  };
  if (target === 'revisione') {
    patch.gateRejection = { by: task.gateRejection?.by ?? 'manager', note: cause, at: new Date(now).toISOString() };
  }
  const updated = updateTask(tenant.id, task.id, patch, 'system:auto-recovery');
  logAudit({
    user: 'auto-recovery', tenant: tenant.id, event: 'task_auto_recovered',
    detail: { taskId: task.id, title: task.title, to: target, cause, attempt },
  });
  return updated;
}

// Escalation cronica (requisito 3): crea UNA sola volta una task per il CEO
// platform con l'ultimo errore noto; marca l'originale come già segnalata
// (chronicEscalatedAt) così i tick successivi non la riproponessero ogni 20
// min. La task originale resta "needs_input" (bloccata, visibile in
// "Bloccate" — MAI in "Da decidere", non ha un ask): il CEO platform valuta e,
// se serve davvero una decisione di Owner, la fa lui con ask_owner (una
// domanda vera, non lo scarico automatico di una needs_input tecnica).
function escalateChronic(tenant, task, now) {
  if (task.chronicEscalatedAt) return null; // già segnalata: non duplicare
  const cause = translateBlockCause(task);
  const lastError = latestErrorForTask(tenant.id, task.id);
  createTask(PLATFORM_TENANT, {
    title: `Task cronica non riesce a partire: [${tenant.name ?? tenant.id}] ${task.title}`.slice(0, 120),
    description: [
      `La bonifica automatica ha recuperato questa task ${task.autoRecoverCount ?? 0} volte senza che arrivasse mai a "done" — non viene più ririlanciata da sola (anti-loop).`,
      `Tenant: ${tenant.name ?? tenant.id} (${tenant.id})`,
      `Task originale: ${task.id} — "${task.title}"`,
      `Causa del blocco: ${cause}`,
      lastError ? `Ultimo errore noto: ${lastError}` : null,
      'La task originale resta in needs_input (lista "Bloccate", non "Da decidere": non ha un ask). Valuta: correggerla, chiuderla, o farne una vera domanda a Owner con ask_owner se serve davvero una sua decisione.',
    ].filter(Boolean).join('\n'),
    urgency: 'alta',
    assignedTo: CEO_PLATFORM_AGENT,
  }, 'system:auto-recovery');
  const updated = updateTask(tenant.id, task.id, { chronicEscalatedAt: new Date(now).toISOString() }, 'system:auto-recovery');
  logAudit({
    user: 'auto-recovery', tenant: tenant.id, event: 'task_chronic_escalated',
    detail: { taskId: task.id, title: task.title, cause, attempts: task.autoRecoverCount ?? 0, lastError },
  });
  return updated;
}

// Entry point del system job (registrato in index.js): TUTTI i tenant,
// deterministico, nessuna run LLM. Ritorna un riepilogo per log/debug.
export function runAutoRecover({ tenants, now = Date.now() }) {
  let recovered = 0;
  let escalated = 0;
  for (const tenant of tenants) {
    for (const task of listTasks(tenant.id)) {
      if (task.status !== 'needs_input' || task.ask) continue; // solo blocco tecnico ("Bloccate")
      if ((task.autoRecoverCount ?? 0) >= CHRONIC_THRESHOLD) {
        if (escalateChronic(tenant, task, now)) escalated += 1;
      } else {
        recoverTask(tenant, task, now);
        recovered += 1;
      }
    }
  }
  if (recovered || escalated) {
    logAudit({ user: 'auto-recovery', tenant: PLATFORM_TENANT, event: 'auto_recovery_run', detail: { recovered, escalated } });
  }
  return { recovered, escalated };
}

// ---- Metriche per il digest serale (requisito 4) --------------------------
// Conta gli eventi audit di oggi (dayStart = inizio giornata locale in ms):
// quante task recuperate, quante segnalate come croniche.
export function countAutoRecoveryToday(dayStart) {
  const recoveredToday = readAuditEvents((e) => e.event === 'task_auto_recovered' && Date.parse(e.ts) >= dayStart).length;
  const chronicToday = readAuditEvents((e) => e.event === 'task_chronic_escalated' && Date.parse(e.ts) >= dayStart).length;
  return { recoveredToday, chronicToday };
}
