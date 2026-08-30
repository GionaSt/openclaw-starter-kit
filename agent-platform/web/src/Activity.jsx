import React, { useEffect, useState } from 'react';
import { apiJson, openWs } from './api.js';

// Feed "Attività" per tenant (task board 31797bb5): traccia persistente in-app
// di ciò che è rilevante per Owner — task completate (con nota di consegna),
// in attesa di una risposta, o bloccate dall'escalation del quality gate.
// Complementare alle push (che si possono perdere): qui Owner vede tutto
// aprendo l'app, senza dipendere dalla notifica arrivata o meno.
// Stato letto/non letto persistito server-side (GET/POST /api/activity*,
// vedi server/lib/activity.js) — sincronizzato tra dispositivi diversi.
const KIND_META = {
  done: { icon: '✅', label: 'Completata' },
  needs_input: { icon: '❓', label: 'Serve una tua risposta' },
  failed: { icon: '⚠️', label: 'Bloccata: serve una decisione' },
};

const timeFmt = (iso) => new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export default function Activity({ tenant, onOpenTask, onUnreadChange }) {
  const [data, setData] = useState(null); // { events, unreadCount }
  const [error, setError] = useState(null);

  const load = () => apiJson(`/api/activity?tenantId=${tenant.id}`)
    .then((d) => { setData(d); onUnreadChange?.(d.unreadCount); })
    .catch((e) => setError(e.message));

  useEffect(() => {
    load();
    return openWs((msg) => { if (msg.type === 'task' && msg.task.tenantId === tenant.id) load(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id]);

  async function open(ev) {
    if (!ev.readAt) {
      try {
        await apiJson(`/api/activity/${ev.id}/read?tenantId=${tenant.id}`, { method: 'POST' });
        setData((d) => {
          if (!d) return d;
          const next = {
            unreadCount: Math.max(0, d.unreadCount - 1),
            events: d.events.map((e) => (e.id === ev.id ? { ...e, readAt: new Date().toISOString() } : e)),
          };
          onUnreadChange?.(next.unreadCount);
          return next;
        });
      } catch { /* best-effort: l'apertura della task non deve bloccarsi */ }
    }
    onOpenTask(ev.taskId);
  }

  async function markAll() {
    try {
      await apiJson(`/api/activity/read-all?tenantId=${tenant.id}`, { method: 'POST' });
      setData((d) => {
        if (!d) return d;
        onUnreadChange?.(0);
        return { unreadCount: 0, events: d.events.map((e) => ({ ...e, readAt: e.readAt ?? new Date().toISOString() })) };
      });
    } catch (e) {
      setError(e.message);
    }
  }

  const events = data?.events ?? [];

  return (
    <main className="page">
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Caricamento…</p>}
      {data && data.unreadCount > 0 && (
        <div className="board-actions">
          <button className="btn-accent" style={{ '--accent': tenant.color }} onClick={markAll}>
            Segna tutto come letto
          </button>
        </div>
      )}
      {data && events.length === 0 && (
        <p className="muted center">Nessuna attività ancora — qui compaiono task completate, in attesa di una tua risposta o bloccate.</p>
      )}
      <div className="cards">
        {events.map((ev) => {
          const meta = KIND_META[ev.kind] ?? { icon: '·', label: ev.kind };
          return (
            <button
              key={ev.id}
              type="button"
              className={`card activity-card${ev.readAt ? '' : ' activity-unread'}`}
              style={{ '--accent': tenant.color }}
              onClick={() => open(ev)}
            >
              <span className="card-icon">{meta.icon}</span>
              <span className="card-body">
                <strong>{ev.title}</strong>
                <small>{meta.label}{ev.note ? ` — ${ev.note}` : ''}</small>
                <small className="muted">{timeFmt(ev.createdAt)}</small>
              </span>
              {!ev.readAt && <span className="activity-dot" title="non letto" />}
            </button>
          );
        })}
      </div>
    </main>
  );
}
