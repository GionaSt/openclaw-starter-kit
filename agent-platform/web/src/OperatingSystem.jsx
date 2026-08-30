import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { apiJson, canManage, openWs } from './api.js';
import { ACCEPT_ATTR, uploadAttachment, AttachmentChip } from './lib/attachmentsUi.jsx';

const SECTIONS = [
  ['projects', 'Progetti'],
  ['reports', 'Report'],
  ['setup', 'Configurazione'],
];

const STEP_LABELS = {
  proposed: 'Proposta', active: 'In corso', pending: 'In coda', completed: 'Completata',
  blocked: 'Bloccata', needs_approval: 'Da approvare', needs_premium_review: 'Quality gate premium',
  deferred: 'Rinviata (attende risposta)', failed: 'Fallita',
};

function ModelSelect({ models, value, onChange, disabled = false }) {
  return <select className="os-model-select" value={value || ''} onChange={(event) => onChange(event.target.value)} disabled={disabled}>{models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select>;
}

// ---- Vista a fila (flusso lineare 2026-08-29) ------------------------------
// Stessa priorita' del backend (v2-executor): queueOrder poi createdAt.
function projectPriority(a, b) {
  const ka = Number.isFinite(Number(a?.queueOrder)) ? Number(a.queueOrder) : Number.MAX_SAFE_INTEGER;
  const kb = Number.isFinite(Number(b?.queueOrder)) ? Number(b.queueOrder) : Number.MAX_SAFE_INTEGER;
  if (ka !== kb) return ka - kb;
  return String(a?.createdAt ?? '').localeCompare(String(b?.createdAt ?? ''));
}

// Riassume in UNA riga leggibile lo stato reale del progetto nella fila:
// cosa sta facendo, perché è fermo, cosa aspetta da Owner.
function projectQueueSummary(project) {
  const steps = project.steps ?? [];
  const total = steps.length;
  const completed = steps.filter((s) => s.status === 'completed').length;
  const deferred = steps.filter((s) => s.status === 'deferred');
  const exec = project.execution?.status ?? 'idle';
  const currentStep = steps.find((s) => s.id === project.execution?.currentStepId || s.status === 'active');
  const base = { total, completed, deferredCount: deferred.length, pct: total ? Math.round((completed / total) * 100) : 0 };
  if (project.status === 'discovery') return { ...base, tone: 'muted', line: 'Piano in definizione nella chat', live: false };
  if (project.status === 'failed') return { ...base, tone: 'blocked', line: '⛔ Fallito: serve un tuo intervento', live: false };
  if (project.status === 'completed') return { ...base, tone: 'done', line: '✅ Completato', live: false };
  if (['running', 'premium_quality_running'].includes(exec)) {
    return { ...base, tone: 'running', live: true, line: `▶ Sta lavorando: ${currentStep?.label ?? 'task in corso'}`, extra: deferred.length ? `⏭️ ${deferred.length} task saltat${deferred.length === 1 ? 'a' : 'e'}: riprendono alla tua risposta` : null };
  }
  if (['needs_input', 'waiting_approval'].includes(exec)) {
    return { ...base, tone: 'blocked', live: false, line: deferred.length ? `✋ Lasciato a metà: ${deferred.length} task aspettano una TUA risposta` : '✋ Fermo: aspetta una TUA risposta' };
  }
  if (exec === 'paused') {
    return { ...base, tone: project.execution?.pausedReason === 'preempted' ? 'waiting' : 'muted', live: false, line: project.execution?.pausedReason === 'preempted' ? '⏸ In pausa: precedenza a un progetto prima in fila (riparte da solo)' : '⏸ In pausa' };
  }
  if (exec === 'error') {
    const retryAt = project.execution?.nextRetryAt ? new Date(project.execution.nextRetryAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : null;
    return { ...base, tone: 'blocked', live: false, line: `⚠️ Errore, ritenta da solo${retryAt ? ` alle ${retryAt}` : ''}` };
  }
  if (project.status === 'needs_premium_review') return { ...base, tone: 'waiting', live: false, line: '🧪 In attesa del quality gate premium' };
  if (exec === 'queued') return { ...base, tone: 'waiting', live: false, line: `🕐 ${project.execution?.queueReason ?? 'In coda, parte appena tocca a lui'}` };
  return { ...base, tone: 'muted', live: false, line: project.workflowLabel ?? '' };
}

function ProjectQueueCard({ project, position, onOpen }) {
  const info = projectQueueSummary(project);
  return (
    <button className={`os-queue-card os-tone-${info.tone}`} onClick={onOpen}>
      <span className="os-queue-pos">{project.status === 'completed' ? '✅' : position ? `${position}º` : '·'}</span>
      <span className="os-queue-body">
        <strong>{project.title}</strong>
        <span className="os-progress"><span className={`os-progress-fill os-fill-${info.tone}`} style={{ width: `${info.pct}%` }} /></span>
        <small className="os-queue-line">{info.live && <span className="os-live-dot" />}{info.line}{info.total ? ` · ${info.completed}/${info.total} task` : ''}</small>
        {info.extra && <small className="os-queue-line os-queue-extra">{info.extra}</small>}
      </span>
    </button>
  );
}

// Esportata per i check di rendering (server/scripts/v2-attachments-ui-check.mjs):
// la chat di progetto e' l'unico punto in cui gli allegati compaiono in UI.
export function ChatWorkspace({ title, subtitle, status, messages, message, setMessage, sending, thinking = false, sendingLabel = 'Il modello sta pensando…', error, placeholder, onSubmit, onBack, drawerLabel, drawer, archived, headerActions = null, attachments = null, onAddFiles = null, onRemoveAttachment = null }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
  // Allegati abilitati solo se il contenitore passa i callback (chat progetto V2);
  // le altre chat (report) restano invariate.
  const attachEnabled = Boolean(onAddFiles) && Array.isArray(attachments);
  const pending = attachEnabled ? attachments : [];
  const uploading = pending.some((att) => att.status === 'uploading');
  const readyCount = pending.filter((att) => att.status === 'done').length;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, sending]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const close = (event) => { if (event.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [drawerOpen]);

  function composerKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <div className="os-chat-workspace">
      <header className="topbar os-chat-topbar">
        <button className="back" onClick={onBack}>←</button>
        <div className="os-chat-heading">
          <h1>{title}</h1>
          <small>{subtitle}</small>
        </div>
        <span className="topbar-right os-chat-actions">
          {headerActions}
          <span className={`os-status os-${status}`}>{status}</span>
          <button className="back os-drawer-trigger" onClick={() => setDrawerOpen(true)} title={drawerLabel}>☰</button>
        </span>
      </header>

      <main
        className={`chat os-chat-thread ${dragOver ? 'drag-over' : ''}`}
        onDragOver={attachEnabled && !archived ? (event) => { event.preventDefault(); if (!dragOver) setDragOver(true); } : undefined}
        onDragLeave={attachEnabled && !archived ? (event) => { if (event.currentTarget === event.target) setDragOver(false); } : undefined}
        onDrop={attachEnabled && !archived ? (event) => {
          event.preventDefault();
          setDragOver(false);
          if (event.dataTransfer?.files?.length) onAddFiles(event.dataTransfer.files);
        } : undefined}
      >
        {messages.map((item) => (
          <div key={item.id} className={`bubble ${item.role === 'user' ? 'user' : 'assistant'}`}>
            {item.role === 'assistant' ? <div className="md"><ReactMarkdown>{item.text}</ReactMarkdown></div> : item.text}
            {/* Allegati persistiti (task B3): restano consultabili riaprendo il
                progetto, perché arrivano dallo stato server del progetto. */}
            {Array.isArray(item.attachments) && item.attachments.length > 0 && (
              <div className="attachments">
                {item.attachments.map((att, index) => <AttachmentChip key={att.id ?? att.stored ?? index} att={att} />)}
              </div>
            )}
          </div>
        ))}
        {(sending || thinking) && <div className="bubble assistant os-thinking" role="status" aria-live="polite"><span className="os-thinking-dots"><i /><i /><i /></span><strong>{sendingLabel}</strong></div>}
        {error && <div className="bubble assistant os-chat-error" role="alert">{error}</div>}
        <div ref={bottomRef} />
        {dragOver && <div className="drop-overlay">Rilascia i file per allegarli</div>}
      </main>

      {!archived && (
        <form className="composer os-v2-composer" onSubmit={onSubmit}>
          {attachEnabled && (
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPT_ATTR}
              style={{ display: 'none' }}
              onChange={(event) => { if (event.target.files?.length) onAddFiles(event.target.files); event.target.value = ''; }}
            />
          )}
          {pending.length > 0 && (
            <div className="composer-attachments">
              {pending.map((att) => (
                <AttachmentChip key={att.localId} att={att} onRemove={() => onRemoveAttachment?.(att.localId)} />
              ))}
            </div>
          )}
          <div className="composer-row">
            {attachEnabled && (
              <button
                type="button"
                className="attach"
                title="Allega un file (immagine, PDF, testo, markdown — max 20MB)"
                onClick={() => fileInputRef.current?.click()}
              >📎</button>
            )}
            <textarea rows="1" value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={composerKeyDown} placeholder={placeholder} disabled={sending} />
            <button className="os-send-button" disabled={(!message.trim() && readyCount === 0) || uploading || sending} title={uploading ? 'Attendi il caricamento degli allegati' : 'Invia'}>➤</button>
          </div>
          <small className="muted">
            Invio per mandare, Shift+Invio per andare a capo.
            {attachEnabled && ' Trascina un file nella chat o usa 📎 per allegarlo.'}
          </small>
        </form>
      )}

      {drawerOpen && (
        <div className="os-drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDrawerOpen(false); }}>
          <aside className="os-context-drawer" role="dialog" aria-modal="true" aria-label={drawerLabel}>
            <header className="os-drawer-head">
              <div><span className="os-kicker">Contesto operativo</span><h2>{drawerLabel}</h2></div>
              <button className="back" onClick={() => setDrawerOpen(false)}>×</button>
            </header>
            <div className="os-drawer-content">{drawer}</div>
          </aside>
        </div>
      )}
    </div>
  );
}

