import React, { useEffect, useMemo, useState } from 'react';
import { apiJson, canManage, openWs } from './api.js';

const STATUS_LABEL = {
  draft: 'Bozza', ready_for_review: 'Pronto per review', approved: 'Approvato', published: 'Pubblicato', archived: 'Archiviato',
};

export default function Deliverables({ user, tenant }) {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const manage = canManage(user);
  const load = () => apiJson(`/api/artifacts?tenantId=${tenant.id}${status ? `&status=${status}` : ''}`)
    .then((data) => { setItems(data); setError(''); })
    .catch((err) => setError(err.message));

  useEffect(() => {
    load();
    return openWs((msg) => {
      if (msg.type === 'task' && msg.task.tenantId === tenant.id) load();
    });
  }, [tenant.id, status]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const item of items) {
      const key = item.resultType || 'general';
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()];
  }, [items]);

  async function open(item) {
    try { setSelected(await apiJson(`/api/artifacts/${item.id}?tenantId=${tenant.id}`)); }
    catch (err) { setError(err.message); }
  }
  async function setArtifactStatus(id, next) {
    try {
      await apiJson(`/api/artifacts/${id}/status?tenantId=${tenant.id}`, { method: 'PATCH', body: { status: next } });
      await load();
      if (selected?.artifact.id === id) setSelected(await apiJson(`/api/artifacts/${id}?tenantId=${tenant.id}`));
    } catch (err) { setError(err.message); }
  }

  return (
    <section className="deliverables-page">
      <div className="section-head">
        <div><h2>Deliverables</h2><p className="muted">Artefatti verificabili, versionati e collegati alle task.</p></div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filtra stato deliverable">
          <option value="">Tutti gli stati</option>
          {Object.entries(STATUS_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>
      {error && <p className="form-error">{error}</p>}
      {!items.length && <p className="empty-state">Nessun deliverable ancora prodotto per questo business.</p>}
      {groups.map(([type, artifacts]) => (
        <div className="deliverable-group" key={type}>
          <h3>{type.replaceAll('_', ' ')}</h3>
          {artifacts.map((artifact) => (
            <article className="deliverable-card" key={artifact.id}>
              <button type="button" className="deliverable-main" onClick={() => open(artifact)}>
                <strong>{artifact.title}</strong>
                <span>{STATUS_LABEL[artifact.status] ?? artifact.status} · {artifact.riskLevel} · v{artifact.version}</span>
                <small>{artifact.executiveSummary || 'Nessun executive summary'}</small>
              </button>
              {manage && artifact.status === 'ready_for_review' && (
                <button type="button" className="secondary" onClick={() => setArtifactStatus(artifact.id, 'approved')}>Approva</button>
              )}
              {manage && artifact.status === 'approved' && (
                <button type="button" className="secondary" onClick={() => setArtifactStatus(artifact.id, 'published')}>Pubblica</button>
              )}
            </article>
          ))}
        </div>
      ))}
      {selected && (
        <div className="deliverable-modal-backdrop" role="presentation" onClick={() => setSelected(null)}>
          <article className="deliverable-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="back" onClick={() => setSelected(null)}>←</button>
            <h2>{selected.artifact.title}</h2>
            <p className="muted">{selected.artifact.resultType} · {selected.artifact.riskLevel} · v{selected.artifact.version}</p>
            <p>{selected.artifact.executiveSummary}</p>
            <p className={selected.artifact.validation?.passed ? 'validation-ok' : 'form-error'}>
              {selected.artifact.validation?.passed ? '✓ Validazione superata' : '⚠ Validazione incompleta'}
            </p>
            {selected.content && <pre className="deliverable-content">{selected.content}</pre>}
            {selected.artifact.externalUrl && <a href={selected.artifact.externalUrl} target="_blank" rel="noreferrer">Apri output esterno</a>}
          </article>
        </div>
      )}
    </section>
  );
}
