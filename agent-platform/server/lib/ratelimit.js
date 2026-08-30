// Stato GLOBALE del limite Claude (task ca71d849). La subscription Max è una
// sola quota condivisa da TUTTI i tenant/agenti: quando UNA run muore sul muro
// ("You've hit your limit · resets HH:MM (UTC)"), l'intera piattaforma è al
// limite fino al reset. Questo modulo tiene quel muro in un posto solo, così:
//   - il dispatcher/scheduler NON lanciano nuove run autonome nella finestra
//     (anti-raffica, requisito 3: sprecherebbe i primi token del reset);
//   - il watchdog NON tenta resume nella finestra;
//   - la UI mostra il banner "limite Claude raggiunto, ripresa alle HH:MM".
// Al reset lo stato si autoazzera (lazy, alla prima lettura dopo resumeAt) e
// watchdog/dispatcher riprendono da soli.
//
// Persistito in server/data/settings.json (accanto a globalAgentCap/autonomy):
// un riavvio DENTRO la finestra non deve ricausare una raffica. Sorgente di
// verità in memoria (idratata dal disco al boot), scrittura solo sui cambi:
// niente I/O nel path caldo di scheduleRun/drainQueue chiamato a ogni tick.
import { join } from 'path';
import { readJson, writeJson, DATA_DIR } from './store.js';

const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

let onChange = null;
export function setRateLimitChangeListener(fn) { onChange = fn; }

// { resumeAt, since, tenantId, agentId, message } oppure null. In memoria è la
// verità; il disco serve solo a sopravvivere a un riavvio dentro la finestra.
let limit = null;
(function hydrate() {
  const l = readJson(SETTINGS_FILE, {}).claudeLimit;
  if (l?.resumeAt && Date.parse(l.resumeAt) > Date.now()) limit = l;
})();

function persist() {
  const all = readJson(SETTINGS_FILE, {});
  if (limit) all.claudeLimit = limit; else delete all.claudeLimit;
  writeJson(SETTINGS_FILE, all);
}

// Registra/estende il muro fino a resumeAt (ISO, tipicamente reset + buffer:
// lo stesso nextRetryAt della run interrotta, così muro globale e resume della
// run scadono in lockstep). Idempotente: un muro già attivo con reset PIÙ
// LONTANO vince (non lo accorciamo). resumeAt nel passato = no-op.
export function noteUsageLimit({ resumeAt, tenantId = null, agentId = null, message = '' } = {}) {
  const now = Date.now();
  if (!resumeAt || Date.parse(resumeAt) <= now) return getLimitState(now);
  if (limit && Date.parse(limit.resumeAt) > now && Date.parse(limit.resumeAt) >= Date.parse(resumeAt)) {
    return getLimitState(now); // muro esistente uguale o più lungo: invariato
  }
  const firstHit = !(limit && Date.parse(limit.resumeAt) > now);
  limit = {
    resumeAt,
    since: firstHit ? new Date().toISOString() : limit.since,
    tenantId,
    agentId,
    message: String(message ?? '').slice(0, 200),
  };
  persist();
  onChange?.(getLimitState(now));
  return getLimitState(now);
}

// Stato corrente. Se il muro è scaduto lo azzera (lazy) e notifica una volta.
export function getLimitState(now = Date.now()) {
  if (!limit) return { limited: false };
  if (Date.parse(limit.resumeAt) <= now) {
    limit = null;
    persist();
    onChange?.({ limited: false });
    return { limited: false };
  }
  return {
    limited: true,
    resumeAt: limit.resumeAt,
    since: limit.since,
    tenantId: limit.tenantId,
    agentId: limit.agentId,
    message: limit.message,
    resumesInMs: Date.parse(limit.resumeAt) - now,
  };
}

// True se la piattaforma è nel muro del limite (usato da scheduleRun/drainQueue/
// dispatcher/watchdog per non tentare a raffica). Autoazzera se scaduto.
export function isRateLimited(now = Date.now()) {
  return getLimitState(now).limited;
}

// Sblocco manuale (es. Owner sa che il limite è caduto prima): lo stato torna
// libero e al prossimo tick il lavoro riparte.
export function clearRateLimit() {
  if (!limit) return;
  limit = null;
  persist();
  onChange?.({ limited: false });
}