function ValueList({ items, empty = 'Da definire in chat' }) {
  return items?.length ? <ul className="os-compact-list">{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted">{empty}</p>;
}

function ProjectDetail({ tenant, projectId, manage, onBack, onChanged }) {
  // Wrapper column: il banner di attesa (richiesta aperta su progetto in pausa)
  // vive FUORI da ChatWorkspace; senza un flex column il banner si comprimeva
  // e la chat perdeva lo spazio (flex:1 di .os-chat-workspace non si applicava).
  return <div className="os-project-view"><ProjectDetailView tenant={tenant} projectId={projectId} manage={manage} onBack={onBack} onChanged={onChanged} /></div>;
}

function ProjectDetailView({ tenant, projectId, manage, onBack, onChanged }) {
  const [project, setProject] = useState(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [lintContent, setLintContent] = useState('');
  const [lintResult, setLintResult] = useState(null);
  const [error, setError] = useState(null);
  const [resuming, setResuming] = useState(false);
  const [premiumReviewing, setPremiumReviewing] = useState(false);
  // Errore dell'ultimo tentativo di ripresa: separato da `error` perché load()
  // azzera quest'ultimo, mentre l'utente deve vedere il motivo del fallimento.
  const [resumeError, setResumeError] = useState(null);
  const [modelCatalog, setModelCatalog] = useState({ models: [], defaultModel: '' });
  const [skillCatalog, setSkillCatalog] = useState([]);
  // Allegati in composizione (task B3): ogni file parte subito verso lo storage
  // scopato al progetto; la chip mostra caricamento/errore/pronto ed è
  // rimovibile finché il messaggio non è partito.
  const [attachments, setAttachments] = useState([]);

  async function load() {
    try {
      setProject(await apiJson(`/api/v2/projects/${projectId}?tenantId=${tenant.id}`));
      setError(null);
    } catch (err) { setError(err.message); }
  }

  useEffect(() => { load(); }, [projectId]);
  useEffect(() => { apiJson('/api/v2/models').then(setModelCatalog).catch(() => {}); }, []);
  useEffect(() => { apiJson(`/api/v2/overview?tenantId=${tenant.id}`).then((data) => setSkillCatalog(data.skills ?? [])).catch(() => {}); }, [tenant.id]);
  useEffect(() => openWs((event) => { if (event.type === 'v2_project' && event.project?.id === projectId) setProject(event.project); }, load), [projectId]);
  // Mobile: tornando in foreground il WS può essere morto e aver perso broadcast.
  // Ricarica lo stato reale dal server (il turno Architect ormai gira lato server).
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [projectId]);
  // Rete di sicurezza: un WS half-open non emette 'close', il broadcast di fine
  // turno si perde e la chat resta su "sta pensando…". Finché l'Architect è
  // occupato si fa polling dello stato; si ferma da solo quando il turno chiude.
  useEffect(() => {
    if (!project?.architectBusy) return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [projectId, project?.architectBusy]);

  async function updateModels(body) {
    try { setProject(await apiJson(`/api/v2/projects/${projectId}/models?tenantId=${tenant.id}`, { method: 'PATCH', body })); }
    catch (err) { setError(err.message); }
  }

  // Gruppo e ordine di fila (flusso lineare): salvataggio al blur, endpoint
  // dedicati; la fila vera la applica l'executor lato server.
  async function updateQueuePlacement(field, value) {
    try {
      const endpoint = field === 'group' ? 'group' : 'queue-order';
      const body = field === 'group'
        ? { group: value.trim() || null }
        : { queueOrder: String(value).trim() === '' ? null : Number(value) };
      setProject(await apiJson(`/api/v2/projects/${projectId}/${endpoint}?tenantId=${tenant.id}`, { method: 'PATCH', body }));
      onChanged();
    } catch (err) { setError(err.message); }
  }

  async function toggleSkill(skillId) {
    const selected = new Set(project.skillIds ?? []);
    if (selected.has(skillId)) selected.delete(skillId); else selected.add(skillId);
    try { setProject(await apiJson(`/api/v2/projects/${projectId}/skills?tenantId=${tenant.id}`, { method: 'PATCH', body: { skillIds: [...selected] } })); }
    catch (err) { setError(err.message); }
  }

  // Fallback di ripresa (fix bug C, diagnosi 2026-08-15): visibile e attivo su
  // ogni progetto in paused/blocked. Se esiste una richiesta aperta il flusso
  // canonico e' /respond (il resume rifiuterebbe con 400): il bottone approva
  // la richiesta, cosi' il Riprendi funziona SEMPRE con un click.
  async function resumeProject() {
    if (resuming) return;
    setResuming(true);
    setResumeError(null);
    try {
      const openRequest = project?.requests?.find((request) => request.status === 'open');
      if (openRequest) {
        const updated = await apiJson(`/api/v2/projects/${projectId}/requests/${openRequest.id}/respond?tenantId=${tenant.id}`, { method: 'POST', body: { answer: 'Approva e riprendi (bottone Riprendi)' } });
        setProject(updated);
      } else {
        await apiJson(`/api/v2/projects/${projectId}/resume?tenantId=${tenant.id}`, { method: 'POST' });
        await load();
      }
      onChanged();
    } catch (err) {
      // load() azzera `error`: il motivo del fallimento va in resumeError,
      // mostrato sotto la topbar finché l'utente non riprova.
      setResumeError(err.message);
      await load();
    } finally { setResuming(false); }
  }

  async function runPremiumReview() {
    if (premiumReviewing) return;
    setPremiumReviewing(true);
    setError(null);
    try {
      await apiJson(`/api/v2/projects/${projectId}/premium-review?tenantId=${tenant.id}`, { method: 'POST' });
      await load();
      onChanged();
    } catch (err) { setError(err.message); }
    finally { setPremiumReviewing(false); }
  }

  async function pauseProject() {
    try { setProject(await apiJson(`/api/v2/projects/${projectId}/pause?tenantId=${tenant.id}`, { method: 'POST' })); }
    catch (err) { setError(err.message); }
  }

  // Upload allegati (task B3): endpoint scopato al progetto, così i file di
  // progetti diversi non si mescolano. Il server valida tipo e dimensione e
  // risponde con un errore leggibile, mostrato sulla chip del file.
  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      const localId = crypto.randomUUID();
      const isImage = (file.type || '').startsWith('image/');
      const previewUrl = isImage ? URL.createObjectURL(file) : null;
      setAttachments((current) => [...current, { localId, name: file.name, size: file.size, type: file.type, kind: isImage ? 'image' : undefined, status: 'uploading', previewUrl }]);
      try {
        const meta = await uploadAttachment(`/api/v2/projects/${projectId}/uploads?tenantId=${encodeURIComponent(tenant.id)}`, file);
        setAttachments((current) => current.map((att) => (att.localId === localId ? { ...meta, localId, previewUrl, status: 'done' } : att)));
      } catch (err) {
        setAttachments((current) => current.map((att) => (att.localId === localId ? { ...att, status: 'error', error: err.message } : att)));
      }
    }
  }

  function removeAttachment(localId) {
    setAttachments((current) => {
      const found = current.find((att) => att.localId === localId);
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
      return current.filter((att) => att.localId !== localId);
    });
  }

  async function sendMessage(event) {
    event.preventDefault();
    const text = message.trim();
    const ready = attachments.filter((att) => att.status === 'done');
    const uploading = attachments.some((att) => att.status === 'uploading');
    // Invio bloccato finché un upload è in corso: altrimenti l'allegato
    // resterebbe fuori dal messaggio senza che l'utente se ne accorga.
    if ((!text && ready.length === 0) || uploading || sending) return;
    const payload = ready.map(({ id, name, stored, type, kind, size, url }) => ({ id, name, stored, type, kind, size, url }));
    setSending(true);
    setMessage('');
    setError(null);
    setProject((current) => current ? {
      ...current,
      messages: [...(current.messages ?? []), { id: `optimistic-${Date.now()}`, role: 'user', text, attachments: ready.map((att) => ({ ...att })) }],
    } : current);
    setAttachments([]);
    try {
      const openRequest = project.requests?.find((request) => request.status === 'open');
      // Con allegati si passa SEMPRE da /architect: l'instradamento sulla
      // richiesta aperta lo fa il server (che risolve e persiste i file),
      // mentre /respond non trasporta allegati.
      const updated = openRequest && payload.length === 0
        ? await apiJson(`/api/v2/projects/${projectId}/requests/${openRequest.id}/respond?tenantId=${tenant.id}`, { method: 'POST', body: { answer: text } })
        : await apiJson(`/api/v2/projects/${projectId}/architect?tenantId=${tenant.id}`, { method: 'POST', body: { text, attachments: payload } });
      setProject(updated);
      onChanged();
    } catch (err) {
      setMessage(text);
      // Gli allegati erano già caricati sul server: si rimettono in composizione
      // così l'invio si ritenta senza ricaricare i file.
      setAttachments(ready);
      setError(err.message);
      await load();
    } finally { setSending(false); }
  }

  async function completeStep(step) {
    try {
      const updated = await apiJson(`/api/v2/projects/${projectId}/steps?tenantId=${tenant.id}`, {
        method: 'POST', body: { stepId: step.id, status: 'completed', evidence: { type: 'manual-confirmation', note: 'Completata dalla UI V2.' } },
      });
      setProject(updated);
      onChanged();
    } catch (err) { setError(err.message); }
  }

  async function approveStep(step) {
    // Instrada SEMPRE sulla risposta alla richiesta di approvazione aperta (/respond):
    // resolveProjectInput riattiva lo step, consuma il gate e rimette il progetto in active
    // in transazione unica, poi il server rilancia runProjectSerial. Niente POST /steps + /resume.
    try {
      const openRequest = project.requests?.find((request) => request.status === 'open' && request.type === 'approval' && request.stepId === step.id)
        ?? project.requests?.find((request) => request.status === 'open' && request.type === 'approval');
      if (!openRequest) { setError('Nessuna richiesta di approvazione aperta per questa task. Ricarica la pagina.'); return; }
      const updated = await apiJson(`/api/v2/projects/${projectId}/requests/${openRequest.id}/respond?tenantId=${tenant.id}`, { method: 'POST', body: { answer: 'Approva' } });
      setProject(updated);
      onChanged();
    } catch (err) { setError(err.message); }
  }

  async function activateProject() {
    try {
      const updated = await apiJson(`/api/v2/projects/${projectId}/activate?tenantId=${tenant.id}`, { method: 'POST' });
      setProject(updated);
      onChanged();
    } catch (err) { setError(err.message); }
  }

  async function toggleArchive() {
    try {
      const archived = project.status !== 'archived';
      const updated = await apiJson(`/api/v2/projects/${projectId}/archive?tenantId=${tenant.id}`, {
        method: 'POST', body: { archived },
      });
      setProject(updated);
      onChanged();
    } catch (err) { setError(err.message); }
  }

  async function runLint() {
    try {
      const result = await apiJson(`/api/v2/projects/${projectId}/brand-lint?tenantId=${tenant.id}`, {
        method: 'POST', body: { content: lintContent },
      });
      setLintResult(result);
      await load();
    } catch (err) { setError(err.message); }
  }

  if (!project) return <main className="page"><p className="muted">Caricamento progetto…</p>{error && <p className="error">{error}</p>}</main>;
  const discovery = project.status === 'discovery';
  const archived = project.status === 'archived';
  const currentStep = project.steps.find((step) => step.id === project.execution?.currentStepId || step.status === 'active');
  const executionStatus = project.execution?.status ?? 'idle';
  const isLive = ['running', 'queued', 'premium_quality_running'].includes(executionStatus) && ['active', 'needs_premium_review'].includes(project.status);
  const PHASE_LABELS = { execution: 'esecuzione', quality: 'quality gate', revision: 'revisione', needs_input: 'in attesa di te', needs_premium_review: 'attende gate premium', premium_quality: 'quality gate premium', premium_quality_error: 'errore quality gate premium', completed: 'completata' };
  const liveDetail = currentStep
    ? `${currentStep.label}${currentStep.execution?.phase ? ` · ${PHASE_LABELS[currentStep.execution.phase] ?? currentStep.execution.phase}` : ''}${Number(currentStep.execution?.attempt) > 1 ? ` · tentativo ${currentStep.execution.attempt}` : ''}`
    : null;
  const openRequest = project.requests?.find((request) => request.status === 'open');
  const resumable = ['paused', 'blocked'].includes(project.status);
  // Pausa su richiesta ancora aperta: il resume nudo verrebbe rifiutato dal
  // server, serve prima rispondere (banner guida sotto, bottone = approva).
  const resumeBlocked = resumable && Boolean(openRequest);
  const workspaceSubtitle = isLive && liveDetail
    ? `▶ Sta lavorando: ${liveDetail}`
    : executionStatus === 'paused' && currentStep ? `⏸ In pausa su: ${currentStep.label}`
    : currentStep ? `Task corrente: ${currentStep.label}`
    : discovery ? 'Project Architect · definizione del progetto' : 'Project workspace · piano operativo';
  const resumeTitle = resumeBlocked
    ? `Richiesta aperta: “${openRequest.question ?? openRequest.type}”. Il bottone la approva e riavvia il progetto.`
    : 'Riavvia il progetto dalla task in cui era fermo';
  const permissionSummary = project.permissions?.autonomyLevel
    ? `${project.permissions.autonomyLevel} · ${(project.permissions.approvalRequired ?? []).length} azioni con approvazione`
    : 'Da definire in chat';

  const drawer = <>
    {error && <p className="error">{error}</p>}
    <section className="os-drawer-section">
      <div className="section-head"><h3>Obiettivo</h3><span className={`os-status ${project.architectReady ? 'os-approved' : 'os-draft'}`}>{project.architectReady ? 'Piano pronto' : 'In definizione'}</span></div>
      <p>{project.objective || 'Da definire nella conversazione.'}</p>
      {project.architectSummary && <small className="muted">{project.architectSummary}</small>}
      {manage && discovery && project.architectReady && project.steps.length > 0 && <button className="btn-accent os-full-button" onClick={activateProject}>Approva piano e avvia</button>}
    </section>
    <section className="os-drawer-section">
      <div className="section-head"><h3>Modelli ed esecuzione</h3><span className={`os-status os-${executionStatus}`}>{isLive && <span className="os-live-dot" />}{executionStatus}</span></div>
      {isLive && liveDetail && <p className="os-live-line"><span className="os-live-dot" /> {liveDetail}</p>}
      {executionStatus === 'paused' && <p className="muted">⏸ Esecuzione in pausa{currentStep ? ` su “${currentStep.label}”` : ''}. Riprende dalla stessa task.</p>}
      <label className="os-model-field">Worker economico (esecuzione)<ModelSelect models={modelCatalog.models} value={project.defaultModel || modelCatalog.defaultModel} onChange={(defaultModel) => updateModels({ defaultModel })} disabled={!manage || archived} /><small className="muted">Usato per svolgere le task. Seleziona <strong>deepseek-v4-flash</strong>.</small></label>
      <label className="os-model-field">Quality gate premium<ModelSelect models={modelCatalog.models} value={project.qualityModel || project.defaultModel} onChange={(qualityModel) => updateModels({ qualityModel })} disabled={!manage || archived} /><small className="muted">Usato solo per controllare il lavoro del worker.</small></label>
      <label className="os-model-field">Quando avviare il quality gate premium<select className="os-model-select" value={project.qualityGateMode || 'immediate'} onChange={(event) => { const qualityGateMode = event.target.value; updateModels({ qualityGateMode, economicPreReviewEnabled: qualityGateMode === 'deferred', economicPreReviewMaxCycles: qualityGateMode === 'deferred' ? Math.max(1, Number(project.economicPreReviewMaxCycles) || 1) : 0 }); }} disabled={!manage || archived}><option value="immediate">Subito dopo ogni task</option><option value="deferred">Metti in pausa finché il premium torna disponibile</option></select></label>
      {project.qualityGateMode === 'deferred' && <><label className="os-list-row"><span><strong>Miglioramento economico prima della pausa</strong><small>Flash e DeepSeek Pro alternano correzione e verifica, con un limite rigido per evitare loop.</small></span><input type="checkbox" checked={project.economicPreReviewEnabled === true} onChange={(event) => updateModels({ economicPreReviewEnabled: event.target.checked, economicPreReviewMaxCycles: event.target.checked ? Math.max(1, Number(project.economicPreReviewMaxCycles) || 1) : 0 })} disabled={!manage || archived} /></label>{project.economicPreReviewEnabled === true && <><label className="os-model-field">Cicli massimi di miglioramento economico<select className="os-model-select" value={Math.max(1, Number(project.economicPreReviewMaxCycles) || 1)} onChange={(event) => updateModels({ economicPreReviewEnabled: true, economicPreReviewMaxCycles: Number(event.target.value) })} disabled={!manage || archived}><option value="1">1 · standard</option><option value="2">2 · codice, ricerca e copy importante</option><option value="3">3 · massimo rigore</option></select><small className="muted">Ogni ciclo fa <strong>Flash → Pro</strong>. Se Pro approva, il flusso si ferma subito; all’ultimo controllo salva eventuali rilievi per il premium.</small></label><label className="os-model-field">Modello pre-controllore economico<ModelSelect models={modelCatalog.models} value={project.economicPreReviewModel || 'deepseek/deepseek-v4-pro'} onChange={(economicPreReviewModel) => updateModels({ economicPreReviewModel })} disabled={!manage || archived} /><small className="muted">Consigliato: <strong>deepseek-v4-pro · cervello forte</strong>.</small></label></>}</>}
      {project.execution?.error && <p className="error">{project.execution.error}</p>}
      {project.status === 'needs_premium_review' && <p className="muted">⏸ {currentStep?.economicPreReview ? (currentStep.economicPreReview.approved ? `Pre-controllo economico approvato: ${currentStep.economicPreReview.reviewCount || 0} verifiche, ${currentStep.economicPreReview.revisionCount || 0} revisioni.` : `Pre-controllo economico arrivato al limite: ${currentStep.economicPreReview.reviewCount || 0} verifiche, ${currentStep.economicPreReview.revisionCount || 0} revisioni; rilievi residui salvati.`) : 'Worker completato.'} Quality gate premium in pausa: risultato e handoff restano salvati finché non riattivi il controllo.</p>}
      {manage && project.status === 'needs_premium_review' && <button className="btn-accent os-full-button" onClick={runPremiumReview} disabled={premiumReviewing}>{premiumReviewing ? '⏳ Quality gate premium…' : '🧪 Esegui quality gate premium'}</button>}
      {/* Ferma: visibile per TUTTA la run, incluso il quality gate premium (isLive
          copre running/queued/premium_quality_running). Prima era legato a
          project.status === 'active' e spariva durante il gate premium. */}
      {manage && isLive && <button className="os-full-button os-danger" onClick={pauseProject}>⏸ Ferma esecuzione</button>}
      {manage && ['active', 'needs_premium_review'].includes(project.status) && ['error', 'paused'].includes(executionStatus) && <button className="btn-accent os-full-button" onClick={resumeProject} disabled={resuming || resumeBlocked}>{resumeBlocked ? '⏸ Rispondi prima alla richiesta aperta' : resuming ? '⏳ Ripresa in corso…' : '▶ Riprendi esecuzione'}</button>}
      {manage && resumable && <button className="btn-accent os-full-button" onClick={resumeProject} disabled={resuming}>{resuming ? '⏳ Ripresa in corso…' : resumeBlocked ? '✓ Approva e riprendi' : '▶ Riprendi progetto'}</button>}
      <small className="muted">Recovery: {project.execution?.recoveryCount ?? 0} · la sessione di ogni task viene riutilizzata dopo restart o interruzioni.</small>
    </section>
    <section className="os-drawer-section">
      <h3>Fila e gruppo</h3>
      <label className="os-model-field">Gruppo (es. Lancio USA)
        <input className="os-text-input" defaultValue={project.group ?? ''} placeholder="Senza gruppo" disabled={!manage}
          onBlur={(event) => { if ((project.group ?? '') !== event.target.value.trim()) updateQueuePlacement('group', event.target.value); }} />
      </label>
      <label className="os-model-field">Ordine in fila
        <input className="os-text-input" type="number" defaultValue={project.queueOrder ?? ''} placeholder="auto (data di creazione)" disabled={!manage}
          onBlur={(event) => { if (String(project.queueOrder ?? '') !== event.target.value.trim()) updateQueuePlacement('queueOrder', event.target.value); }} />
      </label>
      <small className="muted">Numeri bassi partono prima. I progetti girano uno alla volta, in questo ordine.</small>
    </section>
    <section className="os-drawer-section">
      <div className="section-head"><h3>{discovery ? 'Task proposte' : 'Piano operativo'}</h3><span className="muted">{project.steps.length}</span></div>
      {project.steps.length === 0 ? <p className="muted">Le task nasceranno dalla chat.</p> : <div className="os-timeline">{project.steps.map((step) => <div key={step.id} className={`os-step os-step-${step.status} ${project.execution?.currentStepId === step.id ? 'os-step-current' : ''}`}><span className="os-step-dot" /><div><strong>{step.label}</strong>{step.description && <small>{step.description}</small>}<small>{STEP_LABELS[step.status] ?? step.status}{step.execution?.phase ? ` · ${step.execution.phase}` : ''}{step.approvalRequired ? ' · approvazione richiesta' : ''}</small>{manage && <ModelSelect models={modelCatalog.models} value={step.model || project.defaultModel} onChange={(model) => updateModels({ stepId: step.id, model })} disabled={archived || step.status === 'completed'} />}{manage && step.status === 'needs_approval' && <button className="btn-accent os-full-button" onClick={() => approveStep(step)}>Approva e continua</button>}{step.execution?.quality && <small className={step.execution.quality.approved ? 'validation-ok' : 'error'}>Quality score: {step.execution.quality.score ?? '—'}</small>}{step.execution?.output && <details><summary>Risultato task</summary><pre className="os-task-output">{step.execution.output}</pre></details>}</div></div>)}</div>}
    </section>
    <section className="os-drawer-section"><h3>Permessi e autonomia</h3><p>{permissionSummary}</p><strong>Azioni consentite</strong><ValueList items={project.permissions?.allowedActions} /><strong>Approvazione richiesta</strong><ValueList items={project.permissions?.approvalRequired} empty="Nessuna ancora definita" /><strong>Sistemi disponibili</strong><ValueList items={project.permissions?.availableSystems} /></section>
    <section className="os-drawer-section"><h3>Brief e contesto</h3><strong>Deliverable</strong><ValueList items={project.brief?.deliverables} /><strong>Contesto necessario</strong><ValueList items={project.brief?.contextNeeded} /><strong>Vincoli</strong><ValueList items={project.brief?.constraints} /><strong>Criteri di successo</strong><ValueList items={project.successCriteria} /></section>
    <section className="os-drawer-section"><h3>Skill riusabili</h3>{skillCatalog.filter((skill) => skill.status === 'active').length === 0 ? <p className="muted">Nessuna skill disponibile per questo business.</p> : skillCatalog.filter((skill) => skill.status === 'active').map((skill) => <label key={skill.id} className="os-list-row static"><span><strong>{skill.name}</strong><small>{skill.description || skill.key} · v{skill.version}</small></span><input type="checkbox" checked={(project.skillIds ?? []).includes(skill.id)} onChange={() => toggleSkill(skill.id)} disabled={!manage || archived} /></label>)}</section>
    {(project.contextSources?.length ?? 0) > 0 && <section className="os-drawer-section"><h3>Fonti importate</h3>{project.contextSources.map((source) => <details key={`${source.type}:${source.id}`}><summary>{source.title}</summary><pre className="os-report-preview">{source.content || source.summary}</pre></details>)}</section>}
    <section className="os-drawer-section"><h3>Brand e prove</h3><p><strong>{project.brandVersion ?? 'Brand Canon non collegato'}</strong></p><small className="muted">Artifact: {project.artifacts?.length ?? 0} · Evidenze: {project.evidence?.length ?? 0}</small></section>
    {project.currentStepId === 'brand_qa' && manage && <section className="os-drawer-section os-create-form"><h3>Brand/Claims Linter</h3><textarea rows="7" value={lintContent} onChange={(event) => setLintContent(event.target.value)} placeholder="Testo da validare…" /><button className="btn-accent" onClick={runLint} disabled={!lintContent.trim()}>Esegui linter</button>{lintResult && <p className={lintResult.ok ? 'validation-ok' : 'error'}>{lintResult.ok ? `Conforme a ${lintResult.brandVersion}` : `${lintResult.issues.length} problemi: ${lintResult.issues.map((item) => item.value).join(', ')}`}</p>}</section>}
    {manage && <section className="os-drawer-section"><button className="os-full-button" onClick={toggleArchive}>{archived ? 'Ripristina progetto' : 'Archivia progetto'}</button></section>}
  </>;

  // Header: durante una run il tasto Ferma sta SEMPRE in cima alla chat di
  // progetto (il drawer puo' essere chiuso); a run ferma torna il Riprendi.
  const headerActions = manage && isLive
    ? <button className="os-header-resume os-danger" onClick={pauseProject} title="Ferma l’agent in esecuzione: la task riprende da dov’era">⏸ Ferma</button>
    : manage && (resumable || (['active', 'needs_premium_review'].includes(project.status) && executionStatus === 'paused'))
      ? <button className="btn-accent os-header-resume" onClick={resumeProject} disabled={resuming} title={resumeTitle}>{resuming ? '⏳ Ripresa…' : resumeBlocked ? '✓ Approva e riprendi' : '▶ Riprendi'}</button>
      : null;

  return <>
    {resumeBlocked && (
      <div className="os-resume-banner" role="status">
        <span>⏸ In attesa di: <strong>{openRequest.question ?? 'una tua risposta'}</strong> — rispondi in chat oppure usa il bottone per approvare e riprendere.</span>
      </div>
    )}
    {resumeError && (
      <div className="os-resume-error" role="alert">
        <span>⚠️ Ripresa fallita: {resumeError}</span>
        <button onClick={() => setResumeError(null)} title="Chiudi">✕</button>
      </div>
    )}
    <ChatWorkspace title={project.title} subtitle={workspaceSubtitle} status={sending || project.architectBusy ? 'thinking' : (project.execution?.status || project.status)} messages={project.messages} message={message} setMessage={setMessage} sending={sending} thinking={Boolean(project.architectBusy)} sendingLabel="L’Architect sta pensando…" error={error} placeholder={discovery ? 'Rispondi all’Architect o descrivi cosa vuoi ottenere…' : 'Modifica direzione, vincoli o task del progetto…'} onSubmit={sendMessage} onBack={onBack} drawerLabel="Piano del progetto" drawer={drawer} archived={archived || !manage} headerActions={headerActions} attachments={attachments} onAddFiles={addFiles} onRemoveAttachment={removeAttachment} />
  </>;
}


