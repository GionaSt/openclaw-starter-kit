import React, { useEffect, useState } from 'react';
import { apiJson, canManage, openWs } from './api.js';

const STATUS_LABELS = {
  pending: { label: 'In attesa', icon: '✋' },
  approved: { label: 'Approvata', icon: '✅' },
  denied: { label: 'Rifiutata', icon: '⛔' },
  expired: { label: 'Scaduta', icon: '⌛' },
};

// Inbox delle richieste di approvazione dei tool sensibili (Sprint 4).
// Le pending arrivano in tempo reale via WebSocket; approva/rifiuta sblocca la run.
export default function Approvals({ user, tenant }) {
  const [approvals, setApprovals] = useState(null);
  const [error, setError] = useState(null);
  const [denying, setDenying] = useState(null); // id in fase di rifiuto (nota opzionale)
  const [note, setNote] = useState('');
  const manage = canManage(user);

  useEffect(() => {
    apiJson(`/api/approvals?tenantId=${tenant.id}`).then(setApprovals).catch((e) => setError(e.message));
    return openWs((msg) => {
      if (msg.type === 'approval' && msg.approval.tenantId === tenant.id) {
        setApprovals((prev) => {
          const rest = (prev ?? []).filter((a) => a.id !== msg.approval.id);
          return [msg.approval, ...rest];
        });
      }
    });
  }, [tenant.id]);

  async function resolve(id, action, noteText) {
    try {
      const updated = await apiJson(`/api/approvals/${id}?tenantId=${tenant.id}`, {
        method: 'POST',
        body: { action, note: noteText || undefined },
      });
      setApprovals((prev) => prev?.map((a) => (a.id === updated.id ? updated : a)));
      setDenying(null);
      setNote('');
    } catch (err) {
      setError(err.message);
    }
  }

  const sorted = (approvals ?? []).slice().sort((a, b) => {
    // Le pending sempre in cima, poi per data decrescente.
    if ((a.status === 'pending') !== (b.status === 'pending')) return a.status === 'pending' ? -1 : 1;
    return a.requestedAt < b.requestedAt ? 1 : -1;
  });

  return (
    <main className="page">
      {error && <p className="error">{error}</p>}
      {!approvals && !error && <p className="muted">Caricamento…</p>}
      {approvals?.length === 0 && <p className="muted center">Nessuna richiesta di approvazione per questo business.</p>}
      <div className="cards">
        {sorted.map((a) => {
          const st = STATUS_LABELS[a.status] ?? { label: a.status, icon: '·' };
          return (
            <div key={a.id} className={`card session-card status-${a.status === 'pending' ? 'needs_input' : a.status}`} style={{ '--accent': tenant.color }}>
              <div className="session-head">
                <span className="card-icon">{st.icon}</span>
                <span className="card-body">
                  <strong>{a.agentName ?? a.agentId} → {a.toolName}</strong>
                  <small>{st.label}{a.resolvedBy ? ` da ${a.resolvedBy}` : ''}{a.note ? ` — ${a.note}` : ''}</small>
                  <small className="muted">richiesta: {new Date(a.requestedAt).toLocaleString('it-IT')}</small>
                  {a.input && (
                    <small className="muted approval-input">{JSON.stringify(a.input).slice(0, 300)}</small>
                  )}
                </span>
              </div>
              {a.status === 'pending' && manage && (
                denying === a.id ? (
                  <div className="approval-actions">
                    <input
                      value={note}
                      placeholder="Motivo del rifiuto (opzionale)"
                      autoFocus
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <button className="btn-accent" onClick={() => resolve(a.id, 'deny', note)}>Conferma rifiuto</button>
                    <button onClick={() => { setDenying(null); setNote(''); }}>Annulla</button>
                  </div>
                ) : (
                  <div className="approval-actions">
                    <button className="btn-accent" onClick={() => resolve(a.id, 'approve')}>Approva</button>
                    <button onClick={() => setDenying(a.id)}>Rifiuta…</button>
                  </div>
                )
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
