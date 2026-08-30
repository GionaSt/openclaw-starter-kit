// Persistenza server-side delle conversazioni chat per tenant (task 8ed6deb8:
// sync multi-dispositivo — prima le chat vivevano solo sul dispositivo che le
// apriva). Un file JSON per conversazione: data/conversations/<tenantId>/<id>.json
// Schema: { id, tenantId, agentId, title, messages: [{role, text, ts, ...}], createdAt, updatedAt }
//
// Nota: è un layer NUOVO e indipendente dallo storico agentId+sessionId di
// history.js (chat con gli agenti dell'org, con streaming SSE) — qui non lo si
// tocca, niente rischio di perdita dati esistenti. Questo store serve alle
// conversazioni "semplici" del cliente che vanno sincronizzate tra dispositivi.
import { readdirSync, unlinkSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { readJson, writeJson, DATA_DIR, safeSegment, tenantScopedDir, tenantScopedFile } from './store.js';

export const CONVERSATIONS_DIR = join(DATA_DIR, 'conversations');

const safe = safeSegment;
const tenantDir = (tenantId) => tenantScopedDir(CONVERSATIONS_DIR, tenantId);
const conversationFile = (tenantId, id) => tenantScopedFile(CONVERSATIONS_DIR, tenantId, id);

function deriveTitle(title, messages) {
  const t = String(title ?? '').trim();
  if (t) return t.slice(0, 120);
  const firstUser = (messages ?? []).find((m) => m.role === 'user' && m.text);
  if (firstUser) return firstUser.text.trim().slice(0, 80);
  return 'Nuova conversazione';
}

// Normalizza/valida un messaggio in ingresso (create/append/import). Ammette
// campi extra (es. attachments) e li preserva così com'è.
function normalizeMessage(m) {
  if (!m || typeof m !== 'object') throw new Error('messaggio non valido');
  const role = String(m.role ?? '').trim();
  if (!role) throw new Error('role richiesto nel messaggio (es. "user"/"assistant")');
  if (m.text == null || String(m.text).trim() === '') throw new Error('text richiesto nel messaggio');
  return { ...m, role, text: String(m.text), ts: Number.isFinite(m.ts) ? m.ts : Date.now() };
}

export function listConversations(tenantId, { agentId } = {}) {
  const dir = tenantDir(tenantId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(dir, f), null))
    .filter((c) => c && (!agentId || c.agentId === agentId))
    .map(({ id, tenantId: tid, agentId: a, title, messages, createdAt, updatedAt }) => ({
      id, tenantId: tid, agentId: a ?? null, title, messageCount: messages.length, createdAt, updatedAt,
    }))
    .sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
}

export function getConversation(tenantId, id) {
  if (!id || safe(id) !== id) return null;
  return readJson(conversationFile(tenantId, id), null);
}

export function createConversation(tenantId, { id, agentId = null, title, messages = [], createdAt, updatedAt } = {}) {
  if (!Array.isArray(messages)) throw new Error('messages deve essere un array');
  const normalized = messages.map(normalizeMessage);
  const useId = id && safe(id) === id ? id : randomUUID();
  const now = new Date().toISOString();
  const record = {
    id: useId,
    tenantId,
    agentId: agentId || null,
    title: deriveTitle(title, normalized),
    messages: normalized,
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
  };
  writeJson(conversationFile(tenantId, useId), record);
  return record;
}

export function appendMessage(tenantId, id, message) {
  const conv = getConversation(tenantId, id);
  if (!conv) throw new Error('conversazione non trovata');
  const normalized = normalizeMessage(message);
  conv.messages.push(normalized);
  if (!String(conv.title ?? '').trim() && normalized.role === 'user') {
    conv.title = deriveTitle(null, [normalized]);
  }
  conv.updatedAt = new Date().toISOString();
  writeJson(conversationFile(tenantId, id), conv);
  return conv;
}

export function deleteConversation(tenantId, id) {
  const file = conversationFile(tenantId, id);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

// Import bulk (migrazione chat locali dal client, task 8ed6deb8): ogni voce
// crea una nuova conversazione oppure, se porta un id già esistente su questo
// tenant, fa merge non distruttivo dei soli messaggi nuovi (dedupe per
// role+text+ts) — così un import ripetuto dallo stesso device è idempotente e
// non duplica né perde nulla di già sincronizzato.
export function importConversations(tenantId, items) {
  const imported = [];
  const errors = [];
  items.forEach((item, index) => {
    try {
      if (!item || typeof item !== 'object') throw new Error('voce non valida');
      const existing = item.id ? getConversation(tenantId, item.id) : null;
      if (existing) {
        const incoming = (item.messages ?? []).map(normalizeMessage);
        const seen = new Set(existing.messages.map((m) => `${m.role}|${m.text}|${m.ts}`));
        for (const m of incoming) {
          const key = `${m.role}|${m.text}|${m.ts}`;
          if (!seen.has(key)) { existing.messages.push(m); seen.add(key); }
        }
        if (!String(existing.title ?? '').trim() && item.title) existing.title = deriveTitle(item.title, existing.messages);
        existing.updatedAt = new Date().toISOString();
        writeJson(conversationFile(tenantId, existing.id), existing);
        imported.push({ id: existing.id, merged: true, messageCount: existing.messages.length });
      } else {
        const conv = createConversation(tenantId, item);
        imported.push({ id: conv.id, merged: false, messageCount: conv.messages.length });
      }
    } catch (err) {
      errors.push({ index, error: err.message });
    }
  });
  return { imported, errors };
}
