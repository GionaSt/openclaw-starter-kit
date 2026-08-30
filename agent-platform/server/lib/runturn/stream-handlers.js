// Handler dei messaggi del loop di streaming SDK (msg.type system/assistant/
// user/result) — MOVE puro da streamTurn (task 1eed85e7, follow-up di
// 60d40a34): stessa logica, stesse guardie (bug 1c04b1b9, 2671cc26), solo
// rilocata in funzioni esplicite (parametro `ctx` al posto della closure su
// streamTurn) così ogni helper resta sotto le ~50 righe. Nessuna riga di
// logica riscritta.
//
// ctx atteso da handleResultMessage: { tenantId, agentId, sessionId, runId,
//   key, modelTier, sessionMap, saveSessionMap, onDelta, username, startedAt }
// (valori CORRENTI al momento dell'attempt: se il model-tiering degrada
// modelTier tra un tentativo e l'altro, il chiamante ricostruisce ctx ad ogni
// attempt — vedi stream.js).
import {
  journalUpdate, isUsageLimitBanner, journalAddUsage, journalAddTouchedFiles,
} from '../runs.js';
import { recordUsage } from '../budget.js';
import { recordWeeklyUsage } from '../weeklybudget.js';
import { apiEquivalentCost } from '../claudepricing.js';
import { pushSessionEvent } from '../status.js';
import { logAudit } from '../audit.js';
import { appendHistory } from '../history.js';
import { isSubAgentTool, subAgentStart, subAgentEnd } from '../concurrency.js';

// msg.type 'system'/'init': session id SDK disponibile da subito, salvato nel
// journal così il watchdog può fare il resume anche se la run muore prima del
// result. msg.model = modello EFFETTIVAMENTE usato dal CLI: se differisce da
// quello richiesto (downgrade silenzioso lato CLI/piano, non un errore che
// passa dal catch) lo segnaliamo comunque nel journal.
export function handleSystemInitMessage(msg, ctx) {
  const { runId, key, resolvedModel } = ctx;
  const patch = { sdkSessionId: msg.session_id };
  if (msg.model && msg.model !== resolvedModel) {
    patch.modelWarning = `CLI ha usato "${msg.model}" invece del richiesto "${resolvedModel}" (downgrade silenzioso del piano/CLI)`;
    console.warn(`[model-tiering] ${key}: ${patch.modelWarning}`);
  }
  patch.actualModel = msg.model ?? resolvedModel;
  journalUpdate(runId, patch);
}

// Bersagli di SCRITTURA in un comando Bash (task a1cce86c): solo pattern
// inequivocabilmente di scrittura sotto server/ web/ docs/ — redirezioni
// `> path` / `>> path`, `tee [-a] path`, `sed -i ... path`. Volutamente NON
// cattura letture (`cat`, `<`) né path passati come argomento generico: catturare
// un file di UN'ALTRA run che questa run ha solo LETTO reintrodurrebbe il falso
// positivo che stiamo eliminando. Precision over recall.
function bashWriteTargets(cmd) {
  if (typeof cmd !== 'string' || !cmd) return [];
  const out = [];
  const path = '((?:\\./)?(?:server|web|docs)/[^\\s"\'|;&)<>]+)';
  const reRedirect = new RegExp(`(?:>>?|\\btee\\b(?:\\s+-a)?)\\s+["']?${path}`, 'g');
  const reSed = new RegExp(`\\bsed\\b[^|;&]*?-i\\b[^|;&]*?["']?${path}`, 'g');
  let m;
  while ((m = reRedirect.exec(cmd))) out.push(m[1]);
  while ((m = reSed.exec(cmd))) out.push(m[1]);
  return out;
}

// File toccati da un singolo tool_use (Write/Edit/MultiEdit/NotebookEdit/Bash).
function touchedFilesFromToolUse(name, input) {
  const inp = input ?? {};
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') {
    return inp.file_path ? [inp.file_path] : [];
  }
  if (name === 'NotebookEdit') return inp.notebook_path ? [inp.notebook_path] : [];
  if (name === 'Bash') return bashWriteTargets(inp.command);
  return [];
}

// msg.type 'assistant': log leggibile per la tab "Agenti attivi" — testo e
// tool-call dell'agente.
export function handleAssistantMessage(msg, ctx) {
  const { runId, key } = ctx;
  for (const block of msg.message?.content ?? []) {
    if (block.type === 'tool_use') {
      // Fan-out di un sub-agente (tool Task/Agent): contabilizzalo nel cap/
      // memoria globale (task 19577ebf) — lo spawn lo fa il claude-cli figlio,
      // fuori dal journal, quindi va tracciato qui per (runId, toolUseId).
      if (isSubAgentTool(block.name)) subAgentStart(runId, block.id);
      // Traccia i file toccati dai tool di scrittura sulla run (task a1cce86c):
      // fonte del check "commit-before-gate" PER-TASK — alla consegna il warning
      // guarda solo questi file, non l'intero working tree condiviso.
      const touched = touchedFilesFromToolUse(block.name, block.input);
      if (touched.length) journalAddTouchedFiles(runId, touched);
      pushSessionEvent(key, { type: 'tool_call', name: block.name, input: JSON.stringify(block.input ?? {}).slice(0, 300) });
    } else if (block.type === 'text' && block.text?.trim()) {
      pushSessionEvent(key, { type: 'assistant_text', text: block.text.slice(0, 200) });
    }
  }
}

