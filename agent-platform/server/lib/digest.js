// Digest serale a Owner (task board c5ac40a1): un riassunto giornaliero, aggregato
// su TUTTI i tenant, consegnato via push e archiviato nella wiki platform
// (digest.md) per rileggere i giorni precedenti. Approvato da Owner: "un riassunto
// al giorno per non dover entrare a controllare".
//
// Gira come SYSTEM JOB sull'infrastruttura Schedules esistente (stesso tick dello
// scheduler, dedup al minuto), cron configurabile in config/platform.json
// (digest.cron, default "0 21 * * *"). Nessun secondo timer, nessuna dipendenza.
//
// Perché l'aggregazione è lato server e non la fa il CEO da solo: i tool MCP del
// CEO (list_tasks) vedono SOLO il proprio tenant (platform). Il digest è su tutti
// i tenant, quindi qui raccogliamo i fatti grezzi cross-tenant (board di ogni
// tenant + journal delle run + budget finestra Max) e li iniettiamo nel prompt.
// Il CEO NON usa un template rigido: compone un riassunto sensato dai fatti
// (requisito 5), poi lo salva in digest.md e lo manda via notify_owner.
//
// Regola anti-rumore (requisito 4): se il giorno è vuoto (zero attività), il
// digest è UNA riga consegnata in modo deterministico dal job stesso, senza
// spendere una run LLM (niente da riassumere, e non si sprecano token Max).
import { listTasks, countDispatchExhausted } from './tasks.js';
import { listRuns } from './runs.js';
import { getBudgetState } from './budget.js';
import { readPage, writePage } from './wiki.js';
import { scheduleRun } from './concurrency.js';
import { logAudit } from './audit.js';
import { countAutoRecoveryToday } from './autorecover.js';
import { findOrphanSystemJobRuns } from './jobhealth.js';
import { listPendingActivation } from './pendingactivation.js';

export const PLATFORM_TENANT = 'platform';
export const DIGEST_PAGE = 'digest.md';
// Giorni tenuti nella pagina viva; lo storico completo resta nella history git
// (ogni scrittura wiki è un commit), quindi non si perde nulla comprimendo.
export const MAX_ARCHIVE_DAYS = 30;

// Soglia oltre cui una task in fase di quality gate (review_manager/review_ceo)
// è "ferma" e va segnalata nel digest per tenant (task 66ea084a, requisito 3):
// così un blocco del dispatcher/gate riemerge da solo nel riassunto serale.
const GATE_STUCK_HOURS = 6;

const startOfLocalDay = (now) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const isSince = (iso, since) => Boolean(iso) && Date.parse(iso) >= since;
const hoursSince = (iso, now) => Math.max(0, Math.round((now - Date.parse(iso)) / 3600000));
const ageLabel = (h) => (h < 1 ? 'meno di 1h' : h < 24 ? `${h}h` : `${Math.round(h / 24)}g`);

