import React, { useCallback, useEffect, useState } from 'react';
import { apiJson, openWs, canManage } from './api.js';

// Vista "Bloccate" (task board d24e39a0, consuma il lavoro server di 03a5a645
// — lib/blocked.js, GET/POST /api/tasks/blocked, /api/tasks/:id/retry): task
// ferme per un blocco TECNICO (run interrotta, retry esauriti, gate bocciato
// troppe volte) — non una domanda a cui Owner sa rispondere, quella resta in
// "Da decidere" (Requests.jsx/DecisionPopup). Qui niente push/badge assillante:
// solo il contatore silenzioso sulla tab (stesso pattern di "Attività",
// TenantHome), la lista si consulta quando si vuole, non compete con "Da
// decidere". Dettaglio task: riusa TaskBoard (focus/espande la riga), lo
// stesso pattern già usato dal feed Attività — la schermata dedicata di
// f26817e2 non è ancora disponibile.
const timeFmt = (iso) => new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function BlockedCard({ item, manage, busy, onRetry, onOpen }) {
  return (
    <article className="card blocked-card" style={{ '--accent': item.tenantColor ?? '#7c6cf0' }}>
      <button type="button" className="blocked-card-main" onClick={() => onOpen(item)}>
        <span className="card-body">
          <strong>{item.title}</strong>
          <span className="blocked-cause">⛔ {item.cause}</span>
          <small className="muted">
            {item.assignedTo && `🤖 ${item.assignedTo.replace(/^agent:/, '')} · `}
            aggiornata {timeFmt(item.updatedAt)} · tentativo {item.attempts}/{item.maxAttempts}
          </small>
        </span>
      </button>
      {manage && (
        <button
          type="button"
          className="blocked-retry-btn"
          disabled={busy}
          onClick={(e) => { e.stopPropagation(); onRetry(item); }}
        >
          {busy ? '…' : '↻ Riprova'}
        </button>
      )}
    </article>
  );
}

export default function Blocked({ user, tenant, onOpenTask }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [busyAll, setBusyAll] = useState(false);
  const manage = canManage(user);

  const refetch = useCallback(() => {
    apiJson(`/api/tasks/blocked?tenantId=${tenant.id}`)
      .then((d) => { setItems(d.items); setError(null); })
      .catch((e) => setError(e.message));
  }, [tenant.id]);

  useEffect(() => {
    refetch();
    return openWs((msg) => { if (msg.type === 'task' && msg.task.tenantId === tenant.id) refetch(); });
  }, [tenant.id, refetch]);

  async function retryOne(item) {
    setBusyId(item.taskId);
    setError(null);
    try {
      await apiJson(`/api/tasks/${item.taskId}/retry?tenantId=${tenant.id}`, { method: 'POST' });
      setItems((prev) => prev?.filter((it) => it.taskId !== item.taskId) ?? prev);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  async function retryAll() {
    if (!items?.length) return;
    setBusyAll(true);
    setError(null);
    const results = await Promise.allSettled(
      items.map((it) => apiJson(`/api/tasks/${it.taskId}/retry?tenantId=${tenant.id}`, { method: 'POST' })),
    );
    const failedIds = new Set(items.filter((_, i) => results[i].status === 'rejected').map((it) => it.taskId));
    setItems((prev) => prev?.filter((it) => failedIds.has(it.taskId)) ?? prev);
    if (failedIds.size > 0) setError(`${failedIds.size} task non riprovate correttamente — riprova singolarmente.`);
    setBusyAll(false);
  }

  return (
    <main className="page">
      {error && <p className="error">{error}</p>}
      {items === null && !error && <p className="muted">Caricamento…</p>}
      {items?.length === 0 && <p className="muted center">Nessuna task bloccata 🎉</p>}
      {manage && items?.length > 1 && (
        <div className="board-actions">
          <button type="button" className="btn-accent" style={{ '--accent': tenant.color }} disabled={busyAll} onClick={retryAll}>
            {busyAll ? 'Riprovo tutte…' : `↻ Riprova tutte (${items.length})`}
          </button>
        </div>
      )}
      <div className="cards">
        {items?.map((it) => (
          <BlockedCard
            key={it.taskId}
            item={it}
            manage={manage}
            busy={busyId === it.taskId || busyAll}
            onRetry={retryOne}
            onOpen={(x) => onOpenTask(x.taskId)}
          />
        ))}
      </div>
    </main>
  );
}
