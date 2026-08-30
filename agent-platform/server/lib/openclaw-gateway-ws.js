// Trasporto WebSocket per i turni V2 (task E3, 2026-08-26).
//
// PERCHE' ESISTE: l'endpoint HTTP OpenAI-compatible del Gateway
// (`/v1/chat/completions`) crea un AbortController LOCALE all'handler e non lo
// registra da nessuna parte, quindi nessuna RPC puo' fermare quel run: verificato
// il 2026-08-26 con `sessions.abort` (per key e per runId, anche su run ancora
// attaccata) -> `no-active-run`, mentre l'agente continuava a lavorare fino a
// fine turno. Il percorso `chat.send` invece registra il run negli
// `chatAbortControllers` del Gateway: `chat.abort` lo ferma davvero e uccide il
// processo del CLI (spike `docs/spike-e3-ws-chatsend-abort-2026-08-26.mjs`:
// 0 file nuovi in 25 s, pid del CLI morto).
//
// Il modello per-run, che su HTTP viaggiava con l'header `x-openclaw-model`, qui
// si imposta con `sessions.create({ key, model })`: V2 usa una sessione dedicata
// per ogni step/fase, quindi modello-per-sessione == modello-per-run.
import crypto, { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './store.js';

const CONNECT_TIMEOUT_MS = 15_000;

// --- Identita' di dispositivo firmata (task E3, 2026-08-27) -----------------
//
// PERCHE': il Gateway concede `operator.write` all'auth a segreto condiviso solo
// se la connessione arriva da LOOPBACK. agent-platform gira in un container
// diverso e arriva da `host.docker.internal`, quindi negoziava scope VUOTI: la
// `chat.send` veniva rifiutata con `missing scope: operator.write` e ogni run
// ricadeva in silenzio sul percorso HTTP, che non e' abortabile. Risultato: il
// tasto "Ferma" metteva in pausa lo stato ma non uccideva l'agent.
// Misurato con un A/B (stesso token, stessa connect, cambia solo l'indirizzo):
//   ws://localhost:18789   -> ["operator.read","operator.write"]
//   ws://172.18.0.3:18789  -> []
//
// La via sanzionata dalla documentazione (`/app/docs/channels/pairing.md`: fuori
// dal bootstrap QR, `operator.*` "requires a separate approved operator pairing")
// e' il PAIRING FIRMATO: il client si genera un'identita' Ed25519, firma il
// payload di `connect` e chiede gli scope. La prima volta il Gateway risponde
// NOT_PAIRED e mette la richiesta in attesa di approvazione; approvata una volta
// sola, il WS funziona DA QUALUNQUE INDIRIZZO senza aprire nulla sulla rete.
//
// La chiave vive in `server/data`, che e' bind-mounted e gitignorato: sopravvive
// ai rebuild dell'immagine (altrimenti ogni deploy chiederebbe un'approvazione
// nuova) e non finisce mai nel repo.
const IDENTITY_PATH = join(DATA_DIR, 'gateway-device-identity.json');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function publicKeyRaw(publicKeyPem) {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ? spki.subarray(ED25519_SPKI_PREFIX.length)
    : spki;
}

// FOOTGUN: il deviceId e' l'HEX dello sha256 della chiave pubblica raw, non il
// base64url. Con il base64url il Gateway risponde DEVICE_AUTH_DEVICE_ID_MISMATCH
// (costato un giro di spike il 2026-08-27).
function deviceIdFrom(publicKeyPem) {
  return crypto.createHash('sha256').update(publicKeyRaw(publicKeyPem)).digest('hex');
}

let cachedIdentity = null;

export function loadOrCreateDeviceIdentity() {
  if (cachedIdentity) return cachedIdentity;
  try {
    const stored = JSON.parse(readFileSync(IDENTITY_PATH, 'utf8'));
    if (stored?.publicKeyPem && stored?.privateKeyPem) {
      cachedIdentity = { deviceId: deviceIdFrom(stored.publicKeyPem), publicKeyPem: stored.publicKeyPem, privateKeyPem: stored.privateKeyPem };
      return cachedIdentity;
    }
  } catch { /* assente o illeggibile: se ne genera una nuova */ }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  cachedIdentity = { deviceId: deviceIdFrom(publicKeyPem), publicKeyPem, privateKeyPem };
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(IDENTITY_PATH, JSON.stringify({ version: 1, deviceId: cachedIdentity.deviceId, publicKeyPem, privateKeyPem }, null, 2), { mode: 0o600 });
  } catch (err) {
    // Non fatale: senza persistenza il pairing andrebbe riapprovato a ogni boot,
    // ma il turno corrente puo' comunque funzionare.
    console.warn('[v2] identita\' device non persistita:', err.message);
  }
  return cachedIdentity;
}

