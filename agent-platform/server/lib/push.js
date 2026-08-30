// Notifiche push PWA con web-push. Chiavi VAPID generate al primo avvio e
// persistite in data/vapid.json (gitignored: contiene la chiave privata).
import webpush from 'web-push';
import https from 'https';
import { EventEmitter } from 'events';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { readJson, writeJson, DATA_DIR, CONFIG_DIR } from './store.js';
import { logAudit } from './audit.js';

const VAPID_FILE = join(DATA_DIR, 'vapid.json');
const SUBS_FILE = join(DATA_DIR, 'push_subscriptions.json');

// Seam SOLO per i test (mai attivo in produzione, l'env non è mai settato lì):
// se PUSH_CAPTURE_LOG punta a un file, intercetta le richieste HTTPS che
// web-push apre in uscita e le registra su file invece di aprire una vera
// connessione di rete verso il push service. Serve a verificare che una PUSH
// REALE (cifratura aes128gcm, header VAPID reali, endpoint della subscription)
// sia stata generata e inviata dal codice di produzione — senza dipendere da
// un push service esterno raggiungibile dal sandbox (task board 553ea6b1).
if (process.env.PUSH_CAPTURE_LOG) {
  const LOG = process.env.PUSH_CAPTURE_LOG;
  https.request = (options, cb) => {
    const req = new EventEmitter();
    let body = Buffer.alloc(0);
    req.write = (chunk) => {
      body = Buffer.concat([body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
      return true;
    };
    req.end = (chunk) => {
      if (chunk) req.write(chunk);
      try {
        appendFileSync(LOG, `${JSON.stringify({
          at: new Date().toISOString(),
          hostname: options.hostname, port: options.port, path: options.path,
          method: options.method, headers: options.headers,
          bodyLength: body.length,
        })}\n`);
      } catch { /* best-effort: non deve rompere il test */ }
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = 201;
        res.headers = {};
        cb?.(res);
        res.emit('data', Buffer.from(''));
        res.emit('end');
      });
    };
    req.destroy = () => {};
    return req;
  };
  console.warn(`[test] richieste HTTPS di web-push intercettate e loggate in ${LOG} (PUSH_CAPTURE_LOG)`);
}

const platformCfg = readJson(join(CONFIG_DIR, 'platform.json'), {})?.push ?? {};
export const PUSH_ENABLED = platformCfg.enabled !== false;
export const LONG_RUN_THRESHOLD_MS = platformCfg.longRunThresholdMs ?? 60000;

let vapid = readJson(VAPID_FILE, null);
if (!vapid) {
  vapid = webpush.generateVAPIDKeys();
  writeJson(VAPID_FILE, vapid);
  console.log('[push] Chiavi VAPID generate in data/vapid.json');
}

// Il claim VAPID "sub" DEVE essere un mailto: o https: instradabile. Apple Web
// Push (endpoint iOS *.push.apple.com) valida il JWT ed è più severo di FCM:
// con un subject non valido rifiuta con 400/403 e l'invio si perde. TLD riservati
// (.local/.localhost/.test/.invalid/.example, RFC 2606/6762) NON sono instradabili.
// Bug board a5f06236: subject era mailto:...@agent-platform.local → push a Owner
// (unico endpoint: Apple) potenzialmente rifiutate senza traccia.
const DEFAULT_SUBJECT = 'mailto:admin@example.com';
export const PUSH_SUBJECT = platformCfg.subject ?? DEFAULT_SUBJECT;
export function subjectLooksValid(s) {
  if (typeof s !== 'string' || !s) return false;
  if (/^https:\/\/[^\s]+\.[^\s]+/i.test(s)) return true;
  const m = s.match(/^mailto:[^@\s]+@([^@\s]+)$/i);
  if (!m) return false;
  const host = m[1].toLowerCase();
  if (!host.includes('.')) return false;
  if (/\.(local|localhost|internal|test|invalid|example|localdomain)$/.test(host)) return false;
  return true;
}
if (!subjectLooksValid(PUSH_SUBJECT)) {
  console.warn(`[push] VAPID subject "${PUSH_SUBJECT}" non instradabile: Apple Web Push (iOS) può rifiutare il JWT e l'invio fallisce. Usa un mailto: con TLD reale o un https:. Vedi platform.json > push.subject`);
  try { logAudit({ tenant: 'platform', event: 'push_subject_invalid', detail: { subject: PUSH_SUBJECT } }); } catch { /* best-effort */ }
}
webpush.setVapidDetails(PUSH_SUBJECT, vapid.publicKey, vapid.privateKey);

