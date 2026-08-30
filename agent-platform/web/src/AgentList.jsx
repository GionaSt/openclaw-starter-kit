import React, { useEffect, useState } from 'react';
import { authFetch } from './api.js';
import { MODEL_LABELS } from './lib/modelLabels.js';

export default function AgentList({ tenant, onSelect, onBack, embedded = false }) {
  const [agents, setAgents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    authFetch(`/api/tenants/${tenant.id}/agents`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setAgents)
      .catch((e) => setError(e.message));
  }, [tenant.id]);

  const list = (
    <main className="page">
      {error && <p className="error">{error}</p>}
      <div className="cards">
        {agents?.map((a) => (
          <button key={a.id} className="card" style={{ '--accent': tenant.color }} onClick={() => onSelect(a)}>
            <span className="card-body">
              <strong>{a.name}</strong>
              <small>{a.role}</small>
              <small className="muted">{MODEL_LABELS[a.model] ?? a.model}</small>
            </span>
          </button>
        ))}
        {agents?.length === 0 && <p className="muted center">Nessun agente assegnato al tuo utente.</p>}
      </div>
    </main>
  );

  if (embedded) return list;

  return (
    <>
      <header className="topbar">
        <button className="back" onClick={onBack}>←</button>
        <h1>{tenant.icon} {tenant.name}</h1>
      </header>
      {list}
    </>
  );
}
