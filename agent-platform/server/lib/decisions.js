// Coda unificata delle "decisioni" per Owner (task board 69413a7e): un'unica
// astrazione sopra due sorgenti già esistenti — le richieste di approvazione dei
// tool sensibili (approvals.js) e le task ferme in needs_input (tasks.js). Serve
// il popup dedicato della PWA e la push con la domanda già nel testo. NON
// duplica infrastruttura: riusa approvals.json e la board.
import { listTasks, updateTask } from './tasks.js';
import { listApprovals } from './approvals.js';
import { logAudit } from './audit.js';

const clip = (s, n) => {
  const str = String(s ?? '').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

// Una richiesta di approvazione tool (pending) -> decisione normalizzata.
export function approvalToDecision(a, tenant) {
  return {
    kind: 'tool',
    id: a.id,
    tenantId: a.tenantId,
    tenantName: tenant?.name ?? a.tenantId,
    tenantColor: tenant?.color ?? null,
    title: `${a.agentName ?? a.agentId} chiede un'approvazione`,
    context: clip(`Tool: ${a.toolName} — ${JSON.stringify(a.input ?? {})}`, 200),
    question: `Autorizzi «${a.toolName}»?`,
    options: [
      { value: 'approve', label: 'Approva', style: 'primary' },
      { value: 'deny', label: 'Rifiuta', style: 'danger' },
    ],
    allowText: true,
    textLabel: 'Nota (opzionale)',
    agentName: a.agentName ?? a.agentId,
    requestedAt: a.requestedAt,
  };
}

// Una task in needs_input -> decisione normalizzata. Se ha un ask strutturato
// (dal tool ask_owner) usa domanda/contesto/opzioni; altrimenti fallback sul
// contenuto della task (needs_input "generica": escalation del gate, ecc.).
export function taskToDecision(t, tenant) {
  const ask = t.ask ?? null;
  return {
    kind: 'task',
    id: t.id,
    tenantId: t.tenantId,
    tenantName: tenant?.name ?? t.tenantId,
    tenantColor: tenant?.color ?? null,
    title: clip(ask?.title ?? t.title, 90),
    goal: ask?.goal ? clip(ask.goal, 160) : null,
    // Task board d873668c: ask.context è già validato/limitato per intero da
    // buildAskOwner (lib/tasks.js) — ri-clippare qui a 220 char tagliava a metà
    // parola contenuto già accettato per intero. Il clip resta SOLO per il
    // fallback (needs_input "generica" senza ask, note/description libere e
    // non validate da ask_owner).
    context: ask ? (ask.context ?? '') : clip(t.note ?? t.description ?? '', 220),
    question: ask?.question ?? 'Serve un tuo input per sbloccare questa task.',
    steps: Array.isArray(ask?.steps) ? ask.steps.slice(0, 10) : [],
    options: (ask?.options ?? []).map((o) => ({
      value: o.value ?? o.label,
      label: o.label,
      style: o.style ?? 'neutral',
    })),
    allowText: true,
    textLabel: 'La tua risposta',
    // hasAsk=false => needs_input "senza richiesta formale": nessun ask
    // strutturato, la PWA la marca con un badge (task e09455bd) perché è la
    // classe che rischia di restare invisibile a Owner.
    hasAsk: Boolean(ask),
    agentName: ask?.askedByName ?? (t.assignedTo ?? '').replace(/^agent:/, '') ?? null,
    requestedAt: ask?.askedAt ?? t.updatedAt,
  };
}

// Coda pending di un tenant (tool pending + task needs_input CON ask), più
// recenti prima. Task board 03a5a645 (decisione Owner 2026-07-25): "Da
// decidere" è SOLO per richieste vere (ask valorizzato) — una needs_input
// senza ask è un blocco tecnico (run/gate/agente che non ce l'ha fatta), non
// una domanda, e finisce invece in "Bloccate" (lib/blocked.js, non qui): il
// popup non deve più mostrare "Serve un tuo input" senza nessuna domanda.
export function listTenantDecisions(tenant) {
  const tool = listApprovals(tenant.id)
    .filter((a) => a.status === 'pending')
    .map((a) => approvalToDecision(a, tenant));
  const tasks = listTasks(tenant.id)
    .filter((t) => t.status === 'needs_input' && t.ask)
    .map((t) => taskToDecision(t, tenant));
  return [...tool, ...tasks].sort((x, y) => (x.requestedAt < y.requestedAt ? 1 : -1));
}

// Vista dedicata "richieste per Owner" (task board 553ea6b1, ristretta alle
// sole richieste vere da 03a5a645): SOLO le task in needs_input CON ask
// (niente approvazioni tool, niente blocchi tecnici — quelli sono in
// lib/blocked.js), con la domanda in un campo dedicato "richiestaAOwner" —
// mai sepolta nella description — per l'API di badge/lista che deve
// mostrarla in evidenza. Riusa taskToDecision (stesso fallback ask.question
// -> testo generico, ora irrilevante qui perché ask è sempre presente) per
// non duplicare la logica di normalizzazione.
export function listNeedsInputTasks(tenant) {
  return listTasks(tenant.id)
    .filter((t) => t.status === 'needs_input' && t.ask)
    .map((t) => {
      const d = taskToDecision(t, tenant);
      return {
        taskId: t.id,
        tenantId: t.tenantId,
        tenantName: d.tenantName,
        tenantColor: d.tenantColor,
        title: d.title,
        goal: d.goal, // a cosa serve la risposta (tool ask_owner, task ab8328d2)
        hasAsk: d.hasAsk, // false = "senza richiesta formale" -> badge in PWA (task e09455bd)
        richiestaAOwner: d.question, // campo dedicato in evidenza (badge/lista)
        context: d.context,
        steps: d.steps, // eventuale procedura, renderizzata a parte dalla domanda
        options: d.options,
        askedBy: t.ask?.askedByName ?? null,
        assignedTo: t.assignedTo,
        workerId: t.workerId ?? null,
        updatedAt: t.updatedAt,
      };
    })
    .sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
}

// Risposta di Owner a una task in needs_input: la sblocca rimettendola in
// "revisione" con la risposta come nota di revisione (finisce nel prompt di
// rilancio dell'agente). Le needs_input da escalation del gate tornano al worker
// originale; quelle chieste da un agente tornano a chi le ha chieste (assignedTo).
export function answerTaskDecision(tenantId, taskId, { answer }, resolvedBy) {
  const clean = String(answer ?? '').trim();
  if (!clean) throw new Error('serve una risposta (un\'opzione o del testo)');
  const task = listTasks(tenantId).find((t) => t.id === taskId);
  if (!task) throw new Error('task non trovata');
  if (task.status !== 'needs_input') throw new Error('la task non è in attesa di input');
  const route = task.workerId ?? task.assignedTo ?? null; // escalation del gate -> worker
  const updated = updateTask(tenantId, taskId, {
    status: 'revisione',
    note: `Risposta di Owner: ${clean}`,
    assignedTo: route,
    ask: null,
  }, resolvedBy);
  logAudit({
    user: resolvedBy, tenant: tenantId, agent: (route ?? '').replace(/^agent:/, '') || null,
    event: 'decision_answered', detail: { taskId, answer: clean.slice(0, 500) },
  });
  return updated;
}
