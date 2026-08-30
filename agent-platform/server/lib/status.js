// Registro delle sessioni agente (tab "Agenti attivi") + hub WebSocket.
// Stato derivato dagli eventi del SDK: working | needs_input | completed | error.
import { join } from 'path';
import { WebSocketServer } from 'ws';
import { readJson, writeJson, DATA_DIR } from './store.js';

const STATUS_FILE = join(DATA_DIR, 'agent_sessions.json');
const MAX_EVENTS = 20;

let sessions = readJson(STATUS_FILE, {});
// Al riavvio nessuna run puo' essere ancora in corso: le "working" diventano
// "interrupted" — il watchdog (Sprint 5) le riprenderà dal journal.
for (const s of Object.values(sessions)) {
  if (s.status === 'working' || s.status === 'needs_input' || s.status === 'resumed') {
    s.status = 'interrupted';
    s.lastError = 'server riavviato durante la run';
  }
}
const persist = () => writeJson(STATUS_FILE, sessions);
persist();

export function touchSession(key, fields) {
  const now = new Date().toISOString();
  const s = sessions[key] ?? { key, events: [], startedAt: now };
  Object.assign(s, fields, { lastActivity: now });
  sessions[key] = s;
  persist();
  broadcast(s.tenantId, { type: 'agent_session', session: s });
  return s;
}

export function pushSessionEvent(key, event) {
  const s = sessions[key];
  if (!s) return;
  s.events.push({ ts: new Date().toISOString(), ...event });
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
  s.lastActivity = new Date().toISOString();
  persist();
  broadcast(s.tenantId, { type: 'agent_session', session: s });
}

export function listSessions(tenantId) {
  return Object.values(sessions)
    .filter((s) => !tenantId || s.tenantId === tenantId)
    .sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
}

// ---- WebSocket hub: /ws?token=... ----
let wss = null;
const clients = new Map(); // ws -> user

export function initWebSocket(server, verifyToken, userCanTenant) {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const user = verifyToken(url.searchParams.get('token'));
    if (!user) { ws.close(4401, 'non autenticato'); return; }
    clients.set(ws, { user, userCanTenant });
    ws.on('close', () => clients.delete(ws));
    // Un socket senza listener 'error' fa crashare l'intero processo Node al
    // primo errore di trasporto (EventEmitter senza handler 'error' rilancia):
    // client mobile/proxy instabili lo triggerano spesso (vedi footgun WS
    // half-open in memory/agent-platform-v2-chat-fix.md). Va solo isolato: la
    // pulizia della entry resta a carico di 'close', che ws emette comunque.
    ws.on('error', (err) => console.warn('[ws] errore connessione client:', err.message));
    // Snapshot iniziale delle sessioni visibili all'utente.
    const visible = Object.values(sessions).filter((s) => userCanTenant(user, s.tenantId));
    ws.send(JSON.stringify({ type: 'snapshot', sessions: visible }));
  });
}

export function broadcast(tenantId, payload) {
  if (!wss) return;
  const msg = JSON.stringify(payload);
  for (const [ws, { user, userCanTenant }] of clients) {
    if (ws.readyState === 1 && (!tenantId || userCanTenant(user, tenantId))) {
      try { ws.send(msg); } catch {}
    }
  }
}

// Broadcast con filtro per-utente più fine del tenant (es. eventi run della
// pagina "Agenti live": vanno solo a chi può gestire quell'agente).
// check(user) decide connessione per connessione, lato server.
export function broadcastWhere(check, payload) {
  if (!wss) return;
  const msg = JSON.stringify(payload);
  for (const [ws, { user }] of clients) {
    let ok = false;
    try { ok = check(user); } catch {}
    if (ws.readyState === 1 && ok) {
      try { ws.send(msg); } catch {}
    }
  }
}