// msg.type 'user': porta i tool_result dei tool completati (incluso il
// ritorno di un sub-agente Task/Agent) — chiude il conteggio del sub-agente.
export function handleUserMessage(msg, ctx) {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === 'tool_result' && block.tool_use_id) subAgentEnd(ctx.runId, block.tool_use_id);
  }
}

// Guardia false-done (bug 1c04b1b9): quando la subscription Max è al limite,
// il claude-cli a volte NON emette un result d'errore ma un result subtype
// "success" il cui testo è il banner del limite ("You've hit your limit ·
// resets ...", "usage limit reached|<epoch>"). Trattarlo come completamento
// marcherebbe la task done senza lavoro reale (era così che 7 task andarono
// false-done il 2026-07-23). Lo classifichiamo come il limite Max: throw ->
// journalInterrupt reason usage_limit -> il watchdog riprende al reset (senza
// consumare tentativi) e la task resta in lavorazione, MAI in done. Va
// controllata PRIMA di aggiornare sessionMap (il banner non è una sessione
// valida da cui riprendere).
function guardUsageLimitBanner(fullText) {
  if (isUsageLimitBanner(fullText)) {
    throw new Error(String(fullText).slice(0, 300));
  }
}

// Guardia "risposta vuota" (bug 2671cc26): sul resume di una sessione con
// notifiche/turni pendenti in coda (es. task-notification di sub-agenti in
// background), il claude-cli può restituire SUBITO un result subtype
// "success" ma VUOTO (0 output token, nessun testo) — ha processato il
// "Continue from where you left off"/la notifica con "No response requested"
// ed è tornato PRIMA di elaborare il prompt dell'utente. Persistendolo come
// risposta si vedrebbe una bolla vuota e il messaggio andrebbe rinviato a
// mano (è il bug segnalato da Owner). Lo classifichiamo come no-op: va
// controllata DOPO aver aggiornato sessionMap, così il chiamante può
// ritentare il resume sulla sessione appena creata e il prompt viene
// finalmente rielaborato — reinvio automatico.
function guardEmptyNoopResult(fullText, outputTokens) {
  if (!String(fullText).trim() && outputTokens === 0) {
    const noopErr = new Error('result vuoto (no-op) al resume');
    noopErr.noop = true;
    throw noopErr;
  }
}

// Budget token empirico della finestra Max (task b8b98175): accumula
// input/output/cache di QUESTO result sulla run (journal) e sul tracker della
// finestra corrente. cache_read/creation sono opzionali nell'usage SDK:
// assenti → 0. Nessun costo aggiuntivo, leggiamo dati già presenti. Chiude
// con l'audit log leggibile del risultato.
function recordResultUsage(msg, ctx, durationMs) {
  const { runId, username, tenantId, agentId, modelTier } = ctx;
  const tokens = msg.usage
    ? { input: msg.usage.input_tokens ?? null, output: msg.usage.output_tokens ?? null }
    : undefined;
  if (msg.usage) {
    const u = {
      input: msg.usage.input_tokens ?? 0,
      output: msg.usage.output_tokens ?? 0,
      cacheRead: msg.usage.cache_read_input_tokens ?? 0,
      cacheCreation: msg.usage.cache_creation_input_tokens ?? 0,
    };
    const apiCost = apiEquivalentCost(modelTier, u);
    journalAddUsage(runId, u, apiCost);
    recordUsage({ input: apiCost.microUsd });
    recordWeeklyUsage(u, modelTier);
  }
  logAudit({
    user: username, tenant: tenantId, agent: agentId, event: 'chat_result', tokens, detail: { durationMs },
  });
}

// msg.type 'result': esito del tentativo. `fullText` è il testo accumulato
// dai delta di streaming (può essere vuoto se il CLI non ha emesso delta).
// Ritorna { fullText, durationMs } su successo, altrimenti lancia (subtype di
// errore, banner limite Max, o result vuoto/no-op — vedi le due guardie sopra;
// l'ORDINE rispetto all'aggiornamento di sessionMap è lo stesso di prima
// dell'estrazione, vedi i commenti sulle guardie).
export function handleResultMessage(msg, fullText, ctx) {
  const {
    tenantId, agentId, sessionId, modelTier, sessionMap, saveSessionMap, key, onDelta, startedAt,
  } = ctx;
  if (msg.subtype !== 'success') {
    const detail = msg.result ?? msg.subtype;
    throw new Error(typeof detail === 'string' ? detail : msg.subtype);
  }
  if (!fullText && msg.result) {
    fullText = msg.result;
    onDelta?.(fullText);
  }
  guardUsageLimitBanner(fullText);
  sessionMap[key] = msg.session_id;
  saveSessionMap();
  guardEmptyNoopResult(fullText, msg.usage?.output_tokens ?? 0);
  appendHistory(tenantId, agentId, sessionId, { role: 'assistant', text: fullText, model: modelTier });
  const durationMs = Date.now() - startedAt;
  recordResultUsage(msg, ctx, durationMs);
  return { fullText, durationMs };
}
