// Messaggistica cross-tenant tra CEO (task board 183ae10d, appetite 2 giorni).
// I CEO dei business (business A, business B, platform) possono scriversi tra
// loro via il tool MCP send_to_ceo. "Simplest thing that works": nessun DB, un
// file JSON come il resto della piattaforma; la consegna riusa il MECCANISMO
// del dispatcher (una board task sul tenant destinatario, assegnata al suo CEO
// → il dispatcher la trasforma in una run → journal/Agenti live), zero nuovo
// codice di spawn delle run.
//
// Modello dati (data/ceo-mail/threads.json, array di thread):
//   { id, participants:[tenantA,tenantB] (ordinati),
//     status:'active'|'awaiting_owner'|'closed', exchanges:N,
//     messages:[{ id, fromTenant, fromAgent, fromAgentName, toTenant, text, at }],
//     createdAt, updatedAt }
//
// Stati:
//   - 'active': i CEO possono scambiarsi messaggi via send_to_ceo.
//   - 'awaiting_owner': cap anti-loop raggiunto (AUTOMATICO, vedi sotto). Si
//     sblocca con resumeThread() o scrivendo un messaggio di Owner nel thread
//     (addOwnerMessage riporta ad 'active' e azzera exchanges — "sblocco
//     scrivendo" invece di dover chiamare prima /resume).
//   - 'closed': fermato ESPLICITAMENTE da Owner (stopThread, task board
//     a5a5e758) — stessa identica guardia di blocco su sendToCeo di
//     'awaiting_owner' ma stato distinto, così la UI sa dire "fermato da
//     Owner" invece di "cap 6 scambi". Si sblocca SOLO con resumeThread()
//     esplicito (un messaggio di Owner non lo riapre da solo).
//
// Messaggi di Owner (addOwnerMessage): fromTenant:null, fromAgent:'owner',
// fromAgentName:'Owner'. NON contano nel contatore anti-loop (exchanges
// invariato) — altrimenti Owner stessa potrebbe far scattare 'awaiting_owner'
// e non potrebbe più sbloccare il thread scrivendoci. Vengono consegnati come
// run a ENTRAMBI i CEO partecipanti (Owner non è un tenant/partecipante: per
// ciascuno dei due l'intervento è "dell'altra parte", quindi va notificato a
// entrambi, non solo a uno).
//
// ANTI-LOOP (vincolo duro, subscription Max condivisa): MAX_EXCHANGES scambi
// per thread. Raggiunta la soglia il thread va in "awaiting_owner" e NON genera
// altre run (nessuna delivery task): solo Owner può sbloccarlo. Ogni messaggio
// e il valore del contatore finiscono nel journal (audit.jsonl) → visibili in
// pari con "Agenti live".
import { randomUUID } from 'crypto';
import { join } from 'path';
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { readJson, writeJson, DATA_DIR, existsSync, mkdirSync } from './store.js';
import { logAudit } from './audit.js';
import { createTask } from './tasks.js';

export const CEOMAIL_DIR = join(DATA_DIR, 'ceo-mail');
const THREADS_FILE = join(CEOMAIL_DIR, 'threads.json');

// Max scambi (messaggi consegnati) per thread prima dello stop anti-loop.
// Raggiunti i 6, il 7° send è rifiutato e il thread passa a "awaiting_owner".
export const MAX_EXCHANGES = 6;

export const CEOMAIL_MCP_TOOLS = ['mcp__ceomail__send_to_ceo'];

function loadThreads() {
  return readJson(THREADS_FILE, { threads: [] }).threads ?? [];
}

function saveThreads(threads) {
  if (!existsSync(CEOMAIL_DIR)) mkdirSync(CEOMAIL_DIR, { recursive: true });
  writeJson(THREADS_FILE, { threads });
}

