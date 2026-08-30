// Blocco (d) di runAgentTurnInner (task 829e29c2, God-function
// server/index.js): loop di streaming SDK con fallback di modello, retry
// "risposta vuota" (no-op) e retry senza resume. MOVE puro da server/index.js
// (funzioni `attempt`/`attemptWithModelFallback`/`attemptResilient` + wrapping
// withLock): stessa logica, stesse guardie (bug 1c04b1b9, 2671cc26) — zero
// cambi di comportamento.
//
// Task 60d40a34 (follow-up di 829e29c2): `attempt` era un blocco unico di
// ~148 righe. Scomposto in sub-helper (allora nested, closure su streamTurn):
// buildQueryOptions, handleSystemInitMessage, handleAssistantMessage,
// handleResultMessage.
//
// Task 1eed85e7 (follow-up di 60d40a34): i sub-helper messaggi restavano
// nested — streamTurn come funzione superava ancora il criterio "nessun
// helper >50 righe". MOVE puro ulteriore, senza toccare una riga di logica:
// - handler dei messaggi/delta -> ./stream-handlers.js (funzioni esplicite,
//   parametro `ctx` al posto della closure).
// - policy di retry/backoff (model fallback / noop / restart-senza-resume)
//   -> ./retry-policy.js (funzioni PURE: solo errore+stato, testabili senza
//   toccare query/withLock/journal — vedi server/scripts/retry-policy-check.mjs).
// streamTurn resta l'orchestratore del loop: stessa semantica di retry/resume/
// sticky-stop/limite Max delle 4 regressioni storiche note (220eb38, 6759069,
// bba7b68, e14470f).
import {
  journalUpdate, getRun,
} from '../runs.js';
import { isTerminalStatus, isStickyStatus } from '../runstates.js';
import { resolveModel } from '../models.js';
import { pushSessionEvent } from '../status.js';
import { tenantUploadDir } from '../uploads.js';
import {
  handleSystemInitMessage, handleAssistantMessage, handleUserMessage, handleResultMessage,
} from './stream-handlers.js';
import {
  MAX_NOOP_RETRIES, decideModelFallback, decideNoopRetry, decideRestartWithoutResume,
} from './retry-policy.js';

