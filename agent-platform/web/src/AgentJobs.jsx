import React, { useEffect, useMemo, useState } from 'react';
import { apiJson } from './api.js';

// Job agenti proattivi configurabili da UI (task board 50494a0d, API generica
// c5ff7ad3): una card per job esposto da GET /api/agent-jobs — oggi
// code-quality + pm-platform, automatica per eventuali job futuri (nessun
// hardcode sull'elenco). Solo admin (stessa fascia dell'endpoint).
export default function AgentJobs({ user, tenant }) {
  const [jobs, setJobs] = useState(null);
  const [error, setError] = useState(null);
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    if (!isAdmin || tenant?.id !== 'platform') return;
    let cancelled = false;
    apiJson('/api/agent-jobs')
      .then((list) => { if (!cancelled) setJobs(list); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [isAdmin, tenant?.id]);

  function applyUpdate(jobId, patch) {
    return apiJson(`/api/agent-jobs/${jobId}`, { method: 'PUT', body: patch })
      .then((updated) => {
        // Aggiorna lo stato locale con la risposta del server: nextRunAt/cron/
        // enabled a schermo subito, nessun reload (criterio di completamento).
        setJobs((prev) => prev.map((j) => (j.jobId === updated.jobId ? updated : j)));
        return updated;
      });
  }

  if (!isAdmin || tenant?.id !== 'platform') return null;

  return (
    <section className="agent-jobs-section">
      <h2 className="agent-jobs-title">Agenti proattivi</h2>
      {error && <p className="error">{error}</p>}
      {!jobs && !error && <p className="muted">Caricamento…</p>}
      {jobs?.length === 0 && <p className="muted">Nessun job agente configurato.</p>}
      <div className="cards">
        {jobs?.map((job) => (
          <AgentJobCard key={job.jobId} job={job} accent={tenant.color} onUpdate={(patch) => applyUpdate(job.jobId, patch)} />
        ))}
      </div>
    </section>
  );
}

const TITLES = { 'code-quality': 'Check qualità codice', 'pm-platform': 'Miglioramento piattaforma' };
const ICONS = { 'code-quality': '🔍', 'pm-platform': '🚀' };
const DEFAULT_HOUR = { 'code-quality': 5, 'pm-platform': 6 };

// Riconosce il preset corrente da un'espressione cron a 5 campi (stessi
// pattern generati da PRESETS in server/lib/agentjobs.js) per evidenziare il
// bottone attivo e mostrare la frequenza in chiaro.
function detectPreset(cron) {
  if (!cron) return { type: 'custom' };
  const m1 = /^0 (\d{1,2}) \* \* \*$/.exec(cron);
  if (m1) return { type: 'daily', hour: Number(m1[1]) };
  const m2 = /^0 (\d{1,2}),(\d{1,2}) \* \* \*$/.exec(cron);
  if (m2) return { type: 'twiceDaily', hour: Number(m2[1]), hour2: Number(m2[2]) };
  if (cron === '0 */6 * * *') return { type: 'every6h' };
  if (cron === '0 */3 * * *') return { type: 'every3h' };
  return { type: 'custom' };
}

const pad2 = (n) => String(n).padStart(2, '0');

function describeCron(cron) {
  const p = detectPreset(cron);
  if (p.type === 'daily') return `1×/giorno alle ${pad2(p.hour)}:00`;
  if (p.type === 'twiceDaily') return `2×/giorno alle ${pad2(p.hour)}:00 e ${pad2(p.hour2)}:00`;
  if (p.type === 'every6h') return 'ogni 6 ore';
  if (p.type === 'every3h') return 'ogni 3 ore';
  return `cron personalizzato · ${cron}`;
}

function formatDateTime(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function outcomeLabel(lastRun) {
  if (!lastRun) return 'mai eseguita';
  const when = formatDateTime(lastRun.startedAt);
  if (lastRun.status === 'skipped_budget') {
    const pct = lastRun.pctRemaining != null ? ` · budget residuo ${lastRun.pctRemaining}%` : '';
    return `saltata per budget (${when}${pct})`;
  }
  if (lastRun.status === 'completed') return `ok (${when})`;
  if (lastRun.status === 'failed') return `fallita (${when})`;
  return `${lastRun.status} (${when})`;
}

function outcomeClass(lastRun) {
  if (!lastRun) return '';
  if (lastRun.status === 'completed') return 'agent-job-outcome-ok';
  if (lastRun.status === 'failed') return 'agent-job-outcome-fail';
  if (lastRun.status === 'skipped_budget') return 'agent-job-outcome-skip';
  return '';
}

function AgentJobCard({ job, accent, onUpdate }) {
  const preset = useMemo(() => detectPreset(job.cron), [job.cron]);
  const [dailyHour, setDailyHour] = useState(preset.type === 'daily' ? preset.hour : (DEFAULT_HOUR[job.jobId] ?? 8));
  const [cronDraft, setCronDraft] = useState(job.cron);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => { setCronDraft(job.cron); }, [job.cron]);
  useEffect(() => {
    if (preset.type === 'daily') setDailyHour(preset.hour);
  }, [job.cron]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(patch) {
    setBusy(true);
    setErr(null);
    try {
      await onUpdate(patch);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const applyDaily = (hour) => run({ preset: 'daily', hour });
  const applyPreset = (name) => run({ preset: name });
  const togglePause = () => run({ enabled: !job.enabled });
  const applyCron = (e) => {
    e.preventDefault();
    run({ cron: cronDraft.trim() });
  };

  const title = TITLES[job.jobId] ?? job.label;
  const icon = ICONS[job.jobId] ?? '🤖';

  return (
    <div className="card agent-job-card" style={{ '--accent': accent }}>
      <div className="agent-job-head">
        <span className="card-icon">{icon}</span>
        <span className="card-body">
          <strong>{title}</strong>
          <small className="muted">{job.enabled ? 'attiva' : 'in pausa'}</small>
        </span>
        <button
          type="button"
          className={`agent-job-pause-btn ${job.enabled ? '' : 'is-paused'}`}
          onClick={togglePause}
          disabled={busy}
          aria-pressed={!job.enabled}
        >
          {job.enabled ? '⏸ Pausa' : '▶ Riattiva'}
        </button>
      </div>

      <div className="agent-job-info">
        <div><span className="muted">Frequenza:</span> {describeCron(job.cron)}</div>
        <div><span className="muted">Prossima esecuzione:</span> {job.enabled ? (formatDateTime(job.nextRunAt) ?? '—') : 'in pausa'}</div>
        <div className={outcomeClass(job.lastRun)}>
          <span className="muted">Ultima run:</span> {outcomeLabel(job.lastRun)}
        </div>
        {job.focus && (
          <div className="agent-job-focus">
            <span className="muted">Focus di oggi:</span> {job.focus.label}
          </div>
        )}
      </div>

      <div className="agent-job-presets">
        <button
          type="button"
          className={`agent-job-preset-btn ${preset.type === 'daily' ? 'active' : ''}`}
          disabled={busy}
          onClick={() => applyDaily(dailyHour)}
        >
          1×/giorno
        </button>
        <select
          className="agent-job-hour-select"
          aria-label="Orario 1×/giorno"
          value={dailyHour}
          disabled={busy}
          onChange={(e) => {
            const hour = Number(e.target.value);
            setDailyHour(hour);
            if (preset.type === 'daily') applyDaily(hour);
          }}
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>{pad2(h)}:00</option>
          ))}
        </select>
        <button
          type="button"
          className={`agent-job-preset-btn ${preset.type === 'twiceDaily' ? 'active' : ''}`}
          disabled={busy}
          onClick={() => applyPreset('twiceDaily')}
        >
          2×/giorno
        </button>
        <button
          type="button"
          className={`agent-job-preset-btn ${preset.type === 'every6h' ? 'active' : ''}`}
          disabled={busy}
          onClick={() => applyPreset('every6h')}
        >
          Ogni 6h
        </button>
        <button
          type="button"
          className={`agent-job-preset-btn ${preset.type === 'every3h' ? 'active' : ''}`}
          disabled={busy}
          onClick={() => applyPreset('every3h')}
        >
          Ogni 3h
        </button>
      </div>

      {err && <p className="error agent-job-error">{err}</p>}

      <details className="agent-job-advanced">
        <summary>Avanzate: cron libero</summary>
        <form className="agent-job-cron-form" onSubmit={applyCron}>
          <input
            value={cronDraft}
            onChange={(e) => setCronDraft(e.target.value)}
            placeholder="min ora giorno mese giorno-settimana"
            aria-label="Espressione cron"
          />
          <button type="submit" className="btn-accent" disabled={busy || !cronDraft.trim()}>Applica</button>
        </form>
        <p className="muted agent-job-hint">Minimo {job.minIntervalHours}h tra le run (guardrail budget).</p>
      </details>
    </div>
  );
}