export const vapidPublicKey = () => vapid.publicKey;

// Subscription per utente: { username: [subscription, ...] }
function loadSubs() { return readJson(SUBS_FILE, {}); }
function saveSubs(subs) { writeJson(SUBS_FILE, subs); }

export function addSubscription(username, subscription) {
  if (!subscription?.endpoint) throw new Error('subscription non valida');
  const subs = loadSubs();
  const mine = subs[username] ?? [];
  if (!mine.some((s) => s.endpoint === subscription.endpoint)) mine.push(subscription);
  subs[username] = mine;
  saveSubs(subs);
}

export function removeSubscription(username, endpoint) {
  const subs = loadSubs();
  subs[username] = (subs[username] ?? []).filter((s) => s.endpoint !== endpoint);
  saveSubs(subs);
}

function endpointHost(endpoint) {
  try { return new URL(endpoint).host; } catch { return 'unknown'; }
}

async function sendTo(username, payload, tenantId) {
  const subs = loadSubs();
  const mine = subs[username] ?? [];
  const stats = { attempted: mine.length, delivered: 0, failed: 0, expired: 0 };
  let dirty = false;
  for (const sub of [...mine]) {
    const host = endpointHost(sub.endpoint);
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      stats.delivered++;
    } catch (err) {
      const code = err.statusCode ?? null;
      if (code === 404 || code === 410) {
        // Subscription scaduta/revocata: rimuovi e traccia (non è un errore vero,
        // ma va registrata: se resta zero sub, Owner smette di ricevere).
        subs[username] = subs[username].filter((s) => s.endpoint !== sub.endpoint);
        dirty = true;
        stats.expired++;
        logAudit({ user: username, tenant: tenantId, event: 'push_subscription_expired', detail: { host, statusCode: code, title: payload.title } });
      } else {
        // Bug board a5f06236: prima solo console.warn → fallimento silenzioso.
        // Caso tipico iOS/Apple: 400/403 (es. VAPID subject invalido). Ora nel journal.
        stats.failed++;
        console.warn(`[push] invio fallito a ${username} (${host}):`, err.message);
        logAudit({ user: username, tenant: tenantId, event: 'push_delivery_failed', detail: { host, statusCode: code, message: String(err.message ?? '').slice(0, 200), title: payload.title } });
      }
    }
  }
  if (dirty) saveSubs(subs);
  return stats;
}

// Notifica tutti gli utenti che hanno accesso al tenant (rispetta i permessi).
// Ritorna un riepilogo { recipients, attempted, delivered, failed, expired }.
// Registra SEMPRE un evento nel journal (feed in-app + diagnosi): push_sent con
// esito reale se almeno una sub è stata tentata, altrimenti push_no_subscription
// (bug a5f06236: prima push_sent era incondizionato e nascondeva i fallimenti).
export async function notifyTenant(tenantId, payload, { loadUsers, userCanTenant }) {
  if (!PUSH_ENABLED) return { skipped: true, recipients: 0, attempted: 0, delivered: 0, failed: 0, expired: 0 };
  const agg = { recipients: 0, attempted: 0, delivered: 0, failed: 0, expired: 0 };
  for (const user of loadUsers()) {
    if (userCanTenant(user, tenantId)) {
      agg.recipients++;
      const s = await sendTo(user.username, { tenantId, ...payload }, tenantId);
      agg.attempted += s.attempted; agg.delivered += s.delivered; agg.failed += s.failed; agg.expired += s.expired;
    }
  }
  if (agg.attempted === 0) {
    // Nessuna subscription attiva (o nessun destinatario): l'evento esiste comunque
    // per il feed in-app (task 31797bb5), così Owner vede l'attività anche senza push.
    logAudit({ tenant: tenantId, event: 'push_no_subscription', detail: { title: payload.title, recipients: agg.recipients } });
  } else {
    logAudit({ tenant: tenantId, event: 'push_sent', detail: { title: payload.title, recipients: agg.recipients, delivered: agg.delivered, failed: agg.failed, expired: agg.expired } });
  }
  return agg;
}