function ReportDefinitionDetail({ tenant, definitionId, manage, onBack, onChanged }) {
  const [definition, setDefinition] = useState(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [modelCatalog, setModelCatalog] = useState({ models: [], defaultModel: '' });

  async function load() {
    try { setDefinition(await apiJson(`/api/v2/report-definitions/${definitionId}?tenantId=${tenant.id}`)); setError(null); }
    catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, [definitionId]);
  useEffect(() => { apiJson('/api/v2/models').then(setModelCatalog).catch(() => {}); }, []);

  async function updateModel(model) {
    try { setDefinition(await apiJson(`/api/v2/report-definitions/${definitionId}/model?tenantId=${tenant.id}`, { method: 'PATCH', body: { model } })); }
    catch (err) { setError(err.message); }
  }

  async function sendMessage(event) {
    event.preventDefault();
    const text = message.trim();
    if (!text || sending) return;
    setSending(true); setMessage(''); setError(null);
    try {
      const updated = await apiJson(`/api/v2/report-definitions/${definitionId}/designer?tenantId=${tenant.id}`, { method: 'POST', body: { text } });
      setDefinition(updated); onChanged();
    } catch (err) { setMessage(text); setError(err.message); await load(); }
    finally { setSending(false); }
  }

  async function activate() {
    try {
      const updated = await apiJson(`/api/v2/report-definitions/${definitionId}/activate?tenantId=${tenant.id}`, { method: 'POST' });
      setDefinition(updated); onChanged();
    } catch (err) { setError(err.message); }
  }

  async function toggleArchive() {
    try {
      const updated = await apiJson(`/api/v2/report-definitions/${definitionId}/archive?tenantId=${tenant.id}`, { method: 'POST', body: { archived: definition.status !== 'archived' } });
      setDefinition(updated); onChanged();
    } catch (err) { setError(err.message); }
  }

  async function runNow() {
    try {
      await apiJson(`/api/v2/report-definitions/${definitionId}/run?tenantId=${tenant.id}`, { method: 'POST' });
      await load(); onChanged();
    } catch (err) { setError(err.message); }
  }

  if (!definition) return <main className="page"><p className="muted">Caricamento report…</p>{error && <p className="error">{error}</p>}</main>;
  const archived = definition.status === 'archived';
  const schedule = definition.schedule ?? {};
  const cadence = schedule.cadence === 'daily' ? 'Ogni giorno' : schedule.cadence === 'monthly' ? 'Ogni mese' : 'Ogni settimana';

  const drawer = <>
    {error && <p className="error">{error}</p>}
    <section className="os-drawer-section"><div className="section-head"><h3>Scopo</h3><span className={`os-status ${definition.ready ? 'os-approved' : 'os-draft'}`}>{definition.ready ? 'Pronto' : 'In definizione'}</span></div><p>{definition.purpose || 'Da definire nella conversazione.'}</p><small className="muted">Destinatario: {definition.audience || 'da definire'}</small>{manage && definition.status === 'discovery' && definition.ready && <button className="btn-accent os-full-button" onClick={activate}>Approva e rendi ricorrente</button>}{manage && definition.status === 'active' && <button className="os-full-button" onClick={runNow}>Genera ora</button>}</section>
    <section className="os-drawer-section"><h3>Frequenza</h3><p>{cadence} alle {String(schedule.hour ?? 8).padStart(2, '0')}:00</p><small className="muted">{schedule.timezone ?? 'Europe/Rome'} · ultima consegna {definition.lastRunAt ? new Date(definition.lastRunAt).toLocaleString('it-IT') : 'mai'}</small></section>
    <section className="os-drawer-section"><h3>Modello Report Designer</h3><ModelSelect models={modelCatalog.models} value={definition.model || modelCatalog.defaultModel} onChange={updateModel} disabled={!manage || archived} /></section>
    <section className="os-drawer-section"><div className="section-head"><h3>KPI</h3><span className="muted">{definition.kpis.length}</span></div>{definition.kpis.length === 0 ? <p className="muted">I KPI nasceranno dalla chat.</p> : definition.kpis.map((kpi) => <div className="os-list-row static" key={kpi.id}><span><strong>{kpi.label}</strong><small>{kpi.metric} · {kpi.dimension}{kpi.rationale ? ` · ${kpi.rationale}` : ''}</small></span>{kpi.target != null && <span className="os-status">{kpi.target}{kpi.unit}</span>}</div>)}</section>
    <section className="os-drawer-section"><h3>Fonti e permessi</h3><strong>Fonti dati</strong><ValueList items={definition.dataSources} /><strong>Lettura</strong><ValueList items={definition.permissions?.read} /><strong>Scrittura</strong><ValueList items={definition.permissions?.write} empty="Nessun permesso di scrittura" /><strong>Approvazioni</strong><ValueList items={definition.permissions?.approvalRequired} empty="Nessuna approvazione aggiuntiva" /></section>
    <section className="os-drawer-section"><h3>Facsimile</h3>{definition.facsimile ? <pre className="os-report-preview">{definition.facsimile}</pre> : <p className="muted">Il Designer produrrà qui l’impaginazione stabile.</p>}</section>
    {manage && <section className="os-drawer-section"><button className="os-full-button" onClick={toggleArchive}>{archived ? 'Ripristina report' : 'Archivia report'}</button></section>}
  </>;

  return <ChatWorkspace title={definition.title} subtitle="Report Designer · configurazione ricorrente" status={sending ? 'thinking' : definition.status} messages={definition.messages} message={message} setMessage={setMessage} sending={sending} sendingLabel="Il Report Designer sta pensando…" error={error} placeholder="Definisci KPI, fonti, frequenza o modifica l’impaginazione…" onSubmit={sendMessage} onBack={onBack} drawerLabel="Struttura del report" drawer={drawer} archived={archived || !manage} />;
}

export default function OperatingSystem({ user, tenant, initialProjectId = null, onInitialProjectConsumed = () => {} }) {
  const [overview, setOverview] = useState(null);
  const [section, setSection] = useState('projects');
  const [projectId, setProjectId] = useState(null);

  // Deep-link da push: apre subito la chat del progetto notificato.
  useEffect(() => {
    if (!initialProjectId) return;
    setSection('projects');
    setProjectId(initialProjectId);
    onInitialProjectConsumed();
  }, [initialProjectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [reportDefinitionId, setReportDefinitionId] = useState(null);
  const [error, setError] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showArchivedReports, setShowArchivedReports] = useState(false);
  const manage = canManage(user);

  async function load() {
    try { setOverview(await apiJson(`/api/v2/overview?tenantId=${tenant.id}`)); setError(null); }
    catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, [tenant.id]);
  // Stato run live anche in lista: al broadcast v2_project ricarica l'overview.
  useEffect(() => openWs((event) => { if (event.type === 'v2_project') load(); }, load), [tenant.id]);

  const visibleProjects = useMemo(() => (overview?.projects ?? []).filter((item) => showArchived ? item.status === 'archived' : item.status !== 'archived'), [overview, showArchived]);
  // Fila di esecuzione: gruppi ("Lancio USA", …) ordinati per il membro più
  // prioritario, progetti dentro il gruppo in ordine di esecuzione, posizione
  // GLOBALE (1º, 2º, …) per i progetti ancora da finire.
  const queueView = useMemo(() => {
    const items = visibleProjects.slice().sort(projectPriority);
    const inLine = items.filter((item) => ['active', 'needs_premium_review'].includes(item.status));
    const positions = new Map(inLine.map((item, index) => [item.id, index + 1]));
    const groups = new Map();
    for (const item of items) {
      const key = item.group?.trim() || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const ordered = [...groups.entries()].sort((a, b) => projectPriority(a[1][0], b[1][0]));
    // Gruppo vuoto ("senza gruppo") sempre in fondo.
    ordered.sort((a, b) => (a[0] === '' ? 1 : 0) - (b[0] === '' ? 1 : 0));
    return { groups: ordered, positions };
  }, [visibleProjects]);
  // "Aspettano te": tutte le domande aperte di tutti i progetti, in un posto
  // solo. Ogni risposta sblocca la fila, quindi sta in cima alla pagina.
  const waitingForYou = useMemo(() => (overview?.projects ?? [])
    .filter((item) => item.status !== 'archived')
    .flatMap((item) => (item.requests ?? [])
      .filter((request) => request.status === 'open')
      .map((request) => ({ project: item, request })))
    .sort((a, b) => String(a.request.createdAt).localeCompare(String(b.request.createdAt))), [overview]);
  const openOpportunities = useMemo(() => (overview?.opportunities ?? []).filter((item) => item.status === 'open'), [overview]);
  const pendingApprovals = useMemo(() => (overview?.approvals ?? []).filter((item) => item.status === 'pending'), [overview]);
  const visibleReportDefinitions = useMemo(() => (overview?.reportDefinitions ?? []).filter((item) => showArchivedReports ? item.status === 'archived' : item.status !== 'archived'), [overview, showArchivedReports]);

  async function createProject() {
    try {
      const project = await apiJson(`/api/v2/projects?tenantId=${tenant.id}`, { method: 'POST', body: {} });
      await load();
      setProjectId(project.id);
    } catch (err) { setError(err.message); }
  }

  async function createReportDefinition() {
    try {
      const definition = await apiJson(`/api/v2/report-definitions?tenantId=${tenant.id}`, { method: 'POST', body: {} });
      await load();
      setReportDefinitionId(definition.id);
    } catch (err) { setError(err.message); }
  }

  async function convertOpportunity(item) {
    try {
      const project = await apiJson(`/api/v2/opportunities/${item.id}/project?tenantId=${tenant.id}`, { method: 'POST' });
      await load();
      setProjectId(project.id);
    } catch (err) { setError(err.message); }
  }

  async function convertReport(report) {
    try {
      const project = await apiJson(`/api/v2/reports/${report.id}/project?tenantId=${tenant.id}`, { method: 'POST' });
      await load();
      setProjectId(project.id);
    } catch (err) { setError(err.message); }
  }

  async function createSkill(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const list = (name) => String(form.get(name) ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    try {
      await apiJson(`/api/v2/skills?tenantId=${tenant.id}`, { method: 'POST', body: {
        name: form.get('name'), description: form.get('description'), instructions: form.get('instructions'),
        version: form.get('version') || '1.0.0', inputs: list('inputs'), outputs: list('outputs'),
      } });
      event.currentTarget.reset();
      await load();
    } catch (err) { setError(err.message); }
  }

  async function resolveApproval(item, status) {
    try { await apiJson(`/api/v2/approvals/${item.id}/resolve?tenantId=${tenant.id}`, { method: 'POST', body: { status } }); await load(); }
    catch (err) { setError(err.message); }
  }

  async function createBrand(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const list = (name) => String(form.get(name) ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    try {
      await apiJson(`/api/v2/brand-versions?tenantId=${tenant.id}`, { method: 'POST', body: {
        version: form.get('version'), name: form.get('name'), notes: form.get('notes'),
        core: { voice: form.get('voice'), audience: form.get('audience'), promisesAllowed: list('promisesAllowed'), requiredTerms: list('requiredTerms'), forbiddenTerms: list('forbiddenTerms'), callsToAction: list('callsToAction'), designTokensRef: form.get('designTokensRef') },
      } });
      event.currentTarget.reset();
      await load();
    } catch (err) { setError(err.message); }
  }

  async function activateBrand(version) {
    try { await apiJson(`/api/v2/brand-versions/${version.id}/activate?tenantId=${tenant.id}`, { method: 'POST' }); await load(); }
    catch (err) { setError(err.message); }
  }

  if (projectId) return <ProjectDetail tenant={tenant} projectId={projectId} manage={manage} onBack={() => { setProjectId(null); load(); }} onChanged={load} />;
  if (reportDefinitionId) return <ReportDefinitionDetail tenant={tenant} definitionId={reportDefinitionId} manage={manage} onBack={() => { setReportDefinitionId(null); load(); }} onChanged={load} />;
  if (!overview) return <main className="page"><h2>Operating System</h2><p className="muted">Caricamento…</p>{error && <p className="error">{error}</p>}</main>;

  return (
    <main className="page os-v2-page">
      <header className="os-v2-header" style={{ '--accent': tenant.color }}>
        <div><span className="os-kicker">{tenant.name}</span><h2>Operating System</h2><p>Crea, segui e migliora il lavoro dalla chat.</p></div>
        {manage && section === 'projects' && <button className="btn-accent" onClick={createProject}>+ Nuovo progetto</button>}
      </header>
      <nav className="os-subnav">{SECTIONS.map(([id, label]) => <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>{label}{id === 'projects' && pendingApprovals.length ? ` (${pendingApprovals.length})` : ''}</button>)}</nav>
      {error && <p className="error">{error}</p>}

      {section === 'projects' && <>
        {pendingApprovals.length > 0 && <section className="os-panel"><h3>Serve una tua decisione</h3>{pendingApprovals.map((item) => <article className="os-approval" key={item.id}><h4>{item.title}</h4><p>{item.reason}</p>{item.impact && <small>Impatto: {item.impact}</small>}{item.rollback && <small>Rollback: {item.rollback}</small>}{manage && <div className="approval-actions"><button className="btn-accent" onClick={() => resolveApproval(item, 'approved')}>Approva</button><button onClick={() => resolveApproval(item, 'rejected')}>Rifiuta</button></div>}</article>)}</section>}
        {!showArchived && waitingForYou.length > 0 && (
          <section className="os-panel os-waiting-you">
            <div className="section-head"><div><h3>✋ Aspettano te ({waitingForYou.length})</h3><small className="muted">Ogni risposta sblocca la fila: il sistema mette in pausa il resto e riprende da qui.</small></div></div>
            {waitingForYou.map(({ project, request }) => (
              <button className="os-list-row os-waiting-row" key={request.id} onClick={() => setProjectId(project.id)}>
                <span><strong>{request.question}</strong><small>{project.title} · {new Date(request.createdAt).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></span>
                <span className="os-status os-needs_input">rispondi</span>
              </button>
            ))}
          </section>
        )}
        <section className="os-panel">
          <div className="section-head"><div><h3>{showArchived ? 'Progetti archiviati' : 'Fila di esecuzione'}</h3><small className="muted">{showArchived ? 'Tutto il lavoro e le richieste passano dalla chat del progetto.' : 'I progetti girano in questo ordine, una task alla volta. Gruppo e ordine si cambiano dal pannello del progetto.'}</small></div><button onClick={() => setShowArchived((value) => !value)}>{showArchived ? 'Mostra attivi' : 'Archivio'}</button></div>
          {visibleProjects.length === 0 ? <p className="muted">{showArchived ? 'Nessun progetto archiviato.' : 'Crea un progetto e descrivi il risultato che vuoi ottenere.'}</p> : queueView.groups.map(([groupName, groupProjects]) => {
            const done = groupProjects.filter((item) => item.status === 'completed').length;
            return (
              <div className="os-queue-group" key={groupName || '__none__'}>
                <div className="os-queue-group-head">
                  <h4>{groupName || 'Senza gruppo'}</h4>
                  <small className="muted">{done}/{groupProjects.length} completati</small>
                </div>
                {groupProjects.map((project) => (
                  <ProjectQueueCard key={project.id} project={project} position={queueView.positions.get(project.id)} onOpen={() => setProjectId(project.id)} />
                ))}
              </div>
            );
          })}
        </section>
      </>}

      {section === 'reports' && <>
        <section className="os-panel">
          <div className="section-head"><div><h3>{showArchivedReports ? 'Report archiviati' : 'Report ricorrenti'}</h3><small className="muted">Configura via chat contenuto, fonti e frequenza.</small></div><div className="approval-actions"><button onClick={() => setShowArchivedReports((value) => !value)}>{showArchivedReports ? 'Mostra attivi' : 'Archivio'}</button>{manage && !showArchivedReports && <button className="btn-accent" onClick={createReportDefinition}>+ Nuovo report</button>}</div></div>
          {visibleReportDefinitions.length === 0 ? <p className="muted">{showArchivedReports ? 'Nessun report archiviato.' : 'Nessun report configurato.'}</p> : visibleReportDefinitions.map((definition) => <button className="os-list-row" key={definition.id} onClick={() => setReportDefinitionId(definition.id)}><span><strong>{definition.title}</strong><small>{definition.status === 'discovery' ? 'Configurazione nella chat' : `${definition.schedule?.cadence ?? 'weekly'} · ${definition.kpis.length} KPI`}</small></span><span className={`os-status os-${definition.status}`}>{definition.status}</span></button>)}
        </section>
        {overview.reports.length > 0 && <section className="os-panel"><h3>Consegnati</h3>{overview.reports.slice(0, 10).map((report) => <div className="os-report" key={report.id}><strong>{report.title}</strong><span>{report.summary}</span><small>{new Date(report.createdAt).toLocaleString('it-IT')}</small>{report.content && <details><summary>Apri report</summary><pre className="os-report-preview">{report.content}</pre></details>}{manage && <button className="btn-accent" onClick={() => convertReport(report)}>Apri progetto da questo report</button>}</div>)}</section>}
        {openOpportunities.length > 0 && <section className="os-panel"><h3>Suggerimenti automatici</h3>{openOpportunities.map((item) => <article className={`os-opportunity severity-${item.severity}`} key={item.id}><h4>{item.title}</h4><p>{item.reason}</p><small>{item.metric} · {item.currentValue}{item.unit} vs {item.baselineValue}{item.unit}</small>{manage && <button className="btn-accent" onClick={() => convertOpportunity(item)}>Apri progetto</button>}</article>)}</section>}
      </>}

      {section === 'setup' && <>
        <section className="os-panel"><div className="section-head"><div><h3>Skill riusabili</h3><small className="muted">Istruzioni disponibili in tutti i progetti di questo business.</small></div><span className="os-status">{overview.skills.length}</span></div>{overview.skills.length === 0 ? <p className="muted">Nessuna skill definita.</p> : overview.skills.map((skill) => <div className="os-list-row static" key={skill.id}><span><strong>{skill.name}</strong><small>v{skill.version} · {skill.status}</small><small>{skill.description}</small></span></div>)}</section>
        {manage && <details className="os-panel os-setup-details"><summary>Aggiungi skill</summary><form className="os-create-form" onSubmit={createSkill}><div className="os-grid-2"><label>Nome<input name="name" required /></label><label>Versione<input name="version" defaultValue="1.0.0" /></label></div><label>Descrizione<input name="description" /></label><label>Istruzioni operative<textarea name="instructions" rows="8" required /></label><label>Input, separati da virgola<input name="inputs" /></label><label>Output, separati da virgola<input name="outputs" /></label><button className="btn-accent">Crea skill</button></form></details>}
        <section className="os-panel"><div className="section-head"><div><h3>Brand</h3><small className="muted">Regole applicate automaticamente ai progetti.</small></div><span className={`os-status os-${overview.brand?.status}`}>{overview.brand?.version}</span></div><p><strong>{overview.brand?.name}</strong></p><p>{overview.brand?.core?.voice || 'Tone of voice non ancora definito.'}</p><small className="muted">Target: {overview.brand?.core?.audience || 'da definire'}</small></section>
        {manage && <details className="os-panel os-setup-details"><summary>Crea nuova versione Brand</summary><form className="os-create-form" onSubmit={createBrand}><div className="os-grid-2"><label>Versione<input name="version" placeholder="v1.0" required /></label><label>Nome<input name="name" defaultValue={`${tenant.name} Brand Canon`} required /></label></div><label>Tone of voice<textarea name="voice" rows="3" required /></label><label>Target<textarea name="audience" rows="2" required /></label><label>Promesse consentite, separate da virgola<input name="promisesAllowed" /></label><label>Termini obbligatori<input name="requiredTerms" /></label><label>Termini vietati<input name="forbiddenTerms" /></label><label>CTA approvate<input name="callsToAction" /></label><label>Riferimento design tokens<input name="designTokensRef" /></label><label>Note<textarea name="notes" rows="2" /></label><button className="btn-accent">Salva bozza</button></form></details>}
        {overview.brandVersions.some((version) => version.status === 'draft') && <section className="os-panel"><h3>Bozze Brand</h3>{overview.brandVersions.filter((version) => version.status === 'draft').map((version) => <div className="os-list-row static" key={version.id}><span><strong>{version.version}</strong><small>{version.name}</small></span>{manage && <button onClick={() => activateBrand(version)}>Attiva</button>}</div>)}</section>}
      </>}
    </main>
  );
}
