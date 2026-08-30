import React, { useEffect, useState } from 'react';
import { apiJson, canManage } from './api.js';
import AgentJobs from './AgentJobs.jsx';

// Agenti schedulati (Sprint 4): cron a 5 campi, prompt, on/off.
// Le run schedulate compaiono nella tab "Agenti attivi" con utente "scheduler".
export default function Schedules({ user, tenant }) {
  const [schedules, setSchedules] = useState(null);
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [cron, setCron] = useState('0 8 * * 1-5');
  const [prompt, setPrompt] = useState('');
  const manage = canManage(user);

  useEffect(() => {
    apiJson(`/api/schedules?tenantId=${tenant.id}`).then(setSchedules).catch((e) => setError(e.message));
    apiJson(`/api/tenants/${tenant.id}/agents`).then((list) => {
      setAgents(list);
      setAgentId((prev) => prev || list[0]?.id || '');
    }).catch(() => {});
  }, [tenant.id]);

  async function create(e) {
    e.preventDefault();
    try {
      const s = await apiJson('/api/schedules', {
        method: 'POST',
        body: { tenantId: tenant.id, agentId, cron, prompt },
      });
      setSchedules((prev) => [...(prev ?? []), s]);
      setPrompt('');
      setShowForm(false);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggle(s) {
    try {
      const updated = await apiJson(`/api/schedules/${s.id}?tenantId=${tenant.id}`, {
        method: 'PATCH',
        body: { enabled: !s.enabled },
      });
      setSchedules((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(s) {
    if (!window.confirm('Eliminare questa schedulazione?')) return;
    try {
      await apiJson(`/api/schedules/${s.id}?tenantId=${tenant.id}`, { method: 'DELETE' });
      setSchedules((prev) => prev.filter((x) => x.id !== s.id));
    } catch (err) {
      setError(err.message);
    }
  }

  const agentName = (id) => agents.find((a) => a.id === id)?.name ?? id;

  return (
    <main className="page">
      <AgentJobs user={user} tenant={tenant} />
      {tenant.id === 'platform' && user?.role === 'admin' && <h2 className="agent-jobs-title">Schedulazioni manuali</h2>}
      {error && <p className="error">{error}</p>}
      {manage && (
        <div className="board-actions">
          <button className="btn-accent" style={{ '--accent': tenant.color }} onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Annulla' : '＋ Nuova schedulazione'}
          </button>
        </div>
      )}
      {showForm && (
        <form className="card task-form" style={{ '--accent': tenant.color }} onSubmit={create}>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Agente">
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input
            value={cron}
            placeholder='Cron: min ora giorno mese giorno-settimana (es. "0 8 * * 1-5")'
            onChange={(e) => setCron(e.target.value)}
          />
          <textarea
            value={prompt}
            rows={3}
            placeholder="Prompt da inviare all'agente a ogni esecuzione"
            onChange={(e) => setPrompt(e.target.value)}
          />
          <button className="btn-accent" type="submit" disabled={!prompt.trim() || !agentId}>Crea</button>
        </form>
      )}
      {!schedules && !error && <p className="muted">Caricamento…</p>}
      {schedules?.length === 0 && <p className="muted center">Nessuna schedulazione per questo business.</p>}
      <div className="cards">
        {schedules?.map((s) => (
          <div key={s.id} className="card session-card" style={{ '--accent': tenant.color }}>
            <div className="session-head">
              <span className="card-icon">{s.enabled ? '⏰' : '💤'}</span>
              <span className="card-body">
                <strong>{agentName(s.agentId)} · <code>{s.cron}</code></strong>
                <small>{s.prompt}</small>
                <small className="muted">
                  {s.enabled ? 'attiva' : 'in pausa'}
                  {s.lastRunAt ? ` · ultima run: ${new Date(s.lastRunAt).toLocaleString('it-IT')}` : ' · mai eseguita'}
                  {s.createdBy ? ` · creata da ${s.createdBy}` : ''}
                </small>
              </span>
            </div>
            {manage && (
              <div className="approval-actions">
                <button className="btn-accent" onClick={() => toggle(s)}>{s.enabled ? 'Metti in pausa' : 'Attiva'}</button>
                <button onClick={() => remove(s)}>Elimina</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
