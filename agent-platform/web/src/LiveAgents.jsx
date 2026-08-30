import React, { useEffect, useMemo, useState } from 'react';
import { apiJson, openWs } from './api.js';
import { MODEL_LABELS } from './lib/modelLabels.js';

// Vista unificata delle run agente (journal persistente), usata in DUE modi:
// - globale (pagina "Agenti live", prop tenant assente): tutte le run che
//   l'utente può gestire, in tutti i business, con colonna business e — solo
//   admin — il pannello del limite di run autonome del dispatcher;
// - per-attività (tab "Agenti attivi", prop tenant presente): solo le run di
//   quel business, senza colonna business e senza topbar (la fornisce la tab).
// Stesso codice, stessa grafica, stesse azioni (Ferma / Pausa / Pausa a tempo /
// Riprendi) in entrambe le modalità; il filtro sui permessi è SEMPRE lato
// server (GET /api/runs/global e broadcast WS per-connessione).

// Mirror di SOLA PRESENTAZIONE della macchina a stati unica delle run
// (server/lib/runstates.js: fonte di verità di stati/transizioni/regole di
// resume). Qui solo label/icone/ordine — nessuna logica di stato: il resume
// tollerante alle race UI↔watchdog vive server-side (POST /api/runs/:id/resume).
const RUN_STATUS = {
  running: { label: 'In esecuzione', icon: '⏳', cls: 'working' },
  resumed: { label: 'In esecuzione (ripresa)', icon: '🔁', cls: 'working' },
  interrupted: { label: 'Interrotta — riparte da sola', icon: '⚠️', cls: 'interrupted' },
  paused: { label: 'In pausa', icon: '⏸️', cls: 'paused' },
  stopped: { label: 'Fermata', icon: '⏹️', cls: 'stopped' },
  completed: { label: 'Completata', icon: '✅', cls: 'completed' },
  failed: { label: 'Fallita', icon: '🛑', cls: 'failed' },
};

// Etichette del model tiering: MODEL_LABELS importato da ./lib/modelLabels.js
// (modulo condiviso con AgentList e Organigramma). Solo per la UI: la logica
// di risoluzione vive server-side in server/lib/models.js.

// Stati su cui hanno senso Ferma e Pausa (la run gira o ripartirà da sola).
// Volutamente SENZA 'paused': una run in pausa non è azionabile da qui (ha già il suo blocco "Riprendi" a parte, sotto).
const ACTIONABLE_STATES = ['running', 'resumed', 'interrupted'];
// Ordinamento: prima ciò che gira, poi pausa/stop, poi il resto.
const ORDER = { running: 0, resumed: 0, interrupted: 1, paused: 2, stopped: 3, failed: 4, completed: 5 };

const PAUSE_CHOICES = [
  { label: 'finché non riprendo io', ms: null },
  { label: '1 ora', ms: 3600e3 },
  { label: '2 ore', ms: 2 * 3600e3 },
  { label: '3 ore', ms: 3 * 3600e3 },
  { label: '6 ore', ms: 6 * 3600e3 },
  { label: '12 ore', ms: 12 * 3600e3 },
  { label: '24 ore', ms: 24 * 3600e3 },
];

// Legenda delle icone di stato (requisito A5: Owner ha dovuto chiedere cosa
// significano ⏳🔁⚠️⏸️⏹️✅). Collassabile, in testa alla pagina; le stesse
// label sono anche nel tooltip (title) dell'icona su ogni card.
function StatusLegend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="card status-legend">
      <button type="button" className="legend-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>❓ Legenda icone di stato</span>
        <span className="muted">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="legend-grid">
          {Object.values(RUN_STATUS).map((s) => (
            <div key={s.label} className="legend-item">
              <span className="legend-icon">{s.icon}</span>
              <span>{s.label}</span>
            </div>
          ))}
          <div className="legend-item"><span className="legend-icon">⏳</span><span>In coda — in attesa di uno slot libero</span></div>
        </div>
      )}
    </div>
  );
}