// Etichetta del giorno usata come intestazione di sezione nell'archivio: data ISO
// + giorno della settimana abbreviato (es. "2026-07-23 (mer)").
export function dayLabel(now = Date.now()) {
  const d = new Date(now);
  const gg = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} (${gg[d.getDay()]})`;
}

// ---- Raccolta fatti cross-tenant ---------------------------------------------
// Ritorna un oggetto strutturato con anche `empty` (nessuna attività) e `text`
// (rendering compatto pronto da iniettare nel prompt del CEO / da archiviare).
export function collectDigestFacts(tenants, now = Date.now(), bootTimeMs = null) {
  const dayStart = startOfLocalDay(now);

  const doneToday = [];   // { tenant, title }
  const inReview = [];    // { tenant, title, stage, hours }
  // Task board 03a5a645 (decisione Owner 2026-07-25, "Bloccate" vs "Da decidere"):
  // le due classi di needs_input hanno peso diverso nel digest. askRequests =
  // richieste vere (task.ask valorizzato): itemizzate con la domanda, sono ciò
  // su cui Owner deve decidere. blockedTech = blocco tecnico (senza ask): SOLO
  // un conteggio aggregato (requisito 4: "al massimo una riga", mai una per
  // task) — il dettaglio/causa/riprova vive nella lista "Bloccate" in app
  // (lib/blocked.js, GET /api/tasks/blocked), non nel digest.
  const askRequests = []; // { tenant, title, question }
  let blockedTechCount = 0;
  const depBlocked = [];  // { tenant, title, note } — bloccata da dipendenze aperte (blockedBy)
  const perTenant = [];   // { name, active } — solo tenant business (requisito 2, ultima riga)
  const proposte = [];    // { title, status } — task aperte oggi dal manager pm-platform (task 5352926c)
  const gateStuck = [];   // { tenant, count } — task ferme al gate >6h per tenant (task 66ea084a)

  for (const t of tenants) {
    const tasks = listTasks(t.id);
    let active = false;
    let stuckAtGate = 0; // review_manager/review_ceo ferme da >GATE_STUCK_HOURS (task 66ea084a)
    for (const task of tasks) {
      if (isSince(task.updatedAt, dayStart) || isSince(task.createdAt, dayStart)) active = true;

      if ((task.status === 'review_manager' || task.status === 'review_ceo')
        && hoursSince(task.updatedAt, now) >= GATE_STUCK_HOURS) {
        stuckAtGate += 1;
      }

      // Proposte proattive di pm-platform: task che HA CREATO oggi (sintesi nel
      // digest, requisito 4 della task 5352926c). Solo tenant platform.
      if (t.id === PLATFORM_TENANT && task.createdBy === 'agent:pm-platform' && isSince(task.createdAt, dayStart)) {
        proposte.push({ title: task.title, status: task.status });
      }

      if (task.status === 'done' && isSince(task.updatedAt, dayStart)) {
        doneToday.push({ tenant: t.name, title: task.title });
      } else if (task.status === 'review_manager' || task.status === 'review_ceo') {
        inReview.push({
          tenant: t.name,
          title: task.title,
          stage: task.status === 'review_manager' ? 'manager' : 'CEO',
          hours: hoursSince(task.updatedAt, now),
        });
      } else if (task.status === 'needs_input') {
        if (task.ask) {
          askRequests.push({
            tenant: t.name, title: task.title,
            question: String(task.ask.question || task.note || task.title || '').replace(/\s+/g, ' ').trim().slice(0, 160),
          });
        } else {
          blockedTechCount += 1;
        }
      } else if (task.status !== 'done') {
        // Bloccata da dipendenze ancora aperte (blockedBy non tutte done) — non
        // c'entra con le "Bloccate" tecniche sopra (dipendenze aperte è normale
        // sequenziamento, non un errore); resta itemizzata come prima.
        const open = (task.blockedBy ?? []).filter((id) => {
          const dep = tasks.find((x) => x.id === id);
          return dep && dep.status !== 'done';
        });
        if (open.length) {
          depBlocked.push({ tenant: t.name, title: task.title, note: `${open.length} dipendenza/e non ancora done` });
        }
      }
    }
    if (t.id !== PLATFORM_TENANT) perTenant.push({ name: t.name, active });
    if (stuckAtGate > 0) gateStuck.push({ tenant: t.name, count: stuckAtGate });
  }

  // Journal delle run (cross-tenant): quante oggi + quelle fallite/interrotte non
  // ancora recuperate (stato corrente failed/interrupted; "stopped" = fermata a
  // mano dall'utente, non un fallimento da recuperare → esclusa).
  const allRuns = listRuns();
  const runsToday = allRuns.filter((r) => isSince(r.startedAt, dayStart));
  const notRecovered = allRuns
    .filter((r) => r.status === 'failed' || r.status === 'interrupted')
    .map((r) => ({ tenant: r.tenantId, title: r.runTitle || r.agentId, status: r.status, error: String(r.lastError || '').slice(0, 120) }));

  // Consumo finestra Claude: dal tracker budget se calibrato (task b8b98175),
  // altrimenti fallback al numero di run del giorno (requisito 2).
  const budget = getBudgetState(now);
  const consumo = budget.known
    ? {
        known: true,
        pctRemaining: Math.round((budget.pctRemaining ?? 0) * 100),
        tokensUsed: budget.tokensUsed,
        resetAt: budget.resetAt ? new Date(budget.resetAt).toISOString().slice(11, 16) : null,
      }
    : { known: false, runsToday: runsToday.length };

  // Task 212d9b82 (osservabilità, requisito 4): task con retry di dispatch
  // esauriti (run finite senza consegna 3 volte) in attesa dell'auto-retry o
  // di un intervento umano — già contate anche dentro "blocked" (sono
  // needs_input), riga separata per non farle sparire nel rumore generico.
  const dispatchExhausted = countDispatchExhausted(tenants);

  // Bonifica automatica ricorrente (task board 2e2d918f, requisito 4): quante
  // needs_input senza ask sono state recuperate in automatico oggi, quante
  // segnalate come "croniche" al CEO platform (dopo >3 recuperi senza mai
  // arrivare a "done") — fonte: audit journal (lib/autorecover.js).
  const { recoveredToday, chronicToday } = countAutoRecoveryToday(dayStart);

  // Scatti orfani dei 3 job LLM (digest/code-quality/pm-platform) — task
  // e7422c02: uno scatto system_job_run senza run né skip tracciato è un bug
  // dello scheduler, non un fatto operativo del tenant, ma DEVE riemergere qui
  // perché il digest è l'unico canale che Owner guarda ogni giorno senza
  // dover entrare a controllare. Finestra di 25h per coprire senza buchi il
  // gap dall'ultimo digest (~24h fa) col margine di jitter del cron.
  const schedulerOrphans = findOrphanSystemJobRuns({ sinceMs: now - 25 * 60 * 60 * 1000, nowMs: now });

  // "Done" != "live" (task madre 61aea764): task chiuse dal gate ma il cui
  // codice server è più recente del boot del processo vivo — stato STANDING
  // (non un evento "di oggi"), quindi NON entra nel calcolo di `empty` sotto
  // (altrimenti un restart in ritardo terrebbe il digest "non vuoto" all'infinito).
  // bootTimeMs assente (chiamante non lo passa, es. vecchi test) -> skip
  // silenzioso, lista vuota. Guardia su `!= null` (non truthy): bootTimeMs=0
  // è un epoch valido e non deve essere trattato come "assente".
  const pendingActivation = bootTimeMs != null ? listPendingActivation(tenants, bootTimeMs) : [];

  const empty = doneToday.length === 0 && inReview.length === 0 && askRequests.length === 0
    && blockedTechCount === 0 && depBlocked.length === 0 && notRecovered.length === 0 && runsToday.length === 0
    && recoveredToday === 0 && chronicToday === 0 && schedulerOrphans.length === 0;

  const facts = {
    dayLabel: dayLabel(now),
    empty,
    doneToday,
    inReview,
    askRequests,
    blockedTechCount,
    depBlocked,
    notRecovered,
    runsToday: runsToday.length,
    dispatchExhausted,
    gateStuck,
    consumo,
    perTenant,
    proposte,
    recoveredToday,
    chronicToday,
    schedulerOrphans,
    pendingActivation,
  };
  facts.text = renderFactsText(facts);
  return facts;
}

// Rendering compatto e leggibile dei fatti (iniettato nel prompt del CEO; è la
// materia prima da cui compone il riassunto, non il testo finale).
function renderFactsText(f) {
  const L = [];
  L.push(`Giorno: ${f.dayLabel}`);
  L.push(`Task chiuse oggi (done): ${f.doneToday.length}`);
  for (const t of f.doneToday) L.push(`  - [${t.tenant}] ${t.title}`);
  L.push(`In review (quality gate): ${f.inReview.length}`);
  for (const t of f.inReview) L.push(`  - [${t.tenant}] ${t.title} — livello ${t.stage}, da ${ageLabel(t.hours)}`);
  // Richieste vere (needs_input CON ask): itemizzate, sono ciò su cui Owner
  // deve decidere (task board 03a5a645).
  L.push(`Richieste per Owner (needs_input con domanda): ${f.askRequests.length}`);
  for (const t of f.askRequests) L.push(`  - [${t.tenant}] ${t.title} — ${t.question}`);
  // Bloccate per errore tecnico (needs_input SENZA ask): SOLO il conteggio,
  // UNA riga (requisito 4 — mai una per task nel digest, dettaglio/causa/
  // riprova in app, lista "Bloccate").
  L.push(`Bloccate (blocco tecnico, senza domanda formale — vedi lista "Bloccate" in app): ${f.blockedTechCount}`);
  L.push(`Bonifica automatica: ${f.recoveredToday} recuperate oggi, ${f.chronicToday} croniche (segnalate al CEO platform)`);
  L.push(`Task bloccate da dipendenze aperte: ${f.depBlocked.length}`);
  for (const t of f.depBlocked) L.push(`  - [${t.tenant}] ${t.title} — ${t.note}`);
  L.push(`Run fallite/interrotte non recuperate: ${f.notRecovered.length}`);
  for (const r of f.notRecovered) L.push(`  - [${r.tenant}] ${r.title} — ${r.status}${r.error ? `: ${r.error}` : ''}`);
  L.push(`Task con retry di dispatch esauriti (run finite senza consegna): ${f.dispatchExhausted}`);
  const gateStuck = f.gateStuck ?? [];
  const gateStuckTot = gateStuck.reduce((n, g) => n + g.count, 0);
  L.push(`Task ferme al gate (>${GATE_STUCK_HOURS}h in review) per tenant: ${gateStuckTot}`);
  for (const g of gateStuck) L.push(`  - [${g.tenant}] ${g.count}`);
  if (f.proposte?.length) {
    L.push(`Proposte proattive pm-platform (aperte oggi): ${f.proposte.length}`);
    for (const p of f.proposte) L.push(`  - ${p.title} — ${p.status}`);
  }
  if (f.consumo.known) {
    L.push(`Finestra Claude: ~${f.consumo.pctRemaining}% residuo (${f.consumo.tokensUsed} token usati), reset alle ${f.consumo.resetAt ?? '—'} UTC`);
  } else {
    L.push(`Finestra Claude: stima budget non ancora disponibile; run totali del giorno: ${f.consumo.runsToday}`);
  }
  L.push(`Tenant business — attività del giorno:`);
  for (const t of f.perTenant) L.push(`  - ${t.name}: ${t.active ? 'sì' : 'no'}`);
  if (f.schedulerOrphans?.length) {
    L.push(`⚠️ Scatti job schedulati senza esito tracciato (bug scheduler, non un fatto del tenant): ${f.schedulerOrphans.length}`);
    for (const o of f.schedulerOrphans) L.push(`  - ${o.name} — scattato alle ${o.ts} senza run né skip`);
  }
  if (f.pendingActivation?.length) {
    L.push(`Da attivare: ${f.pendingActivation.length} (${f.pendingActivation.map((p) => p.taskId).join(', ')})`);
  }
  return L.join('\n');
}

// ---- Archivio (wiki platform digest.md) --------------------------------------
const archiveHeader = () => `# Digest serale — Platform Org

