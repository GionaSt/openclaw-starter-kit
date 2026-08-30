// Storico conversazioni per tenant: data/history/<tenantId>/<agentId>__<sessionId>.json
// Archivio (reset chat non distruttivo): data/history/<tenantId>/archive/*.json
import { readdirSync, renameSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { readJson, writeJson, DATA_DIR, safeSegment, tenantScopedDir } from './store.js';

export const HISTORY_DIR = join(DATA_DIR, 'history');
mkdirSync(HISTORY_DIR, { recursive: true });

const safe = safeSegment;

export function historyFile(tenantId, agentId, sessionId) {
  return join(tenantScopedDir(HISTORY_DIR, tenantId), `${safe(agentId)}__${safe(sessionId)}.json`);
}

export function loadHistory(tenantId, agentId, sessionId) {
  return readJson(historyFile(tenantId, agentId, sessionId), []);
}

export function appendHistory(tenantId, agentId, sessionId, entry) {
  const h = loadHistory(tenantId, agentId, sessionId);
  h.push({ ...entry, ts: Date.now() });
  writeJson(historyFile(tenantId, agentId, sessionId), h);
}

// Migrazione una tantum dal vecchio layout piatto tenant__agent__session.json
export function migrateFlatHistory() {
  for (const f of readdirSync(HISTORY_DIR)) {
    if (!f.endsWith('.json')) continue;
    const parts = f.slice(0, -5).split('__');
    if (parts.length < 3) continue;
    const [tenantId, agentId, ...rest] = parts;
    const dest = historyFile(tenantId, agentId, rest.join('__'));
    mkdirSync(join(HISTORY_DIR, safe(tenantId)), { recursive: true });
    renameSync(join(HISTORY_DIR, f), dest);
    console.log(`[history] migrato ${f} -> ${dest}`);
  }
}

// ---- Archiviazione (il reset chat non cancella mai) ----
function archiveDir(tenantId) {
  return join(tenantScopedDir(HISTORY_DIR, tenantId), 'archive');
}

export function archiveConversation(tenantId, agentId, sessionId, archivedBy) {
  const src = historyFile(tenantId, agentId, sessionId);
  if (!existsSync(src)) return null;
  const messages = readJson(src, []);
  if (messages.length === 0) return null;
  const firstUser = messages.find((m) => m.role === 'user');
  const archivedAt = new Date().toISOString();
  const id = `${safe(agentId)}__${safe(sessionId)}__${Date.now()}`;
  const dir = archiveDir(tenantId);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, `${id}.json`), {
    id,
    tenantId,
    agentId,
    sessionId,
    archivedAt,
    archivedBy,
    title: (firstUser?.text ?? 'Conversazione').slice(0, 80),
    messages,
  });
  rmSync(src); // il contenuto vive ora nel file di archivio
  return { id, archivedAt, count: messages.length };
}

export function listArchived(tenantId, agentId) {
  const dir = archiveDir(tenantId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(dir, f), null))
    .filter((c) => c && (!agentId || c.agentId === agentId))
    .map(({ id, agentId: a, sessionId, archivedAt, title, messages }) => ({
      id, agentId: a, sessionId, archivedAt, title, count: messages.length,
    }))
    .sort((x, y) => (x.archivedAt < y.archivedAt ? 1 : -1));
}

export function getArchived(tenantId, id) {
  if (safe(id) !== id) return null;
  return readJson(join(archiveDir(tenantId), `${id}.json`), null);
}
