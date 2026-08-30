import React, { useEffect, useMemo, useState } from 'react';
import { apiJson, canManage } from './api.js';

// Vista "Tra CEO" (task board 45b4a981): thread di messaggistica ASINCRONA
// cross-tenant tra i CEO dei business (backend task 183ae10d, server/lib/ceomail.js).
// Vista GLOBALE come "Agenti live" (i thread coinvolgono 2 tenant, non ha senso
// come tab dentro un singolo business) — raggiunta da un FAB in App.jsx.
//
// MAX_EXCHANGES: mirror di SOLA PRESENTAZIONE del cap anti-loop server-side
// (server/lib/ceomail.js, export MAX_EXCHANGES). Se cambia lì, aggiornare qui.
const MAX_EXCHANGES = 6;

// Contratto backend (task a5a5e758, server/lib/ceomail.js): POST .../message
// (messaggio di Owner nel thread — NON incrementa exchanges; se il thread era
// 'awaiting_owner' lo riporta 'active' con exchanges=0, se era 'closed' resta
// 'closed'), POST .../stop ('closed', stop esplicito di Owner — distinto dal
// blocco automatico 'awaiting_owner' del cap 6 scambi) e POST .../resume
// (riporta 'active' ed azzera exchanges: riapre sia 'awaiting_owner' che
// 'closed'). Errore generico qui: apiJson già propaga il messaggio del server
// (data.error) quando presente, altrimenti "HTTP <status>".
function friendlyActionError(err) {
  return `Azione non riuscita, riprova.${err?.message ? ` (${err.message})` : ''}`;
}

function fmtWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function tenantChip(t, fallbackId) {
  if (t) return `${t.icon} ${t.name}`;
  return fallbackId ? `❓ ${fallbackId}` : '❓ tenant sconosciuto';
}

// Riuso della pillola visiva `urgency-badge` (già usata per l'urgenza task,
// vedi TaskBoard.jsx) per il badge di stato del thread: stesso linguaggio
// visivo a colori, zero CSS nuovo per un semplice badge testuale.
function StatusBadge({ status, exchanges }) {
  if (status === 'awaiting_owner') {
    return <span className="urgency-badge urgency-alta">⏸️ in attesa di Owner · {exchanges}/{MAX_EXCHANGES}</span>;
  }
  if (status === 'closed') {
    return <span className="urgency-badge urgency-critica">⏹️ fermato</span>;
  }
  return <span className="urgency-badge urgency-media">🟢 attivo · {exchanges}/{MAX_EXCHANGES}</span>;
}

function ThreadCard({ thread, tenantsById, onOpen }) {
  const [a, b] = thread.participants ?? [];
  const ta = tenantsById[a];
  const tb = tenantsById[b];
  const last = thread.lastMessage;
  const lastFromName = last ? (tenantsById[last.fromTenant]?.name ?? last.fromAgentName ?? last.fromTenant) : null;
  const preview = last ? `${last.text.slice(0, 80)}${last.text.length > 80 ? '…' : ''}` : 'Nessun messaggio ancora';
  return (
    <button type="button" className="card" style={{ '--accent': ta?.color ?? tb?.color ?? '#7c6cf0' }} onClick={() => onOpen(thread.id)}>
      <span className="card-icon">🤝</span>
      <span className="card-body">
        <strong>{tenantChip(ta, a)} ↔ {tenantChip(tb, b)}</strong>
        <small>{last ? `${lastFromName}: ${preview}` : preview}</small>
        <small className="muted">aggiornato {fmtWhen(thread.updatedAt)} · {thread.messageCount ?? 0} messaggi</small>
        <StatusBadge status={thread.status} exchanges={thread.exchanges} />
      </span>
    </button>
  );
}

