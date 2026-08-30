import { join } from 'path';
import { CONFIG_DIR, readJson } from './store.js';
import { getLimitState, clearRateLimit } from './ratelimit.js';
import { abortGatewayChatRun, runGatewayTurnWs, wsTransportEnabled } from './openclaw-gateway-ws.js';

const MODELS_FILE = join(CONFIG_DIR, 'openclaw-models.json');

export function getOpenClawModels() {
  return readJson(MODELS_FILE, { defaultModel: 'anthropic/claude-opus-5', models: [] });
}

function replyText(payload) {
  return (payload?.result?.payloads ?? []).filter((item) => !item?.isReasoning && !item?.isError)
    .map((item) => String(item?.text ?? '').trim()).filter(Boolean).join('\n\n');
}

export function isRetryableModelError(error) {
  return /weekly limit|usage limit|session limit|rate.?limit|limit reached|out of extended usage|model.*(?:unavailable|overloaded)|capacity|resource exhausted|temporarily unavailable|failovererror/i.test(String(error?.message ?? error ?? ''));
}

// Errori di TRASPORTO (connessione morta prima/durante la risposta): distinti dagli
// errori applicativi (4xx/5xx con corpo leggibile) cosi' l'executor puo' riagganciare
// invece di rieseguire.
export function isTransportError(error) {
  if (error?.isTransport === true) return true;
  const message = String(error?.message ?? error ?? '');
  return /fetch failed|UND_ERR_|timeout Gateway OpenClaw|connessione Gateway OpenClaw chiusa|stream Gateway OpenClaw interrotto|socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|network timeout/i.test(message);
}

// Heartbeat lato CLIENT: il Gateway (closed-source) non emette nulla durante le tool
// call lunghe dell'agente, quindi undici (Node fetch) fa scattare bodyTimeout dopo
// ~300s di silenzio tra chunk. Workaround: un parser dello stream con "watchdog";
// se non arriva alcun byte per `heartbeatMs`, la risposta e' considerata morta e
// viene abortita in modo controllato, cosi' il chiamante puo' riagganciare il run
// invece di aspettare un fallimento opaco. Inoltre esponiamo stream realmente
// incrementale: niente piu' attesa della risposta intera (headersTimeout aggirato
// perche' gli header SSE arrivano subito).
// ---- Timeout della catena di trasporto verso il Gateway ----
// Fonte UNICA dei valori: `server/config/platform.json` -> sezione `gatewayTransport`
// (sovrascrivibile senza toccare il codice, come push/digest/transcription).
// Override operativi via env: V2_GATEWAY_STREAM_HEARTBEAT_MS e V2_GATEWAY_TURN_TIMEOUT_S
// (gli env vincono sul file, utili per test one-shot senza toccare config).
//
// Caso peggiore reale osservato (journal V2, 2026-08-14): step worker+QA piu'
// lungo = 33.2 min (progetto Affidabilita', runid-riaggancio, 3 tentativi),
// p95 = 18 min. timeoutSeconds default 2400s (40 min) = peggior caso + ~20%.
// Coerenza catena: RUN_WALLCLOCK_TIMEOUT (run INTERNE, default 45 min) >
// turnTimeout (40 min) > watchdog (120s): il primo che scatta e' il watchdog
// solo se la connessione e' muta (trasporto morto -> riaggancio), altrimenti
// e' il turnTimeout a chiudere un turno appeso. Undici headersTimeout (300s)
// e' aggirato alla radice dallo streaming SSE (headers subito).
const TRANSPORT_CFG = (() => {
  const fileCfg = readJson(join(CONFIG_DIR, 'platform.json'), {})?.gatewayTransport ?? {};
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    streamHeartbeatMs: num(process.env.V2_GATEWAY_STREAM_HEARTBEAT_MS, num(fileCfg.streamHeartbeatMs, 120_000)),
    turnTimeoutSeconds: num(process.env.V2_GATEWAY_TURN_TIMEOUT_S, num(fileCfg.turnTimeoutSeconds, 2400)),
  };
})();
const STREAM_HEARTBEAT_MS = TRANSPORT_CFG.streamHeartbeatMs;
export const GATEWAY_TURN_TIMEOUT_S = TRANSPORT_CFG.turnTimeoutSeconds;

