// Budget token EMPIRICO della finestra Max (task board b8b98175). La subscription
// Max non pubblica il numero di token della finestra 5h: lo STIMIAMO dai dati che
// abbiamo già (usage dell'SDK nel journal + i "muri" del rate limit). L'idea:
//   1) sommiamo i token consumati dalla piattaforma nella finestra corrente;
//   2) quando scatta un rate limit registriamo un "limit event" = quanti token
//      la finestra aveva accumulato al momento del muro (+ l'orario di reset);
//   3) con 2-3 limit event si ottiene una stima prudenziale del budget della
//      finestra, che si raffina nel tempo (più muri osserviamo, più è accurata);
//   4) da lì derivano % residuo, proiezione di esaurimento e una policy per il
//      dispatcher (throttle → solo critiche, margine riservato per il quality
//      gate, stop ordinato prima del muro invece di schiantarsi a metà run).
//
// TUTTO in memoria come sorgente di verità, persistito su server/data/budget.json
// (gitignored) per sopravvivere ai riavvii DENTRO la finestra. Scrittura solo sui
// cambi (recordUsage/noteLimitEvent), letture pure in memoria: niente I/O nel path
// caldo del dispatcher.
import { join } from 'path';
import { readJson, writeJson, DATA_DIR } from './store.js';

const BUDGET_FILE = join(DATA_DIR, 'budget.json');

// Finestra Max: 5 ore rolling (documentata ovunque nella piattaforma).
export const WINDOW_MS = 5 * 60 * 60 * 1000;
// Quanti limit event storici teniamo per la stima (i più recenti: il piano/uso
// cambia nel tempo, gli ultimi muri sono più rappresentativi).
const MAX_LIMIT_EVENTS = 8;

// Soglie della policy budget-aware del dispatcher (frazioni del budget residuo).
// RICALIBRATE al ribasso (task bdca4569): il vero stop hard è il rate-limit REALE
// (isRateLimited, con auto-ripresa al reset) — la STIMA è solo advisory. Meglio un
// halt tardivo + retry che sprecare un terzo di finestra su una stima incerta.
//  - LOW: solo task critiche/alte, niente lanci massivi, tier più economici;
//  - RESERVE: solo run di review (quality gate): margine riservato al gate;
//  - HALT: stop ordinato PRIMA del muro (niente nuovi lanci), la coda aspetta il
//    reset. Backstop: col floor auto-correttivo (sotto) queste fasce restano
//    dormienti finché non scatta il muro reale; servono da rete se il floor è
//    rimosso o nei primissimi istanti di finestra.
// DECISIONE (task 88fba579, sblocca b8b2c5ec): budgetPolicy() ORA decide su
// pctRemainingRaw (residuo REALE, non floorato). Prima decideva sul floorato e
// queste soglie erano irraggiungibili per costruzione (BudgetHaltBanner = codice
// morto). Il rischio che bloccava il passaggio a raw — un singolo campione-muro
// basso → halt falso di TUTTA la piattaforma (task bdca4569, evidenza 2026-07-24
// ~2% raw vs 31% reale) — è ora eliminato ALLA FONTE dallo stimatore robusto
// (estimateBudget sotto): >=2 campioni coerenti richiesti, mediana con scarto
// outlier, scarto dei campioni sotto il consumo già osservato; con dati
// insufficienti NON si stima (known=false → policy permissiva → nessun halt).
// Quindi raw non è più avvelenabile da un dato isolato e può pilotare l'halt.
// Il floor (LIVE_HEADROOM / operativeEffective) resta SOLO sulla percentuale
// mostrata in UI (pctRemaining), non tocca più la superficie decisionale.
export const LOW_PCT = 0.15;
export const RESERVE_PCT = 0.07;
export const HALT_PCT = 0.03;

// Floor auto-correttivo del residuo (task bdca4569). PROBLEMA osservato: la stima
// da muro poggiava su UN solo campione basso (10.96M) mentre la finestra reale
// aveva ancora ~31% → halt col 2% stimato. Se la finestra corrente ha già
// consumato OLTRE la stima-da-muro SENZA aver toccato il muro reale, la stima è
// PROVATA troppo bassa: alziamo la capienza effettiva così il residuo non scende
// sotto LIVE_HEADROOM finché non scatta isRateLimited (l'unico stop hard). Valore
// calibrato ~6pt sotto l'osservazione reale del 2026-07-24 (31%) per prudenza.
export const LIVE_HEADROOM = 0.25;