function ThreadList({ tenantsById, onOpen }) {
  const [threads, setThreads] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = () => apiJson('/api/ceomail/threads').then((r) => setThreads(r.items ?? [])).catch((e) => setError(e.message));
    load();
    const timer = setInterval(load, 20000);
    // Retry al ritorno online, stesso pattern usato in tutta la PWA (task board dec1de1f).
    window.addEventListener('online', load);
    return () => { clearInterval(timer); window.removeEventListener('online', load); };
  }, []);

  const sorted = useMemo(() => [...(threads ?? [])].sort((x, y) => {
    // Thread in attesa di una decisione in cima: sono quelli che richiedono azione.
    if (x.status === 'awaiting_owner' && y.status !== 'awaiting_owner') return -1;
    if (y.status === 'awaiting_owner' && x.status !== 'awaiting_owner') return 1;
    return x.updatedAt < y.updatedAt ? 1 : -1;
  }), [threads]);

  return (
    <main className="page">
      <p className="muted">
        Conversazioni asincrone tra i CEO dei business (tool send_to_ceo). Ogni thread si ferma da solo dopo
        {' '}{MAX_EXCHANGES} scambi e resta in attesa di una tua decisione (nessuna run generata finché non lo sblocchi).
      </p>
      {error && <p className="error">Server non raggiungibile: {error}</p>}
      {!threads && !error && <p className="muted">Caricamento…</p>}
      {threads?.length === 0 && <p className="muted center">Nessuna conversazione tra CEO ancora.</p>}
      <div className="cards">
        {sorted.map((t) => <ThreadCard key={t.id} thread={t} tenantsById={tenantsById} onOpen={onOpen} />)}
      </div>
    </main>
  );
}

function MessageRow({ msg, tenantsById }) {
  const isOwner = !msg.fromTenant || msg.fromTenant === 'owner' || msg.fromAgent === 'owner';
  const t = tenantsById[msg.fromTenant];
  const name = isOwner ? '👤 Owner' : `${t ? `${t.icon} ` : ''}${msg.fromAgentName || msg.fromAgent}`;
  return (
    <div className={`bubble ${isOwner ? 'owner-msg' : 'ceo-msg'}`} style={{ '--accent': t?.color }}>
      <strong className="bubble-sender">{name}{!isOwner && t ? ` · ${t.name}` : ''}</strong>
      <div>{msg.text}</div>
      <small className="bubble-note">{fmtWhen(msg.at)}</small>
    </div>
  );
}