// Chiamata via endpoint HTTP OpenAI-compatible del Gateway (gateway.http.endpoints.chatCompletions).
// Il vecchio path WebSocket connetteva senza device identity: il Gateway azzera gli scope
// self-dichiarati dei client device-less non-loopback e ogni `agent` falliva con
// "missing scope: operator.write". Il bearer condiviso su HTTP ripristina invece
// l'intero set di scope operator (vedi docs/gateway/openai-http-api.md, auth matrix).
// Contenuto del messaggio utente in formato OpenAI-compatible. Senza immagini
// resta una stringa (comportamento storico, zero cambi); con immagini diventa
// un array di parti text + image_url (data URL), l'unico modo per dare
// contenuto VISIVO a un agente che gira via /v1/chat/completions e non ha tool
// di lettura file (task B2). Limiti Gateway: max 8 parti image_url per
// messaggio, 10MB per immagine, 20MB totali — filtrati a monte in v2-content.js.
export function buildChatContent(message, images = []) {
  const parts = Array.isArray(images) ? images.filter((img) => img?.dataUrl) : [];
  if (!parts.length) return message;
  return [
    { type: 'text', text: message },
    ...parts.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
  ];
}

// Ferma davvero il run in corso sulla sessione (task E3, 2026-08-26).
// STORIA: qui prima si apriva il WS e si sparava `sessions.abort` come primo
// frame, senza l'handshake `connect` obbligatorio -> il Gateway rispondeva
// sempre INVALID_REQUEST ("first request must be connect") e la risposta non
// veniva nemmeno letta: abort morto. E comunque `sessions.abort` non vede i run
// lanciati via HTTP /v1/chat/completions (non sono nel registro abort del
// Gateway). L'unico stop reale e' `chat.abort` sulla sessione, che e' anche il
// percorso con cui ora vengono dispacciati i turni.
// Best-effort: non deve mai far fallire la pausa.
export async function abortGatewaySession(runId, sessionKey) {
  if (!sessionKey && !runId) return null;
  return abortGatewayChatRun(sessionKey, runId);
}

// Un turno = prima il trasporto WS (`chat.send`), che e' l'UNICO abortabile
// davvero (task E3, 2026-08-26: i run HTTP non sono registrati nel registro
// abort del Gateway, quindi il tasto Ferma non li fermava). Se il WS non e'
// utilizzabile — token assente, handshake rifiutato, `chat.send` non accettata,
// oppure ci sono immagini da mandare — si ricade sul percorso HTTP storico, che
// resta identico: la piattaforma non deve mai smettere di lavorare per colpa
// del trasporto nuovo.
async function runSingleOpenClawAgent(params) {
  const canUseWs = wsTransportEnabled() && Boolean(params.sessionKey) && !(params.images?.length);
  if (canUseWs) {
    try {
      return await runGatewayTurnWs({
        message: params.message,
        model: params.model,
        sessionKey: params.sessionKey,
        idempotencyKey: params.idempotencyKey,
        thinking: params.thinking,
        signal: params.signal,
        onAccepted: params.onAccepted,
        timeoutSeconds: params.timeoutSeconds,
        streamHeartbeatMs: STREAM_HEARTBEAT_MS,
      });
    } catch (error) {
      if (!error?.wsUnavailable) throw error;
      // Il pairing da approvare NON e' un guasto transitorio del trasporto: e'
      // un'azione umana da fare una volta sola, e finche' non e' fatta il tasto
      // "Ferma" resta a meta' (lo stato si ferma, il turno in volo no). Il
      // fallback silenzioso e' esattamente il motivo per cui il bug E3 e'
      // passato inosservato per giorni: qui va detto forte.
      if (error?.pairingRequired) {
        console.error(`[v2] PAIRING DA APPROVARE: il trasporto WS (e quindi il tasto Ferma) resta disattivato finche' il dispositivo non e' approvato. deviceId=${error.details?.deviceId ?? '?'} scope=${(error.details?.requestedScopes ?? []).join(',')}. Approvarlo dalle richieste di pairing in attesa.`);
      } else {
        console.warn(`[v2] trasporto WS non disponibile, fallback HTTP: ${error.message}`);
      }
    }
  }
  return runSingleOpenClawAgentHttp(params);
}

