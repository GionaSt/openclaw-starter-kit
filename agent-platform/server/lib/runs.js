// Journal persistente delle run agente: server/data/runs.json (gitignored).
// Ogni run viene registrata su disco PRIMA di partire, con heartbeat periodico:
// se il server muore a metà, il journal resta con status "running" e heartbeat
// stantio, e il recovery/watchdog la riprende (resume della sessione SDK).
// Stati: running | interrupted | resumed | completed | failed | stopped | paused.
// "stopped" = fermata manualmente dall'utente: vince sull'auto-resume
// (il watchdog non la riprende mai finché resta stopped).
// "paused"  = messa in pausa dall'utente: come stopped (sticky, niente
// auto-resume), ma pensata per essere ripresa; se ha resumeAt valorizzato
// (pausa a tempo) il watchdog la riprende da solo al primo tick dopo resumeAt.
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { readJson, writeJson, DATA_DIR, SERVER_DIR } from './store.js';
import { isStickyStatus, isTerminalStatus } from './runstates.js';

const RUNS_FILE = join(DATA_DIR, 'runs.json');
// Radice del repo (server/ web/ docs/ stanno qui sotto): serve per rendere
// repo-relative i path assoluti dei tool Write/Edit prima di tracciarli.
const REPO_ROOT = dirname(SERVER_DIR);
export const HEARTBEAT_MS = 15000;          // aggiornamento heartbeat durante la run
export const STALE_HEARTBEAT_MS = 120000;   // running senza heartbeat da 2 min = morta
export const MAX_RESUME_ATTEMPTS = 5;
// Run interrotte da OOM (reason 'oom', vedi isOomError sotto): il kernel ha
// già ucciso il processo per mancanza di memoria, quindi un backoff cieco a
// parità di condizioni fallisce 5 volte di fila per lo STESSO motivo (evidenza
// task 16edce3a: 3 run SIGKILL, tutte attempts 5/5, usage 0 su ogni tentativo).
// Un solo retry, e solo quando l'admission control a memoria (lib/mem.js,
// hasMemoryHeadroom) dà via libera — vedi watchdog.js.
export const OOM_MAX_RESUME_ATTEMPTS = 1;
// Timeout wall-clock di una run INTERNA (task 019ab89d, resilienza run): tempo
// massimo di parete di un TURNO oltre il quale la run è considerata impiantata
// (query SDK bloccata, tool che non ritorna, deadlock).
// Diverso dallo STALE_HEARTBEAT (run ESTERNE, che il server non controlla) e dal
// backoff delle interrupted (riprendibili): qui il processo è vivo ma non
// produce risultato, quindi va terminato pulito e marcato failed DEFINITIVO con
// reason 'timeout' — un resume ripartirebbe sullo stesso punto morto.
// PORTATA: la finestra è per-TURNO, non per-tentativo. Il deadline timer nasce e
// muore con una invocazione di runAgentTurnInner (index.js), quindi copre TUTTI i
// retry interni di streamTurn (noop-retry, restart-senza-resume, degrado di tier)
// messi insieme: il tempo speso in un tentativo fallito NON viene restituito al
// successivo. Riparte da zero solo a una nuova invocazione di runAgentTurn (es.
// resume del watchdog dopo una interrupted). Default 45 min; configurabile via env
// AGENT_PLATFORM_RUN_TIMEOUT_MIN; <=0 disabilita.
export const RUN_WALLCLOCK_TIMEOUT_MS = (() => {
  const raw = process.env.AGENT_PLATFORM_RUN_TIMEOUT_MIN;
  if (raw == null || raw === '') return 45 * 60000;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 45 * 60000;
  return n > 0 ? n * 60000 : 0; // <=0 disabilita esplicitamente
})();
const COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // pruning run chiuse dopo 7 giorni

let runs = readJson(RUNS_FILE, {});
const persist = () => writeJson(RUNS_FILE, runs);