function fmtElapsed(fromIso, now) {
  const ms = Math.max(0, now - Date.parse(fromIso));
  const m = Math.floor(ms / 60000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}g ${h % 24}h`;
}

function RunCard({ run, now, onAction, busy, showTenant }) {
  const [pauseMs, setPauseMs] = useState('');
  // Vista di default: riassunto breve (runTitle). Il prompt completo NON è la
  // vista di default (task UX b3861fb9): si consulta espandendo la card.
  const [expanded, setExpanded] = useState(false);
  const st = RUN_STATUS[run.status] ?? { label: run.status, icon: '·', cls: run.status };
  const active = ACTIONABLE_STATES.includes(run.status);
  // Run esterne (registrate via /api/runs/register): il server non controlla il
  // processo, quindi niente pausa/riprendi; Ferma marca solo il journal.
  const external = Boolean(run.external);
  // Etichetta breve popolata dal server (mai derivata qui dal prompt): titolo
  // task per le run del dispatcher, prime parole del messaggio per i turni chat.
  const title = run.runTitle || run.prompt?.slice(0, 64) || run.agentName;
  const who = showTenant ? `${run.tenantIcon} ${run.tenantName} · ${run.agentName}` : run.agentName;
  return (
    <div className={`card session-card status-${st.cls}`} style={{ '--accent': run.tenantColor }}>
      <button type="button" className="session-head" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        <span className="card-icon" title={st.label}>{st.icon}</span>
        <span className="card-body">
          <strong className="run-title">{title}</strong>
          <small className="muted">{who}</small>
          <small>{st.label}
            {run.status === 'paused' && run.resumeAt ? ` — riprende ${new Date(run.resumeAt).toLocaleString('it-IT')}` : ''}
            {run.status === 'paused' && !run.resumeAt ? ' — ripresa manuale' : ''}
            {run.lastError ? ` — ${run.lastError.slice(0, 120)}` : ''}
          </small>
          <small className="muted">
            {active ? `gira da ${fmtElapsed(run.startedAt, now)}` : `avviata ${fmtElapsed(run.startedAt, now)} fa`}
            {run.username ? ` · da ${run.username}` : ''}
            {run.source === 'dispatcher' ? ' · 🤖 autonoma (task board)' : ''}
            {run.source === 'board_check' ? ' · 🩺 check board CEO' : ''}
            {external ? ' · 🔗 processo esterno registrato' : ''}
            {run.attempts > 0 ? ` · tentativi ${run.attempts}` : ''}
            {run.model ? ` · ${MODEL_LABELS[run.model] ?? run.model}` : ''}
          </small>
          {run.modelWarning && (
            <small className="muted" title={run.modelWarning}>
              ⚠️ {run.modelDegraded ? 'tier degradato: ' : ''}{run.modelWarning.slice(0, 140)}
            </small>
          )}
          <small className="run-expand-hint muted">{expanded ? '▾ nascondi prompt completo' : '▸ mostra prompt completo'}</small>
        </span>
      </button>
      {expanded && (
        <div className="run-prompt-full">
          <small className="muted">Prompt completo dato all'agente:</small>
          <pre className="run-prompt-pre">{run.prompt || '(nessun prompt)'}</pre>
        </div>
      )}
      {active && (
        <div className="session-actions">
          <button className="btn-accent" disabled={busy} onClick={() => onAction(run, 'stop')}>⏹ Ferma</button>
          {!external && (
            <>
              <button className="btn-accent" disabled={busy} onClick={() => onAction(run, 'pause', pauseMs === '' ? null : Number(pauseMs))}>⏸ Pausa</button>
              <select value={pauseMs} onChange={(e) => setPauseMs(e.target.value)} aria-label="Durata pausa">
                {PAUSE_CHOICES.map((c) => <option key={c.label} value={c.ms ?? ''}>{c.label}</option>)}
              </select>
            </>
          )}
        </div>
      )}
      {(run.status === 'stopped' || run.status === 'paused') && !external && (
        <div className="session-actions">
          <button className="btn-accent" disabled={busy} onClick={() => onAction(run, 'resume')}>▶ Riprendi</button>
        </div>
      )}
    </div>
  );
}

// Banner globale del limite Claude (task ca71d849): quando la subscription Max
// è al muro ("You've hit your limit"), la piattaforma non lancia nuove run
// autonome fino al reset. Mostrato in cima ad Agenti live (vista globale e
// per-business): lo stato arriva da GET /api/settings/concurrency (campo
// rateLimit), aggiornato in realtime dal ping WS 'concurrency' (compare quando
// scatta il limite, sparisce da solo al reset). Solo admin può forzare lo sblocco.
function RateLimitBanner({ isAdmin }) {
  const [rl, setRl] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => apiJson('/api/settings/concurrency')
    .then((c) => setRl(c.rateLimit ?? { limited: false }))
    .catch(() => {});

  useEffect(() => {
    load();
    const closeWs = openWs((msg) => { if (msg.type === 'concurrency') load(); });
    const timer = setInterval(load, 30000);
    // Retry al ritorno online (task board dec1de1f, F4): coerente con
    // BudgetPanel/ConcurrencyPanel, stesso pattern.
    window.addEventListener('online', load);
    return () => { closeWs(); clearInterval(timer); window.removeEventListener('online', load); };
  }, []);

  if (!rl?.limited) return null;
  const resume = rl.resumeAt ? new Date(rl.resumeAt) : null;
  const hhmm = resume ? resume.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '—';
  const clear = async () => {
    if (!window.confirm('Sbloccare manualmente il limite Claude? Il lavoro autonomo riparte subito: fallo solo se sai che la quota è già tornata.')) return;
    setBusy(true);
    try { await apiJson('/api/settings/rate-limit/clear', { method: 'POST', body: {} }); await load(); }
    catch { /* il ping WS aggiornerà comunque */ }
    finally { setBusy(false); }
  };
  return (
    <div className="card ratelimit-banner">
      <strong>🚧 Limite Claude raggiunto — ripresa automatica alle {hhmm}</strong>
      <small>
        La quota della subscription Max (finestra 5h, condivisa da tutti i business) è esaurita.
        Le run interrotte e le task in coda ripartono da sole al reset ({resume ? resume.toLocaleString('it-IT') : 'orario non disponibile'}),
        per urgenza e nel cap di concorrenza. Nel frattempo nessun nuovo lancio autonomo (niente token sprecati a raffica).
      </small>
      {rl.message ? <small className="muted">Dettaglio: {String(rl.message).slice(0, 160)}</small> : null}
      {isAdmin && (
        <div className="session-actions">
          <button className="btn-accent" disabled={busy} onClick={clear}>Sblocca ora (quota già tornata)</button>
        </div>
      )}
    </div>
  );
}

// Banner auto-restart (task 03a4d9d6): quando una modifica a server/** è su disco
// ma non ancora live (restartNeeded), mostra lo stato del riavvio automatico e —
// per gli admin — un bottone "Riavvia ora" per forzarlo dalla PWA. Stato da GET
// /api/restart-status (restartNeeded, shouldRestart, reason, activeRuns, idleMs,
// config). Se la restart-policy Docker non è confermata, lo dice esplicitamente
// (l'auto-restart resta inerte finché Owner non conferma). Non si mostra quando
// il codice è già live.
const RESTART_REASON_LABEL = {
  disabled: 'auto-restart disattivato (leva in config)',
  'docker-policy-unconfirmed': 'in attesa di conferma della restart-policy Docker',
  'active-runs': 'ci sono agenti al lavoro — riavvio quando la piattaforma è libera',
  'not-idle': 'chat in corso — riavvio dopo qualche minuto di inattività',
  'out-of-window': 'fuori dalla finestra oraria consentita',
  'rate-limited': 'raggiunto il tetto di riavvii/ora (anti-loop)',
  ok: 'riavvio automatico a breve…',
};
function RestartBanner({ isAdmin }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = () => apiJson('/api/restart-status').then(setSt).catch(() => {});
  useEffect(() => {
    load();
    const timer = setInterval(load, 20000);
    // Retry al ritorno online (task board dec1de1f, F4): ultimo pannello di
    // questo file rimasto senza, per coerenza con gli altri qui sopra.
    window.addEventListener('online', load);
    return () => { clearInterval(timer); window.removeEventListener('online', load); };
  }, []);

  if (!st?.restartNeeded) return null; // codice già live → niente banner

  const restartNow = async () => {
    if (!window.confirm('Riavviare ora la piattaforma per applicare gli aggiornamenti? Breve downtime; le run interrotte ripartono da sole.')) return;
    setBusy(true); setErr(null);
    try { await apiJson('/api/restart', { method: 'POST', body: {} }); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const label = st.shouldRestart ? RESTART_REASON_LABEL.ok : (RESTART_REASON_LABEL[st.reason] ?? 'aggiornamenti in attesa di riavvio');
  const idleMin = st.idleMs != null ? Math.floor(st.idleMs / 60000) : null;
  return (
    <div className="card ratelimit-banner">
      <strong>🔄 Aggiornamenti in attesa di riavvio</strong>
      <small>{label}</small>
      <small className="muted">
        {st.activeRuns > 0 ? `${st.activeRuns} run attive · ` : ''}
        {idleMin != null ? `chat idle ${idleMin}min · ` : ''}
        riavvii nell'ultima ora: {st.restartsLastHour}/{st.config?.maxPerHour ?? 3}
        {st.config && !st.config.dockerPolicyConfirmed ? ' · restart-policy Docker da confermare' : ''}
      </small>
      {err ? <small className="error">{err}</small> : null}
      {isAdmin && (
        <div className="session-actions">
          <button className="btn-accent" disabled={busy} onClick={restartNow}>
            {busy ? 'Riavvio…' : 'Riavvia ora'}
          </button>
        </div>
      )}
    </div>
  );
}

// Banner "esecuzione in pausa per quota" (task 5998e8a7; rinominato in task
// 48bb6942: il nome precedente prometteva l'halt totale mentre la condizione
// era — ed è tuttora — quella della soglia RESERVE al 7%). Quando il
// budget della finestra Max scende sotto RESERVE, il dispatcher ferma i NUOVI
// lanci autonomi (solo review del quality gate ammesse) SENZA che sia ancora
// scattato il muro hard del rate limit. Prima era invisibile: sembrava che i CEO
// delegassero ma non partisse nulla.
// Legge budgetPolicy da GET /api/settings/concurrency. Non si mostra se è già
// attivo il RateLimitBanner (muro hard) per non duplicare il messaggio.
// Variante shouldHaltAll (soglia 3%, task 48bb6942 punto 2): stessa card, copy
// più netto — a quel punto il residuo è così basso che anche il margine di
// riserva per il gate è eroso; lo segnaliamo esplicitamente invece di mostrare
// lo stesso testo "solo review" della soglia 7%, che a quel punto capirebbe.
function BudgetReserveBanner() {
  const [state, setState] = useState(null);

  const load = () => apiJson('/api/settings/concurrency')
    .then((c) => setState({ policy: c.budgetPolicy ?? null, budget: c.budget ?? null, rl: c.rateLimit ?? { limited: false } }))
    .catch(() => {});

  useEffect(() => {
    load();
    const closeWs = openWs((msg) => { if (msg.type === 'concurrency') load(); });
    const timer = setInterval(load, 30000);
    // Retry al ritorno online (task board dec1de1f, F4).
    window.addEventListener('online', load);
    return () => { closeWs(); clearInterval(timer); window.removeEventListener('online', load); };
  }, []);

  const budgetPolicy = state?.policy;
  // Mostra solo se la policy riserva/ferma l'esecuzione e NON c'è già il muro hard.
  if (!budgetPolicy?.shouldReserveForReview || state?.rl?.limited) return null;
  const reset = state?.budget?.resetAt ? new Date(state.budget.resetAt) : null;
  const hhmm = reset ? reset.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '—';
  // Residuo REALE (raw): è il valore su cui il dispatcher ha deciso l'halt
  // (task 88fba579). pctRemaining floorato è solo per il BudgetPanel di progresso.
  const remReal = budgetPolicy.pctRemainingRaw ?? budgetPolicy.pctRemaining;
  const pct = remReal != null ? Math.round(remReal * 100) : null;
  const resetFull = reset ? reset.toLocaleString('it-IT') : 'orario non disponibile';
  const haltAll = !!budgetPolicy.shouldHaltAll;
  return (
    <div className="card ratelimit-banner">
      {haltAll ? (
        <>
          <strong>🛑 Esecuzione ferma: quota Claude ai minimi — riparte alle {hhmm}</strong>
          <small>
            Il budget della finestra Max (5h, condivisa da tutti i business){pct != null ? ` è al ~${pct}% residuo` : ' è quasi esaurito'}:
            il dispatcher ha fermato ANCHE i lanci di riserva per non schiantarsi sul muro reale prima del reset.
            Le task delegate dai CEO restano <strong>in coda</strong> e ripartono da sole al reset ({resetFull}), per urgenza.
          </small>
        </>
      ) : (
        <>
          <strong>⏸️ Esecuzione in pausa: quota Claude quasi esaurita — riparte alle {hhmm}</strong>
          <small>
            Il budget della finestra Max (5h, condivisa da tutti i business){pct != null ? ` è al ~${pct}% residuo` : ' è quasi esaurito'}:
            il dispatcher ha messo in pausa i nuovi lanci non critici; restano attive <strong>solo le review del quality gate</strong>, per riservare il margine residuo.
            Le task delegate dai CEO restano <strong>in coda</strong> e ripartono da sole al reset ({resetFull}), per urgenza. Non è un blocco totale: è throttling voluto per non schiantarsi sul muro.
          </small>
        </>
      )}
    </div>
  );
}

// Indicatore del budget token empirico della finestra Max (task b8b98175):
// usato/stimato, % residuo, orario di reset, proiezione di esaurimento al ritmo
// attuale. La stima è EMPIRICA: si calibra dai "muri" del rate limit osservati
// (servono 2-3 limit event), quindi finché known=false mostra solo l'uso grezzo.
// Stesso fetch di ConcurrencyPanel (GET /api/settings/concurrency, campo budget),
// aggiornato dal ping WS 'concurrency' e da un timer.
function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
}

function BudgetPanel() {
  const [b, setB] = useState(null);

  const load = () => apiJson('/api/settings/concurrency')
    .then((c) => setB(c.budget ?? null))
    .catch(() => {});

  useEffect(() => {
    load();
    const closeWs = openWs((msg) => { if (msg.type === 'concurrency') load(); });
    const timer = setInterval(load, 15000);
    // Retry al ritorno online (task board dec1de1f, F4): offline il fetch
    // falliva in silenzio (catch vuoto) e si restava fermi fino al prossimo
    // timer da 15s; con l'evento 'online' si aggiorna subito.
    window.addEventListener('online', load);
    return () => { closeWs(); clearInterval(timer); window.removeEventListener('online', load); };
  }, []);

  if (!b) return null;
  const reset = b.resetAt ? new Date(b.resetAt) : null;
  const hhmm = reset ? reset.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '—';
  const pctRem = b.known ? Math.round(b.pctRemaining * 100) : null;
  // Colore della barra per fascia di residuo (allineate alle soglie del server:
  // <25% basso, <12% riservato al gate, <4% muro).
  const barCls = !b.known ? 'muted' : pctRem <= 4 ? 'budget-crit' : pctRem <= 12 ? 'budget-warn' : pctRem <= 25 ? 'budget-low' : 'budget-ok';
  const proj = b.projectedExhaustionAt ? new Date(b.projectedExhaustionAt) : null;
  return (
    <div className="card autonomy-panel">
      <strong>🎯 Budget token finestra (Max, 5h)</strong>
      <small className="muted">
        Stima empirica dal consumo osservato e dai muri del rate limit (subscription Max,
        quota condivisa da tutti i business). Guida il dispatcher: sotto il 25% solo task
        critiche/alte, un margine è sempre riservato al quality gate, vicino al muro stop ordinato.
      </small>
      {b.known ? (
        <>
          <div className={`budget-bar ${barCls}`}>
            <div className="budget-bar-fill" style={{ width: `${Math.min(100, 100 - pctRem)}%` }} />
          </div>
          <small className={barCls === 'muted' ? 'muted' : `queue-badge-warn ${barCls}`}>
            {fmtTokens(b.tokensUsed)} / ~{fmtTokens(b.estimate.operative)} token · <strong>{pctRem}% residuo</strong>
          </small>
          <small className="muted">
            Reset ~{hhmm} (UTC)
            {b.burnPerMin ? ` · ritmo ~${fmtTokens(b.burnPerMin)} tok/min` : ''}
            {proj ? ` · esaurimento stimato ~${proj.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` : ''}
          </small>
          <small className="muted">
            Stima calibrata su {b.estimate.samples} muro/i (min {fmtTokens(b.estimate.min)}, media {fmtTokens(b.estimate.avg)})
          </small>
        </>
      ) : (
        <small className="muted">
          Consumo finestra: {fmtTokens(b.tokensUsed)} token · stima del budget non ancora disponibile
          (servono 2-3 muri di rate limit per calibrarla){reset ? ` · reset ~${hhmm} (UTC)` : ''}.
        </small>
      )}
    </div>
  );
}

// Etichette brevi del motivo di blocco (task e54446c9, follow-up UI di
// 9181275b): stessi codici di server/lib/concurrency.js (BLOCK_REASON_LABELS),
// ma accorciate per stare su una riga di badge mobile senza troncare
// ("cap agenti" invece di "cap globale di agenti paralleli raggiunto").
// Fallback a blockReasonLabel (frase completa dell'API) per un codice non
// ancora mappato qui, così un nuovo motivo lato server non sparisce mai.
const BLOCK_REASON_SHORT = {
  rate_limit: 'quota Claude',
  cap: 'cap agenti',
  memory: 'memoria disponibile',
};

// Coda "Da attivare" (task madre 61aea764 "Done ≠ live", superficie PWA: task
// 39ee5a86): task "done" il cui codice server/** è più recente del boot del
// processo vivo — il gate le ha approvate ma il processo che gira ancora non
// le carica (moduli ESM caricati una sola volta all'avvio). Campo
// pendingActivation { count, list } già nello stesso cfg di ConcurrencyPanel
// (nessuna chiamata in più, stesso fetch di cap/coda/rateLimit/
// dispatchExhausted/oomFailures24h/blockReason — server task 2e6fb2e5).
// Badge nascosto a count 0 come dispatchExhausted/oomFailures24h qui sopra
// (zero-state silenzioso, niente rumore); al tap espande l'elenco task (+
// eventuali file server toccati), stesso pattern collassabile di StatusLegend.
function PendingActivationBadge({ pending }) {
  const [open, setOpen] = useState(false);
  if (!pending?.count) return null;
  return (
    <div>
      <button
        type="button"
        className="legend-toggle pending-activation-toggle queue-badge-warn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Feature done col codice server non ancora caricato dal processo vivo — serve un restart per renderle attive"
      >
        <span>🚧 Da attivare: {pending.count}</span>
        <span className="muted">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="pending-activation-list">
          <small className="muted">
            Feature done col codice server non ancora caricato dal processo vivo — serve un restart per renderle attive.
          </small>
          {pending.list.map((item) => (
            <div key={`${item.tenant}-${item.taskId}`} className="pending-activation-item">
              <strong className="run-title">{item.title}</strong>
              <small className="muted">{item.tenant} · {item.taskId.slice(0, 8)}</small>
              {item.files?.length > 0 && <small className="muted">{item.files.join(', ')}</small>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Cap globale di agenti attivi in parallelo (decisione Owner): selettore
// "agenti paralleli" — il valore diventa il cap dello scheduler su TUTTI i
// tenant (run + subagenti + run esterne registrate). Visibile a tutti,
// modificabile solo da admin. Effetto immediato: se lo si alza la coda si
// svuota subito; se lo si abbassa gli agenti in corso finiscono ma niente di
// nuovo parte finché non si rientra nel cap.
function ConcurrencyPanel({ isAdmin }) {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = () => apiJson('/api/settings/concurrency').then(setCfg).catch((e) => setError(e.message));

  useEffect(() => {
    load();
    const closeWs = openWs((msg) => { if (msg.type === 'concurrency') load(); });
    const timer = setInterval(load, 15000);
    // Retry al ritorno online (task board dec1de1f, F4): senza questo
    // l'errore da offline restava a schermo fino al prossimo poll (15s).
    window.addEventListener('online', load);
    return () => { closeWs(); clearInterval(timer); window.removeEventListener('online', load); };
  }, []);

  const save = async (cap) => {
    setSaving(true);
    setError(null);
    try {
      setCfg(await apiJson('/api/settings/concurrency', { method: 'PUT', body: { cap } }));
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!cfg) return error ? <p className="error">{error}</p> : null;
  const range = Array.from({ length: cfg.max - cfg.min + 1 }, (_, i) => cfg.min + i);

  // Riga memoria/OOM (task PWA b61ad0b2): memAvailableMb/memLimitMb/
  // deferredForMemory/oomFailures24h arrivano GIÀ nello stesso cfg qui sopra
  // (endpoint /api/settings/concurrency, task backend 16edce3a) — nessuna
  // chiamata né polling in più. Badge coda/OOM nascosti a 0 (nessuno spazio
  // riservato: niente layout shift quando i contatori sono a riposo).
  const hasMem = typeof cfg.memLimitMb === 'number' && typeof cfg.memAvailableMb === 'number' && cfg.memLimitMb > 0;
  const memPctUsed = hasMem ? Math.round(((cfg.memLimitMb - cfg.memAvailableMb) / cfg.memLimitMb) * 100) : null;
  const memBarCls = memPctUsed == null ? 'muted'
    : memPctUsed >= 90 ? 'budget-crit' : memPctUsed >= 75 ? 'budget-warn' : memPctUsed >= 50 ? 'budget-low' : 'budget-ok';
  const deferredForMemory = cfg.deferredForMemory ?? 0;
  const oomFailures24h = cfg.oomFailures24h ?? 0;

  return (
    <div className="card autonomy-panel">
      <strong>🚦 Agenti paralleli (cap globale piattaforma)</strong>
      <small className="muted">
        Totale agenti attivi su tutti i business (run avviate dal server + subagenti + run esterne
        registrate): oltre questo numero i nuovi lanci autonomi (task board, schedulazioni, check CEO)
        entrano in coda e ripartono da soli al primo slot libero — non falliscono mai.
      </small>
      {error && <p className="error">{error}</p>}
      <label className="autonomy-row">
        <span>Agenti paralleli</span>
        {isAdmin ? (
          <select disabled={saving} value={cfg.cap} onChange={(e) => save(Number(e.target.value))}>
            {range.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        ) : <strong>{cfg.cap}</strong>}
      </label>
      {/* Badge riassuntivo unico "X/Y attivi — N in coda, limite: <motivo>"
          (task e54446c9, follow-up UI di 9181275b): blockReason/blockReasonLabel
          arrivano già in cfg (stesso fetch, endpoint /api/settings/concurrency),
          calcolati dalla STESSA funzione di ammissione usata da scheduleRun/
          drainQueue (admissionBlockReason()) — qui solo presentazione, nessuna
          nuova API. Nascosto del tutto se non c'è nulla da segnalare (nessun
          motivo attivo e coda vuota): niente avviso fantasma. */}
      <small className={(cfg.queued > 0 || cfg.blockReason) ? 'queue-badge-warn' : 'muted'}>
        {cfg.active}/{cfg.cap} attivi
        {cfg.blockReason
          ? ` — ${cfg.queued} in coda, limite: ${BLOCK_REASON_SHORT[cfg.blockReason] ?? cfg.blockReasonLabel}`
          : (cfg.queued > 0 ? ` · ⏳ ${cfg.queued} in attesa di slot` : '')}
      </small>
      {hasMem && (
        <>
          <label className="autonomy-row">
            <span>Memoria</span>
            <strong>{cfg.memAvailableMb} / {cfg.memLimitMb} MB liberi</strong>
          </label>
          <div className={`budget-bar ${memBarCls}`}>
            <div className="budget-bar-fill" style={{ width: `${Math.min(100, Math.max(0, memPctUsed))}%` }} />
          </div>
          {(deferredForMemory > 0 || oomFailures24h > 0) && (
            <small className="mem-badges">
              {deferredForMemory > 0 && <span className="queue-badge-warn">⏳ {deferredForMemory} in coda per memoria</span>}
              {oomFailures24h > 0 && <span className="queue-badge-warn">⚠️ {oomFailures24h} OOM nelle ultime 24h</span>}
            </small>
          )}
        </>
      )}
      {/* Retry di dispatch esauriti (requisito 4 task 212d9b82): campo
          dispatchExhausted già presente nello stesso cfg (nessuna chiamata
          in più) — conta cross-tenant le task in needs_input finite in
          auto-retry/intervento umano dopo 3 tentativi di dispatch senza
          consegna esplicita. Badge nascosto a 0, come gli altri qui sopra. */}
      {cfg.dispatchExhausted > 0 && (
        <small className="queue-badge-warn">
          🔁 {cfg.dispatchExhausted} task con retry di dispatch esauriti
        </small>
      )}
      <PendingActivationBadge pending={cfg.pendingActivation} />
    </div>
  );
}

// Elenco dei lanci autonomi in coda per il cap globale (badge "in attesa di
// slot", requisito 3): tenantId assente = tutti quelli visibili all'utente
// (vista globale), presente = solo quel business (tab "Agenti attivi").
function QueueList({ tenantId }) {
  const [items, setItems] = useState([]);

  const load = () => apiJson('/api/runs/queue')
    .then((all) => setItems(tenantId ? all.filter((q) => q.tenantId === tenantId) : all))
    .catch(() => {});

  useEffect(() => {
    load();
    const closeWs = openWs((msg) => { if (msg.type === 'concurrency') load(); });
    const timer = setInterval(load, 15000);
    // Retry al ritorno online (task board dec1de1f, F4).
    window.addEventListener('online', load);
    return () => { closeWs(); clearInterval(timer); window.removeEventListener('online', load); };
  }, [tenantId]);

  if (items.length === 0) return null;
  return (
    <div className="cards">
      {items.map((q) => (
        <div key={q.id} className="card session-card status-queued" style={{ '--accent': q.tenantColor }}>
          <div className="session-head" style={{ cursor: 'default' }}>
            <span className="card-icon">⏳</span>
            <span className="card-body">
              <strong className="run-title">{q.runTitle || (tenantId ? q.agentName : `${q.tenantIcon} ${q.tenantName} · ${q.agentName}`)}</strong>
              <small className="muted">{tenantId ? q.agentName : `${q.tenantIcon} ${q.tenantName} · ${q.agentName}`}</small>
              <small>In attesa di slot — posizione {q.position} in coda · urgenza {q.urgency}</small>
              <small className="muted">
                {q.source === 'dispatcher' ? '🤖 task board (autonoma)' : ''}
                {q.source === 'board_check' ? '🩺 check board CEO' : ''}
                {q.source === 'schedule' ? '🕒 agente schedulato' : ''}
              </small>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// Avviso health del check periodico CEO (ogni 30 min per tenant business):
// se lastBoardCheckAt supera 2× l'intervallo, il check è in ritardo.
function BoardCheckHealth({ tenantId }) {
  const [checks, setChecks] = useState([]);
  useEffect(() => {
    const load = () => apiJson('/api/board-checks').then(setChecks).catch(() => {});
    load();
    const timer = setInterval(load, 60000);
    // Retry al ritorno online (task board dec1de1f, F4).
    window.addEventListener('online', load);
    return () => { clearInterval(timer); window.removeEventListener('online', load); };
  }, []);
  const stale = checks.filter((c) => c.stale && (!tenantId || c.tenantId === tenantId));
  if (stale.length === 0) return null;
  return (
    <div className="card boardcheck-warn">
      <strong>⚠️ Check periodico CEO in ritardo</strong>
      {stale.map((c) => (
        <small key={c.tenantId}>
          {c.tenantIcon} {c.tenantName}: ultimo check board {new Date(c.lastBoardCheckAt).toLocaleString('it-IT')}
          {' '}(atteso ogni {Math.round(c.intervalMs / 60000)} min)
        </small>
      ))}
    </div>
  );
}

// Kill switch GLOBALE della piattaforma (backend task 16fb8517, UI task
// bc78adfb): pausa/riprendi l'INTERA piattaforma con un tap in testa ad Agenti
// live. Soft-pause: le run in corso finiscono, NON parte nulla di nuovo
// (dispatcher, cron/schedulati, chat/board). Stato PERSISTITO server-side
// (platformPaused, dentro GET /api/settings/concurrency): il banner resta
// coerente dopo reload/riapertura PWA — nessuno stato solo-locale (req.4).
// Req.6: nessun polling nuovo dedicato — si aggancia al ping WS 'concurrency'
// già esistente (il server lo emette a ogni cambio di pausa) + refetch al
// ritorno online. Banner visibile a tutti; il toggle è solo admin (la POST
// /api/settings/platform-pause è admin-only). "N run attive" = run in
// running/resumed (stessi RUNNING_STATES del server), passate dal parent che le
// ha già dallo stream — nessuna chiamata in più.
function PlatformPauseControl({ isAdmin, activeRuns, onStopActiveRuns }) {
  const [state, setState] = useState(null);   // { paused, since, by, reason }
  const [dialog, setDialog] = useState(false);
  const [alsoStop, setAlsoStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [flash, setFlash] = useState(null);

  const load = () => apiJson('/api/settings/concurrency')
    .then((c) => setState(c.platformPaused ?? { paused: false }))
    .catch(() => {});

  useEffect(() => {
    load();
    const closeWs = openWs((msg) => { if (msg.type === 'concurrency') load(); });
    window.addEventListener('online', load);
    return () => { closeWs(); window.removeEventListener('online', load); };
  }, []);

  const showFlash = (m) => { setFlash(m); setTimeout(() => setFlash(null), 4000); };

  const paused = !!state?.paused;
  const nActive = activeRuns?.length ?? 0;

  const doPause = async () => {
    setBusy(true); setErr(null);
    try {
      // La POST torna { paused, since, by, reason, activeRuns, activeRunList }:
      // usiamo activeRunList (autorevole all'istante della pausa) per l'hard stop.
      const res = await apiJson('/api/settings/platform-pause', { method: 'POST', body: { paused: true } });
      setState({ paused: true, since: res.since, by: res.by, reason: res.reason });
      let stopped = 0;
      if (alsoStop && res.activeRunList?.length) {
        stopped = await onStopActiveRuns(res.activeRunList);
      }
      setDialog(false); setAlsoStop(false);
      showFlash(stopped > 0 ? `✓ Piattaforma in pausa · ${stopped} run fermate` : '✓ Piattaforma in pausa');
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const doResume = async () => {
    setBusy(true); setErr(null);
    try {
      await apiJson('/api/settings/platform-pause', { method: 'POST', body: { paused: false } });
      setState({ paused: false });
      showFlash('✓ Piattaforma ripresa — i lanci autonomi riprendono');
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (state == null) return null; // non caricato: niente flicker del bottone

  const sinceHhmm = state.since
    ? new Date(state.since).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <>
      {paused ? (
        <div className="card platform-pause-banner" role="status">
          <strong>⏸️ Piattaforma in pausa{sinceHhmm ? ` da ${sinceHhmm}` : ''} — nessuna nuova run</strong>
          <small>
            Non parte nulla di nuovo (task board, schedulazioni, avvii da chat). Le run già avviate finiscono il loro giro.
            {state.by ? ` · in pausa da ${state.by}` : ''}
          </small>
          {isAdmin && (
            <div className="session-actions">
              <button className="btn-accent" disabled={busy} onClick={doResume}>
                {busy ? 'Riprendo…' : '▶ Riprendi'}
              </button>
            </div>
          )}
          {err && <small className="error">{err}</small>}
          {flash && <small className="pause-flash">{flash}</small>}
        </div>
      ) : (
        isAdmin && (
          <div className="card platform-pause-bar">
            <button
              type="button"
              className="btn-danger btn-block"
              disabled={busy}
              onClick={() => { setErr(null); setAlsoStop(false); setDialog(true); }}
            >
              ⏸ Pausa tutto
            </button>
            {flash && <small className="pause-flash">{flash}</small>}
          </div>
        )
      )}

      {dialog && (
        <div className="decision-overlay" onClick={() => !busy && setDialog(false)}>
          <div className="decision-card platform-pause-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="pause-dialog-body">
              <h2>Mettere in pausa la piattaforma?</h2>
              <p>
                Non partirà <strong>nessuna nuova run</strong> su nessun business (task board,
                schedulazioni, avvii da chat). Le run <strong>già in corso finiscono</strong> il loro giro.
              </p>
              {nActive > 0 ? (
                <label className="pause-check">
                  <input type="checkbox" checked={alsoStop} onChange={(e) => setAlsoStop(e.target.checked)} />
                  <span>
                    Ferma anche le {nActive} run attive adesso
                    <small className="muted"> (vengono fermate subito, senza ripresa automatica)</small>
                  </span>
                </label>
              ) : (
                <p className="muted">Nessuna run attiva in questo momento.</p>
              )}
              {err && <p className="error">{err}</p>}
            </div>
            <div className="pause-dialog-actions">
              <button className="btn-ghost" disabled={busy} onClick={() => setDialog(false)}>Annulla</button>
              <button className="btn-danger" disabled={busy} onClick={doPause}>
                {busy ? 'Attendere…' : 'Conferma'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// tenant assente = vista globale; tenant presente = solo quel business
// (il server ri-verifica comunque il tenantId sui permessi dell'utente).
export default function LiveAgents({ user, tenant = null, onBack }) {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [now, setNow] = useState(Date.now());
  const tenantId = tenant?.id ?? null;

  useEffect(() => {
    setRuns(null);
    setError(null);
    const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
    apiJson(`/api/runs/global${qs}`).then(setRuns).catch((e) => setError(e.message));
    const timer = setInterval(() => setNow(Date.now()), 15000); // durata "gira da" viva
    const closeWs = openWs((msg) => {
      if (msg.type === 'run' && (!tenantId || msg.run.tenantId === tenantId)) {
        setRuns((prev) => {
          const rest = (prev ?? []).filter((r) => r.id !== msg.run.id);
          return [msg.run, ...rest];
        });
      }
    });
    return () => { clearInterval(timer); closeWs(); };
  }, [tenantId]);

  const runAction = async (run, action, resumeAfterMs) => {
    if (action === 'stop' && !window.confirm(`Fermare la run di ${run.agentName} (${run.tenantName})? Non verrà ripresa automaticamente.`)) return;
    setBusy(run.id);
    setError(null);
    try {
      const body = { tenantId: run.tenantId };
      if (action === 'pause' && resumeAfterMs) body.resumeAfterMs = resumeAfterMs;
      const updated = await apiJson(`/api/runs/${run.id}/${action}`, { method: 'POST', body });
      setRuns((prev) => (prev ?? []).map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  // Hard-stop di una lista di run (riusa il per-run stop già esistente), usato
  // dal kill switch globale quando si spunta "ferma anche le N run attive".
  // Nessun window.confirm qui: la conferma l'ha già data il dialog di pausa.
  // Torna quante ne ha effettivamente fermate. Best-effort: una run già finita
  // non blocca le altre.
  const stopActiveRuns = async (list) => {
    let stopped = 0;
    for (const r of list) {
      try {
        const updated = await apiJson(`/api/runs/${r.id}/stop`, { method: 'POST', body: { tenantId: r.tenantId } });
        setRuns((prev) => (prev ?? []).map((x) => (x.id === updated.id ? { ...x, ...updated } : x)));
        stopped += 1;
      } catch { /* run già finita/non fermabile: si prosegue con le altre */ }
    }
    return stopped;
  };

  const sorted = useMemo(() => [...(runs ?? [])].sort((a, b) => {
    const d = (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9);
    return d !== 0 ? d : (a.startedAt < b.startedAt ? 1 : -1);
  }), [runs]);
  const activeCount = sorted.filter((r) => ACTIONABLE_STATES.includes(r.status)).length;
  // Run attive che l'hard-stop del kill switch fermerebbe: running/resumed,
  // stessi RUNNING_STATES del server (activeRunsForStop in index.js). N per la
  // checkbox del dialog di pausa — nessuna chiamata in più (dallo stream).
  const activeRunsForStop = useMemo(
    () => (runs ?? []).filter((r) => r.status === 'running' || r.status === 'resumed'),
    [runs],
  );

  const body = (
    <main className="page">
      {!tenant && (
        <PlatformPauseControl
          isAdmin={user?.role === 'admin'}
          activeRuns={activeRunsForStop}
          onStopActiveRuns={stopActiveRuns}
        />
      )}
      <RateLimitBanner isAdmin={user?.role === 'admin'} />
      <BudgetReserveBanner />
      {!tenant && <RestartBanner isAdmin={user?.role === 'admin'} />}
      <StatusLegend />
      {!tenant && <ConcurrencyPanel isAdmin={user?.role === 'admin'} />}
      {!tenant && <BudgetPanel />}
      <BoardCheckHealth tenantId={tenantId} />
      <QueueList tenantId={tenantId} />
      {error && <p className="error">{error}</p>}
      {!runs && !error && <p className="muted">Caricamento…</p>}
      {runs?.length === 0 && (
        <p className="muted center">
          Nessuna run {tenant ? 'per questo business' : (user?.role === 'admin' ? 'registrata' : 'dei tuoi agenti')} nelle ultime 24 ore.
        </p>
      )}
      <div className="cards">
        {sorted.map((r) => (
          <RunCard key={r.id} run={r} now={now} busy={busy === r.id} onAction={runAction} showTenant={!tenant} />
        ))}
      </div>
    </main>
  );

  // In modalità per-attività la topbar e le tab le fornisce TenantHome.
  if (tenant) return body;

  return (
    <>
      <header className="topbar">
        <button className="back" onClick={onBack}>←</button>
        <h1>📡 Agenti live</h1>
        <span className="topbar-right muted">{activeCount} attivi</span>
      </header>
      {body}
    </>
  );
}
