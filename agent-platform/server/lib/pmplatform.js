// pm-platform: system job giornaliero (06:00) sull'infrastruttura Schedules
// (stesso motore di backup/digest/code-quality — vedi scheduler.js / agentjobs.js).
// Lancia il MANAGER `pm-platform` (org platform) per una run di MIGLIORAMENTO
// PROATTIVO della piattaforma (decisione Owner, task 5352926c): analizza lo stato
// (wiki, board, journal, feedback di Owner) e apre fino a 3 task nuove, motivate e
// verificabili, ai dev / a cto-platform, rispettando i guardrail.
//
// Skip DETERMINISTICO se il budget della finestra Max è <25%: non si spende una
// run proprio quando la quota è quasi esaurita (come code-quality e il digest sul
// giorno vuoto). La run parte via scheduleRun → sessione normale, journaled e
// visibile in "Agenti live" (requisito: run nel journal). Il focus/guardrail è
// nel system prompt dell'agente (tenants.json) + ribadito nel prompt della run.
import { getBudgetState } from './budget.js';
import { scheduleRun } from './concurrency.js';
import { logAudit } from './audit.js';
import { isoDay } from './store.js';

export const PLATFORM_TENANT = 'platform';
export const PM_PLATFORM_AGENT = 'pm-platform';
// Sotto questa frazione di budget residuo la run del giorno viene saltata.
export const MIN_BUDGET_FRACTION = 0.25;

// Prompt della run: la missione + i guardrail, self-contained (il system prompt
// dell'agente li ha già; qui li ribadiamo perché la run non fallisca se cambia).
export function pmPlatformPrompt(now = Date.now()) {
  const day = isoDay(now);
  return [
    `Run giornaliera pm-platform — ${day}. Missione: MIGLIORARE PROATTIVAMENTE la piattaforma. Output = fino a 3 task nuove sul board, motivate e verificabili. NON scrivi codice.`,
    '',
    'ANALISI STATO (leggi prima di proporre):',
    '- WIKI: `wiki_read` su prodotto.md, audit-mobile-pwa.md, decisions.md, roadmap.md, processi.md — feature mancanti, attriti noti, problemi d\'audit non ancora a board.',
    '- BOARD: `list_tasks` su TUTTI gli stati — cosa è done di recente, cosa è bloccato/needs_input, pattern e attriti ricorrenti. Serve anche per l\'anti-duplicati.',
    '- JOURNAL/RUN: con Bash guarda server/data/runs.json e gli audit — run fallite/interrotte non recuperate, colli di bottiglia, run lente o ripetute.',
    '- FEEDBACK OWNER: digest.md (wiki) e la chat del CEO — cosa lamenta o chiede di ricorrente.',
    'Puoi spawnare sotto-agenti operativi per analisi in parallelo (registrati nel journal, docs/governance.md, entro il cap globale); ma CONSOLIDI TU l\'unica lista finale.',
    '',
    'INDIVIDUA MIGLIORAMENTI concreti su 4 assi: UX, robustezza, feature mancanti, attriti operativi. Priorità a ciò che sblocca altro lavoro o riduce un attrito ricorrente.',
    '',
    'CREA LE TASK (`create_task`) — SPECIFICHE e VERIFICABILI, con criteri di completamento:',
    '- assignedTo: `dev-backend` (server/), `dev-frontend` (web/), o `cto-platform` per le architetturali.',
    '- OGNI task cita la MOTIVAZIONE/EVIDENZA da cui nasce (run fallita X, voce d\'audit Y, attrito Z, feedback di Owner).',
    '',
    'GUARDRAIL (non negoziabili):',
    '- MAX 3 task nuove. Se emergono più idee, tieni le 3 a impatto più alto; le altre le citi nel report roadmap, non le apri.',
    '- ANTI-DUPLICATI: NON aprire una task già presente (stesso tema anche se fraseggiato diverso) né una già chiusa di recente sullo stesso punto. Nel dubbio, non crearla.',
    '- URGENZA default bassa/media. MAI alta/critica (solo il CEO).',
    '- IDEA GROSSA O COSTOSA (rework architetturale, nuova superficie importante, scelta di prodotto) → NON crearla di slancio: `ask_owner` PRIMA per l\'ok, poi eventualmente aprila.',
    '',
    `WIKI (a fine run, obbligatoria): prependi in roadmap.md una sezione "## ${day} — pm-platform run" con: cosa analizzato, task aperte (id + titolo + evidenza), idee scartate/rimandate, eventuali ask_owner. Scrivi il contenuto COMPLETO con wiki_write (crea la pagina + riga in INDEX.md se non esiste). Se una proposta è una decisione di indirizzo, loggala anche in decisions.md (stile ADR).`,
    '',
    'Poi termina: le task ai dev viaggiano nel gate normale (dev → cto-platform → CEO); non consegni nulla di tuo al gate se non hai toccato codice. La sintesi delle proposte finisce nel digest serale in automatico.',
  ].join('\n');
}

// ---- Entry point del system job ----------------------------------------------
// runFn = runAgentTurn (iniettata da index.js). Ritorna {skipped, reason} se
// salta per budget, altrimenti la promise di scheduleRun. getBudget iniettabile
// per i test (default: lo stato reale della finestra).
export function runPmPlatform({ runFn, now = Date.now(), getBudget = getBudgetState }) {
  const budget = getBudget(now);
  // pctRemainingRaw (NON floorato), non pctRemaining: quest'ultimo è floorato
  // ≥25% per costruzione (getBudgetState, task b8b2c5ec) e renderebbe questo
  // skip irraggiungibile per sempre — bug corretto da questa stessa task.
  if (budget.known && budget.pctRemainingRaw != null && budget.pctRemainingRaw < MIN_BUDGET_FRACTION) {
    const pct = Math.round(budget.pctRemainingRaw * 100);
    logAudit({
      user: 'pm-platform', tenant: PLATFORM_TENANT, event: 'pm_platform_skip',
      detail: { reason: 'budget', pctRemaining: pct },
    });
    return Promise.resolve({ skipped: true, reason: 'budget', pctRemaining: pct });
  }

  const sessionId = `pmplat-${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  logAudit({
    user: 'pm-platform', tenant: PLATFORM_TENANT, event: 'pm_platform_run',
    detail: { sessionId },
  });
  return scheduleRun(runFn, {
    tenantId: PLATFORM_TENANT,
    agentId: PM_PLATFORM_AGENT,
    sessionId,
    message: pmPlatformPrompt(now),
    username: 'pm-platform',
    source: 'pm-platform',
    singleton: true, // una sola run pm-platform attiva per volta (task 01ed5b8d)
    urgency: 'bassa',
    runTitle: 'pm-platform — miglioramento proattivo',
  });
}