Archivio dei digest giornalieri, aggregati su tutti i tenant (il più recente in alto).
Generato dal job schedulato "digest-serale" (vedi processi.md / decisions.md); ogni
digest è anche inviato a Owner via push. La pagina tiene gli ultimi ${MAX_ARCHIVE_DAYS} giorni;
lo storico completo resta nella history git della wiki.`;

// Compone la pagina archivio: prepende il blocco di oggi (una sezione "## <data>")
// e tiene solo le MAX_ARCHIVE_DAYS sezioni più recenti. `entryBlock` è già la
// sezione completa ("## 2026-07-23 (mer)\n- riga\n- riga"). Idempotente sullo
// stesso giorno: se esiste già una sezione con la stessa data, la sostituisce.
export function assembleArchive(existing, entryBlock) {
  const text = String(existing ?? '');
  const idx = text.search(/^## /m);
  const body = idx === -1 ? '' : text.slice(idx);
  const sections = body ? body.split(/(?=^## )/m).map((s) => s.trim()).filter(Boolean) : [];
  const entry = entryBlock.trim();
  const todayHeading = entry.split('\n', 1)[0].trim();
  const kept = [entry, ...sections.filter((s) => s.split('\n', 1)[0].trim() !== todayHeading)]
    .slice(0, MAX_ARCHIVE_DAYS);
  return `${archiveHeader()}\n\n${kept.join('\n\n')}\n`;
}

// Scrive una sezione nell'archivio (usa allowShrink: la pagina viene ricomposta
// per intero, la guardia anti-svuotamento non si applica a una ricomposizione
// legittima; lo storico resta comunque in git).
function writeArchive(entryBlock, author) {
  const existing = readPage(PLATFORM_TENANT, DIGEST_PAGE);
  const page = assembleArchive(existing, entryBlock);
  writePage(PLATFORM_TENANT, DIGEST_PAGE, page, { author, allowShrink: true });
  return page;
}

// ---- Prompt per il CEO (giorno con attività) ---------------------------------
export function digestPrompt(facts, now = Date.now()) {
  return [
    `Digest serale a Owner per ${facts.dayLabel}. Run breve e silenziosa: nessun lavoro operativo, solo comporre e consegnare il riassunto del giorno.`,
    '',
    'I FATTI del giorno sono già aggregati su TUTTI i tenant (qui sotto): NON usare list_tasks (vede solo il tenant platform). Componi un riassunto SENSATO, non un elenco meccanico: raggruppa, dai priorità a ciò che richiede attenzione di Owner, taglia il rumore. Massimo ~10 righe totali, tono asciutto.',
    '',
    '--- FATTI DEL GIORNO ---',
    facts.text,
    '--- FINE FATTI ---',
    '',
    'Copri, in quest\'ordine e solo se rilevante: se presenti, gli "Scatti job schedulati senza esito tracciato" (⚠️) SUBITO in cima — è un bug dello scheduler stesso, non un fatto di un tenant, e va segnalato chiaramente; task chiuse oggi (titoli brevi); task in review e da quanto; le "Richieste per Owner" con COSA serve (domanda breve, una per riga: sono le uniche vere decisioni aperte); le "Bloccate" per errore tecnico SOLO come un conteggio totale in UNA riga (mai una riga per task: il dettaglio/causa/pulsante Riprova vive nella lista "Bloccate" in app, qui basta il numero); run fallite/interrotte non recuperate; consumo finestra Claude; una riga sintetica per i tenant business (attività sì/no). Metti per primo ciò su cui Owner potrebbe dover agire.',
    '',
    'Poi consegna il digest in DUE modi (entrambi obbligatori):',
    `1. ARCHIVIO: apri la pagina wiki "${DIGEST_PAGE}" con wiki_read (se non esiste la crei). Devi PREPENDERE una nuova sezione in cima all'archivio, subito dopo il paragrafo introduttivo, con questo formato ESATTO:`,
    `   ## ${facts.dayLabel}`,
    '   - riga 1',
    '   - riga 2 (ecc., le stesse ~10 righe del digest)',
    `   Mantieni l'intestazione/introduzione della pagina e le sezioni dei giorni precedenti sotto la tua; tieni al massimo le ${MAX_ARCHIVE_DAYS} sezioni più recenti (le più vecchie restano comunque in git). Scrivi con wiki_write il contenuto COMPLETO della pagina, passando confirm_restructure: true (stai potando le sezioni-log più vecchie: senza quel flag la guardia entry-loss rifiuta la scrittura).`,
    '2. PUSH: manda il digest a Owner con notify_owner (titolo breve tipo "Digest serale", body = il riassunto in 1-2 frasi + i punti chiave). È l\'unica push della giornata: falla contare.',
    '',
    'Non creare né modificare task, non toccare altre pagine wiki. Finito questo, termina.',
  ].join('\n');
}

