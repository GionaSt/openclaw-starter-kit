import React, { useEffect, useMemo, useState } from 'react';
import { apiJson, openWs } from './api.js';
import { MODEL_LABELS } from './lib/modelLabels.js';

// Vista "Organigramma" (task board 2cc8ade2, parte 2/3 di 09c9e256): albero
// gerarchico degli agenti del tenant, costruito lato client dal campo
// managerId restituito da GET /api/tenants/:id/organigramma (parte 1/3,
// 60afee6e). Nessun elenco hardcoded: la forma dell'albero segue solo i dati.

const RUN_STATUS_LABELS = {
  running: 'In esecuzione',
  resumed: 'In esecuzione (ripresa)',
  interrupted: 'Interrotta',
  paused: 'In pausa',
  stopped: 'Fermata',
  completed: 'Completata',
  failed: 'Fallita',
  queued: 'In coda',
};

const timeFmt = (iso) => new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// Raggruppa i figli per managerId. Root = managerId assente OPPURE che non
// risolve a nessun agente della lista (robustezza contro dati incoerenti):
// possono esserci più root (es. platform: ceo-platform e cto-platform).
function groupByManager(agents) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const childrenOf = new Map();
  agents.forEach((a) => {
    const key = a.managerId && byId.has(a.managerId) ? a.managerId : null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(a);
  });
  return { byId, childrenOf, roots: childrenOf.get(null) ?? [] };
}

function OrgNode({ agent, childrenOf, collapsed, onToggle, onSelect, accent }) {
  const kids = childrenOf.get(agent.id) ?? [];
  const isCollapsed = collapsed.has(agent.id);
  return (
    <div className="org-node">
      <div className="org-node-row" style={{ '--accent': accent }}>
        {kids.length > 0 ? (
          <button
            type="button"
            className="org-caret-btn"
            onClick={() => onToggle(agent.id)}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? `espandi ${agent.name}` : `comprimi ${agent.name}`}
          >
            {isCollapsed ? '▸' : '▾'}
          </button>
        ) : (
          <span className="org-caret-spacer" aria-hidden="true" />
        )}
        <button type="button" className="org-node-btn" onClick={() => onSelect(agent.id)}>
          <span className="org-node-name">
            {agent.name}
            {agent.state === 'in_run' && <span title="in esecuzione ora">🟢</span>}
            {agent.openTasks > 0 && <span className="tab-badge">{agent.openTasks}</span>}
          </span>
          <small className="muted">{agent.role} · {MODEL_LABELS[agent.model] ?? agent.model}</small>
        </button>
      </div>
      {kids.length > 0 && !isCollapsed && (
        <div className="org-children">
          {kids.map((child) => (
            <OrgNode
              key={child.id}
              agent={child}
              childrenOf={childrenOf}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelect={onSelect}
              accent={accent}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Organigramma({ tenant, onOpenChat }) {
  const [agents, setAgents] = useState(null);
  const [error, setError] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      apiJson(`/api/tenants/${tenant.id}/organigramma`)
        .then((d) => { if (!cancelled) { setAgents(d); setError(null); } })
        .catch((e) => { if (!cancelled) setError(e.message); });
    };
    load();
    // Aggiorna badge live e conteggio task su eventi ws del tenant, invece di
    // affidarsi solo al fetch iniziale (stesso pattern di TenantHome/Activity).
    const stopWs = openWs((msg) => {
      if (
        (msg.type === 'run' && msg.run?.tenantId === tenant.id)
        || (msg.type === 'agent_session' && msg.session?.tenantId === tenant.id)
        || (msg.type === 'task' && msg.task?.tenantId === tenant.id)
      ) load();
    });
    return () => { cancelled = true; stopWs(); };
  }, [tenant.id]);

  const { byId, childrenOf, roots } = useMemo(() => groupByManager(agents ?? []), [agents]);
  const selected = selectedId ? byId.get(selectedId) : null;
  const manager = selected?.managerId ? byId.get(selected.managerId) : null;

  function toggle(id) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ---- Dettaglio agente ----
  if (selected) {
    return (
      <main className="page">
        <div className="wiki-detail-head">
          <button className="back" onClick={() => setSelectedId(null)}>←</button>
          <strong className="wiki-page-name">{selected.name}</strong>
        </div>
        <div className="card org-detail-card" style={{ '--accent': tenant.color }}>
          <small className="muted">Ruolo</small>
          <p>{selected.role}</p>
          <small className="muted">Modello</small>
          <p>{MODEL_LABELS[selected.model] ?? selected.model}</p>
          <small className="muted">Manager</small>
          <p>{manager ? manager.name : (selected.managerId ? selected.managerId : 'nessuno (radice)')}</p>
          <small className="muted">Stato</small>
          <p>{selected.state === 'in_run' ? '🟢 in esecuzione' : '⚪ inattivo'}</p>
          <small className="muted">Task aperte</small>
          <p>{selected.openTasks}</p>
          <small className="muted">Ultima run</small>
          {selected.lastRun ? (
            <p>
              {selected.lastRun.runTitle} — {RUN_STATUS_LABELS[selected.lastRun.status] ?? selected.lastRun.status}
              <br />
              <span className="muted">{timeFmt(selected.lastRun.updatedAt || selected.lastRun.startedAt)}</span>
            </p>
          ) : (
            <p className="muted">Nessuna run registrata.</p>
          )}
          <button className="btn-accent" style={{ '--accent': tenant.color }} onClick={() => onOpenChat(selected)}>
            💬 Apri chat
          </button>
        </div>
      </main>
    );
  }

  // ---- Albero ----
  return (
    <main className="page">
      {error && <p className="error">{error}</p>}
      {!agents && !error && <p className="muted">Caricamento…</p>}
      {agents?.length === 0 && <p className="muted center">Nessun agente assegnato al tuo utente.</p>}
      <div className="org-tree">
        {roots.map((a) => (
          <OrgNode
            key={a.id}
            agent={a}
            childrenOf={childrenOf}
            collapsed={collapsed}
            onToggle={toggle}
            onSelect={setSelectedId}
            accent={tenant.color}
          />
        ))}
      </div>
    </main>
  );
}