// params: { tenantId, agentId, sessionId, key, runId, agent, modelTier,
//   resolvedModel, promptForModel, systemPrompt, allowedTools, mcpServers,
//   canUseTool, knowledgeDir, grantReadForAttachments, resumeSessionId,
//   onDelta, onReset, username, startedAt }
// deps: { query, withLock, activeQueries, sessionMap, saveSessionMap, OAUTH_TOKEN }
//
// Ritorna { fullText, durationMs } su successo. Su fallimento rilancia
// l'errore originale con err.streamedText/err.modelTier attaccati (usati da
// finalizeTurn per persistere il parziale su stop e per il campo `model`).
export async function streamTurn(params, deps) {
  const {
    tenantId, agentId, sessionId, key, runId, agent, promptForModel, systemPrompt,
    allowedTools, mcpServers, canUseTool, knowledgeDir, grantReadForAttachments,
    resumeSessionId, onDelta, onReset, username, startedAt,
  } = params;
  let { modelTier, resolvedModel } = params;
  const { query, withLock, activeQueries, sessionMap, saveSessionMap, OAUTH_TOKEN } = deps;

  // Testo streamato dal tentativo in corso, visibile anche al catch esterno:
  // su stop manuale il parziale viene persistito in history (non va perso).
  let streamedText = '';

  // Opzioni della chiamata SDK `query()` per un singolo tentativo (resumeId
  // incluso). resolvedModel letto dalla closure: riflette sempre il tier
  // CORRENTE, anche dopo un degrado di attemptWithModelFallback.
  const buildQueryOptions = (resumeId) => ({
    model: resolvedModel,
    ...(agent.effort ? { effort: agent.effort } : {}),
    systemPrompt,
    allowedTools,
    mcpServers,
    canUseTool,
    // Agenti dev (org platform): pieni poteri sul codice in /app.
    ...(agent.dev
      ? { permissionMode: 'bypassPermissions', cwd: '/app' }
      // Agente NON dev con campo "knowledge": cwd sulla cartella di conoscenza
      // e permessi in modalità 'default' così il path-scoping di canUseTool
      // viene consultato per ogni tool file (bypassPermissions lo salterebbe).
      // Ha precedenza sugli allegati: se il turno porta anche immagini/PDF,
      // il wrapper canUseTool include già la upload dir tra le root consentite.
      : knowledgeDir
        ? { permissionMode: 'default', cwd: knowledgeDir }
        // Agente NON dev con allegati immagine/PDF: bypass permessi limitato al
        // solo tool Read (l'unico su filesystem concesso qui), cwd sulla cartella
        // uploads del tenant — così Read esegue senza prompt interattivo.
        : (grantReadForAttachments ? { permissionMode: 'bypassPermissions', cwd: tenantUploadDir(tenantId) } : {})),
    maxTurns: agent.dev ? 100 : 10,
    includePartialMessages: true,
    resume: resumeId,
    env: {
      ...process.env,
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN ?? '',
      // Evita che il CLI figlio si creda annidato dentro un'altra sessione Claude Code.
      CLAUDECODE: undefined,
      CLAUDE_CODE_ENTRYPOINT: undefined,
      CLAUDE_CODE_SESSION_ID: undefined,
      CLAUDE_CODE_CHILD_SESSION: undefined,
      // Sandbox (container isolato): richiesto da bypassPermissions da root e
      // impostato anche per gli agenti knowledge, che eseguono tool file da root.
      ...(agent.dev || grantReadForAttachments || knowledgeDir ? { IS_SANDBOX: '1' } : {}),
    },
  });

  // Un tentativo di streaming: apre la query SDK e smista ogni messaggio
  // all'handler dedicato (./stream-handlers.js). `ctx` è ricostruito ad ogni
  // attempt con modelTier/resolvedModel CORRENTI (possono essere cambiati da
  // un degrado di tier nel giro precedente).
  const attempt = async (resumeId) => {
    // Stop/pausa (sticky) o timeout wall-clock (failed terminale, task 019ab89d)
    // arrivati mentre la run aspettava il lock/tra un retry e l'altro: non
    // partire affatto (un nuovo query() girerebbe fuori dal deadline).
    if (isStickyStatus(getRun(runId)?.status) || isTerminalStatus(getRun(runId)?.status)) {
      throw new Error(`run ${getRun(runId).status} prima dell'avvio`);
    }
    streamedText = '';
    const q = query({
      // Con allegati il prompt include i riferimenti ai file (path da leggere +
      // testo inline); senza allegati è il messaggio utente puro.
      prompt: promptForModel,
      options: buildQueryOptions(resumeId),
    });
    // Registrata per lo stop manuale: POST /api/runs/:id/stop la interrompe.
    activeQueries.set(runId, q);

    const ctx = {
      tenantId, agentId, sessionId, runId, key, modelTier, resolvedModel,
      sessionMap, saveSessionMap, onDelta, username, startedAt,
    };

    let fullText = '';
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
        handleSystemInitMessage(msg, ctx);
      } else if (msg.type === 'stream_event') {
        const delta = msg.event?.delta;
        if (msg.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
          fullText += delta.text;
          streamedText = fullText;
          onDelta?.(delta.text);
        }
      } else if (msg.type === 'assistant') {
        handleAssistantMessage(msg, ctx);
      } else if (msg.type === 'user') {
        handleUserMessage(msg, ctx);
      } else if (msg.type === 'result') {
        return handleResultMessage(msg, fullText, ctx);
      }
    }
    throw new Error('stream terminato senza risultato');
  };

  // Fallback di tier (requisito 3): se il modello richiesto non è disponibile
  // nel piano/CLI si degrada di UN tier (decideModelFallback, pura) e si
  // ritenta subito con lo STESSO resumeId — mai un crash, e mai più di un
  // giro per tier della catena (fable-5 -> opus -> sonnet -> haiku), quindi
  // termina sempre.
  const attemptWithModelFallback = async (resumeId) => {
    for (;;) {
      try {
        return await attempt(resumeId);
      } catch (err) {
        const next = decideModelFallback(err, modelTier);
        if (!next) throw err;
        const warning = `modello "${modelTier}" non disponibile (${String(err.message).slice(0, 150)}) — degrado a "${next}"`;
        console.warn(`[model-tiering] ${key}: ${warning}`);
        modelTier = next;
        resolvedModel = resolveModel(next).model;
        journalUpdate(runId, { model: modelTier, resolvedModel, modelWarning: warning, modelDegraded: true });
        pushSessionEvent(key, { type: 'model_degraded', text: warning });
      }
    }
  };

  // Retry "risposta vuota" (bug 2671cc26, decideNoopRetry pura): se il resume
  // restituisce un result vuoto si ritenta SUBITO il resume della sessione
  // aggiornata, così il prompt viene rielaborato senza reinvio manuale.
  const attemptResilient = async (resumeId) => {
    let rid = resumeId;
    for (let noopTries = 0; ; noopTries += 1) {
      try {
        return await attemptWithModelFallback(rid);
      } catch (err) {
        if (decideNoopRetry(err, { noopTries, runStatus: getRun(runId)?.status })) {
          rid = sessionMap[key] ?? rid; // resume della sessione aggiornata dal no-op
          console.warn(`[chat] ${key}: result vuoto (no-op) al resume, retry ${noopTries + 1}/${MAX_NOOP_RETRIES}`);
          pushSessionEvent(key, { type: 'noop_retry', text: 'risposta vuota al resume, ritento automaticamente' });
          continue;
        }
        throw err;
      }
    }
  };

  try {
    let result;
    try {
      result = await withLock(key, () => attemptResilient(resumeSessionId ?? sessionMap[key]));
    } catch (err) {
      // Fallimento col resume attivo (decideRestartWithoutResume, pura: es.
      // sessione Claude persa dopo ricreazione container): si riprova una
      // volta partendo da una sessione pulita invece di mostrare errore.
      if (decideRestartWithoutResume(err, { hasResumeSession: Boolean(sessionMap[key]), runStatus: getRun(runId)?.status })) {
        console.warn(`[chat] ${key}: errore col resume (${err.message}), riparto senza resume`);
        delete sessionMap[key];
        saveSessionMap();
        // Il nuovo tentativo ristreamma da zero sullo stesso canale: il client
        // deve azzerare il buffer del messaggio, altrimenti concatena i due
        // tentativi (testo duplicato).
        onReset?.();
        result = await withLock(key, () => attemptResilient(undefined));
      } else {
        throw err;
      }
    }
    return result;
  } catch (err) {
    err.streamedText = streamedText;
    err.modelTier = modelTier;
    throw err;
  }
}
