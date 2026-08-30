import React, { useState } from 'react';
import { apiJson } from './api.js';

// Kill switch PER-TENANT (backend task 6116efe1, UI task 967e0385). Blocca/
// sblocca un singolo business: da bloccato la piattaforma NON lancia agenti per
// quel tenant, resta attiva solo la chat col CEO. Stato SERVER-SIDE (campo
// `blocked` nel payload /api/tenants); qui aggiornamento OTTIMISTICO + riallineamento
// sulla risposta della POST — nessuno stato solo-client (req.5). Il toggle è solo
// admin (le POST /api/tenants/:id/block|unblock sono admin-only); il banner di
// stato è visibile a tutti. Mirror per-tenant di PlatformPauseControl (riusa gli
// stessi stili .platform-pause-* / .decision-* per coerenza e zero CSS nuovo).
export default function TenantBlockControl({ user, tenant, blocked, onChange }) {
  const isAdmin = user?.role === 'admin';
  const isBlocked = !!blocked?.blocked;
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const doBlock = async () => {
    setBusy(true); setErr(null);
    onChange({ blocked: true }); // ottimistico: stato bloccato subito
    try {
      // Risposta autorevole: { blocked, blockedAt, blockedBy, stoppedRuns, droppedQueued }
      const res = await apiJson(`/api/tenants/${tenant.id}/block`, { method: 'POST' });
      onChange(res);
      setDialog(false);
    } catch (e) {
      setErr(e.message);
      onChange({ blocked: false }); // rollback ottimistico
    } finally { setBusy(false); }
  };

  const doUnblock = async () => {
    setBusy(true); setErr(null);
    onChange({ blocked: false }); // ottimistico
    try {
      const res = await apiJson(`/api/tenants/${tenant.id}/unblock`, { method: 'POST' });
      onChange(res); // { blocked: false }
    } catch (e) {
      setErr(e.message);
      onChange({ blocked: true }); // rollback
    } finally { setBusy(false); }
  };

  return (
    <>
      {isBlocked ? (
        <div className="card platform-pause-banner tenant-block-banner" role="status">
          <strong>🚫 BLOCCATO</strong>
          <small>Bloccato — solo la chat con il CEO è attiva. Nessun agente viene lanciato per questo business.</small>
          {isAdmin && (
            <div className="session-actions">
              <button className="btn-accent" disabled={busy} onClick={doUnblock}>
                {busy ? 'Sblocco…' : '▶ Sblocca business'}
              </button>
            </div>
          )}
          {err && <small className="error">{err}</small>}
        </div>
      ) : (
        isAdmin && (
          <div className="card platform-pause-bar tenant-block-bar">
            <button
              type="button"
              className="btn-danger btn-block"
              disabled={busy}
              onClick={() => { setErr(null); setDialog(true); }}
            >
              🚫 Blocca business
            </button>
            {err && <small className="error">{err}</small>}
          </div>
        )
      )}

      {dialog && (
        <div className="decision-overlay" onClick={() => !busy && setDialog(false)}>
          <div className="decision-card platform-pause-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="pause-dialog-body">
              <h2>Bloccare {tenant.name}?</h2>
              <p>
                <strong>Nessun agente verrà lanciato</strong>; le run in corso vengono fermate.
                Potrai comunque scrivere al CEO in chat.
              </p>
              {err && <p className="error">{err}</p>}
            </div>
            <div className="pause-dialog-actions">
              <button className="btn-ghost" disabled={busy} onClick={() => setDialog(false)}>Annulla</button>
              <button className="btn-danger" disabled={busy} onClick={doBlock}>
                {busy ? 'Blocco…' : 'Blocca business'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
