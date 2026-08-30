// Code-quality: system job giornaliero (05:00) sull'infrastruttura Schedules
// (stesso motore di backup/digest — vedi scheduler.js). Lancia l'agente
// `code-quality` (org platform) per una run di review qualità del codice a
// FOCUS RISTRETTO — solo 2 ambiti per run, così l'attenzione è profonda e non
// un check superficiale su tutto (decisione Owner, task aabd54ca):
//   A) SEMPRE: il diff dei giorni precedenti (commit recenti server/ + web/).
//   B) A ROTAZIONE FISSA: UN solo aspetto del codice esistente al giorno,
//      calendario settimanale calcolato dalla DATA e iniettato nel prompt (NON
//      scelto dall'agente).
//
// Skip DETERMINISTICO se il budget della finestra Max è <25%: non si spende una
// run proprio quando la quota è quasi esaurita (come il corto-circuito del
// digest sul giorno vuoto). La run parte via scheduleRun → è una sessione
// normale, journaled e visibile in "Agenti live" (requisito: run nel journal).
import { getBudgetState } from './budget.js';
import { scheduleRun } from './concurrency.js';
import { logAudit } from './audit.js';
import { isoDay } from './store.js';

export const PLATFORM_TENANT = 'platform';
export const CODE_QUALITY_AGENT = 'code-quality';
// Sotto questa frazione di budget residuo la run del giorno viene saltata.
export const MIN_BUDGET_FRACTION = 0.25;

// Calendario di rotazione (requisito B): indicizzato per Date.getDay()
// (0=domenica … 6=sabato). Un solo aspetto dell'esistente per giorno.
export const FOCUS_BY_DAY = [
  { day: 'dom', key: 'naming',         label: 'Naming, struttura delle cartelle e coerenza con le convenzioni di processi.md (nomi fuorvianti, incoerenze, file fuori posto).' },
  { day: 'lun', key: 'dry',            label: 'Duplicazione / DRY: logica ripetuta o copia-incolla tra moduli, blocchi estraibili in helper condivisi.' },
  { day: 'mar', key: 'dead-code',      label: 'Codice morto: file/export/rami mai usati, import inutilizzati, CSS orfano (es. gli stili kanban del problema C2 dell\'audit mobile).' },
  { day: 'mer', key: 'error-handling', label: 'Error handling: catch vuoti/silenziosi, errori ingoiati senza log, promise non gestite (unhandled rejection), fallback che nascondono i bug.' },
  { day: 'gio', key: 'security',       label: 'Sicurezza: input non validati, secrets nel codice, endpoint senza auth/authorization, path traversal, injection.' },
  { day: 'ven', key: 'complexity',     label: 'Complessità: funzioni troppo lunghe, nesting profondo, God-file/God-function da spezzare, condizioni illeggibili.' },
  { day: 'sab', key: 'deps-perf',      label: 'Dipendenze (inutilizzate in package.json, obsolete, vulnerabili) e performance (letture ripetute, lavoro O(n²) evitabile, sync bloccante nell\'event loop).' },
];

// Focus dell'ambito B per la data della run.
export function focusForDay(now = Date.now()) {
  return FOCUS_BY_DAY[new Date(now).getDay()];
}