// I metadati entrano nella firma normalizzati (trim + minuscole): se il client
// e il Gateway non li normalizzano allo stesso modo la firma non verifica.
const normMeta = (v) => (typeof v === 'string' ? v.trim().replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)) : '');

// Contratto v3 letto dal gateway-client (`buildDeviceAuthPayloadV3`): l'ordine
// dei campi e il separatore `|` sono parte della firma, non riordinare.
function signDeviceConnect(identity, { role, scopes, signedAtMs, token, nonce, clientId, clientMode, platform, deviceFamily }) {
  const payload = [
    'v3', identity.deviceId, clientId, clientMode, role, scopes.join(','),
    String(signedAtMs), token ?? '', nonce, normMeta(platform), normMeta(deviceFamily),
  ].join('|');
  return b64url(crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(identity.privateKeyPem)));
}

// Errore dedicato: il pairing e' in attesa di approvazione. Non e' un guasto del
// trasporto, e' una cosa che deve fare l'umano una volta sola, quindi va detta
// forte nei log invece di sparire dentro il fallback silenzioso.
export class PairingRequiredError extends Error {
  constructor(details) {
    super(`pairing del dispositivo da approvare (deviceId ${details?.deviceId ?? '?'})`);
    this.name = 'PairingRequiredError';
    this.wsUnavailable = true;
    this.pairingRequired = true;
    this.details = details ?? null;
  }
}

// Il testo del messaggio negli eventi chat arriva come array di blocchi
// ({type:'text', text}), non come stringa: senza questa estrazione il turno
// tornava "[object Object]".
function textFromMessage(message) {
  if (!message) return '';
  const { content } = message;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  if (typeof message.text === 'string') return message.text;
  return '';
}

function wsUrl() {
  return process.env.OPENCLAW_GATEWAY_URL || 'ws://host.docker.internal:18789';
}

export function wsTransportEnabled() {
  return process.env.V2_GATEWAY_WS_DISABLED !== '1' && Boolean(process.env.OPENCLAW_GATEWAY_TOKEN);
}

// Errore usato per dire "il trasporto WS non e' utilizzabile": chi chiama
// ricade sul percorso HTTP storico invece di far fallire la run.
export class WsUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'WsUnavailableError'; this.wsUnavailable = true; }
}