// ---- Giorno vuoto: consegna deterministica (requisito 4) ---------------------
export async function deliverEmptyDigest({ notify, now = Date.now(), author = 'system:digest' } = {}) {
  const label = dayLabel(now);
  const line = 'Giornata vuota: nessuna attività su board o run.';
  writeArchive(`## ${label}\n- ${line}`, author);
  logAudit({ user: 'digest', tenant: PLATFORM_TENANT, event: 'digest_empty', detail: { label } });
  if (notify) {
    await notify(PLATFORM_TENANT, {
      title: 'Digest serale — nulla da segnalare',
      body: line,
      tag: 'digest-serale',
    });
  }
  return { empty: true, line, label };
}

// ---- Entry point del system job ----------------------------------------------
// tenants = tenantsConfig.tenants; runFn = runAgentTurn; notify = (tenantId,payload)=>...
// Vuoto → consegna deterministica (no run). Altrimenti → lancia il CEO platform
// (run breve, journaled, visibile in "Agenti live") che compone e consegna.
export function runDigest({ tenants, runFn, notify, now = Date.now(), bootTimeMs = null }) {
  const facts = collectDigestFacts(tenants, now, bootTimeMs);
  logAudit({
    user: 'digest', tenant: PLATFORM_TENANT, event: 'digest_run',
    detail: {
      empty: facts.empty, done: facts.doneToday.length, review: facts.inReview.length, askRequests: facts.askRequests.length, blockedTech: facts.blockedTechCount, failed: facts.notRecovered.length,
      schedulerOrphans: facts.schedulerOrphans.length, pendingActivation: facts.pendingActivation.length,
    },
  });
  // Traccia dedicata (oltre alla riga nel digest stesso): grep-abile senza
  // dover parsare il digest composto dall'LLM (task e7422c02, requisito 3).
  if (facts.schedulerOrphans.length) {
    logAudit({
      user: 'digest', tenant: PLATFORM_TENANT, event: 'scheduler_orphans_detected',
      detail: { orphans: facts.schedulerOrphans },
    });
  }

  if (facts.empty) return deliverEmptyDigest({ notify, now });

  const platform = tenants.find((t) => t.id === PLATFORM_TENANT);
  const ceo = platform?.agents.find((a) => a.role === 'CEO');
  if (!ceo) throw new Error('CEO platform non trovato: impossibile comporre il digest');

  const sessionId = `digest-${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  return scheduleRun(runFn, {
    tenantId: PLATFORM_TENANT,
    agentId: ceo.id,
    sessionId,
    message: digestPrompt(facts, now),
    username: 'digest',
    source: 'digest',
    singleton: true, // un solo digest serale attivo per volta (task 01ed5b8d)
    urgency: 'bassa',
    runTitle: 'Digest serale a Owner',
  });
}