// Prompt della run: focus A (diff) + focus B (aspetto del giorno) già iniettati.
// L'agente NON sceglie il focus: è deterministico dalla data.
export function codeQualityPrompt(focus, now = Date.now()) {
  const day = isoDay(now);
  return [
    `Run giornaliera di qualità del codice della piattaforma — ${day}. FOCUS RISTRETTO: esattamente 2 ambiti, niente altro (attenzione profonda, non un check superficiale su tutto).`,
    '',
    'AMBITO A (SEMPRE) — review del diff dei giorni precedenti:',
    '- Con Bash/git guarda i commit recenti (ultime ~24-48h, o gli ultimi commit se non ce ne sono di così recenti) che toccano server/ e web/: `git log --since="2 days ago" --oneline -- server web` e `git diff` dei relativi commit.',
    '- Cerca: bug introdotti, sporcizia, duplicazioni nuove, incoerenze con le convenzioni, TODO/regressioni.',
    '',
    `AMBITO B (SOLO OGGI, ${focus.day}) — un unico aspetto del codice ESISTENTE:`,
    `- ${focus.label}`,
    '- Analizza SOLO questo aspetto sull\'esistente; non allargarti agli altri (quelli hanno il loro giorno).',
    '',
'PLAYBOOK: prima di giudicare, leggi con wiki_read la pagina platform "playbook-code-quality.md" — principi Google code review, code smells di Fowler, OWASP Top 10, Clean Code, con SOGLIE concrete (funzione >50 righe = spezza; ciclomatica >20 = spezza; nesting >4; >3 parametri; file >500; duplicazione alla 3ª occorrenza) e il TEMPLATE per le task ai dev. Applica quelle soglie, non a sensazione.',
    '',
    'CHECKLIST DA SENIOR (usala come lente sui 2 ambiti sopra): duplicazione/DRY; codice morto; funzioni lunghe/complessità; naming; error handling silenzioso (catch vuoti, errori ingoiati); smell di sicurezza (input non validati, secrets nel codice, endpoint senza auth); dipendenze inutilizzate; coerenza con le convenzioni di processi.md.',
    '',
    'COSA FARE CON I RISULTATI (regola di modalità, non negoziabile):',
    '1. Refactor PICCOLO e SICURO (≤ ~50 righe, ZERO cambi di comportamento, build/test verdi): APPLICALO direttamente con Edit. Prima e dopo verifica con Bash che nulla si rompa — `node --check` sui file server toccati, gli script server/scripts/*-check.mjs pertinenti, e `npm run build` in web/ se hai toccato la PWA. Se non riesci a garantire zero-regressioni, NON applicarlo: aprilo come task ai dev (punto 2).',
'2. Tutto il resto (refactor grande, cambio di comportamento, dubbio, bug non banale): NON toccare il codice — crea una task sul board con create_task, assignedTo `dev-backend` (server/) o `dev-frontend` (web/). IMBOCCA l\'operativo con il TEMPLATE del playbook, compilato campo per campo (Titolo [area] · File:riga · Problema · Perché conta [+categoria, es. OWASP A01] · Fix suggerito · Come verificare · Urgenza), un problema = una task. Mappa urgenza→board: P0=critica, P1=alta, P2=media, Nit=bassa.',
    '3. LIMITI DURI: MAI toccare server/data (dati vivi) né la wiki di altri tenant. Resta dentro server/ e web/ per il codice, e nella wiki platform per la documentazione.',
    '',
    'CONSEGNA E REPORT:',
    `- REPORT SINTETICO della run: aprilo con wiki_read sulla pagina wiki "code-quality.md" (se non esiste creala con un\'intestazione) e PREPENDI una sezione "## ${day} — focus: ${focus.key}" con: cosa hai guardato (diff + aspetto del giorno), refactor applicati (file, righe, verifica), task aperte ai dev (id + titolo), oppure "nulla da segnalare". Scrivi il contenuto COMPLETO della pagina con wiki_write passando confirm_restructure: true (potatura di una pagina-log: senza quel flag la guardia entry-loss rifiuta la scrittura). Tieni ~30 sezioni, le più vecchie restano nella history git.`,
    '- Se hai APPLICATO uno o più refactor: (a) logga OGNI refactor in decisions.md della wiki platform con wiki_append (una voce, stile ADR: data, cosa, perché) NELLA STESSA run; (b) porta i refactor al quality gate: crea una task `create_task` (assignedTo `code-quality`, titolo «Code quality '+day+' — refactor '+focus.key+'», descrizione = elenco refactor + come verificato) e poi `update_task` a status "review_manager" così il gate CTO→CEO rivede il diff. Se il gate boccia, correggi e riconsegna.',
    '- Se NON hai applicato refactor: niente task al gate; il report in wiki + le eventuali task ai dev bastano. Poi termina.',
    '',
    'Run breve e mirata: niente lavoro fuori dai 2 ambiti, niente refactor rischiosi, ogni pezzo di lavoro deciso esiste come task sul board.',
  ].join('\n');
}

// ---- Entry point del system job ----------------------------------------------
// runFn = runAgentTurn (iniettata da index.js). Ritorna {skipped, reason} se
// salta per budget, altrimenti la promise di scheduleRun. `getBudget` è
// iniettabile per i test (default: lo stato reale della finestra).
export function runCodeQuality({ runFn, now = Date.now(), getBudget = getBudgetState }) {
  const budget = getBudget(now);
  // pctRemainingRaw (NON floorato), non pctRemaining: quest'ultimo è floorato
  // ≥25% per costruzione (getBudgetState, task b8b2c5ec) e renderebbe questo
  // skip irraggiungibile per sempre — bug corretto da questa stessa task.
  if (budget.known && budget.pctRemainingRaw != null && budget.pctRemainingRaw < MIN_BUDGET_FRACTION) {
    const pct = Math.round(budget.pctRemainingRaw * 100);
    logAudit({
      user: 'code-quality', tenant: PLATFORM_TENANT, event: 'code_quality_skip',
      detail: { reason: 'budget', pctRemaining: pct },
    });
    return Promise.resolve({ skipped: true, reason: 'budget', pctRemaining: pct });
  }

  const focus = focusForDay(now);
  const sessionId = `codeq-${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  logAudit({
    user: 'code-quality', tenant: PLATFORM_TENANT, event: 'code_quality_run',
    detail: { focus: focus.key, sessionId },
  });
  return scheduleRun(runFn, {
    tenantId: PLATFORM_TENANT,
    agentId: CODE_QUALITY_AGENT,
    sessionId,
    message: codeQualityPrompt(focus, now),
    username: 'code-quality',
    source: 'code-quality',
    singleton: true, // un solo agente code-quality attivo per volta (task 01ed5b8d)
    urgency: 'bassa',
    runTitle: `Code quality — ${focus.key}`,
  });
}