// Connessione + handshake `connect` (obbligatorio: il primo frame DEVE essere
// `connect`, altrimenti il Gateway risponde INVALID_REQUEST e ignora tutto il
// resto — e' il bug che rendeva morto il vecchio abortGatewaySession).
async function openSocket() {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) throw new WsUnavailableError('OPENCLAW_GATEWAY_TOKEN assente');
  const { default: WebSocket } = await import('ws');
  const url = wsUrl();
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  const handlers = new Map();          // id -> {resolve, reject}
  const listeners = new Set();         // (msg) => void
  let closed = null;

  ws.on('message', (data) => {
    let msg = null;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg?.id && handlers.has(msg.id)) {
      const { resolve } = handlers.get(msg.id);
      handlers.delete(msg.id);
      resolve(msg);
    }
    for (const listener of listeners) listener(msg);
  });
  const fail = (err) => {
    closed = err;
    for (const { reject } of handlers.values()) reject(err);
    handlers.clear();
    for (const listener of listeners) listener({ __closed: err });
  };
  ws.on('error', (err) => fail(new WsUnavailableError(`WS Gateway: ${err.message}`)));
  ws.on('close', () => fail(new Error('WS Gateway chiuso')));

  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed) return reject(closed);
    const id = `${method}-${randomUUID()}`;
    handlers.set(id, { resolve, reject });
    try { ws.send(JSON.stringify({ type: 'req', id, method, params })); }
    catch (err) { handlers.delete(id); reject(err); }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new WsUnavailableError(`handshake Gateway: nessuna challenge entro ${CONNECT_TIMEOUT_MS} ms`)), CONNECT_TIMEOUT_MS);
    const onMessage = (msg) => {
      if (msg?.__closed) { clearTimeout(timer); listeners.delete(onMessage); return reject(msg.__closed); }
      if (msg?.event !== 'connect.challenge') return;
      listeners.delete(onMessage);

      // Il nonce della challenge entra nella firma: lega la connect a QUESTO
      // handshake e impedisce il replay di una connect firmata catturata prima.
      const nonce = msg?.payload?.nonce ?? msg?.nonce;
      const identity = loadOrCreateDeviceIdentity();
      const scopes = ['operator.read', 'operator.write'];
      const clientId = 'gateway-client';
      const clientMode = 'backend';
      const platform = 'linux';
      const signedAtMs = Date.now();

      request('connect', {
        minProtocol: 1, maxProtocol: 4,
        client: { id: clientId, version: '2.0.0', platform, mode: clientMode },
        role: 'operator', scopes, caps: [], commands: [], permissions: {},
        auth: { token }, locale: 'it-IT', userAgent: 'agent-platform-v2',
        // Identita' firmata: senza questa il Gateway concede scope vuoti a
        // qualunque connessione non-loopback e `chat.send` viene rifiutata.
        device: {
          id: identity.deviceId,
          publicKey: b64url(publicKeyRaw(identity.publicKeyPem)),
          signature: signDeviceConnect(identity, { role: 'operator', scopes, signedAtMs, token, nonce, clientId, clientMode, platform }),
          signedAt: signedAtMs,
          nonce,
        },
      }).then((res) => {
        clearTimeout(timer);
        if (!res?.ok) {
          const err = res?.error ?? {};
          const code = err?.details?.code ?? err?.code;
          if (code === 'PAIRING_REQUIRED' || err?.code === 'NOT_PAIRED') {
            return reject(new PairingRequiredError({ ...err.details, deviceId: err?.details?.deviceId ?? identity.deviceId }));
          }
          return reject(new WsUnavailableError(`connect rifiutato: ${JSON.stringify(err)}`));
        }
        resolve();
      }, (err) => { clearTimeout(timer); reject(err instanceof WsUnavailableError ? err : new WsUnavailableError(err.message)); });
    };
    listeners.add(onMessage);
    ws.on('error', (err) => { clearTimeout(timer); reject(new WsUnavailableError(`WS Gateway: ${err.message}`)); });
  });

  return {
    request,
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    close: () => { try { ws.close(); } catch { /* noop */ } },
  };
}

// Ferma davvero il run in corso su una sessione: handshake + chat.abort.
// Ritorna il payload del Gateway (`{ok, aborted, runIds}`) o null se non
// raggiungibile: chi chiama non deve mai fallire per colpa dello stop.
export async function abortGatewayChatRun(sessionKey, runId) {
  if (!sessionKey) return null;
  let socket = null;
  try {
    socket = await openSocket();
    const res = await socket.request('chat.abort', { sessionKey, ...(runId ? { runId } : {}) });
    return res?.ok ? (res.payload ?? { ok: true }) : { ok: false, error: res?.error ?? null };
  } catch (err) {
    return { ok: false, error: { message: err?.message ?? String(err) } };
  } finally {
    socket?.close();
  }
}