function ThreadDetail({ threadId, tenantsById, manage, onBack }) {
  const [thread, setThread] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [text, setText] = useState('');

  useEffect(() => {
    setThread(null);
    setError(null);
    const load = () => apiJson(`/api/ceomail/threads/${threadId}`).then(setThread).catch((e) => setError(e.message));
    load();
    const timer = setInterval(load, 15000);
    window.addEventListener('online', load);
    return () => { clearInterval(timer); window.removeEventListener('online', load); };
  }, [threadId]);

  const unlock = async () => {
    setBusy(true); setActionError(null);
    try {
      const r = await apiJson(`/api/ceomail/threads/${threadId}/resume`, { method: 'POST', body: {} });
      setThread(r.thread ?? thread);
    } catch (e) { setActionError(friendlyActionError(e)); } finally { setBusy(false); }
  };

  const stopThread = async () => {
    if (!window.confirm('Fermare questo thread? I CEO non potranno scambiarsi altri messaggi finché non lo sblocchi.')) return;
    setBusy(true); setActionError(null);
    try {
      const r = await apiJson(`/api/ceomail/threads/${threadId}/stop`, { method: 'POST', body: {} });
      setThread(r.thread ?? { ...thread, status: 'closed' });
    } catch (e) { setActionError(friendlyActionError(e)); } finally { setBusy(false); }
  };

  const send = async () => {
    const value = text.trim();
    if (!value) return;
    setBusy(true); setActionError(null);
    try {
      const r = await apiJson(`/api/ceomail/threads/${threadId}/message`, { method: 'POST', body: { text: value } });
      setThread(r.thread ?? thread);
      setText('');
    } catch (e) { setActionError(friendlyActionError(e)); } finally { setBusy(false); }
  };

  const [a, b] = thread?.participants ?? [];
  const title = thread ? `${tenantChip(tenantsById[a], a)} ↔ ${tenantChip(tenantsById[b], b)}` : 'Thread';
  const messages = useMemo(() => [...(thread?.messages ?? [])].sort((x, y) => (x.at < y.at ? -1 : 1)), [thread]);

  return (
    <>
      <header className="topbar">
        <button className="back" onClick={onBack}>←</button>
        <h1>{title}</h1>
      </header>
      <main className="page">
        {error && <p className="error">{error}</p>}
        {!thread && !error && <p className="muted">Caricamento…</p>}
        {thread && (
          <>
            <div className="urgency-row">
              <StatusBadge status={thread.status} exchanges={thread.exchanges} />
              <small className="muted">{messages.length} messaggi</small>
            </div>
            {thread.status === 'awaiting_owner' && (
              <div className="card ratelimit-banner">
                <strong>⏸️ In attesa di una tua decisione</strong>
                <small>Raggiunti {MAX_EXCHANGES}/{MAX_EXCHANGES} scambi: nessun altro messaggio finché non sblocchi il thread.</small>
                {manage && (
                  <div className="session-actions">
                    <button className="btn-accent" disabled={busy} onClick={unlock}>🔓 Sblocca (riprendi scambi)</button>
                  </div>
                )}
              </div>
            )}
            {thread.status === 'closed' && (
              <div className="card ratelimit-banner">
                <strong>⏹️ Thread fermato</strong>
                <small>Nessun altro messaggio finché non lo sblocchi.</small>
                {manage && (
                  <div className="session-actions">
                    <button className="btn-accent" disabled={busy} onClick={unlock}>🔓 Sblocca</button>
                  </div>
                )}
              </div>
            )}
            <div className="ceomail-messages">
              {messages.map((m) => <MessageRow key={m.id} msg={m} tenantsById={tenantsById} />)}
              {messages.length === 0 && <p className="muted center">Nessun messaggio ancora.</p>}
            </div>
            {manage && thread.status === 'active' && (
              <div className="task-form">
                <textarea
                  rows={2}
                  placeholder="Scrivi un messaggio come Owner in questo thread…"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <div className="session-actions">
                  <button className="btn-accent" disabled={busy || !text.trim()} onClick={send}>✉️ Invia come Owner</button>
                  <button className="btn-accent" disabled={busy} onClick={stopThread}>⏹ Ferma thread</button>
                </div>
              </div>
            )}
            {actionError && <p className="error">{actionError}</p>}
          </>
        )}
      </main>
    </>
  );
}

export default function CeoMail({ user, onBack }) {
  const [tenants, setTenants] = useState(null);
  const [openId, setOpenId] = useState(null);
  const manage = canManage(user);

  useEffect(() => { apiJson('/api/tenants').then(setTenants).catch(() => setTenants([])); }, []);
  // Mappa id tenant -> {name, icon, color}: solo i tenant assegnati all'utente
  // (endpoint /api/tenants filtra sui permessi). Se un thread coinvolge un
  // tenant non accessibile all'utente corrente, tenantChip mostra un fallback
  // con l'id grezzo invece di rompere la vista.
  const tenantsById = useMemo(() => Object.fromEntries((tenants ?? []).map((t) => [t.id, t])), [tenants]);

  if (openId) {
    return <ThreadDetail threadId={openId} tenantsById={tenantsById} manage={manage} onBack={() => setOpenId(null)} />;
  }

  return (
    <>
      <header className="topbar">
        <button className="back" onClick={onBack}>←</button>
        <h1>🤝 Tra CEO</h1>
      </header>
      <ThreadList tenantsById={tenantsById} onOpen={setOpenId} />
    </>
  );
}
