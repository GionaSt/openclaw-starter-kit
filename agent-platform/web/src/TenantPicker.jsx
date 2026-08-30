import React, { useEffect, useState } from 'react';
import { authFetch } from './api.js';

export default function TenantPicker({ user, onSelect, onLogout, autoSelectId = null }) {
  const [tenants, setTenants] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    authFetch('/api/tenants')
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then(setTenants)
      .catch((err) => setError(err.message));
  }, []);

  // Deep-link da push: appena la lista è pronta apre direttamente il business giusto.
  useEffect(() => {
    if (!autoSelectId || !tenants) return;
    const match = tenants.find((item) => item.id === autoSelectId);
    if (match) onSelect(match);
  }, [autoSelectId, tenants]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <header className="topbar">
        <div className="os-tenant-title">
          <h1>⚡ Operating System</h1>
          <small>{user?.username}</small>
        </div>
        <span className="topbar-right"><button className="back" onClick={onLogout}>Esci</button></span>
      </header>
      <main className="page os-picker-page">
        <div className="os-picker-intro">
          <span className="os-kicker">Workspace</span>
          <h2>Scegli il business</h2>
          <p>Progetti, report, approvazioni e automazioni V2 in un unico posto.</p>
        </div>
        {error && <p className="error">Server non raggiungibile: {error}</p>}
        {!tenants && !error && <p className="muted">Caricamento…</p>}
        <div className="cards">
          {tenants?.map((tenant) => (
            <button key={tenant.id} className="card" style={{ '--accent': tenant.color }} onClick={() => onSelect(tenant)}>
              <span className="card-icon">{tenant.icon}</span>
              <span className="card-body">
                <strong>{tenant.name}</strong>
                <small>{tenant.description}</small>
                <small className="muted">Apri Operating System</small>
              </span>
            </button>
          ))}
          {tenants?.length === 0 && <p className="muted center">Nessun business assegnato.</p>}
        </div>
      </main>
    </>
  );
}