// RACCOLTO DAL TRANSCRIPT (fix 541 redispatch, 2026-08-30): quando un turno
// viene dato per morto di trasporto ma l'agente in realta' aveva FINITO, il
// `<task_result>` finale non e' perso: sta nel transcript della sessione sul
// Gateway (visto dal vivo su task_area_membri: step segnato attempt 4 /
// lastErrorKind=transport, ultimo messaggio assistant = task_result completed).
// Prima di pagare un intero turno di riaggancio (l'agente riverifica il
// filesystem e riscrive la risposta) si legge chat.history e, se l'ultimo
// messaggio assistant DOPO l'avvio dello step contiene un task_result, lo si
// usa cosi' com'e': costo zero token. Best-effort: qualsiasi guasto -> null,
// chi chiama procede col riaggancio normale.
export async function fetchLastTaskResult(sessionKey, { afterTs = 0 } = {}) {
  if (!sessionKey || !wsTransportEnabled()) return null;
  let socket = null;
  try {
    socket = await openSocket();
    const res = await socket.request('chat.history', { sessionKey, limit: 30 });
    if (!res?.ok) return null;
    const messages = Array.isArray(res.payload?.messages) ? res.payload.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const item = messages[i];
      if (item?.role !== 'assistant') continue;
      const text = textFromMessage(item).trim();
      if (!text) continue;
      // Solo l'ULTIMO assistant non vuoto conta: se non ha il task_result, il
      // turno e' morto davvero a meta' e il riaggancio e' la strada giusta.
      const ts = Number(item.timestamp ?? item.ts ?? 0);
      if (afterTs && ts && ts < afterTs) return null;
      if (!/<task_result>/i.test(text)) return null;
      return { text, timestamp: ts || null };
    }
    return null;
  } catch {
    return null;
  } finally {
    socket?.close();
  }
}

