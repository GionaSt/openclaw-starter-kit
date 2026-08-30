import React, { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { apiJson, canManage } from './api.js';

// Wiki di conoscenza del business: pagine markdown, INDEX + pagine di dominio,
// versionate con git lato server (ogni salvataggio è un commit, con cronologia
// e ripristino). Master/detail semplice: lista pagine -> pagina aperta.
export default function Wiki({ user, tenant }) {
  const [pages, setPages] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [newPageName, setNewPageName] = useState('');
  const [showNew, setShowNew] = useState(false);
  const manage = canManage(user);

  function loadPages() {
    apiJson(`/api/tenants/${tenant.id}/wiki`).then(setPages).catch((e) => setError(e.message));
  }
  useEffect(loadPages, [tenant.id]);

  function open(page) {
    setSelected(page);
    setEditing(false);
    setShowHistory(false);
    setHistory(null);
    setError(null);
    apiJson(`/api/tenants/${tenant.id}/wiki/${encodeURIComponent(page)}`)
      .then((d) => { setContent(d.content); setDraft(d.content); })
      .catch((e) => setError(e.message));
  }

  async function save() {
    setSaving(true);
    try {
      const result = await apiJson(`/api/tenants/${tenant.id}/wiki/${encodeURIComponent(selected)}`, {
        method: 'PUT',
        body: { content: draft },
      });
      setContent(draft);
      setEditing(false);
      loadPages();
      setError(result.warning ?? null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function createPage(e) {
    e.preventDefault();
    const name = newPageName.trim();
    if (!name) return;
    const page = name.endsWith('.md') ? name : `${name}.md`;
    try {
      await apiJson(`/api/tenants/${tenant.id}/wiki/${encodeURIComponent(page)}`, {
        method: 'PUT',
        body: { content: `# ${page.replace(/\.md$/, '')}\n\n` },
      });
      setNewPageName('');
      setShowNew(false);
      loadPages();
      open(page);
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleHistory() {
    setShowHistory((v) => !v);
    if (!history) {
      apiJson(`/api/tenants/${tenant.id}/wiki/${encodeURIComponent(selected)}/history`)
        .then(setHistory)
        .catch((e) => setError(e.message));
    }
  }

  async function rollback(hash) {
    if (!window.confirm('Ripristinare questa versione? Crea un nuovo commit con quel contenuto (niente si perde).')) return;
    try {
      await apiJson(`/api/tenants/${tenant.id}/wiki/${encodeURIComponent(selected)}/rollback`, {
        method: 'POST',
        body: { commit: hash },
      });
      setHistory(null);
      open(selected);
    } catch (err) {
      setError(err.message);
    }
  }

  // ---- Vista di dettaglio pagina ----
  if (selected) {
    return (
      <main className="page">
        <div className="wiki-detail-head">
          <button className="back" onClick={() => setSelected(null)}>←</button>
          <strong className="wiki-page-name">{selected}</strong>
          {manage && !editing && (
            <button className="btn-accent" style={{ '--accent': tenant.color }} onClick={() => setEditing(true)}>Modifica</button>
          )}
          <button onClick={toggleHistory}>{showHistory ? 'Nascondi cronologia' : 'Cronologia'}</button>
        </div>
        {error && <p className="error">{error}</p>}
        {showHistory && (
          <ul className="wiki-history">
            {history === null && <li className="muted">Caricamento…</li>}
            {history?.length === 0 && <li className="muted">Nessuna cronologia.</li>}
            {history?.map((h) => (
              <li key={h.hash}>
                <span className="muted">{new Date(h.date).toLocaleString('it-IT')}</span> — {h.message}
                {manage && <button onClick={() => rollback(h.hash)}>Ripristina</button>}
              </li>
            ))}
          </ul>
        )}
        {editing ? (
          <>
            <textarea className="wiki-editor" value={draft} onChange={(e) => setDraft(e.target.value)} rows={18} />
            <div className="wiki-editor-actions">
              <button className="btn-accent" style={{ '--accent': tenant.color }} onClick={save} disabled={saving}>
                {saving ? 'Salvo…' : 'Salva'}
              </button>
              <button onClick={() => { setDraft(content); setEditing(false); }}>Annulla</button>
            </div>
          </>
        ) : (
          <div className="wiki-render">
            <ReactMarkdown>{content || '_pagina vuota_'}</ReactMarkdown>
          </div>
        )}
      </main>
    );
  }

  // ---- Lista pagine ----
  return (
    <main className="page">
      {error && <p className="error">{error}</p>}
      {manage && (
        <div className="board-actions">
          <button className="btn-accent" style={{ '--accent': tenant.color }} onClick={() => setShowNew((v) => !v)}>
            {showNew ? 'Annulla' : '＋ Nuova pagina'}
          </button>
        </div>
      )}
      {showNew && (
        <form className="card task-form" style={{ '--accent': tenant.color }} onSubmit={createPage}>
          <input value={newPageName} placeholder="nome-pagina.md" autoFocus onChange={(e) => setNewPageName(e.target.value)} />
          <button className="btn-accent" type="submit" disabled={!newPageName.trim()}>Crea</button>
        </form>
      )}
      {!pages && !error && <p className="muted">Caricamento…</p>}
      {pages?.length === 0 && <p className="muted center">Wiki vuota.</p>}
      <div className="cards">
        {pages?.map((p) => (
          <button key={p.page} className="card" style={{ '--accent': tenant.color }} onClick={() => open(p.page)}>
            <span className="card-icon">{p.page === 'INDEX.md' ? '🗺️' : '📄'}</span>
            <span className="card-body">
              <strong>{p.page}</strong>
              <small className="muted">{p.words} parole{p.words > 2000 ? ' · oltre target, valuta di dividerla' : ''}</small>
            </span>
          </button>
        ))}
      </div>
    </main>
  );
}
