// Helper di persistenza su file JSON (nessun database, per scelta).
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
// AGENT_PLATFORM_DATA_DIR: override usato SOLO dai test (istanza su porta
// separata con dati isolati); in produzione resta server/data.
export const DATA_DIR = process.env.AGENT_PLATFORM_DATA_DIR || join(SERVER_DIR, 'data');
// AGENT_PLATFORM_CONFIG_DIR: stesso pattern di AGENT_PLATFORM_DATA_DIR, override
// usato SOLO dagli script di verifica che scrivono config (es. agent-jobs-check)
// per non toccare il config/platform.json reale del progetto.
export const CONFIG_DIR = process.env.AGENT_PLATFORM_CONFIG_DIR || join(SERVER_DIR, 'config');
mkdirSync(DATA_DIR, { recursive: true });

// Giorno ISO (YYYY-MM-DD) per chiavi giornaliere condivise (budget, quality gate).
export function isoDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  // Scrittura atomica: evita file troncati se il processo muore a metà.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function appendJsonl(path, entry) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n');
}

// Difesa path traversal per segmenti di path derivati da input utente
// (tenantId, agentId, sessionId, taskId dai parametri delle route): un solo
// posto per la regex, prima duplicata verbatim in 7 moduli (task 3f3d7ab6).
// MOVE puro: stessa identica regex di prima, nessun cambio di comportamento.
export const safeSegment = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
export const tenantScopedDir = (baseDir, tenantId) => join(baseDir, safeSegment(tenantId));
export const tenantScopedFile = (baseDir, tenantId, id, ext = '.json') =>
  join(tenantScopedDir(baseDir, tenantId), `${safeSegment(id)}${ext}`);

export { existsSync, mkdirSync, renameSync, join };
