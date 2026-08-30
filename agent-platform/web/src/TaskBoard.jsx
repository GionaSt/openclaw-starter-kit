import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiJson, canManage, openWs } from './api.js';

// Board task reimpaginata (task UX b3861fb9): una sola lista mobile-first con
// filtri per stato invece di 7 colonne kanban affiancate (illeggibili su
// telefono). Vista compatta di default per ogni task — titolo breve + priorità
// + stato — che si espande al tap per mostrare descrizione, note, dipendenze,
// fase di review e i controlli di gestione.
//
// review_manager/review_ceo: quality gate a due livelli (task board 539c05b9)
// prima del done — la task consegnata dall'operativo passa dal manager (o
// salta il livello se il reparto non ne ha uno) e poi dal CEO del tenant.
const STATUSES = [
  { id: 'todo', label: 'Da fare', badge: '📋 Da fare', group: 'aperte' },
  { id: 'in_progress', label: 'In corso', badge: '⚙️ In corso', group: 'aperte' },
  { id: 'review_manager', label: 'Review manager', badge: '🧭 Review manager', group: 'review' },
  { id: 'review_ceo', label: 'Review CEO', badge: '🌟 Review CEO', group: 'review' },
  { id: 'needs_input', label: 'Serve input', badge: '⏸️ Serve input', group: 'input' },
  { id: 'ready_for_owner', label: 'Pronta per Owner', badge: '👤 Pronta per Owner', group: 'input' },
  { id: 'revisione', label: 'Revisione', badge: '🔁 Revisione', group: 'review' },
  { id: 'done', label: 'Fatte', badge: '✅ Fatta', group: 'chiuse' },
  { id: 'archived', label: 'Archiviate', badge: '🗄️ Archiviata', group: 'archivio' },
];
const STATUS_BY_ID = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

// Filtri di stato mostrati come chip (una sola riga scrollabile, mobile-first).
// "Attive" = tutto ciò che non è chiuso (default: è quello che interessa a
// colpo d'occhio); gli altri raggruppano gli stati affini del quality gate.
const FILTERS = [
  { id: 'attive', label: 'Attive', match: (t) => !['done', 'archived'].includes(t.status) },
  { id: 'todo', label: 'Da fare', match: (t) => t.status === 'todo' },
  { id: 'in_progress', label: 'In corso', match: (t) => t.status === 'in_progress' },
  { id: 'review', label: 'In review', match: (t) => ['review_manager', 'review_ceo', 'revisione'].includes(t.status) },
  { id: 'needs_input', label: 'Serve input', match: (t) => t.status === 'needs_input' },
  { id: 'ready_for_owner', label: 'Pronte per me', match: (t) => t.status === 'ready_for_owner' },
  { id: 'done', label: 'Fatte', match: (t) => t.status === 'done' },
  { id: 'archived', label: 'Archiviate', match: (t) => t.status === 'archived' },
  { id: 'tutte', label: 'Tutte', match: () => true },
];

const URGENCIES = [
  { id: 'bassa', label: 'Bassa' },
  { id: 'media', label: 'Media' },
  { id: 'alta', label: 'Alta' },
  { id: 'critica', label: 'Critica' },
];
const URGENCY_RANK = { bassa: 0, media: 1, alta: 2, critica: 3 };

