import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiJson } from './api.js';

// Sezione "Completate" (task board c5366bb3, consuma GET /api/tasks/completed
// — task adb782e9): report di sola lettura delle task done, per business.
// Card compatta (titolo, agente, data, sintesi) raggruppata per giorno di
// completamento; tap -> dettaglio con descrizione, nota di consegna intera,
// note di review e file toccati. Filtri: business, agente, periodo — come
// "Agenti live"/"Richieste per te" il business si sceglie qui (chip), non è
// un secondo livello di navigazione: chi gestisce più business confronta il
// lavoro fatto senza uscire dalla sezione.

const PERIODS = [
  { id: 'tutto', label: 'Tutto' },
  { id: 'oggi', label: 'Oggi' },
  { id: '7', label: '7 giorni' },
  { id: '30', label: '30 giorni' },
];

// Data locale YYYY-MM-DD (non UTC: "oggi"/i confini giorno devono seguire il
// fuso di chi guarda, non quello del timestamp ISO salvato in UTC).
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function periodFrom(period) {
  if (period === 'tutto') return null;
  const d = new Date();
  if (period === 'oggi') return localDateStr(d);
  d.setDate(d.getDate() - (Number(period) - 1));
  return localDateStr(d);
}

const dayHeaderFmt = (key) => {
  const label = new Date(`${key}T12:00:00`).toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
};
const timeFmt = (iso) => new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const reviewTimeFmt = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const agentLabel = (v) => (v ? String(v).replace(/^agent:/, '') : null);

function TaskCard({ item, accent, open, onToggle }) {
  const agent = agentLabel(item.assignedTo) ?? agentLabel(item.workerId);
  return (
    <article className="task-row status-done" style={{ '--accent': accent }}>
      <button type="button" className="task-row-head" onClick={onToggle} aria-expanded={open}>
        <span className="task-row-title">{item.title}</span>
        <span className="task-status-badge">{timeFmt(item.completedAt)}</span>
        <span className="task-row-caret muted">{open ? '▾' : '▸'}</span>
      </button>
      <div className="completed-card-sub">
        {agent && <small className="muted">🤖 {agent}</small>}
        {item.report && <small className="completed-report">{item.report}</small>}
      </div>
      {open && (
        <div className="task-row-detail">
          {item.description && <p className="task-desc">{item.description}</p>}
          {item.deliveryNote && (
            <>
              <small className="muted">📝 Nota di consegna</small>
              <p className="task-desc">{item.deliveryNote}</p>
            </>
          )}
          {item.reviewNotes?.length > 0 && (
            <>
              <small className="muted">🔍 Review</small>
              <ul className="completed-review-list">
                {item.reviewNotes.map((r, i) => (
                  <li key={i}>
                    <span>{r.decision === 'approve' ? '✅' : '❌'} {r.stage ?? ''} · {reviewTimeFmt(r.at)}</span>
                    {r.note && <span className="completed-review-note">{r.note}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          <small className="muted">
            📁 File toccati: {item.filesTouched?.length > 0 ? item.filesTouched.join(', ') : 'non registrati'}
          </small>
        </div>
      )}
    </article>
  );
}

export default function CompletedTasks({ tenant }) {
  const [tenants, setTenants] = useState(null);
  const [tenantsError, setTenantsError] = useState(null);
  const [tenantId, setTenantId] = useState(tenant.id);
  const [agents, setAgents] = useState([]);
  const [agentId, setAgentId] = useState('');
  const [period, setPeriod] = useState('tutto');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);

  const loadTenants = useCallback(() => {
    setTenantsError(null);
    apiJson('/api/tenants').then(setTenants).catch((err) => {
      console.warn('/api/tenants fallita:', err);
      // Fallback silenzioso ma tracciato: senza i chip degli altri business
      // resta comunque disponibile quello corrente (activeTenant sotto).
      setTenantsError(err.message || 'Errore di rete');
    });
  }, []);

  useEffect(() => { loadTenants(); }, [loadTenants]);

  useEffect(() => {
    setAgentId('');
    // ?all=true: include anche gli agenti operativi, non solo il CEO
    // (interlocutore di chat) — task c918de5b, altrimenti il filtro qui
    // sotto non permette di scegliere gli agenti che eseguono le task.
    apiJson(`/api/tenants/${tenantId}/agents?all=true`).then(setAgents).catch(() => setAgents([]));
  }, [tenantId]);

  useEffect(() => {
    setError(null);
    const from = periodFrom(period);
    const params = new URLSearchParams({ tenantId, limit: '100' });
    if (from) params.set('from', from);
    if (agentId) params.set('agentId', agentId);
    apiJson(`/api/tasks/completed?${params}`).then(setData).catch((e) => setError(e.message));
  }, [tenantId, agentId, period]);

  const activeTenant = tenants?.find((t) => t.id === tenantId) ?? tenant;
  const accent = activeTenant.color;

  const groups = useMemo(() => {
    const map = new Map();
    for (const item of data?.items ?? []) {
      const key = localDateStr(new Date(item.completedAt));
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    return [...map.entries()];
  }, [data]);

  return (
    <main className="page">
      {error && <p className="error">{error}</p>}

      {tenantsError && !tenants?.length && (
        <div className="fetch-error-inline">
          <p className="error">Elenco business non caricato: {tenantsError}</p>
          <button type="button" className="retry-btn" onClick={loadTenants}>Riprova</button>
        </div>
      )}

      {tenants?.length > 1 && (
        <div className="task-filters">
          {tenants.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`filter-chip ${tenantId === t.id ? 'active' : ''}`}
              style={{ '--accent': t.color }}
              onClick={() => setTenantId(t.id)}
            >
              {t.icon} {t.name}
            </button>
          ))}
        </div>
      )}

      <div className="task-filters">
        {PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`filter-chip ${period === p.id ? 'active' : ''}`}
            style={{ '--accent': accent }}
            onClick={() => setPeriod(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <select className="completed-agent-select" value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Filtra per agente">
        <option value="">Tutti gli agenti</option>
        {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>

      {!data && !error && <p className="muted">Caricamento…</p>}
      {data && data.items.length === 0 && <p className="muted center">Nessuna task completata con questi filtri.</p>}
      {data && data.count > data.items.length && (
        <p className="muted completed-count-note">{data.items.length} di {data.count} — restringi periodo/agente per vederle tutte.</p>
      )}

      <div className="task-list">
        {groups.map(([day, items]) => (
          <section key={day} className="completed-day-group">
            <h3 className="completed-day-header">{dayHeaderFmt(day)} <span className="filter-count">{items.length}</span></h3>
            {items.map((item) => (
              <TaskCard
                key={item.id}
                item={item}
                accent={accent}
                open={openId === item.id}
                onToggle={() => setOpenId((v) => (v === item.id ? null : item.id))}
              />
            ))}
          </section>
        ))}
      </div>
    </main>
  );
}
