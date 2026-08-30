// Kill switch GLOBALE della piattaforma (task 16fb8517). Owner può mettere in
// pausa TUTTA la piattaforma con un tap da "Agenti live". Semantica (decisa dal
// CEO, non riaprire qui):
//   - pausa GLOBALE (tutti i tenant), non per-tenant;
//   - SOFT pause: le run già in corso NON vengono uccise, finiscono il loro
//     giro. NON parte nulla di nuovo (dispatcher, job cron/schedulati, avvio
//     run da chat/board). L'eventuale "hard" (stop delle run attive) lo fa il
//     client riusando il per-run stop già esistente: qui nessun nuovo path di kill.
//   - stato PERSISTITO: se Owner mette in pausa e il container riparte
//     (restart/autorestart), resta in pausa.
//
// Deep module a interfaccia minima (stesso pattern di ratelimit.js): un solo
// posto tiene lo stato, gli enforcement point (dispatcher, scheduleRun/drainQueue,
// /api/chat) chiamano solo isPlatformPaused(). Persistito in
// server/data/settings.json accanto a claudeLimit/globalAgentCap/autonomy.
// Verità in memoria (idratata dal disco al boot), scrittura solo sui cambi:
// niente I/O nel path caldo di scheduleRun/dispatcher chiamato a ogni tick.
import { join } from 'path';
import { readJson, writeJson, DATA_DIR } from './store.js';

const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

let onChange = null;
export function setPlatformPauseChangeListener(fn) { onChange = fn; }

// { paused: true, since, by, reason } quando in pausa, altrimenti null.
let state = null;
(function hydrate() {
  const p = readJson(SETTINGS_FILE, {}).platformPaused;
  if (p?.paused) {
    state = {
      paused: true,
      since: p.since ?? null,
      by: p.by ?? null,
      reason: p.reason ?? null,
    };
  }
})();

function persist() {
  const all = readJson(SETTINGS_FILE, {});
  if (state) all.platformPaused = state; else delete all.platformPaused;
  writeJson(SETTINGS_FILE, all);
}

// True se la piattaforma è in pausa (unico predicato usato dagli enforcement
// point: dispatcher, scheduleRun/drainQueue, /api/chat).
export function isPlatformPaused() {
  return state !== null;
}

// Stato pubblico per API/UI (banner in Agenti live).
export function getPlatformPauseState() {
  return state
    ? { paused: true, since: state.since, by: state.by, reason: state.reason }
    : { paused: false };
}

// Mette in pausa. Idempotente: se già in pausa non riazzera "since"/"by"
// (chi ha messo in pausa per primo e quando). Torna lo stato pubblico.
export function pausePlatform({ by = null, reason = null } = {}) {
  if (!state) {
    state = {
      paused: true,
      since: new Date().toISOString(),
      by: by ?? null,
      reason: reason ? String(reason).slice(0, 200) : null,
    };
    persist();
    onChange?.(getPlatformPauseState());
  }
  return getPlatformPauseState();
}

// Riprende (esce dalla pausa). Idempotente. Torna lo stato pubblico.
export function resumePlatform() {
  if (state) {
    state = null;
    persist();
    onChange?.(getPlatformPauseState());
  }
  return getPlatformPauseState();
}
