// Risoluzione UNICA della radice workspace OpenClaw dentro la Agent Platform.
// In produzione (container) il compose monta il workspace read-only e imposta
// OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace. In dev/test l'env puo'
// mancare: fallback = parent della repo locale (layout storico workspace/
// agent-platform-live). Nessun path hardcoded duplicato altrove.
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url)); // server/lib
const SERVER_DIR = dirname(HERE);
const REPO_DIR = dirname(SERVER_DIR);

export const OPENCLAW_WORKSPACE = process.env.OPENCLAW_WORKSPACE_DIR || resolve(REPO_DIR, '..');