// Riassunto brevissimo di cosa sta facendo una run (campo runTitle), mostrato
// come etichetta in "Agenti live" al posto del prompt completo (task UX
// b3861fb9). Il prompt di lavoro inizia sempre con le stesse istruzioni
// standard, quindi le run risultavano indistinguibili tra loro: qui riduciamo
// a ~10 parole / ~64 caratteri, collassando spazi e newline e togliendo il
// rumore markdown iniziale (#, >, -, *, backtick, virgolette triple). Sorgente
// unica del troncamento, riusata sia alla creazione della run sia dal fallback
// server-side per le run vecchie (senza runTitle nel journal).
const RUN_TITLE_MAX_WORDS = 10;
const RUN_TITLE_MAX_CHARS = 64;
export function summarizeRunTitle(text) {
  const clean = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')   // via i blocchi di codice tripli
    .replace(/[#>*_`~]+/g, ' ')          // via il rumore markdown
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return 'run agente';
  const words = clean.split(' ').slice(0, RUN_TITLE_MAX_WORDS).join(' ');
  const short = words.length > RUN_TITLE_MAX_CHARS ? `${words.slice(0, RUN_TITLE_MAX_CHARS - 1).trimEnd()}…` : words;
  return words.length < clean.length && !short.endsWith('…') ? `${short}…` : short;
}

// Run effettivamente attive in QUESTO processo: il watchdog non deve mai
// riprendere una run che sta ancora girando qui (heartbeat a parte).
const activeNow = new Set();

// onChange(run): hook per il broadcast WS della pagina globale, settato da index.js.
// Chiamato a ogni mutazione di stato (non sugli heartbeat: niente spam).
let onChange = null;
export function setRunChangeListener(fn) { onChange = fn; }

function prune() {
  const cutoff = Date.now() - COMPLETED_RETENTION_MS;
  for (const [id, r] of Object.entries(runs)) {
    if ((r.status === 'completed' || r.status === 'failed' || r.status === 'stopped') && Date.parse(r.updatedAt ?? r.startedAt) < cutoff) {
      delete runs[id];
    }
  }
}

// Recovery al boot: nessuna run può essere ancora in corso quando il server
// (ri)parte, quindi running/resumed -> interrupted, pronte per il watchdog.
// Le run esterne (processi fuori dal server, registrate via API) sopravvivono
// al riavvio: non vengono toccate, ci pensa il loro heartbeat (o failStaleExternal).
export function recoverOnBoot() {
  let count = 0;
  const now = new Date().toISOString();
  for (const r of Object.values(runs)) {
    if (r.external) continue;
    if (r.status === 'running' || r.status === 'resumed') {
      r.status = 'interrupted';
      r.reason = 'restart';
      r.lastError = 'server riavviato durante la run';
      r.nextRetryAt = new Date(Date.now() + 30000).toISOString(); // 30s dopo il boot
      r.updatedAt = now;
      count += 1;
    }
  }
  prune();
  persist();
  return count;
}

export function journalStart({
  tenantId, agentId, sessionId, sessionKey, prompt, username, resumeOfRunId, source, taskId,
  model, resolvedModel, runTitle,
}) {
  // Un resume riusa la entry esistente (conserva prompt originale e tentativi).
  if (resumeOfRunId && runs[resumeOfRunId]) {
    const r = runs[resumeOfRunId];
    r.status = 'resumed';
    r.heartbeatAt = new Date().toISOString();
    r.updatedAt = r.heartbeatAt;
    // Backfill del riassunto per le run avviate prima di questa feature.
    if (!r.runTitle) r.runTitle = summarizeRunTitle(runTitle || r.prompt);
    // Il tier può essere cambiato nel frattempo (config aggiornata, degrado
    // avvenuto prima dell'interruzione): rispecchia sempre quello attuale.
    if (model) r.model = model;
    if (resolvedModel) r.resolvedModel = resolvedModel;
    activeNow.add(r.id);
    persist();
    onChange?.(r);
    return r.id;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  runs[id] = {
    id, tenantId, agentId, sessionId, sessionKey,
    prompt: String(prompt).slice(0, 4000),
    // Riassunto brevissimo di cosa fa la run (etichetta di "Agenti live"):
    // esplicito dal chiamante (titolo task dal dispatcher, label sotto-task) o,
    // in mancanza, derivato dalle prime parole del prompt (turni chat).
    runTitle: summarizeRunTitle(runTitle || prompt),
    username,
    source: source ?? null,   // 'dispatcher' per le run autonome della task board
    taskId: taskId ?? null,   // task collegata (solo run da dispatcher)
    status: 'running',
    sdkSessionId: null,
    // Model tiering (docs/model-tiering.md): model = alias di tier richiesto
    // dal manifest ("fable-5"/"opus"/"sonnet"/"haiku"), resolvedModel = id
    // reale passato all'SDK, actualModel = quello riportato dal CLI nel
    // messaggio di init (per scoprire eventuali downgrade silenziosi lato
    // CLI). modelWarning/modelDegraded valorizzati solo se scatta un fallback.
    model: model ?? null,
    resolvedModel: resolvedModel ?? null,
    actualModel: null,
    modelWarning: null,
    modelDegraded: false,
    attempts: 0,
    reason: null,
    lastError: null,
    nextRetryAt: null,
    // Token consumati dalla run (accumulati su tutti i suoi result/resume, task
    // budget b8b98175): alimenta il tracker della finestra Max (lib/budget.js).
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    // File sorgente (repo-relative sotto server/ web/ docs/) toccati dai tool
    // Write/Edit/Bash della run — alimentato da journalAddTouchedFiles durante
    // lo streaming. Fonte del check "commit-before-gate" per-task (task
    // a1cce86c): il warning alla consegna guarda SOLO questi file, non l'intero
    // working tree condiviso (stop ai falsi positivi da run concorrenti).
    touchedFiles: [],
    startedAt: now,
    heartbeatAt: now,
    updatedAt: now,
  };
  activeNow.add(id);
  prune();
  persist();
  onChange?.(runs[id]);
  return id;
}

// ---- Run esterne (governance): processi/agenti lanciati fuori da runAgentTurn ----
// Registrate via POST /api/runs/register: entrano nel journal (e quindi in
// "Agenti live") ma NON sono riprendibili dal watchdog — vivono in un processo
// che il server non controlla. Heartbeat via POST /api/runs/:id/heartbeat,
// chiusura via POST /api/runs/:id/complete; heartbeat stantio -> failed.
export function journalRegisterExternal({ tenantId, agentId, sessionId, prompt, username, title }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  runs[id] = {
    id, tenantId, agentId,
    sessionId: sessionId ?? `ext-${id.slice(0, 8)}`,
    sessionKey: null,
    prompt: String(prompt).slice(0, 4000),
    // Etichetta breve: il "title" dichiarato alla registrazione (cosa fa il
    // processo) o, se assente, le prime parole del prompt.
    runTitle: summarizeRunTitle(title || prompt),
    username: username ?? 'external',
    source: 'external',
    external: true,
    taskId: null,
    status: 'running',
    sdkSessionId: null,
    attempts: 0,
    reason: null,
    lastError: null,
    nextRetryAt: null,
    startedAt: now,
    heartbeatAt: now,
    updatedAt: now,
  };
  prune();
  persist();
  onChange?.(runs[id]);
  return runs[id];
}

// Run esterne col heartbeat perso: il processo è morto senza chiamare
// /complete. Marcate failed (chiamata dal watchdog a ogni tick).
export function failStaleExternal(now = Date.now()) {
  const stale = Object.values(runs).filter((r) => r.external && r.status === 'running'
    && now - Date.parse(r.heartbeatAt ?? r.startedAt) > STALE_HEARTBEAT_MS);
  for (const r of stale) {
    journalUpdate(r.id, { status: 'failed', reason: 'stale_heartbeat', lastError: 'heartbeat perso: processo esterno terminato senza chiamare /complete' });
  }
  return stale;
}

export function journalUpdate(id, fields) {
  const r = runs[id];
  if (!r) return;
  Object.assign(r, fields, { updatedAt: new Date().toISOString() });
  persist();
  onChange?.(r);
}

export function journalHeartbeat(id) {
  const r = runs[id];
  if (!r) return;
  r.heartbeatAt = new Date().toISOString();
  persist();
}

// Accumula i token di una risposta SDK sulla run (task budget b8b98175). usage
// = { input, output, cacheRead, cacheCreation }. Persistito nel journal (visibile
// in "Agenti live") e sommato alla finestra Max dal chiamante (recordUsage).
export function journalAddUsage(id, usage = {}, apiCost = null) {
  const r = runs[id];
  if (!r) return;
  const u = r.usage ?? (r.usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  u.input += usage.input ?? 0;
  u.output += usage.output ?? 0;
  u.cacheRead += usage.cacheRead ?? 0;
  u.cacheCreation += usage.cacheCreation ?? 0;
  if (apiCost) {
    r.apiCostUsd = Number(((r.apiCostUsd ?? 0) + apiCost.usd).toFixed(9));
    r.pricedAs = apiCost.pricedAs;
    r.pricingProxy = apiCost.proxy;
  }
  r.updatedAt = new Date().toISOString();
  persist();
}

export function journalComplete(id) {
  activeNow.delete(id);
  journalUpdate(id, { status: 'completed', reason: null, lastError: null, nextRetryAt: null });
}

// Normalizza un path (assoluto o relativo) a repo-relative posix SE cade sotto
// server/ web/ docs/ — le sole aree guardate dal check "commit-before-gate";
// altrimenti null (fuori scope: /tmp, node_modules, data/, ecc.). I path git
// --porcelain sono già repo-relative posix, quindi combaciano con questi.
export function toTrackedRepoPath(p) {
  if (!p || typeof p !== 'string') return null;
  let rel = p;
  if (p.startsWith('/')) {
    const root = REPO_ROOT.endsWith('/') ? REPO_ROOT : `${REPO_ROOT}/`;
    if (!p.startsWith(root)) return null; // fuori dal repo
    rel = p.slice(root.length);
  }
  rel = rel.replace(/^\.\//, '').replace(/\\/g, '/');
  return /^(server|web|docs)\//.test(rel) ? rel : null;
}

// Registra i file toccati da un tool Write/Edit/Bash sulla run (task a1cce86c).
// Filtra e normalizza a repo-relative; dedup; cap difensivo. Persistito nel
// journal, così alla consegna il check attribuisce all'agente SOLO i suoi file.
export function journalAddTouchedFiles(id, files) {
  const r = runs[id];
  if (!r || !Array.isArray(files) || !files.length) return;
  const set = new Set(r.touchedFiles ?? []);
  let changed = false;
  for (const f of files) {
    const rel = toTrackedRepoPath(f);
    if (rel && !set.has(rel)) { set.add(rel); changed = true; }
  }
  if (!changed) return;
  r.touchedFiles = Array.from(set).slice(-500); // cap: evita crescita illimitata
  r.updatedAt = new Date().toISOString();
  persist();
}

// Unione dei file toccati da TUTTE le run di una task (una consegna può seguire
// più run/resume). Fonte del warning per-task del gate (task a1cce86c).
export function touchedFilesForTask(tenantId, taskId) {
  if (!taskId) return [];
  const set = new Set();
  for (const r of Object.values(runs)) {
    if (r.tenantId === tenantId && r.taskId === taskId) {
      for (const f of r.touchedFiles ?? []) set.add(f);
    }
  }
  return Array.from(set);
}

// Chiusura con errore: la run diventa "interrupted" e sarà il watchdog a
// decidere se/quando riprenderla. reason: 'usage_limit' | 'error' | 'restart'.
// Se nextRetryAt non è indicato: backoff esponenziale sui tentativi già
// consumati (1, 2, 4, 8, 16 minuti).
export function journalInterrupt(id, { reason, error, nextRetryAt }) {
  activeNow.delete(id);
  // Stop e pausa manuali sono sticky: la terminazione del processo genera un
  // errore che NON deve riportare la run in interrupted (tornerebbe auto-resumabile).
  if (isStickyStatus(runs[id]?.status)) return;
  // Già terminale (failed/completed): non riaprirla. Copre il timeout wall-clock
  // (journalTimeout marca failed e interrompe la query; l'errore del for-await
  // arriva qui DOPO e la riporterebbe a interrupted → auto-resume su un punto
  // morto). Terminale = definitivo, per definizione non si torna in interrupted.
  if (isTerminalStatus(runs[id]?.status)) return;
  const backoff = 60000 * 2 ** Math.min(runs[id]?.attempts ?? 0, 4);
  journalUpdate(id, {
    status: 'interrupted',
    reason,
    lastError: String(error ?? '').slice(0, 500),
    nextRetryAt: nextRetryAt ?? new Date(Date.now() + backoff).toISOString(),
  });
}

export function journalFail(id, error) {
  activeNow.delete(id);
  if (isStickyStatus(runs[id]?.status)) return; // stop/pausa manuali sono sticky
  if (isTerminalStatus(runs[id]?.status)) return; // già failed/completed: non riscrivere
  journalUpdate(id, { status: 'failed', lastError: String(error ?? '').slice(0, 500), nextRetryAt: null });
}

// Timeout wall-clock (task 019ab89d): il deadline timer di runAgentTurn ha
// superato RUN_WALLCLOCK_TIMEOUT_MS senza risultato → run terminata pulita e
// marcata failed DEFINITIVO con reason 'timeout' (mai interrupted/resume: il
// processo era vivo ma impiantato, un resume ripeterebbe lo stallo). Stop/pausa
// manuali vincono (sticky); una run già terminale non viene toccata.
export function journalTimeout(id, timeoutMs) {
  activeNow.delete(id);
  if (isStickyStatus(runs[id]?.status)) return;
  if (isTerminalStatus(runs[id]?.status)) return;
  const mins = Math.max(1, Math.round((timeoutMs ?? RUN_WALLCLOCK_TIMEOUT_MS) / 60000));
  journalUpdate(id, {
    status: 'failed',
    reason: 'timeout',
    lastError: `timeout wall-clock: run terminata dopo ${mins} min senza produrre un risultato (processo impiantato)`,
    nextRetryAt: null,
  });
}

// Stop manuale esplicito dall'utente: unico stato che il watchdog non riprende
// mai (listResumable non lo considera, recoverOnBoot non lo tocca).
export function journalStop(id, username) {
  const r = runs[id];
  if (!r) return;
  journalUpdate(id, {
    status: 'stopped',
    reason: 'manual_stop',
    stoppedBy: username ?? null,
    lastError: null,
    nextRetryAt: null,
  });
}

// Pausa manuale (con o senza scadenza): come lo stop è sticky rispetto a
// interrupt/fail, ma è pensata per la ripresa. Con resumeAfterMs (pausa a
// tempo) il watchdog la riprende da solo al primo tick dopo resumeAt.
export function journalPause(id, username, resumeAfterMs) {
  const r = runs[id];
  if (!r) return;
  journalUpdate(id, {
    status: 'paused',
    reason: 'manual_pause',
    pausedBy: username ?? null,
    resumeAt: resumeAfterMs ? new Date(Date.now() + resumeAfterMs).toISOString() : null,
    lastError: null,
    nextRetryAt: null,
  });
}

// Ripresa manuale di una run fermata o in pausa: torna "interrupted" con retry
// immediato e tentativi azzerati, così il watchdog la riprende al tick successivo
// (riuso del meccanismo esistente, zero logica nuova).
export function journalManualResume(id) {
  const r = runs[id];
  if (!r || !isStickyStatus(r.status)) return;
  journalUpdate(id, {
    status: 'interrupted',
    reason: 'manual_resume',
    stoppedBy: null,
    pausedBy: null,
    resumeAt: null,
    attempts: 0,
    lastError: null,
    nextRetryAt: new Date().toISOString(),
  });
}

// ---- Riconoscimento del limite di utilizzo della subscription Max ----
// claude-cli fallisce con messaggi tipo "Claude AI usage limit reached|<epoch>"
// (epoch del reset dopo la barra), "You've hit your limit · resets HH:MM (UTC)"
// o varianti con "usage/rate limit". "hit your (usage )?limit" è indispensabile:
// è il formato del banner reale (task ca71d849) e senza di esso l'errore veniva
// scambiato per un errore generico (backoff a raffica) invece che per il muro
// Max, senza alzare lo stato globale né aspettare il reset.
const USAGE_LIMIT_RE = /usage limit|session limit|weekly limit|rate.?limit(?:ed)?|limit reached|out of extended usage|hit your (?:(?:usage|session|weekly) )?limit/i;

export function isUsageLimitError(message) {
  return USAGE_LIMIT_RE.test(String(message ?? ''));
}

// ---- Riconoscimento del crash da OOM (task 16edce3a) ----
// Il claude-agent-sdk emette due messaggi letterali quando il processo claude-
// cli muore (transport.mjs, getProcessExitError): "Claude Code process
// terminated by signal SIGKILL" quando il kernel lo uccide per OOM (segnale),
// o "Claude Code process exited with code 137" quando il codice di uscita
// arriva invece del segnale (137 = 128+SIGKILL, stessa causa). Nessuno dei due
// è un errore applicativo: ritentare con lo stesso backoff cieco della SDK
// resume ripete lo stesso crash a vuoto (evidenza: 3 run, 5/5 tentativi, usage
// 0 su ognuno) finché non c'è più memoria libera per farlo ripartire davvero.
const OOM_ERROR_RE = /terminated by signal SIGKILL|exited with code 137\b/i;

export function isOomError(message) {
  return OOM_ERROR_RE.test(String(message ?? ''));
}

// Banner ESATTO del limite emesso dal claude-cli quando la subscription Max è
// esaurita. Più stretto di USAGE_LIMIT_RE apposta: serve a distinguere una
// RISPOSTA "success" che in realtà è solo il banner del limite (bug false-done
// 1c04b1b9) da una risposta legittima che si limita a PARLARE di rate limit —
// un agente dev della piattaforma discute di rate limit di continuo, non deve
// mai essere scambiato per una run morta. Match solo sulle frasi-banner reali.
// NB (fix 66ea084a): il claude-cli emette anche la variante "session limit"
// ("You've hit your session limit · resets HH:MM (UTC)"). Senza questa parola
// il banner passava per un result "success" legittimo → run di review marcata
// completed senza submit_review, muro Max mai alzato, dispatchAttempts bruciati
// a raffica e task congelate al gate (business-a 3f0d58d1/9035bc44).
const USAGE_LIMIT_BANNER_RE = /claude ai (?:(?:usage|session|weekly) )?limit reached|you'?ve hit your (?:(?:usage|session|weekly) )?limit|hit your (?:usage|session|weekly) limit|(?:usage|session|weekly) limit reached\s*\|?\s*\d*/i;

export function isUsageLimitBanner(text) {
  return USAGE_LIMIT_BANNER_RE.test(String(text ?? ''));
}

// Parsing dell'orario di reset dichiarato dal limite (requisito 1), due formati:
//  a) epoch dopo la barra, formato del claude-cli: "...usage limit reached|<epoch>"
//     (secondi o millisecondi);
//  b) orario del giorno, formato banner: "You've hit your limit · resets 15:30 (UTC)"
//     (anche "resets at 3pm", con o senza minuti, con o senza (UTC)); interpretato
//     come UTC — è così che il CLI lo emette.
// Ritorna una Date del reset, oppure null se non parsabile con confidenza.
// Guardia: la finestra Max è di 5h, quindi un reset che risulterebbe a più di 6h
// è quasi certamente un misparse → null (meglio il fallback prudente a 30 min).
// Offset (ms) di una IANA timezone rispetto a UTC nell'istante dato: serve per
// i banner tipo "resets 9pm (Europe/Rome)" (visto live 2026-08-29: interpretare
// 9pm come UTC faceva aspettare 2 ore a muro gia' scaduto).
function tzOffsetMs(tz, at) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(at).map((p) => [p.type, p.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)) - at.getTime();
  } catch { return 0; }
}

export function parseUsageLimitReset(message, now = new Date()) {
  const s = String(message ?? '');
  const tzMatch = s.match(/\(([A-Za-z]+\/[A-Za-z_+-]+)\)/);
  const tzOffset = tzMatch ? tzOffsetMs(tzMatch[1], now) : 0;
  const epoch = s.match(/\|\s*(\d{9,13})/);
  if (epoch) {
    let ts = Number(epoch[1]);
    if (ts < 1e12) ts *= 1000; // epoch in secondi → ms
    if (ts > now.getTime()) return new Date(ts);
  }
  const dated = s.match(/reset[s]?(?:\s+at)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:,\s*(\d{4}))?,?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (dated) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    let hour = Number(dated[4]);
    const minute = dated[5] ? Number(dated[5]) : 0;
    const meridiem = dated[6]?.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    const month = months[dated[1].slice(0, 3).toLowerCase()];
    const year = Number(dated[3] ?? now.getUTCFullYear());
    if (month !== undefined && hour <= 23 && minute <= 59) {
      const reset = new Date(Date.UTC(year, month, Number(dated[2]), hour, minute, 0, 0) - tzOffset);
      if (reset.getTime() > now.getTime()) return reset;
    }
  }
  const hhmm = s.match(/reset[s]?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (hhmm) {
    let hour = Number(hhmm[1]);
    const min = hhmm[2] ? Number(hhmm[2]) : 0;
    const ap = hhmm[3]?.toLowerCase();
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
    if (hour <= 23 && min <= 59) {
      const reset = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, min, 0, 0,
      ) - tzOffset);
      // Orario già passato oggi → è di domani (il muro dura < 24h).
      if (reset.getTime() <= now.getTime()) reset.setUTCDate(reset.getUTCDate() + 1);
      if (reset.getTime() - now.getTime() <= 6 * 3600 * 1000) return reset;
    }
  }
  return null;
}

// Quando ritentare dopo un limite: 1 minuto dopo il reset dichiarato dal CLI
// (buffer per non ripartire proprio sullo scoccare del reset), altrimenti
// fallback prudente di 30 minuti (requisito 2: backoff quando l'orario non c'è).
export function usageLimitRetryAt(message) {
  const reset = parseUsageLimitReset(message);
  if (reset) return new Date(reset.getTime() + 60000).toISOString();
  return new Date(Date.now() + 30 * 60000).toISOString();
}

export function getRun(id) { return runs[id] ?? null; }
export function isActiveNow(id) { return activeNow.has(id); }

export function listRuns(tenantId) {
  return Object.values(runs).filter((r) => !tenantId || r.tenantId === tenantId);
}

// Conteggio run marcate reason 'oom' (interrotte o fallite in via definitiva)
// aggiornate nelle ultime 24h — esposto in GET /api/settings/concurrency
// (task 16edce3a, requisito 3) per la UI/digest serale. Conta la run una
// volta sola per id anche se ha già ritentato (updatedAt si aggiorna in
// place, non genera nuove entry).
export function countOomFailures24h(now = Date.now()) {
  const cutoff = now - 24 * 60 * 60 * 1000;
  return Object.values(runs).filter(
    (r) => r.reason === 'oom' && Date.parse(r.updatedAt ?? r.startedAt) >= cutoff,
  ).length;
}

// Run che il watchdog deve riprendere: interrupted con retry maturato, run
// in pausa a tempo con resumeAt maturato, oppure running/resumed con heartbeat
// stantio e non attive in questo processo (zombie).
export function listResumable(now = Date.now()) {
  return Object.values(runs).filter((r) => {
    if (r.external) return false; // il server non può riprendere processi esterni
    if (activeNow.has(r.id)) return false;
    if (r.status === 'interrupted') return !r.nextRetryAt || Date.parse(r.nextRetryAt) <= now;
    if (r.status === 'paused') return Boolean(r.resumeAt) && Date.parse(r.resumeAt) <= now;
    if (r.status === 'running' || r.status === 'resumed') {
      return now - Date.parse(r.heartbeatAt ?? r.startedAt) > STALE_HEARTBEAT_MS;
    }
    return false;
  });
}