// Campione di muro plausibile: sotto questa soglia un limitEvent è spazzatura
// (burst di errori rate-limit al restart con token non ancora tracciati → 0, o
// muro prematuro non rappresentativo) e NON calibra la stima.
const MIN_SAMPLE_TOKENS = 500_000;

// Peso dei cache-read nel "costo" della finestra: i token letti dalla cache di
// prompt costano ~1/10 dei token normali (sconto Anthropic), quindi pesarli 1:1
// gonfierebbe la stima. Input/output/cache-creation contano pieni. NOTA (task
// bdca4569): la quota Max pesa i cache-read anche MENO di 1/10, ma non possiamo
// ri-calibrare i campioni storici (salvavano solo lo scalare pesato, non i
// componenti). Da ora salviamo i componenti grezzi in ogni limitEvent → il peso
// sarà ri-tarabile sui dati; nel frattempo il floor auto-correttivo compensa la
// sovrastima residua e il rate-limit reale resta il vero stop.
const CACHE_READ_WEIGHT = 0.1;

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, billable: 0 };
}

// Token "fatturabili" della finestra secondo la metrica sopra (usati per budget/
// proiezioni); i componenti grezzi restano disponibili per la UI.
export function billableOf({ input = 0, output = 0, cacheRead = 0, cacheCreation = 0 } = {}) {
  return Math.round(input + output + cacheCreation + cacheRead * CACHE_READ_WEIGHT);
}

// { window: {startAt, resetAt, tokens}, limitEvents: [{at, windowTokens, resetAt}] }
let state = null;
(function hydrate() {
  const s = readJson(BUDGET_FILE, null);
  if (s && s.window) state = s;
  else state = { window: null, limitEvents: [] };
})();

let onChange = null;
export function setBudgetChangeListener(fn) { onChange = fn; }

function persist() {
  writeJson(BUDGET_FILE, state);
}

// Assicura che esista una finestra corrente valida per `now`, facendola rollare
// se scaduta (now oltre resetAt). Un rollover azzera i token accumulati: è
// l'inizio di una nuova quota Max.
function ensureWindow(now) {
  const w = state.window;
  if (!w) {
    state.window = { startAt: new Date(now).toISOString(), resetAt: new Date(now + WINDOW_MS).toISOString(), tokens: emptyTokens() };
    return state.window;
  }
  if (now >= Date.parse(w.resetAt)) {
    // Nuova finestra: parte dal reset della precedente se il salto è piccolo
    // (finestre contigue), altrimenti da adesso (server fermo a lungo).
    const prevReset = Date.parse(w.resetAt);
    const startAt = now - prevReset < WINDOW_MS ? prevReset : now;
    state.window = { startAt: new Date(startAt).toISOString(), resetAt: new Date(startAt + WINDOW_MS).toISOString(), tokens: emptyTokens() };
  }
  return state.window;
}

// Registra i token di UNA risposta SDK nella finestra corrente. usage = shape
// del journal ({input, output, cacheRead, cacheCreation}). Chiamata da
// runAgentTurn a ogni result. Idempotenza non richiesta: ogni result è unico.
export function recordUsage(usage = {}, now = Date.now()) {
  if (state.unit !== 'api_usd_equivalent') {
    state = { window: null, limitEvents: [], unit: 'api_usd_equivalent' };
  }
  const w = ensureWindow(now);
  const t = w.tokens;
  t.input += usage.input ?? 0;
  t.output += usage.output ?? 0;
  t.cacheRead += usage.cacheRead ?? 0;
  t.cacheCreation += usage.cacheCreation ?? 0;
  t.billable = billableOf(t);
  persist();
  onChange?.();
  return w;
}

// Registra un "muro" del rate limit: la finestra corrente aveva accumulato
// `window.tokens.billable` token quando la quota si è esaurita → è una misura
// empirica del budget della finestra. Salviamo anche l'orario di reset (fine
// finestra) e allineiamo il resetAt della finestra a quello reale del muro.
// Chiamata da runAgentTurn quando isUsageLimitError (task ca71d849 già rileva
// il muro; qui ci agganciamo per imparare il budget).
export function noteLimitEvent({ resetAt = null, message = '' } = {}, now = Date.now()) {
  const w = ensureWindow(now);
  const windowTokens = w.tokens.billable;
  state.limitEvents.push({
    at: new Date(now).toISOString(),
    windowTokens,
    // Componenti grezzi al muro (task bdca4569): permettono di ri-calibrare il
    // peso dei cache-read sui dati reali in futuro, cosa impossibile con il solo
    // scalare pesato. weightAtRecord = peso usato per `windowTokens` qui.
    components: { ...w.tokens },
    weightAtRecord: CACHE_READ_WEIGHT,
    resetAt: resetAt ?? null,
    message: String(message ?? '').slice(0, 160),
  });
  // Teniamo solo i più recenti.
  if (state.limitEvents.length > MAX_LIMIT_EVENTS) {
    state.limitEvents = state.limitEvents.slice(-MAX_LIMIT_EVENTS);
  }
  // Il muro segna la fine reale della finestra: allinea resetAt (se plausibile,
  // entro la finestra) così il tracker e il budget scadono in lockstep col reset.
  if (resetAt && Date.parse(resetAt) > now) {
    w.resetAt = resetAt;
  }
  persist();
  onChange?.();
  return getBudgetState(now);
}

