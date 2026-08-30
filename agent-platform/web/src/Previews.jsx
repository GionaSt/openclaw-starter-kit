import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiJson } from './api.js';

// Vetrina globale dei deliverable pubblicati dagli agenti (publish_preview,
// task 9d1b6ebb) — task board 821382a7: indice /preview/ navigabile per
// business da telefono. Consuma SOLO le API di registro della task 4ab8c6b8
// (GET /api/previews, GET /api/previews/:tenantId): nessuna logica di
// rendering duplicata qui — il contenuto vero (html/markdown/immagine/pdf,
// sandboxato) resta quello già pubblico su /preview/<tenantId>/<slug>
// (server/lib/previews.js); "Apri a schermo intero" ci si limita a linkare.
//
// 3 livelli, navigazione a stato (stesso pattern di LiveAgents/CeoMail —
// niente client routing in questa app, vedi App.jsx):
//   home (card per business) -> business (lista lavori) -> lavoro (dettaglio)

const TIPO_ICON = { html: '🌐', markdown: '📝', immagine: '🖼️', pdf: '📄' };
const agentLabel = (v) => (v ? String(v).replace(/^agent:/, '') : null);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDateShort = (iso) => (iso ? new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
const lastUpdateOf = (items) => items.reduce((max, it) => (!max || it.updatedAt > max ? it.updatedAt : max), null);

export default function Previews({ onBack, onOpenTask }) {
  const [tenants, setTenants] = useState(null);
  const [tenantsError, setTenantsError] = useState(null);
  const [groups, setGroups] = useState(null); // [{tenantId, tenantName, items}]
  const [groupsError, setGroupsError] = useState(null);
  const [tenantId, setTenantId] = useState(null); // business aperto, null = home
  const [items, setItems] = useState(null); // lavori del business aperto, ordinati
  const [itemsError, setItemsError] = useState(null);
  const [slug, setSlug] = useState(null); // lavoro aperto, null = lista
  // "Vai alla task": se il taskId nel registry non esiste (più) nel tenant
  // dell'item (seed errato / task cancellata), il deep-link porterebbe a una
  // board vuota — task board 8457315c. Validiamo prima di navigare e, se manca,
  // mostriamo un toast invece di portare a una pagina cieca.
  const [taskNav, setTaskNav] = useState({ checking: false, toast: null });

  const loadTenants = useCallback(() => {
    setTenantsError(null);
    apiJson('/api/tenants').then(setTenants).catch((e) => setTenantsError(e.message));
  }, []);
  const loadGroups = useCallback(() => {
    setGroupsError(null);
    apiJson('/api/previews').then(setGroups).catch((e) => setGroupsError(e.message));
  }, []);
  useEffect(loadTenants, [loadTenants]);
  useEffect(loadGroups, [loadGroups]);

  const loadItems = useCallback((id) => {
    setItemsError(null);
    setItems(null);
    apiJson(`/api/previews/${encodeURIComponent(id)}`)
      .then((list) => setItems([...list].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))))
      .catch((e) => setItemsError(e.message));
  }, []);
  useEffect(() => { if (tenantId) loadItems(tenantId); }, [tenantId, loadItems]);

  const tenantMeta = (id) => tenants?.find((t) => t.id === id);
  const openTenant = (id) => { setTenantId(id); setSlug(null); };
  const item = useMemo(() => items?.find((it) => it.slug === slug) ?? null, [items, slug]);

  // Naviga alla task di origine solo se esiste davvero nel tenant dell'item:
  // GET /api/tasks/:id torna 404 se assente (seed errato / task cancellata) →
  // toast invece di deep-link morto.
  const goToTask = useCallback((meta, taskId, tId) => {
    if (!taskId || !meta) return;
    setTaskNav({ checking: true, toast: null });
    apiJson(`/api/tasks/${encodeURIComponent(taskId)}?tenantId=${encodeURIComponent(tId)}`)
      .then(() => { setTaskNav({ checking: false, toast: null }); onOpenTask(meta, taskId); })
      .catch(() => setTaskNav({ checking: false, toast: 'Task di origine non disponibile' }));
  }, [onOpenTask]);

  // ---- Vista lavoro ----
  if (tenantId && slug) {
    const meta = tenantMeta(tenantId);
    const publicUrl = `/preview/${encodeURIComponent(tenantId)}/${encodeURIComponent(slug)}`;
    return (
      <>
        <header className="topbar">
          <button className="back" onClick={() => setSlug(null)}>←</button>
          <h1>{item?.titolo ?? 'Lavoro'}</h1>
        </header>
        <main className="page">
          {!item && !itemsError && <p className="muted">Caricamento…</p>}
          {item && (
            <div className="preview-detail">
              <p className="preview-detail-meta">
                <span className="p-chip">{TIPO_ICON[item.tipo] ?? '📦'} {item.tipo}</span>
                {meta && <span className="p-chip" style={{ '--accent': meta.color }}>{meta.icon} {meta.name}</span>}
              </p>
              <ul className="preview-detail-list">
                <li><span className="muted">Pubblicato</span> {fmtDate(item.createdAt)}</li>
                {item.updatedAt !== item.createdAt && (
                  <li><span className="muted">Ultimo aggiornamento</span> {fmtDate(item.updatedAt)}</li>
                )}
                {agentLabel(item.agente) && <li><span className="muted">Agente</span> {agentLabel(item.agente)}</li>}
                {item.taskId && <li><span className="muted">Task di origine</span> {item.taskId}</li>}
                {item.versions?.length > 0 && <li><span className="muted">Versioni precedenti</span> {item.versions.length}</li>}
              </ul>
              <div className="preview-detail-actions">
                <a className="btn-accent preview-fullscreen-btn" href={publicUrl} target="_blank" rel="noreferrer">
                  ⤢ Apri a schermo intero
                </a>
                {item.taskId && meta && (
                  <button type="button" className="btn-accent" disabled={taskNav.checking} onClick={() => goToTask(meta, item.taskId, tenantId)}>
                    🗂 {taskNav.checking ? 'Verifica…' : 'Vai alla task'}
                  </button>
                )}
              </div>
              {taskNav.toast && <p className="preview-toast" role="status">{taskNav.toast}</p>}
            </div>
          )}
        </main>
      </>
    );
  }

  // ---- Vista business (lista lavori) ----
  if (tenantId) {
    const meta = tenantMeta(tenantId);
    return (
      <>
        <header className="topbar">
          <button className="back" onClick={() => setTenantId(null)}>←</button>
          <h1>{meta ? `${meta.icon} ${meta.name}` : tenantId}</h1>
        </header>
        <main className="page">
          {itemsError && (
            <div className="fetch-error-inline">
              <p className="error">Lista non caricata: {itemsError}</p>
              <button type="button" className="retry-btn" onClick={() => loadItems(tenantId)}>Riprova</button>
            </div>
          )}
          {!items && !itemsError && <p className="muted">Caricamento…</p>}
          {items && items.length === 0 && <p className="muted center">Nessun lavoro pubblicato ancora.</p>}
          <div className="task-list">
            {items?.map((it) => (
              <button key={it.slug} type="button" className="preview-row" onClick={() => setSlug(it.slug)}>
                <span className="preview-row-icon">{TIPO_ICON[it.tipo] ?? '📦'}</span>
                <span className="preview-row-body">
                  <strong className="preview-row-title">{it.titolo}</strong>
                  <small className="muted">
                    {fmtDateShort(it.updatedAt)}
                    {agentLabel(it.agente) ? ` · ${agentLabel(it.agente)}` : ''}
                    {it.taskId ? ` · task ${String(it.taskId).slice(0, 8)}` : ''}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </main>
      </>
    );
  }

  // ---- Home: card per business ----
  return (
    <>
      <header className="topbar">
        <button className="back" onClick={onBack}>←</button>
        <h1>🖼 Vetrina lavori</h1>
      </header>
      <main className="page">
        {groupsError && (
          <div className="fetch-error-inline">
            <p className="error">Elenco non caricato: {groupsError}</p>
            <button type="button" className="retry-btn" onClick={loadGroups}>Riprova</button>
          </div>
        )}
        {tenantsError && !tenants?.length && (
          <p className="muted">Nomi/colori business non disponibili: {tenantsError}</p>
        )}
        {!groups && !groupsError && <p className="muted">Caricamento…</p>}
        {groups && groups.length === 0 && <p className="muted center">Nessun lavoro pubblicato ancora, in nessun business.</p>}
        <div className="cards">
          {groups?.map((g) => {
            const meta = tenantMeta(g.tenantId);
            const last = lastUpdateOf(g.items);
            return (
              <button key={g.tenantId} className="card" style={{ '--accent': meta?.color }} onClick={() => openTenant(g.tenantId)}>
                <span className="card-icon">{meta?.icon ?? '📦'}</span>
                <span className="card-body">
                  <strong>{g.tenantName}</strong>
                  <small>{g.items.length} lavor{g.items.length === 1 ? 'o' : 'i'}</small>
                  <small className="muted">Ultimo aggiornamento: {fmtDateShort(last)}</small>
                </span>
              </button>
            );
          })}
        </div>
      </main>
    </>
  );
}