// Esegue un turno completo sul Gateway via chat.send, con la stessa semantica
// del percorso HTTP: onAccepted appena il run e' accettato (per persistere il
// runId), watchdog di silenzio, tetto sul turno, abort esterno che ferma
// DAVVERO l'agente.
export async function runGatewayTurnWs({
  message, model, sessionKey, idempotencyKey, thinking, signal, onAccepted,
  timeoutSeconds = 2400, streamHeartbeatMs = 120_000,
}) {
  if (!sessionKey) throw new WsUnavailableError('sessionKey obbligatoria sul trasporto WS');
  const socket = await openSocket();
  let runId = null;
  let settled = false;

  try {
    // Modello per-run: la sessione e' dedicata allo step, quindi basta crearla
    // con il modello giusto. Se esiste gia' (riaggancio) l'errore e' atteso e
    // innocuo: il modello e' gia' quello impostato al primo giro.
    if (model) {
      let applied = false;
      try {
        const created = await socket.request('sessions.create', { key: sessionKey, model });
        applied = Boolean(created?.ok);
      } catch { /* sessione gia' esistente: si passa alla patch */ }
      // Sessione gia' creata (riaggancio, oppure fallback su un altro modello
      // nello stesso step): `sessions.patch` e' l'unico modo per cambiarle il
      // modello, altrimenti il turno girerebbe in silenzio con quello vecchio.
      if (!applied) {
        try { await socket.request('sessions.patch', { key: sessionKey, model }); }
        catch { /* best-effort: si prosegue col modello corrente della sessione */ }
      }
    }

    return await new Promise((resolve, reject) => {
      let text = '';
      let usage;
      let watchdog = null;
      let turnTimer = null;
      const cleanupFns = [];
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        clearTimeout(turnTimer);
        for (const fn2 of cleanupFns) fn2();
        fn();
      };
      const transportError = (msg) => { const err = new Error(msg); err.isTransport = true; return err; };
      const armWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => finish(() => reject(transportError(`connessione Gateway OpenClaw chiusa: nessun dato per ${streamHeartbeatMs / 1000}s durante il run`))), streamHeartbeatMs);
      };

      const onExternalAbort = () => {
        // Stop vero: chat.abort sul run in corso. Solo dopo la conferma (o il
        // fallimento) chiudiamo il turno con l'errore "fermata da Owner".
        socket.request('chat.abort', { sessionKey, ...(runId ? { runId } : {}) })
          .catch(() => null)
          .finally(() => finish(() => reject(new Error('esecuzione fermata da Owner'))));
      };
      if (signal) {
        if (signal.aborted) { socket.close(); throw new Error('esecuzione fermata da Owner'); }
        signal.addEventListener('abort', onExternalAbort, { once: true });
        cleanupFns.push(() => signal.removeEventListener('abort', onExternalAbort));
      }

      const off = socket.onEvent((msg) => {
        if (msg?.__closed) return finish(() => reject(transportError(`stream Gateway OpenClaw interrotto: ${msg.__closed.message}`)));
        // LIVENESS (fix 541 redispatch, 2026-08-30): durante le tool call
        // lunghe il Gateway non emette NESSUN delta `chat`, ma trasmette in
        // continuazione frame `agent` (stream item/command_output/assistant)
        // con la stessa sessionKey — misurati dal vivo 142 frame agent contro
        // 34 chat delta in 75s. Questo handler pero' scartava tutto cio' che
        // non era `chat`, quindi il watchdog scattava su run in piena
        // attivita', il turno veniva classificato "trasporto morto" e
        // riagganciato in loop (attempt 11-28 sulla stessa step, la risposta
        // finale buttata). I frame agent della NOSTRA sessione sono prova di
        // vita: alimentano il watchdog e basta.
        if (msg?.event === 'agent') {
          const ap = msg.payload ?? {};
          if (ap.sessionKey === sessionKey || (runId && ap.runId === runId)) armWatchdog();
          return;
        }
        if (msg?.event !== 'chat') return;
        const payload = msg.payload ?? {};
        if (payload.sessionKey && payload.sessionKey !== sessionKey) return;
        if (runId && payload.runId && payload.runId !== runId) return;
        armWatchdog();
        if (payload.usage) usage = payload.usage;
        if (payload.state === 'delta') {
          if (payload.replace) text = String(payload.deltaText ?? '');
          else text += String(payload.deltaText ?? '');
          return;
        }
        if (payload.state === 'final') {
          const finalText = textFromMessage(payload.message).trim() || text.trim();
          // Il finale vuoto e' anche la maschera dei guasti del MODELLO (quota
          // settimanale kimi esaurita, visto live 2026-08-29: l'agente muore
          // prima di produrre testo e il Gateway chiude il turno senza nulla).
          // isEmptyResponse permette a runOpenClawAgent di provare il modello
          // di fallback invece di riagganciare all'infinito lo stesso worker.
          if (!finalText) {
            const err = transportError('risposta vuota dal Gateway OpenClaw');
            err.isEmptyResponse = true;
            return finish(() => reject(err));
          }
          return finish(() => resolve({ status: 'ok', result: { payloads: [{ text: finalText }] }, text: finalText, usage, gatewayRunId: runId, transport: 'ws' }));
        }
        if (payload.state === 'aborted') return finish(() => reject(new Error('esecuzione fermata da Owner')));
        if (payload.state === 'error') {
          const detail = payload.errorMessage || 'errore sconosciuto';
          const err = new Error(`Gateway OpenClaw: ${detail}`);
          if (['transport', 'timeout', 'unknown'].includes(payload.errorKind)) err.isTransport = true;
          return finish(() => reject(err));
        }
      });
      cleanupFns.push(off);

      turnTimer = setTimeout(() => finish(() => reject(transportError(`timeout Gateway OpenClaw (turno oltre ${timeoutSeconds}s)`))), Math.max(1000, Number(timeoutSeconds || 0) * 1000));
      armWatchdog();

      socket.request('chat.send', {
        sessionKey,
        message,
        idempotencyKey: idempotencyKey || randomUUID(),
        ...(thinking ? { thinking } : {}),
        deliver: false,
      }).then((res) => {
        if (!res?.ok) {
          const detail = JSON.stringify(res?.error ?? {});
          return finish(() => reject(new WsUnavailableError(`chat.send rifiutata: ${detail}`)));
        }
        runId = res.payload?.runId ?? runId;
        armWatchdog();
        onAccepted?.({ status: 'accepted', runId });
      }, (err) => finish(() => reject(err instanceof WsUnavailableError ? err : transportError(`chat.send fallita: ${err.message}`))));
    });
  } finally {
    socket.close();
  }
}