// Banda di coerenza attorno alla mediana: un campione-muro che se ne discosta
// oltre questa frazione è un outlier (muro prematuro/anomalo o burst) e non
// calibra la stima. Scarto simmetrico (outlier bassi E alti).
const OUTLIER_BAND = 0.4;
// Minimo di campioni coerenti per OSARE una stima. Con meno NON si stima
// (operative=null → known=false → policy permissiva → nessun halt): un singolo
// campione-muro è avvelenabile (evidenza 2026-07-24: ~2% raw vs 31% reale) e
// non deve mai poter decidere un halt di piattaforma. Meglio "non so → non
// fermo" che fermare tutto su un dato isolato (il vero stop resta isRateLimited).
const MIN_SAMPLES_FOR_ESTIMATE = 2;

function median(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Stima ROBUSTA del budget della finestra dai limit event osservati (task
// 88fba579). Pipeline di scarto, poi mediana dei campioni superstiti:
//   1) scarta la spazzatura (< MIN_SAMPLE_TOKENS): burst di errori al restart;
//   2) scarta i campioni INCOERENTI CON LA FINESTRA: se la finestra corrente ha
//      già consumato più di un campione SENZA toccare il muro reale, quel
//      campione è PROVATO troppo basso (il budget è almeno usedTokens) → fuori;
//   3) serve >=2 campioni coerenti: con meno, operative=null (non stimare);
//   4) scarto outlier: tieni solo i campioni entro OUTLIER_BAND dalla mediana;
//      se ne restano <2 i dati sono troppo dispersi → operative=null;
//   5) operative = mediana dei campioni coerenti (robusta ai singoli outlier,
//      a differenza del vecchio min() avvelenabile da un solo campione basso).
// usedTokens (dalla finestra corrente) alimenta il passo 2; default 0 = nessun
// vincolo di coerenza (chiamata diretta nei test/diagnosi).
export function estimateBudget(usedTokens = 0) {
  const clean = state.limitEvents
    .map((e) => e.windowTokens)
    .filter((wt) => wt >= MIN_SAMPLE_TOKENS && wt >= usedTokens)
    .sort((a, b) => a - b);
  const insufficient = { operative: null, avg: null, min: null, max: null, samples: clean.length, kept: 0 };
  if (clean.length < MIN_SAMPLES_FOR_ESTIMATE) return insufficient;
  const med = median(clean);
  const kept = clean.filter((wt) => Math.abs(wt - med) <= med * OUTLIER_BAND);
  if (kept.length < MIN_SAMPLES_FOR_ESTIMATE) return insufficient;
  const operative = median(kept);
  const avg = Math.round(kept.reduce((a, b) => a + b, 0) / kept.length);
  return { operative, avg, min: kept[0], max: kept[kept.length - 1], samples: clean.length, kept: kept.length };
}

// Vista della finestra corrente per `now`, con rollover VIRTUALE (senza
// persistere): se la finestra è scaduta i token risultano azzerati subito —
// così UI/policy/contesto vedono la quota fresca appena passato il reset, anche
// prima che un nuovo recordUsage materializzi il rollover su disco.
function windowView(now) {
  const w = state.window;
  if (!w) return { startAt: null, resetAt: null, tokens: emptyTokens(), tokensUsed: 0 };
  if (now >= Date.parse(w.resetAt)) {
    const prevReset = Date.parse(w.resetAt);
    const startAt = now - prevReset < WINDOW_MS ? prevReset : now;
    return {
      startAt: new Date(startAt).toISOString(),
      resetAt: new Date(startAt + WINDOW_MS).toISOString(),
      tokens: emptyTokens(),
      tokensUsed: 0,
    };
  }
  return { startAt: w.startAt, resetAt: w.resetAt, tokens: w.tokens, tokensUsed: w.tokens.billable };
}

// Stato completo del budget della finestra corrente (per UI, contesto agenti,
// policy dispatcher). Sempre definito anche senza dati (known=false).
export function getBudgetState(now = Date.now()) {
  const v = windowView(now);
  const tokensUsed = v.tokensUsed;
  // Stima robusta calibrata anche sul consumo già osservato (scarto dei campioni
  // sotto usedTokens, provati troppo bassi): vedi estimateBudget passo 2.
  const est = estimateBudget(tokensUsed);
  const startAt = v.startAt;
  const resetAt = v.resetAt;
  const known = est.operative != null;

  // Capienza EFFETTIVA con auto-correzione (task bdca4569): se la finestra ha già
  // consumato oltre la stima-da-muro senza toccare il muro reale, la stima è
  // provata bassa → alza la capienza così il residuo resta ≥ LIVE_HEADROOM finché
  // isRateLimited (unico stop hard) non scatta. Esposta come estimate.operativeEffective.
  let operativeEff = est.operative;
  if (known) {
    const floorByLive = Math.round(tokensUsed / (1 - LIVE_HEADROOM));
    operativeEff = Math.max(est.operative, floorByLive);
  }

  // Due campi, due platee (task 88fba579): il floor sopra garantisce
  // pctRemaining ≥ LIVE_HEADROOM (25%) per costruzione.
  // - pctRemaining/pctUsed (floorati su operativeEff): SOLO UI di progresso
  //   (BudgetPanel) — smoothing per non mostrare mai rosso su stima incerta.
  // - pctRemainingRaw/pctUsedRaw (su est.operative robusto, NESSUN floor): il
  //   residuo REALE, superficie DECISIONALE — budgetPolicy() (dispatcher +
  //   BudgetHaltBanner) e i guardrail isolati (codequality.js, pmplatform.js).
  let pctUsed = null;
  let pctRemaining = null;
  let pctUsedRaw = null;
  let pctRemainingRaw = null;
  let projectedExhaustionAt = null;
  let burnPerMin = null;
  if (known) {
    pctUsed = Math.min(1, tokensUsed / operativeEff);
    pctRemaining = Math.max(0, 1 - pctUsed);
    pctUsedRaw = Math.min(1, tokensUsed / est.operative);
    pctRemainingRaw = Math.max(0, 1 - pctUsedRaw);
    const elapsedMin = startAt ? Math.max(1, (now - Date.parse(startAt)) / 60000) : null;
    if (elapsedMin) {
      burnPerMin = tokensUsed / elapsedMin;
      const remainingTokens = Math.max(0, operativeEff - tokensUsed);
      if (burnPerMin > 0) {
        projectedExhaustionAt = new Date(now + (remainingTokens / burnPerMin) * 60000).toISOString();
      }
    }
  }

  return {
    known,
    windowStart: startAt,
    resetAt,
    resetsInMs: resetAt ? Math.max(0, Date.parse(resetAt) - now) : null,
    unit: state.unit ?? 'legacy_weighted_tokens',
    tokensUsed,
    apiUsdUsed: state.unit === 'api_usd_equivalent' ? tokensUsed / 1_000_000 : null,
    tokens: v.tokens,
    estimate: { ...est, operativeEffective: known ? operativeEff : null, apiUsd: state.unit === 'api_usd_equivalent' && est.operative != null ? est.operative / 1_000_000 : null },
    pctUsed,
    pctRemaining,
    pctUsedRaw,
    pctRemainingRaw,
    burnPerMin: burnPerMin != null ? Math.round(burnPerMin) : null,
    projectedExhaustionAt,
    limitEvents: state.limitEvents.length,
  };
}

// Policy budget-aware per il dispatcher (una sola valutazione per tick, il
// budget è globale di piattaforma — quota Max condivisa da tutti i tenant).
// Con budget sconosciuto (nessun limit event) è tutto permissivo: non frenare
// mai su una stima che non abbiamo.
export function budgetPolicy(now = Date.now()) {
  const s = getBudgetState(now);
  if (!s.known) {
    return {
      known: false, shouldThrottle: false, shouldReserveForReview: false,
      shouldHaltAll: false, pctRemaining: null,
    };
  }
  // DECIDE sul residuo REALE non floorato (task 88fba579): lo stimatore robusto
  // (estimateBudget) rende pctRemainingRaw affidabile — >=2 campioni coerenti o
  // known=false → nessun singolo campione-muro basso può più causare un halt
  // falso (era il rischio che teneva la decisione sul floorato). Il floor resta
  // solo su s.pctRemaining, esposto qui per la UI del banner, senza decidere.
  // Epsilon: il residuo raw è un rapporto in virgola mobile, sul confine esatto
  // (es. 97% consumato → 0.03000…0027) l'uguaglianza va persa; il confine è
  // inclusivo per intento ("al 3% o meno → halt").
  const rem = s.pctRemainingRaw;
  const EPS = 1e-9;
  // Tre soglie reali, un campo per ciascuna (task 10ae7949: prima erano 6 alias
  // per le stesse 3 soglie, con 2 nomi morti e una coppia di nomi quasi identici
  // ma di gravità opposta). Il nome porta ora la soglia esplicitamente.
  const shouldHaltAll = rem <= HALT_PCT + EPS;             // <=3%: stop ordinato prima del muro
  const shouldReserveForReview = rem <= RESERVE_PCT + EPS; // <=7%: solo review, margine per il gate
  const shouldThrottle = rem <= LOW_PCT + EPS;             // <=15%: solo critiche/alte, niente raffica
  return {
    known: true,
    pctRemaining: s.pctRemaining,       // floorato: SOLO display (banner UI)
    pctRemainingRaw: rem,               // reale: valore che ha deciso le soglie
    shouldThrottle,
    shouldReserveForReview,
    shouldHaltAll,
  };
}

// Riga singola di contesto per CEO/manager (requisito 6): iniettata nel system
// prompt a ogni turno, così il ragionamento sulle priorità tiene conto davvero
// del budget residuo e dell'orario di reset.
export function budgetObjectiveLine(now = Date.now()) {
  const s = getBudgetState(now);
  const obiettivo = 'Obiettivo: massimizza le task completate con output di ottima qualità nel minor tempo possibile, dentro il limite token di Claude (finestra 5h, subscription Max).';
  if (!s.known) {
    return `${obiettivo} Budget finestra: stima non ancora disponibile (servono 2-3 muri di rate limit per calibrarla); lavora normalmente ma senza sprechi.`;
  }
  // Residuo REALE (raw): stessa base su cui decide il dispatcher, così la guida
  // al CEO/manager coincide con ciò che accade davvero ai lanci (task 88fba579).
  const rem = s.pctRemainingRaw ?? s.pctRemaining;
  const pct = Math.round(rem * 100);
  const reset = s.resetAt ? new Date(s.resetAt).toISOString().slice(11, 16) : '—';
  let guida = '';
  // Sotto la soglia RESERVE il dispatcher FERMA l'esecuzione (solo review): le
  // task delegate NON partono finché non torna la quota. Il CEO/manager DEVE
  // dirlo esplicitamente a Owner (board in coda per quota, riparte alle HH:MM),
  // non fingere che parta subito — altrimenti sembra che deleghi ma non succeda nulla.
  const codaPerQuota = ` L'esecuzione autonoma è in PAUSA per quota esaurita: le task che deleghi restano in coda e ripartono da sole al reset (${reset} UTC), per urgenza. Dillo a Owner con chiarezza — «board in coda per quota, riparte alle ${reset}» — non dire che parte subito.`;
  if (rem <= HALT_PCT) guida = ` Vicino al muro: chiudi/consegna ciò che è in corso, non aprire nuovi fronti.${codaPerQuota}`;
  else if (rem <= RESERVE_PCT) guida = ` Budget molto basso: priorità assoluta al quality gate (review), riserva il margine, niente nuovo lavoro non critico.${codaPerQuota}`;
  else if (rem <= LOW_PCT) guida = ' Budget basso: solo task critiche/alte, tier economici dove sensato, niente lanci massivi.';
  return `${obiettivo} Budget finestra ~${pct}% residuo, reset alle ${reset} (UTC).${guida}`;
}

// Solo per i test: azzera lo stato in memoria e su disco.
export function resetBudgetForTest() {
  state = { window: null, limitEvents: [] };
  persist();
}

// Solo per i test: imposta uno stato deterministico (finestra corrente + limit
// event storici) senza dover simulare il tempo reale. samples = totali-al-muro
// osservati (calibrano la stima); usedTokens = billable consumato nella finestra
// corrente; windowStart/resetAt = confini della finestra corrente.
export function seedForTest({ samples = [], usedTokens = 0, windowStart = Date.now(), resetAt = Date.now() + WINDOW_MS } = {}) {
  state = {
    window: {
      startAt: new Date(windowStart).toISOString(),
      resetAt: new Date(resetAt).toISOString(),
      tokens: { input: usedTokens, output: 0, cacheRead: 0, cacheCreation: 0, billable: usedTokens },
    },
    limitEvents: samples.map((wt, i) => ({
      at: new Date(windowStart - (i + 1) * 60000).toISOString(),
      windowTokens: wt,
      resetAt: null,
      message: 'test',
    })),
  };
  persist();
}