// Card singola: compatta di default (urgenza + titolo + stato), si espande al
// tap. Descrizione, note, dipendenze e fase review vivono solo nell'espansione.
function TaskRow({ task, tasks, tenant, manage, onPatch, forceOpen }) {
  const [open, setOpen] = useState(false);
  // Apertura diretta dal feed Attività (task board 31797bb5): un tap su un
  // evento porta qui con la task da espandere subito, senza richiedere un
  // secondo tap dell'utente.
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  const st = STATUS_BY_ID[task.status] ?? { label: task.status, badge: task.status };
  const openBlockers = (task.blockedBy ?? [])
    .map((id) => tasks.find((x) => x.id === id))
    .filter((dep) => dep && !['done', 'archived'].includes(dep.status));
  return (
    <article id={`task-row-${task.id}`} className={`task-row status-${task.status}`} style={{ '--accent': tenant.color }}>
      <button type="button" className="task-row-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`urgency-badge urgency-${task.urgency ?? 'media'}`}>{task.urgency ?? 'media'}</span>
        <span className="task-row-title">{task.title}</span>
        <span className="task-status-badge">{st.badge}</span>
        {openBlockers.length > 0 && <span className="task-blocked-dot" title={`bloccata da ${openBlockers.length} task`}>⛔</span>}
        <span className="task-row-caret muted">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="task-row-detail">
          {task.description && <p className="task-desc">{task.description}</p>}
          {task.assignedTo && (
            <small className="working-on">
              🤖 {task.status === 'in_progress' ? 'in lavorazione' : 'assegnata a'}: {task.assignedTo.replace('agent:', '')}
            </small>
          )}
          {openBlockers.length > 0 && (
            <small className="blocked-badge">⛔ bloccata da {openBlockers.length} task: {openBlockers.map((d) => d.title).join(', ')}</small>
          )}
          {(task.status === 'review_manager' || task.status === 'review_ceo') && (
            <small className="muted">
              🔍 in review: livello {task.status === 'review_manager' ? 'manager' : 'CEO'}
              {(task.managerRejections || task.ceoRejections)
                ? ` · bocciature manager ${task.managerRejections ?? 0}/2, CEO ${task.ceoRejections ?? 0}/2`
                : ''}
            </small>
          )}
          {task.status === 'revisione' && task.gateRejection && (
            <small className="muted">❌ bocciata dal {task.gateRejection.by === 'manager' ? 'manager' : 'CEO'}: {task.gateRejection.note}</small>
          )}
          {task.status === 'revisione' && !task.gateRejection && task.revisionNote && <small className="muted">🔁 revisione: {task.revisionNote}</small>}
          {task.note && <small className="muted">📝 {task.note}</small>}
          <small className="muted">
            {task.createdBy?.startsWith('agent:') ? '🤖 agente' : '👤 utente'} · aggiornata {new Date(task.updatedAt).toLocaleString('it-IT')}
          </small>
          {manage && (
            <div className="task-controls">
              <select
                value={task.status}
                onChange={(e) => {
                  const status = e.target.value;
                  if (status === 'revisione') {
                    const note = window.prompt('Nota di revisione per l\'agente (cosa correggere/integrare):', task.revisionNote ?? '');
                    if (note === null) return;
                    onPatch(task, { status, note });
                  } else {
                    onPatch(task, { status });
                  }
                }}
                aria-label="Cambia stato"
              >
                {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              <select value={task.urgency ?? 'media'} onChange={(e) => onPatch(task, { urgency: e.target.value })} aria-label="Cambia urgenza">
                {URGENCIES.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
              </select>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function TaskBoard({ user, tenant, focusTaskId, onConsumeFocus, presetFilter, onConsumeFilter }) {
  const [tasks, setTasks] = useState(null);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [urgency, setUrgency] = useState('media');
  const [filter, setFilter] = useState(presetFilter ?? 'attive');
  const manage = canManage(user);
  // Arrivo dalla progress line "fatte/in coda" (task board 920d5040): il tap
  // seleziona già il filtro giusto (stesso pattern di focusTaskId/forceOpen).
  useEffect(() => {
    if (!presetFilter) return;
    setFilter(presetFilter);
    onConsumeFilter?.();
  }, [presetFilter, onConsumeFilter]);
  // Task aperta da fuori (feed Attività): mostra "Tutte" (la task potrebbe non
  // essere tra le "Attive", es. è già "done") e scrolla/espande alla riga giusta.
  const focusHandled = useRef(null);
  useEffect(() => {
    if (focusTaskId) setFilter('tutte');
  }, [focusTaskId]);
  useEffect(() => {
    if (!focusTaskId || !tasks || focusHandled.current === focusTaskId) return;
    const el = document.getElementById(`task-row-${focusTaskId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    focusHandled.current = focusTaskId;
    onConsumeFocus?.();
  }, [focusTaskId, tasks, onConsumeFocus]);

  useEffect(() => {
    apiJson(`/api/tasks?tenantId=${tenant.id}`).then(setTasks).catch((e) => setError(e.message));
    return openWs((msg) => {
      if (msg.type === 'task' && msg.task.tenantId === tenant.id) {
        setTasks((prev) => {
          if (!prev) return prev;
          const rest = prev.filter((t) => t.id !== msg.task.id);
          return [...rest, msg.task];
        });
      }
    });
  }, [tenant.id]);

  async function create(e) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const task = await apiJson('/api/tasks', {
        method: 'POST',
        body: { tenantId: tenant.id, title, description, urgency },
      });
      setTasks((prev) => (prev?.some((t) => t.id === task.id) ? prev : [...(prev ?? []), task]));
      setTitle('');
      setDescription('');
      setUrgency('media');
      setShowForm(false);
    } catch (err) {
      setError(err.message);
    }
  }

  async function patch(task, body) {
    try {
      const updated = await apiJson(`/api/tasks/${task.id}?tenantId=${tenant.id}`, { method: 'PATCH', body });
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (err) {
      setError(err.message);
    }
  }

  const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];
  const visible = useMemo(() => (tasks ?? [])
    .filter((t) => active.match(t))
    .sort((a, b) => {
      const d = (URGENCY_RANK[b.urgency] ?? 1) - (URGENCY_RANK[a.urgency] ?? 1);
      return d !== 0 ? d : (a.updatedAt < b.updatedAt ? 1 : -1);
    }), [tasks, active]);
  const countFor = (f) => (tasks ?? []).filter((t) => f.match(t)).length;

  return (
    <main className="page">
      {error && <p className="error">{error}</p>}
      {manage && (
        <div className="board-actions">
          <button className="btn-accent" style={{ '--accent': tenant.color }} onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Annulla' : '＋ Nuova task'}
          </button>
        </div>
      )}
      {showForm && (
        <form className="card task-form" style={{ '--accent': tenant.color }} onSubmit={create}>
          <input value={title} placeholder="Titolo" autoFocus onChange={(e) => setTitle(e.target.value)} />
          <textarea value={description} rows={2} placeholder="Descrizione (opzionale)" onChange={(e) => setDescription(e.target.value)} />
          <label className="urgency-row">
            Urgenza
            <select value={urgency} onChange={(e) => setUrgency(e.target.value)}>
              {URGENCIES.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </label>
          <button className="btn-accent" type="submit" disabled={!title.trim()}>Crea</button>
        </form>
      )}

      <div className="task-filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`filter-chip ${filter === f.id ? 'active' : ''}`}
            style={{ '--accent': tenant.color }}
            onClick={() => setFilter(f.id)}
          >
            {f.label} <span className="filter-count">{countFor(f)}</span>
          </button>
        ))}
      </div>

      {!tasks && !error && <p className="muted">Caricamento…</p>}
      {tasks && visible.length === 0 && <p className="muted center">Nessuna task in «{active.label}».</p>}
      <div className="task-list">
        {visible.map((t) => (
          <TaskRow key={t.id} task={t} tasks={tasks} tenant={tenant} manage={manage} onPatch={patch} forceOpen={t.id === focusTaskId} />
        ))}
      </div>
    </main>
  );
}