async function runSingleOpenClawAgentHttp({ message, images, model, sessionKey, idempotencyKey, thinking, timeoutSeconds, onAccepted, signal }) {
  const wsUrl = process.env.OPENCLAW_GATEWAY_URL || 'ws://host.docker.internal:18789';
  const base = (process.env.OPENCLAW_GATEWAY_HTTP_URL || wsUrl).replace(/^ws(s?):\/\//, 'http$1://').replace(/\/$/, '');
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) throw new Error('OPENCLAW_GATEWAY_TOKEN non configurato');

  const controller = new AbortController();
  let watchdog = null;
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort(new Error('watchdog-silence')), STREAM_HEARTBEAT_MS);
  };
  // Timer APPLICATIVO sul turno intero (default TRANSPORT_CFG.turnTimeoutSeconds).
  // Senza questo la fetch poteva restare appesa indefinitamente se il gateway
  // rispondeva byte sparsi ma mai [DONE]; ora il tetto e' esplicito e coerente.
  const turnTimer = setTimeout(() => controller.abort(new Error('turn-timeout')), Math.max(1000, Number(timeoutSeconds || 0) * 1000));
  let externallyAborted = signal?.aborted === true;
  const onExternalAbort = () => { externallyAborted = true; controller.abort(); };
  if (signal) {
    if (externallyAborted) throw new Error('esecuzione fermata da Owner');
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const doRequest = (withSessionHeader) => fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(model ? { 'x-openclaw-model': model } : {}),
        ...(withSessionHeader && sessionKey ? { 'x-openclaw-session-key': sessionKey } : {}),
      },
      body: JSON.stringify({
        model: 'openclaw/main',
        messages: [{ role: 'user', content: buildChatContent(message, images) }],
        // SSE: gli header arrivano subito (niente headersTimeout a 300s) e i delta
        // testuali tengono viva la connessione; il watchdog copre i silenzi lunghi.
        stream: true,
        stream_options: { include_usage: true },
        user: sessionKey || idempotencyKey,
      }),
    });

    let res = await doRequest(true);
    if (res.status === 400 && sessionKey) {
      // Session key rifiutata (namespace riservato): riprova con la sola sessione derivata da `user`.
      const detail = await res.text();
      if (/session/i.test(detail)) res = await doRequest(false);
      else throw new Error(`Gateway OpenClaw HTTP 400: ${detail.slice(0, 400)}`);
    }
    if (!res.ok) {
      const bodyText = await res.text();
      throw new Error(`Gateway OpenClaw HTTP ${res.status}: ${bodyText.slice(0, 400)}`);
    }

    // --- Lettura SSE incrementale con watchdog di silenzio ---
    // Il primo chunk (role) arriva appena il run e' accettato: contiene il runId
    // (chatcmpl_*) e lo notifichiamo SUBITO via onAccepted, cosi' l'executor puo'
    // persistere gatewayRunId PRIMA che il lavoro inizi e riagganciarlo dopo una
    // caduta di trasporto.
    let buffer = '';
    let text = '';
    let usage;
    let runId = null;
    let accepted = false;
    let sawDone = false;
    const markAccepted = (id) => {
      if (accepted) return;
      accepted = true;
      runId = id ?? runId;
      onAccepted?.({ status: 'accepted', runId });
    };
    const handleEvent = (raw) => {
      const data = raw.trim();
      if (!data) return;
      if (data === '[DONE]') { sawDone = true; return; }
      let chunk;
      try { chunk = JSON.parse(data); } catch { return; }
      if (chunk?.error) throw new Error(`stream Gateway OpenClaw: ${chunk.error.message ?? 'errore'}`);
      if (chunk?.id && !runId) markAccepted(chunk.id);
      const choice = chunk?.choices?.[0];
      const deltaText = choice?.delta?.content;
      if (typeof deltaText === 'string' && deltaText) text += deltaText;
      if (choice?.finish_reason && !accepted) markAccepted(chunk?.id ?? null);
      if (chunk?.usage) usage = chunk.usage;
    };

    armWatchdog();
    const decoder = new TextDecoder();
    try {
      for await (const piece of res.body) {
        armWatchdog();
        buffer += decoder.decode(piece, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data:')) handleEvent(line.slice(5));
          }
        }
      }
    } catch (streamErr) {
      if (controller.signal.aborted) {
        if (externallyAborted) throw new Error('esecuzione fermata da Owner');
        const reason = String(controller.signal.reason?.message ?? '');
        if (reason === 'watchdog-silence') {
          const err = new Error(`connessione Gateway OpenClaw chiusa: nessun dato per ${STREAM_HEARTBEAT_MS / 1000}s durante il run`);
          err.isTransport = true;
          throw err;
        }
        const err3 = new Error(`timeout Gateway OpenClaw (${reason === 'turn-timeout' ? `turno oltre ${timeoutSeconds}s` : 'abort senza reason'})`);
        err3.isTransport = true;
        throw err3;
      }
      const err = new Error(`stream Gateway OpenClaw interrotto: ${streamErr?.message ?? streamErr}`);
      err.isTransport = true;
      err.cause = streamErr;
      throw err;
    }
    if (!sawDone && !text) {
      const err = new Error('stream Gateway OpenClaw interrotto: chiuso senza [DONE] e senza contenuto');
      err.isTransport = true;
      throw err;
    }
    text = text.trim();
    if (!text) {
      // Classe TRASPORTO, non applicativa (fix 2026-08-29): sotto carico il
      // Gateway puo' chiudere un turno senza testo; contarlo come errore
      // applicativo bruciava 1 dei 3 tentativi e con 3 vuoti di fila il
      // progetto finiva 'failed' di notte senza colpa. Il chiamante (executor)
      // sa che su questo errore NON deve riagganciare la stessa chiave.
      const err = new Error('risposta vuota dal Gateway OpenClaw');
      err.isTransport = true;
      err.isEmptyResponse = true;
      throw err;
    }
    if (!accepted) markAccepted(runId);
    return { status: 'ok', result: { payloads: [{ text }] }, text, usage, gatewayRunId: runId, transport: 'http' };
  } catch (err) {
    if (err?.isTransport) throw err;
    if (err?.name === 'AbortError') {
      const err2 = new Error(externallyAborted ? 'esecuzione fermata da Owner' : `timeout Gateway OpenClaw (turno oltre ${timeoutSeconds}s)`);
      if (!externallyAborted) err2.isTransport = true;
      throw err2;
    }
    if (err?.cause?.code && /^UND_ERR_|ECONN|EPIPE/.test(String(err.cause.code))) err.isTransport = true;
    throw err;
  } finally {
    clearTimeout(watchdog);
    clearTimeout(turnTimer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function runOpenClawAgent({ message, images, model, fallbackModels, sessionKey, idempotencyKey, thinking = 'high', timeoutSeconds = TRANSPORT_CFG.turnTimeoutSeconds, onAccepted, signal }) {
  const configured = getOpenClawModels();
  const candidates = [...new Set([
    model || configured.defaultModel,
    ...(fallbackModels ?? configured.fallbackModels ?? []),
  ].filter(Boolean))];
  let lastError;
  const attempts = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    // Non tutti i modelli supportano lo stesso livello di thinking (kimi/k3
    // accetta solo "off"): il Gateway risponde con l'elenco dei livelli validi
    // e senza questo retry OGNI turno su quel modello moriva con
    // 'Thinking level "high" is not supported' (visto live 2026-08-29 quando
    // Owner ha messo kimi/k3 come worker). Al primo rifiuto si ritenta lo
    // STESSO modello col primo livello suggerito.
    let effectiveThinking = thinking;
    for (let thinkingRetry = 0; ; thinkingRetry += 1) {
      try {
        const result = await runSingleOpenClawAgent({
          message,
          images,
          model: candidate,
          sessionKey,
          idempotencyKey: `${idempotencyKey}-${index}${thinkingRetry ? `-t${thinkingRetry}` : ''}`,
          thinking: effectiveThinking,
          timeoutSeconds,
          signal,
          onAccepted: (payload) => onAccepted?.({ ...payload, model: candidate, fallback: index > 0 }),
        });
        // Il Gateway puo' rispondere 200 con l'errore come TESTO della
        // completion (misurato live: turno da 3s con body 'Thinking level
        // "high" is not supported for kimi/k3. Use one of: off.'). Va
        // intercettato qui, non solo nel catch.
        const unsupportedInText = String(result?.text ?? '').trim().match(/^Thinking level .+ not supported .*Use one of:\s*([a-z, ]+)/i);
        if (unsupportedInText && thinkingRetry === 0) {
          effectiveThinking = unsupportedInText[1].split(',')[0].trim() || 'off';
          continue;
        }
        // AUTO-GUARIGIONE del muro Claude (2026-08-29): se un turno Anthropic
        // RIESCE mentre il muro globale risulta attivo, il muro e' falso
        // (orario di reset misparsato o limite caduto prima del previsto: la
        // fila restava ferma ore a quota gia' disponibile). Lo si azzera qui,
        // nel punto che ha la prova concreta. Solo modelli anthropic/*: un
        // successo kimi/deepseek non dice nulla sulla subscription Claude.
        if (candidate.startsWith('anthropic/') && getLimitState().limited) clearRateLimit();
        return { ...result, modelUsed: candidate, fallbackUsed: index > 0, thinkingUsed: effectiveThinking, modelAttempts: [...attempts, { model: candidate, status: 'ok' }] };
      } catch (error) {
        const unsupported = String(error?.message ?? '').match(/Thinking level .+ not supported .*Use one of:\s*([a-z, ]+)/i);
        if (unsupported && thinkingRetry === 0) {
          effectiveThinking = unsupported[1].split(',')[0].trim() || 'off';
          continue;
        }
        lastError = error;
        attempts.push({ model: candidate, status: 'error', error: String(error?.message ?? error) });
        // La "risposta vuota" e' come si presenta un worker saturo (quota kimi
        // esaurita 2026-08-29): senza testo d'errore non matcherebbe mai
        // isRetryableModelError e il fallback (kimi -> opus-5) non partirebbe.
        const canFallback = isRetryableModelError(error) || error?.isEmptyResponse === true;
        if (!canFallback || index === candidates.length - 1) throw error;
        break;
      }
    }
  }

  throw lastError ?? new Error('Nessun modello disponibile');
}
