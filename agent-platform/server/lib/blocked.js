// "Bloccate" (task board 03a5a645, decisione Owner 2026-07-25): task ferme in
// needs_input SENZA un ask strutturato — un blocco TECNICO (run interrotta,
// retry esauriti, gate che ha bocciato troppe volte, un agente che ha scritto
// una nota generica senza passare da ask_owner), non una domanda a cui Owner
// sa cosa rispondere. Prima finivano indistinte in "Da decidere" insieme alle
// vere richieste (popup con "Serve un tuo input" e nessuna domanda: le
// richieste vere si perdevano nel rumore). Separate alla radice:
//   - "Da decidere" (lib/decisions.js): SOLO needs_input con ask.
//   - "Bloccate" (qui): needs_input SENZA ask, con causa leggibile in
//     italiano, tentativi, ultimo errore di run e un'azione "Riprova".
//
// Migrazione dei record esistenti: NESSUNA riscrittura dei file dati. La
// causa è tradotta a lettura (translateBlockCause) da due fonti, in ordine:
// 1) pattern sulla nota tecnica (che dispatcher/gate scrivono già oggi, prima
//    e dopo questo fix — copre anche le task create prima del deploy, che non
//    hanno ancora il campo blockCause persistito);
// 2) il campo task.blockCause (persistito da applyStatusTransition in
//    tasks.js per le nuove transizioni), con fallback 'manual'.
// Così una task "vecchia" senza blockCause resta comunque leggibile, senza
// bisogno di uno script di migrazione a parte.
import { listTasks, updateTask } from './tasks.js';
import { MAX_DISPATCH_ATTEMPTS } from './dispatcher.js';
import { listRuns } from './runs.js';
import { logAudit } from './audit.js';

const clip = (s, n) => {
  const str = String(s ?? '').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

// Requisito 5: mappa errore/nota tecnica -> frase italiana leggibile (mai lo
// stack/errore grezzo in prima battuta). Testata sulla nota che dispatcher.js
// e tasks.js (submitReview, escalation) scrivono già: coperta sia la
// terminologia attuale sia quella di versioni precedenti del dispatcher
// (task ancora ferme da prima di 81ea4965), senza doverle riscrivere.
const NOTE_PATTERNS = [
  [/limite di quota|rate.?limit|usage_limit|muro del limite/i, 'Run interrotta per limite di quota (rate limit) di Claude.'],
  [/timeout/i, 'Run interrotta per timeout.'],
  [/run non pi[uù] presente nel journal|run.*sparita/i, 'La run si è interrotta senza lasciare traccia (processo terminato inaspettatamente).'],
  [/tentativi di lavorazione esauriti|tentativi esauriti/i, 'La lavorazione automatica ha esaurito i tentativi senza riuscire a consegnare.'],
  [/senza consegna esplicita|senza consegnare/i, 'L\'agente ha finito la run senza consegnare il lavoro.'],
  [/senza chiamare submit_review/i, 'Il reviewer ha finito la run senza approvare o bocciare.'],
  [/bocciatura a livello/i, 'Il quality gate ha bocciato la consegna troppe volte: serve una decisione su come procedere.'],
  [/run fallita/i, 'La run di lavorazione è fallita.'],
];

const BLOCK_CAUSE_FALLBACK = {
  gate_exhausted: 'Il quality gate ha bocciato la consegna troppe volte: serve una decisione su come procedere.',
  dispatch_exhausted: 'La lavorazione automatica ha esaurito i tentativi senza riuscire a consegnare.',
  manual: 'Bloccata senza una domanda formale: nessuna richiesta strutturata associata, verifica la nota.',
};

export function translateBlockCause(task) {
  const note = String(task.note ?? '');
  for (const [re, label] of NOTE_PATTERNS) {
    if (re.test(note)) return label;
  }
  return BLOCK_CAUSE_FALLBACK[task.blockCause] ?? BLOCK_CAUSE_FALLBACK.manual;
}

// Ultimo errore di run noto per la task (requisito "ultimo errore"): l'ultima
// run del tenant collegata a questa task che ha un lastError, più recente prima.
export function latestErrorForTask(tenantId, taskId) {
  const withError = listRuns(tenantId)
    .filter((r) => r.taskId === taskId && r.lastError)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return withError[0]?.lastError ?? null;
}

export function listBlockedTasks(tenant) {
  return listTasks(tenant.id)
    .filter((t) => t.status === 'needs_input' && !t.ask)
    .map((t) => ({
      taskId: t.id,
      tenantId: t.tenantId,
      tenantName: tenant.name ?? t.tenantId,
      tenantColor: tenant.color ?? null,
      title: clip(t.title, 90),
      cause: translateBlockCause(t),      // causa leggibile in italiano (requisito 5)
      rawNote: t.note ? clip(t.note, 300) : null, // nota tecnica grezza, per chi vuole il dettaglio
      attempts: t.dispatchAttempts ?? 0,
      maxAttempts: MAX_DISPATCH_ATTEMPTS,
      lastError: (() => { const e = latestErrorForTask(tenant.id, t.id); return e ? clip(e, 300) : null; })(),
      assignedTo: t.assignedTo,
      workerId: t.workerId ?? null,
      updatedAt: t.updatedAt,
    }))
    .sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
}

// "Riprova" (requisito 3): rimette la task in coda (todo) e azzera i
// tentativi. updateTask con updatedBy umano azzera già da solo
// dispatchAttempts/dispatchExhausted/dispatchAutoRetries per QUALSIASI tocco
// non-dispatcher (tasks.js, guardia "humanTouch") — qui lo passiamo comunque
// esplicito nel patch per chiarezza, non per necessità.
export function retryBlockedTask(tenantId, taskId, resolvedBy) {
  const task = listTasks(tenantId).find((t) => t.id === taskId);
  if (!task) throw new Error('task non trovata');
  if (task.status !== 'needs_input' || task.ask) {
    throw new Error('la task non è "Bloccata" (needs_input senza ask): niente da riprovare qui');
  }
  const cause = translateBlockCause(task);
  const updated = updateTask(tenantId, taskId, {
    status: 'todo',
    dispatchAttempts: 0,
    dispatchExhausted: false,
    dispatchAutoRetries: 0,
    // Un intervento umano è sempre un nuovo inizio (task board 2e2d918f): azzera
    // anche il contatore della bonifica automatica, altrimenti una task già
    // recuperata 3 volte in automatico e poi sistemata a mano da Owner resterebbe
    // "cronica" per sempre pur non avendo più bisogno di escalation.
    autoRecoverCount: 0,
    chronicEscalatedAt: null,
    note: `Riprovata da Owner (era bloccata: ${cause})`,
  }, resolvedBy);
  logAudit({ user: resolvedBy, tenant: tenantId, event: 'task_blocked_retry', detail: { taskId, causeWas: cause } });
  return updated;
}
