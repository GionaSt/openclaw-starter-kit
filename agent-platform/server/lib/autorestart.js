// Auto-restart della piattaforma (task board 03a4d9d6).
// -----------------------------------------------------------------------------
// Obiettivo: mai più riavvii manuali da CLI. Quando una modifica a server/**
// richiede il restart per andare live (codice stantio, vedi /api/version), la
// piattaforma si riavvia DA SOLA in sicurezza — solo quando non ci sono run
// attive né chat interattiva in corso, dentro una finestra opzionale e con un
// tetto anti-loop di N restart/ora.
//
// Questo modulo è la MACCHINA A STATI PURA della decisione (testabile a zero
// quota) + la persistenza di due file di stato in DATA_DIR:
//   - autorestart-history.json : timestamp dei restart auto (rate limit /ora)
//   - autorestart-pending.json : marker scritto PRIMA dell'uscita, letto al
//     boot successivo per la verifica post-restart e la notifica a Owner.
//
// PRECONDIZIONE (task collegata 49bcf241): l'auto-restart parte SOLO se la
// restart-policy Docker è attiva (config.dockerPolicyConfirmed) E l'auto-restart
// è abilitato (config.enabled). Finché Owner non conferma la policy, la feature
// è inerte: il flag restartNeeded e la UI funzionano, ma nessun process.exit.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson, DATA_DIR, CONFIG_DIR } from './store.js';

const HOUR_MS = 3_600_000;

export const DEFAULT_CONFIG = {
  enabled: false,               // OFF di default — leva esplicita di Owner
  dockerPolicyConfirmed: false, // gate precondizione (task 49bcf241)
  idleMs: 120_000,              // 2 min senza chat interattiva
  maxPerHour: 3,                // anti-loop
  postRestartTimeoutMs: 90_000, // atteso max per la risalita del container
  windowStart: null,            // "HH:MM" opzionale (null = sempre attivo)
  windowEnd: null,              // "HH:MM"
};

const historyFile = () => join(DATA_DIR, 'autorestart-history.json');
const markerFile = () => join(DATA_DIR, 'autorestart-pending.json');

// ---- Config ---------------------------------------------------------------
export function loadConfig() {
  const raw = readJson(join(CONFIG_DIR, 'platform.json'), {})?.autoRestart ?? {};
  return { ...DEFAULT_CONFIG, ...raw };
}

// ---- Attività interattiva (chat di Owner) ---------------------------------
// Timestamp in-process dell'ultimo messaggio interattivo: marcato dall'ingresso
// POST /api/chat. Non persistito: un restart azzera l'idle, ma è corretto —
// dopo un restart la chat è comunque ripartita da zero.
let lastInteractiveAt = 0;
export function markInteractive(now = Date.now()) { lastInteractiveAt = now; }
export function idleSince(now = Date.now()) {
  return lastInteractiveAt ? now - lastInteractiveAt : Infinity;
}

// ---- Rate limit (restart/ora) ---------------------------------------------
export function loadHistory(now = Date.now()) {
  const h = readJson(historyFile(), []);
  return (Array.isArray(h) ? h : []).filter((t) => typeof t === 'number' && now - t < HOUR_MS);
}
export function recordRestart(now = Date.now()) {
  const h = loadHistory(now);
  h.push(now);
  writeJson(historyFile(), h);
  return h;
}
export function restartsLastHour(now = Date.now()) { return loadHistory(now).length; }

// ---- Finestra oraria opzionale --------------------------------------------
function parseHM(s) {
  if (typeof s !== 'string' || !/^\d{1,2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}
export function inWindow(config, now = Date.now()) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const s = parseHM(cfg.windowStart);
  const e = parseHM(cfg.windowEnd);
  if (s == null || e == null) return true; // nessuna finestra valida = sempre
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e); // a cavallo mezzanotte
}

// ---- Decisione (pura) ------------------------------------------------------
// Ritorna sempre { restartNeeded, shouldRestart, reason, detail } — restartNeeded
// riflette la sola staleness (usato dalla UI), shouldRestart include TUTTI i gate.
export function decide({ stale, activeRuns = 0, now = Date.now(), config, idleMsNow } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const idle = idleMsNow != null ? idleMsNow : idleSince(now);
  if (!stale) return { restartNeeded: false, shouldRestart: false, reason: 'up-to-date', detail: {} };

  const block = (reason, detail = {}) => ({ restartNeeded: true, shouldRestart: false, reason, detail: { ...detail, cfg: { enabled: cfg.enabled } } });

  if (!cfg.enabled) return block('disabled');
  if (!cfg.dockerPolicyConfirmed) return block('docker-policy-unconfirmed');
  if (activeRuns > 0) return block('active-runs', { activeRuns });
  if (idle < cfg.idleMs) return block('not-idle', { idleMs: idle, needMs: cfg.idleMs });
  if (!inWindow(cfg, now)) return block('out-of-window', { windowStart: cfg.windowStart, windowEnd: cfg.windowEnd });
  const recent = restartsLastHour(now);
  if (recent >= cfg.maxPerHour) return block('rate-limited', { recent, maxPerHour: cfg.maxPerHour });

  return { restartNeeded: true, shouldRestart: true, reason: 'ok', detail: {} };
}

// ---- Marker post-restart ---------------------------------------------------
export function writePendingMarker(marker) { writeJson(markerFile(), marker); }
export function readPendingMarker() { return readJson(markerFile(), null); }
export function clearPendingMarker() {
  try { rmSync(markerFile(), { force: true }); } catch { /* ignore */ }
}