// ---- Lettura (per la PWA / gli endpoint HTTP) ----
export function listThreads() {
  return loadThreads().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getThread(id) {
  return loadThreads().find((t) => t.id === id) ?? null;
}

// Thread che coinvolgono un dato tenant (mittente o destinatario di almeno un
// messaggio, o partecipante): usata dagli endpoint per filtrare sui permessi.
export function listThreadsForTenant(tenantId) {
  return listThreads().filter((t) => (t.participants ?? []).includes(tenantId));
}

const ceoOf = (tenant) => tenant?.agents?.find((a) => a.role === 'CEO') ?? null;
const sortedPair = (a, b) => [a, b].sort();

// ---- Core: registra il messaggio, applica l'anti-loop, consegna ----
// deps: { tenants (array config), notify (push a Owner), deliver (crea la run
// destinataria; default = board task sul tenant destinatario). Iniettabili per
// i test a quota zero (ceomail-check.mjs).
export function sendToCeo(
  { fromTenant, fromAgentId, fromAgentName, toTenantId, message, threadId },
  { tenants, notify, deliver = defaultDeliver } = {},
) {
  const text = String(message ?? '').trim();
  if (!text) throw new Error('messaggio vuoto');
  if (!toTenantId || toTenantId === fromTenant) throw new Error('destinatario non valido (non puoi scrivere a te stesso)');

  const destTenant = (tenants ?? []).find((t) => t.id === toTenantId);
  if (!destTenant) throw new Error(`tenant destinatario non trovato: ${toTenantId} (disponibili → ${(tenants ?? []).map((t) => t.id).join(', ')})`);
  const destCeo = ceoOf(destTenant);
  if (!destCeo) throw new Error(`il tenant ${toTenantId} non ha un CEO a cui consegnare`);

  const threads = loadThreads();
  let thread = threadId ? threads.find((t) => t.id === threadId) : null;
  const now = new Date().toISOString();

  if (thread && (thread.status === 'awaiting_owner' || thread.status === 'closed')) {
    // Thread già fermato — dall'anti-loop ('awaiting_owner') o esplicitamente
    // da Owner ('closed', stopThread): nessuna nuova run finché non si sblocca.
    const reason = thread.status === 'closed'
      ? 'Thread fermato da Owner: nessun altro messaggio finché non lo sblocca.'
      : `Thread in attesa di Owner (raggiunti ${MAX_EXCHANGES} scambi): nessun altro messaggio finché non lo sblocca.`;
    logAudit({ user: `agent:${fromAgentId}`, tenant: fromTenant, agent: fromAgentId, event: 'ceomail_blocked', detail: { threadId: thread.id, to: toTenantId, exchanges: thread.exchanges, reason: thread.status } });
    return { blocked: true, status: thread.status, threadId: thread.id, exchanges: thread.exchanges, reason };
  }

  // Anti-loop: soglia raggiunta → stop, niente delivery, escalation a Owner.
  if (thread && thread.exchanges >= MAX_EXCHANGES) {
    thread.status = 'awaiting_owner';
    thread.updatedAt = now;
    saveThreads(threads);
    logAudit({ user: `agent:${fromAgentId}`, tenant: fromTenant, agent: fromAgentId, event: 'ceomail_loop_stop', detail: { threadId: thread.id, to: toTenantId, exchanges: thread.exchanges, max: MAX_EXCHANGES } });
    if (notify) {
      notify({
        title: `📪 Thread CEO fermato (${MAX_EXCHANGES} scambi)`,
        body: `${fromAgentName} (${fromTenant}) → ${destCeo.name} (${toTenantId}): raggiunto il limite anti-loop, thread in attesa di una tua decisione.`,
        tag: `ceomail-loop-${thread.id}`,
      }).catch?.(() => {});
    }
    return { blocked: true, status: 'awaiting_owner', threadId: thread.id, exchanges: thread.exchanges, reason: `Limite anti-loop raggiunto (${MAX_EXCHANGES} scambi): thread messo in attesa di Owner, nessuna run generata.` };
  }

  // Nuovo thread se serve.
  if (!thread) {
    thread = {
      id: randomUUID(),
      participants: sortedPair(fromTenant, toTenantId),
      status: 'active',
      exchanges: 0,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    threads.push(thread);
  }

  const entry = {
    id: randomUUID(),
    fromTenant,
    fromAgent: fromAgentId,
    fromAgentName: fromAgentName ?? fromAgentId,
    toTenant: toTenantId,
    text,
    at: now,
  };
  thread.messages.push(entry);
  thread.exchanges += 1;
  thread.updatedAt = now;
  saveThreads(threads);

  // Consegna come run del CEO destinatario (meccanismo del dispatcher: board task).
  const delivery = deliver({ destTenant, destCeo, thread, entry, fromAgentName: entry.fromAgentName });

  // Journal: ogni messaggio inter-CEO + il valore del contatore anti-loop.
  logAudit({
    user: `agent:${fromAgentId}`, tenant: fromTenant, agent: fromAgentId, event: 'ceomail_sent',
    detail: { threadId: thread.id, to: toTenantId, toCeo: destCeo.id, exchanges: thread.exchanges, max: MAX_EXCHANGES, taskId: delivery?.taskId ?? null },
  });

  return {
    ok: true, threadId: thread.id, exchanges: thread.exchanges, remaining: MAX_EXCHANGES - thread.exchanges,
    deliveredTo: `${destCeo.name} (${toTenantId})`, taskId: delivery?.taskId ?? null,
  };
}

// Consegna di default: crea una board task sul tenant destinatario assegnata al
// suo CEO. Il dispatcher la prende al tick successivo e la trasforma in una run
// (journal/Agenti live), esattamente come qualsiasi altra task.
function defaultDeliver({ destTenant, destCeo, thread, entry, fromAgentName }) {
  const description = [
    `📨 Messaggio da un altro CEO (messaggistica cross-tenant tra CEO).`,
    '',
    `Da: ${fromAgentName} — CEO di ${entry.fromTenant}`,
    `Thread: ${thread.id} (scambio ${thread.exchanges}/${MAX_EXCHANGES})`,
    '',
    `Messaggio:`,
    entry.text,
    '',
    `--- Come rispondere ---`,
    `Se serve replicare, usa il tool send_to_ceo con toTenantId="${entry.fromTenant}" e threadId="${thread.id}" (STESSO thread, così resta un unico filo e conta per l'anti-loop).`,
    `Anti-loop: max ${MAX_EXCHANGES} scambi per thread; oltre, il thread si ferma e decide Owner. Rispondi solo se serve davvero.`,
    `Quando hai gestito il messaggio (letto ed eventualmente risposto), consegna la task con update_task status "review_manager".`,
  ].join('\n');
  const task = createTask(destTenant.id, {
    title: `📨 Messaggio da CEO ${entry.fromTenant}`,
    description,
    status: 'todo',
    urgency: 'alta',
    assignedTo: `agent:${destCeo.id}`,
  }, `ceomail:${entry.fromTenant}`);
  return { taskId: task.id };
}

// ---- Tool MCP send_to_ceo (esposto SOLO ai CEO, vedi runturn/access.js) ----
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

export function ceomailTools(tenant, agentId, { tenants, notify } = {}) {
  const agent = tenant.agents.find((a) => a.id === agentId);
  const fromAgentName = agent?.name ?? agentId;
  // Destinatari possibili: gli altri tenant con un CEO (escluso il proprio).
  const dests = (tenants ?? [])
    .filter((t) => t.id !== tenant.id && t.agents?.some((a) => a.role === 'CEO'))
    .map((t) => `${t.id} (${t.name})`)
    .join(', ');
  return [
    tool(
      'send_to_ceo',
      `Invia un messaggio ASINCRONO al CEO di un altro business della piattaforma (messaggistica cross-tenant tra CEO). Il messaggio viene consegnato come una task/run sulla board del destinatario: risponde quando può, non è una chat sincrona. Owner vede sempre tutto il thread e può fermarlo. ANTI-LOOP: max ${MAX_EXCHANGES} scambi per thread, poi si ferma e decide Owner — usa lo stesso threadId per continuare un filo esistente, ometti threadId per aprirne uno nuovo. Destinatari disponibili: ${dests || '(nessun altro tenant con CEO)'}.`,
      {
        toTenantId: z.string().describe('Id del tenant destinatario (il suo CEO riceverà il messaggio).'),
        message: z.string().describe('Il messaggio per l\'altro CEO.'),
        threadId: z.string().optional().describe('Id di un thread esistente per continuare la conversazione (ometti per aprirne uno nuovo).'),
      },
      async ({ toTenantId, message, threadId }) => {
        try {
          const res = sendToCeo(
            { fromTenant: tenant.id, fromAgentId: agentId, fromAgentName, toTenantId, message, threadId },
            { tenants, notify },
          );
          return ok(res);
        } catch (err) {
          return ok({ error: err.message });
        }
      },
    ),
  ];
}

export function buildCeomailMcpServer(tenant, agentId, opts = {}) {
  return createSdkMcpServer({ name: 'ceomail', version: '1.0.0', tools: ceomailTools(tenant, agentId, opts) });
}

// Sblocco manuale di Owner (endpoint HTTP): riporta il thread ad "active" e
// azzera il contatore così può ripartire. Ritorna il thread aggiornato o null.
export function resumeThread(threadId) {
  const threads = loadThreads();
  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return null;
  thread.status = 'active';
  thread.exchanges = 0;
  thread.updatedAt = new Date().toISOString();
  saveThreads(threads);
  logAudit({ user: 'user', event: 'ceomail_thread_resumed', detail: { threadId } });
  return thread;
}

// Delivery del messaggio di Owner: stesso MECCANISMO di defaultDeliver (board
// task sul tenant destinatario, assegnata al suo CEO) ma testo dedicato — a
// differenza di un messaggio tra CEO qui non c'è un "mittente tenant" a cui
// rispondere, c'è l'ALTRO partecipante del thread.
function ownerDeliver({ destTenant, destCeo, thread, entry }) {
  const otherParticipant = (thread.participants ?? []).find((p) => p !== destTenant.id) ?? null;
  const description = [
    `👤 Messaggio di Owner in un thread di messaggistica tra CEO.`,
    '',
    `Thread: ${thread.id}${otherParticipant ? ` (con ${otherParticipant})` : ''}`,
    '',
    `Messaggio di Owner:`,
    entry.text,
    '',
    `--- Come rispondere ---`,
    otherParticipant
      ? `Se serve continuare la conversazione, usa il tool send_to_ceo con toTenantId="${otherParticipant}" e threadId="${thread.id}" (stesso thread).`
      : null,
    `Quando hai gestito il messaggio, consegna la task con update_task status "review_manager".`,
  ].filter(Boolean).join('\n');
  const task = createTask(destTenant.id, {
    title: `👤 Messaggio di Owner nel thread CEO`,
    description,
    status: 'todo',
    urgency: 'alta',
    assignedTo: `agent:${destCeo.id}`,
  }, `ceomail-owner:${thread.id}`);
  return { taskId: task.id };
}

// Inserimento di un messaggio di Owner in un thread esistente (endpoint HTTP,
// task board a5a5e758): NON passa da sendToCeo (niente mittente-tenant, niente
// cap anti-loop) ma riusa lo stesso meccanismo di consegna (board task → run).
// Consegna a ENTRAMBI i CEO partecipanti (vedi commento in testa al file).
// Se il thread era 'awaiting_owner' lo riporta 'active' con exchanges=0 (il
// messaggio stesso è lo sblocco); se era 'closed' resta 'closed' (stop
// esplicito, serve un resume esplicito — un messaggio non lo riapre da solo).
// Ritorna il thread aggiornato, o null se l'id non esiste.
export function addOwnerMessage(threadId, text, { tenants, deliver = ownerDeliver } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('messaggio vuoto');
  const threads = loadThreads();
  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return null;
  const now = new Date().toISOString();

  const entry = {
    id: randomUUID(), fromTenant: null, fromAgent: 'owner', fromAgentName: 'Owner', toTenant: null, text: clean, at: now,
  };
  thread.messages.push(entry);
  thread.updatedAt = now;

  const wasAwaitingOwner = thread.status === 'awaiting_owner';
  if (wasAwaitingOwner) {
    thread.status = 'active';
    thread.exchanges = 0;
  }
  saveThreads(threads);

  const taskIds = [];
  for (const tenantId of thread.participants ?? []) {
    const destTenant = (tenants ?? []).find((t) => t.id === tenantId);
    const destCeo = destTenant ? ceoOf(destTenant) : null;
    if (!destTenant || !destCeo) continue;
    const delivery = deliver({ destTenant, destCeo, thread, entry });
    if (delivery?.taskId) taskIds.push(delivery.taskId);
  }

  logAudit({ user: 'user', event: 'ceomail_owner_message', detail: { threadId, taskIds, reopened: wasAwaitingOwner } });
  return thread;
}

// Stop manuale di Owner (endpoint HTTP, task board a5a5e758): porta il thread
// a 'closed', stato distinto da 'awaiting_owner' (quello è il cap anti-loop
// automatico) ma con la STESSA guardia di blocco su sendToCeo — vedi il check
// unificato in sendToCeo sopra. Ritorna il thread aggiornato o null.
export function stopThread(threadId) {
  const threads = loadThreads();
  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return null;
  thread.status = 'closed';
  thread.updatedAt = new Date().toISOString();
  saveThreads(threads);
  logAudit({ user: 'user', event: 'ceomail_thread_stopped', detail: { threadId } });
  return thread;
}
