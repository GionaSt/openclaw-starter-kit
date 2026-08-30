import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { authFetch, apiJson } from './api.js';
import { ACCEPT_ATTR, uploadAttachment, AttachmentChip } from './lib/attachmentsUi.jsx';
import { handleComposerKeyDown } from './lib/composerKeys.js';
import { consumeChatStream, createDeltaBuffer, buildOutgoingMessage } from './lib/chatStream.js';

// sessionId per coppia tenant+agente: chiave di cache locale (fallback offline),
// ma la fonte di verità è il server (task e66dc5e1 — chat sincronizzata tra
// dispositivi, vedi resolveActiveSessionId sotto).
function sessionKey(tenantId, agentId) {
  return `session:${tenantId}:${agentId}`;
}
// Marca l'ultimo sessionId locale già "offerto" al server per la migrazione
// (import one-shot): evita di ritentare l'import a ogni apertura della chat.
function migratedKey(tenantId, agentId) {
  return `session-migrated:${tenantId}:${agentId}`;
}

// Risolve il sessionId "attivo" da usare per /api/chat e /api/history,
// sincronizzato tra dispositivi tramite l'API conversazioni server-side
// (task 8ed6deb8 + e66dc5e1). Non tocca lo storico reale (history.js, che
// resta la fonte autoritativa dei messaggi): usa `/api/conversations` solo
// come puntatore condiviso — l'id della conversazione DIVENTA il sessionId,
// così ogni dispositivo che lo scopre via GET /api/conversations converge
// sullo stesso file di storico server-side.
//
// Passi:
// 1) GET /api/conversations?agentId=X: cosa già sa il server per questo agente.
// 2) Se questo device ha un sessionId locale (pre-esistente, con storico reale
//    su history.js) mai offerto al server, lo IMPORTA (id esplicito = quello
//    locale) così diventa scopribile da altri device — "chat PC recuperata".
// 3) Tra tutti i candidati (server + quello appena migrato), vince il più
//    recente ("ultima scrittura vince, niente merge complessi").
// 4) Se non esiste nulla da nessuna parte, ne crea uno nuovo (vuoto).
async function resolveActiveSessionId(tenant, agent) {
  const tenantId = tenant.id;
  const agentId = agent.id;

  let serverConvs = [];
  try {
    serverConvs = await apiJson(`/api/conversations?tenantId=${encodeURIComponent(tenantId)}&agentId=${encodeURIComponent(agentId)}`);
  } catch {
    serverConvs = [];
  }

  const legacyId = localStorage.getItem(sessionKey(tenantId, agentId));
  const alreadyOffered = localStorage.getItem(migratedKey(tenantId, agentId)) === legacyId;
  let legacyConv = null;
  if (legacyId && !alreadyOffered) {
    try {
      const hist = await authFetch(`/api/history?tenantId=${encodeURIComponent(tenantId)}&agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(legacyId)}`)
        .then((r) => (r.ok ? r.json() : null));
      const messages = (Array.isArray(hist) ? hist : [])
        .filter((h) => h && h.role && String(h.text ?? '').trim())
        .map((h) => ({ role: h.role, text: h.text, ts: h.ts }));
      const { imported } = await apiJson('/api/conversations/import', {
        method: 'POST',
        body: { tenantId, conversations: [{ id: legacyId, agentId, messages }] },
      });
      if (imported?.length) legacyConv = { id: legacyId, updatedAt: new Date().toISOString() };
      localStorage.setItem(migratedKey(tenantId, agentId), legacyId);
    } catch {
      // offline o errore: si ritenta al prossimo mount (flag "migrated" non scritto)
    }
  }

  const candidates = serverConvs.slice();
  if (legacyConv && !candidates.some((c) => c.id === legacyConv.id)) candidates.push(legacyConv);
  if (candidates.length > 0) {
    candidates.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return candidates[0].id;
  }
  // Nessuna conversazione da nessuna parte: se questo device aveva già un id
  // locale (chat mai iniziata, storico vuoto) lo registra comunque sul server
  // così è visibile da subito agli altri device; altrimenti ne crea una nuova.
  if (legacyId) {
    try {
      await apiJson('/api/conversations/import', {
        method: 'POST',
        body: { tenantId, conversations: [{ id: legacyId, agentId, messages: [] }] },
      });
    } catch { /* best-effort */ }
    return legacyId;
  }
  const created = await apiJson('/api/conversations', { method: 'POST', body: { tenantId, agentId } });
  return created.id;
}

// Bozza per-chat: il testo non ancora inviato deve sopravvivere a cambio chat,
// cambio tab e refresh della PWA. Chiave per coppia tenant+agente (indipendente
// dal sessionId, così la bozza resta anche archiviando/aprendo una nuova
// conversazione). Best-effort: se localStorage non è disponibile (modalità
// privata / quota piena) non si rompe nulla, semplicemente non si persiste.
function draftKey(tenantId, agentId) {
  return `draft:${tenantId}:${agentId}`;
}
function loadDraft(tenantId, agentId) {
  try {
    return localStorage.getItem(draftKey(tenantId, agentId)) || '';
  } catch {
    return '';
  }
}
function saveDraft(tenantId, agentId, text) {
  try {
    if (text) localStorage.setItem(draftKey(tenantId, agentId), text);
    else localStorage.removeItem(draftKey(tenantId, agentId));
  } catch {
    // storage non disponibile: la bozza è best-effort, si ignora
  }
}

// Pulsante microfono: trascrizione server (whisper) se disponibile, altrimenti
// Web Speech API del browser. Il testo trascritto finisce nel campo di input,
// sempre modificabile prima dell'invio.
function MicButton({ onText }) {
  const [mode, setMode] = useState(null); // 'server' | 'webspeech' | null
  const [recording, setRecording] = useState(false);
  const recRef = useRef(null);

  useEffect(() => {
    apiJson('/api/transcribe/status')
      .then((s) => {
        if (s.available) setMode('server');
        else if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) setMode('webspeech');
      })
      .catch(() => {
        if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) setMode('webspeech');
      });
  }, []);

  async function toggleServer() {
    if (recording) {
      recRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        try {
          const resp = await authFetch('/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': blob.type },
            body: blob,
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data?.error ?? `HTTP ${resp.status}`);
          if (data.text) onText(data.text);
        } catch (err) {
          alert(`Trascrizione fallita: ${err.message}`);
        }
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (err) {
      alert(`Microfono non disponibile: ${err.message}`);
    }
  }

  function toggleWebSpeech() {
    if (recording) {
      recRef.current?.stop();
      return;
    }
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = 'it-IT';
    rec.interimResults = false;
    rec.continuous = true;
    rec.onresult = (e) => {
      const text = Array.from(e.results).map((r) => r[0].transcript).join(' ').trim();
      if (text) onText(text);
    };
    rec.onend = () => setRecording(false);
    rec.onerror = () => setRecording(false);
    recRef.current = rec;
    rec.start();
    setRecording(true);
  }

  if (!mode) return null;
  return (
    <button
      type="button"
      className={`mic ${recording ? 'recording' : ''}`}
      title={recording ? 'Ferma la registrazione' : 'Detta un messaggio'}
      onClick={mode === 'server' ? toggleServer : toggleWebSpeech}
    >
      {recording ? '⏺' : '🎤'}
    </button>
  );
}

function Bubble({ m, color, onCancelQueued }) {
  return (
    <div className={`bubble ${m.role} ${m.queued ? 'queued' : ''}`} style={{ '--accent': color }}>
      {m.role === 'assistant' ? (
        <div className="md">
          <ReactMarkdown>{m.text || (m.streaming ? '…' : '')}</ReactMarkdown>
        </div>
      ) : (
        m.text
      )}
      {Array.isArray(m.attachments) && m.attachments.length > 0 && (
        <div className="attachments">
          {m.attachments.map((att, i) => <AttachmentChip key={att.id ?? att.localId ?? i} att={att} />)}
        </div>
      )}
      {/* Messaggio accodato (task 13aad6c3, coda API 311d2946): l'agente sta
          già lavorando un turno su questa sessione — resta cancellabile con un
          tap finché il turno di consegna non lo preleva. */}
      {m.queued && (
        <div className="bubble-note queue-note">
          <span>⏳ in coda</span>
          <button type="button" className="queue-cancel" title="Annulla invio" onClick={() => onCancelQueued?.(m)}>Annulla</button>
        </div>
      )}
      {m.error && <div className="bubble-note error">⚠️ {m.error}</div>}
      {m.stopped && (
        <div className="bubble-note">
          ⏹ {m.stopped === 'paused' ? 'generazione in pausa — riprenderà da qui' : 'generazione fermata'}
        </div>
      )}
    </div>
  );
}

// Vista in sola lettura di una conversazione archiviata.
function ArchivedView({ tenant, conv, onBack }) {
  return (
    <>
      <header className="topbar">
        <button className="back" onClick={onBack}>←</button>
        <h1>
          Archivio
          <small className="muted"> · {new Date(conv.archivedAt).toLocaleString('it-IT')}</small>
        </h1>
      </header>
      <main className="chat">
        <p className="muted center">Conversazione archiviata — sola lettura</p>
        {conv.messages.map((m, i) => <Bubble key={i} m={m} color={tenant.color} />)}
      </main>
    </>
  );
}

function ArchiveList({ tenant, agent, onOpen, onBack }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiJson(`/api/conversations/archived?tenantId=${tenant.id}&agentId=${agent.id}`)
      .then(setList)
      .catch((e) => setError(e.message));
  }, [tenant.id, agent.id]);

  return (
    <>
      <header className="topbar">
        <button className="back" onClick={onBack}>←</button>
        <h1>Conversazioni archiviate</h1>
      </header>
      <main className="page">
        {error && <p className="error">{error}</p>}
        {list?.length === 0 && <p className="muted center">Nessuna conversazione archiviata.</p>}
        <div className="cards">
          {list?.map((c) => (
            <button
              key={c.id}
              className="card"
              style={{ '--accent': tenant.color }}
              onClick={() => {
                apiJson(`/api/conversations/archived/${c.id}?tenantId=${tenant.id}`)
                  .then(onOpen)
                  .catch((e) => setError(e.message));
              }}
            >
              <span className="card-body">
                <strong>{c.title}</strong>
                <small className="muted">
                  {new Date(c.archivedAt).toLocaleString('it-IT')} · {c.count} messaggi
                </small>
              </span>
            </button>
          ))}
        </div>
      </main>
    </>
  );
}

export default function Chat({ user, tenant, agent, blocked, onBack }) {
  // sessionId risolto in modo asincrono dal server (null finché non risolto):
  // niente history/chat finché non sappiamo su quale conversazione siamo.
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState(() => loadDraft(tenant.id, agent.id));
  const [busy, setBusy] = useState(false);
  // Allegati del messaggio in composizione: {localId,name,size,type,status,...meta}
  const [attachments, setAttachments] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const [view, setView] = useState('chat'); // chat | archive-list | archived
  const [archivedConv, setArchivedConv] = useState(null);
  // Incrementato quando uno stream si chiude male: riattiva il polling della
  // history per riagganciare la risposta completata lato server.
  const [pollNonce, setPollNonce] = useState(0);
  const busyRef = useRef(false);
  const bottomRef = useRef(null);
  // runId della generazione in corso (dall'evento SSE 'run'): serve al bottone STOP.
  const runIdRef = useRef(null);
  const taRef = useRef(null);
  // serverMessageId delle bolle attualmente in coda in locale (task 6af5f541):
  // specchio di `messages` tenuto fuori dallo state, cosi' il poll di coda puo'
  // leggerlo in modo sincrono per rilevare il drain senza dipendere da un
  // side-effect dentro l'updater di setMessages (che sotto batching non gira
  // in tempo utile prima del controllo su drained).
  const queuedIdsRef = useRef(new Set());

  // Textarea auto-espandibile: cresce col testo fino a ~5 righe (max-height in
  // CSS), poi scrolla internamente; si riadatta anche a svuotamento (post-invio).
  const TA_MAX_PX = 132;
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, TA_MAX_PX)}px`;
  }, [input]);

  // Persistenza della bozza (debounce ~300ms): il testo non inviato sopravvive
  // a cambio chat/tab e refresh. Si azzera solo all'invio riuscito (in send) o
  // svuotando manualmente il campo. Nota: la chat viene rimontata al cambio di
  // agente (agent passa da null all'oggetto), quindi il ripristino avviene
  // tramite l'inizializzatore di useState(input) sopra.
  useEffect(() => {
    const t = setTimeout(() => saveDraft(tenant.id, agent.id, input), 300);
    return () => clearTimeout(t);
  }, [input, tenant.id, agent.id]);
  // Autoscroll "aggancia il fondo": attivo solo se l'utente e' gia' in fondo;
  // se ha scrollato su per rileggere, lo streaming non gli strappa la vista.
  const stickRef = useRef(true);

  // Risoluzione del sessionId attivo dal server ad ogni apertura della chat
  // (task e66dc5e1, criterio "refresh lista chat all'apertura app"): sincronizza
  // con la conversazione più recente vista da qualunque device, migrando al volo
  // l'eventuale chat locale di questo device mai offerta al server prima d'ora.
  useEffect(() => {
    let cancelled = false;
    setSessionId(null);
    resolveActiveSessionId(tenant, agent)
      .then((id) => {
        if (cancelled) return;
        localStorage.setItem(sessionKey(tenant.id, agent.id), id);
        setSessionId(id);
      })
      .catch(() => {
        if (cancelled) return;
        // offline o server irraggiungibile: resta usabile con l'ultimo id noto
        // localmente (o uno nuovo), si risincronizza al prossimo mount utile.
        const fallback = localStorage.getItem(sessionKey(tenant.id, agent.id)) || crypto.randomUUID();
        localStorage.setItem(sessionKey(tenant.id, agent.id), fallback);
        setSessionId(fallback);
      });
    return () => { cancelled = true; };
  }, [tenant.id, agent.id]);

  // Carica lo storico; se l'ultimo messaggio e' dell'utente c'e' una risposta in
  // lavorazione (magari partita da un'altra schermata): mostra "…" e ricontrolla.
  useEffect(() => {
    if (!sessionId) return undefined;
    let stopped = false;
    let timer;
    const load = () => {
      authFetch(`/api/history?tenantId=${tenant.id}&agentId=${agent.id}&sessionId=${sessionId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((h) => {
          if (stopped || busyRef.current) return;
          // Errore transitorio (es. server in riavvio): NON azzerare la chat, riprova.
          if (!Array.isArray(h)) {
            timer = setTimeout(load, 5000);
            return;
          }
          const msgs = h.map(({ role, text, attachments }, i) => ({ id: `h${i}`, role, text, attachments }));
          const pending = msgs.length > 0 && msgs[msgs.length - 1].role === 'user';
          if (pending) timer = setTimeout(load, 3000);
          setMessages((cur) => {
            if (pending) {
              // Se in locale c'e' gia' una risposta parziale (stream interrotto),
              // la si conserva nel placeholder invece di rimpiazzarla con "…".
              const curLast = cur[cur.length - 1];
              const keep = curLast?.role === 'assistant' && curLast.text
                ? { ...curLast, streaming: true }
                : { id: 'pending', role: 'assistant', text: '', streaming: true };
              return [...msgs, keep];
            }
            return msgs;
          });
        })
        .catch(() => {
          if (!stopped && !busyRef.current) timer = setTimeout(load, 5000);
        });
    };
    load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [tenant.id, agent.id, sessionId, pollNonce]);

  // Tiene queuedIdsRef allineato a `messages` dopo ogni render committato
  // (nuovo invio via onQueued, cancellazione, o il drain marcato piu' sotto):
  // e' la fonte di verita' che il poll di coda legge per calcolare `drained`.
  useEffect(() => {
    queuedIdsRef.current = new Set(
      messages.filter((msg) => msg.queued && msg.serverMessageId).map((msg) => msg.serverMessageId)
    );
  }, [messages]);

  // Sincronizza i messaggi in coda (task 13aad6c3, API 311d2946): il turno che
  // li consegna (drain a fine turno precedente) e' fire-and-forget lato server,
  // niente SSE per il client — nessun evento dice "consegnato ora". Un poll
  // leggero su /api/chat/queue copre 3 cose: seed all'apertura/refresh (coda
  // gia' presente, anche da un altro device), transizione "in coda" → normale
  // non appena il turno di consegna la preleva (sparisce dalla lista server),
  // e la riattivazione del poll storico sopra (pollNonce) per far comparire
  // la risposta dell'agente una volta che la coda si e' svuotata.
  useEffect(() => {
    if (!sessionId) return undefined;
    let stopped = false;
    let timer;
    const tick = async () => {
      let data;
      try {
        data = await apiJson(`/api/chat/queue?tenantId=${encodeURIComponent(tenant.id)}&agentId=${encodeURIComponent(agent.id)}&sessionId=${encodeURIComponent(sessionId)}`);
      } catch {
        if (!stopped) timer = setTimeout(tick, 3000);
        return;
      }
      if (stopped) return;
      const items = Array.isArray(data?.messages) ? data.messages : [];
      const liveIds = new Set(items.map((it) => it.id));
      // Drain derivato dai dati del poll (ref sincrono), non da un side-effect
      // dentro l'updater di setMessages: sotto automatic batching l'updater
      // puo' non girare prima di questo punto, e un `drained` letto da una
      // var mutata li' dentro resterebbe sempre false (task 6af5f541).
      const drained = [...queuedIdsRef.current].some((id) => !liveIds.has(id));
      setMessages((cur) => {
        const known = new Set(cur.filter((msg) => msg.queued).map((msg) => msg.serverMessageId));
        // Bolle non ancora rappresentate in locale (accodate da un altro
        // device/tab, o sopravvissute a un refresh di pagina).
        const seeded = items
          .filter((it) => !known.has(it.id))
          .map((it) => ({
            id: `q-${it.id}`,
            role: 'user',
            text: it.message,
            attachments: it.attachments?.length ? it.attachments : undefined,
            queued: true,
            serverMessageId: it.id,
          }));
        const next = cur.map((msg) => (
          !msg.queued || liveIds.has(msg.serverMessageId) ? msg : { ...msg, queued: false }
        ));
        return seeded.length ? [...next, ...seeded] : next;
      });
      if (drained) setPollNonce((n) => n + 1); // fa comparire la risposta via il poll storico sopra
      if (!stopped && items.length > 0) timer = setTimeout(tick, 2000);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [tenant.id, agent.id, sessionId, pollNonce]);

  useEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages]);

  // Tastiera iOS Safari (task board c376e7d6, completa il fix B3 di App.jsx):
  // --vvh tiene l'app ancorata al viewport visibile, ma il resize non
  // riscrolla da solo la lista messaggi — se l'utente era in fondo (stickRef),
  // l'apertura/chiusura tastiera lo deve riagganciare al fondo, altrimenti
  // l'ultimo messaggio/il composer restano fuori vista sotto la tastiera.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const onResize = () => {
      if (stickRef.current) bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  async function newConversation() {
    if (busy || !sessionId) return;
    if (messages.length > 0 && !window.confirm('Archiviare la conversazione corrente e iniziarne una nuova?')) return;
    try {
      await apiJson('/api/conversations/archive', {
        method: 'POST',
        body: { tenantId: tenant.id, agentId: agent.id, sessionId },
      });
    } catch {
      // anche se l'archiviazione fallisce (es. conversazione vuota) si riparte comunque
    }
    // Nuova conversazione registrata subito lato server (non un id locale a
    // caso): così è scopribile da altri device fin dal primo messaggio.
    let fresh;
    try {
      const conv = await apiJson('/api/conversations', { method: 'POST', body: { tenantId: tenant.id, agentId: agent.id } });
      fresh = conv.id;
    } catch {
      fresh = crypto.randomUUID(); // offline: si risincronizza al prossimo mount utile
    }
    localStorage.setItem(sessionKey(tenant.id, agent.id), fresh);
    localStorage.setItem(migratedKey(tenant.id, agent.id), fresh); // nulla da migrare: è nuova
    setMessages([]);
    setSessionId(fresh);
  }

  // Upload di uno o più file scelti (bottone o drag&drop). Ogni file parte subito;
  // la chip mostra lo stato (caricamento/errore/pronto). Il server valida
  // tipo/dimensione e risponde con un errore pulito → mostrato sulla chip.
  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      const localId = crypto.randomUUID();
      const isImage = (file.type || '').startsWith('image/');
      const previewUrl = isImage ? URL.createObjectURL(file) : null;
      setAttachments((a) => [...a, { localId, name: file.name, size: file.size, type: file.type, kind: isImage ? 'image' : undefined, status: 'uploading', previewUrl }]);
      try {
        const data = await uploadAttachment(`/api/uploads?tenantId=${encodeURIComponent(tenant.id)}`, file);
        setAttachments((a) => a.map((x) => (x.localId === localId ? { ...data, localId, previewUrl, status: 'done' } : x)));
      } catch (e) {
        setAttachments((a) => a.map((x) => (x.localId === localId ? { ...x, status: 'error', error: e.message } : x)));
      }
    }
  }

  function removeAttachment(localId) {
    setAttachments((a) => {
      const x = a.find((it) => it.localId === localId);
      if (x?.previewUrl) URL.revokeObjectURL(x.previewUrl);
      return a.filter((it) => it.localId !== localId);
    });
  }

  // Mirror best-effort verso l'API conversazioni (task e66dc5e1): la fonte
  // autoritativa resta lo storico server-side (history.js, già scritto da
  // /api/chat); questo aggiorna solo il puntatore condiviso tra device
  // (updatedAt/titolo) usato da resolveActiveSessionId. Non blocca né rompe
  // la chat se fallisce (es. offline, sessione non ancora sincronizzata).
  function mirrorToConversation(sentSessionId, userText, assistantText) {
    if (!sentSessionId) return;
    if (userText) {
      apiJson(`/api/conversations/${sentSessionId}/messages`, {
        method: 'POST',
        body: { tenantId: tenant.id, role: 'user', text: userText },
      }).catch(() => {});
    }
    if (assistantText && assistantText.trim()) {
      apiJson(`/api/conversations/${sentSessionId}/messages`, {
        method: 'POST',
        body: { tenantId: tenant.id, role: 'assistant', text: assistantText },
      }).catch(() => {});
    }
  }

  // Composer SEMPRE attivo (task 13aad6c3, coda API 311d2946): l'unico motivo
  // per non inviare e' un upload allegati ancora in corso o la sessione non
  // ancora risolta — MAI perche' l'agente sta rispondendo. Se la sessione e'
  // occupata da un turno in corso, e' il SERVER a deciderlo (risponde con
  // l'evento 'queued' invece di 'run'): il client non deve indovinarlo prima,
  // altrimenti due tab/dispositivi diversi finirebbero fuori sincrono.
  async function send() {
    const { message, uploading, ready, attachPayload, attachForBubble } = buildOutgoingMessage(input, attachments);
    if (uploading || !sessionId) return;
    if (!message && ready.length === 0) return;
    setInput('');
    setAttachments([]);
    // Bozza inviata: rimuovi subito la copia persistita (sincrono, così un
    // eventuale rimontaggio entro il debounce non ripristina testo già inviato).
    saveDraft(tenant.id, agent.id, '');

    // La bolla utente appare subito, sempre (in coda o no) — update mirati per
    // id: mai per indice, cosi' nessun setState su stato stantio puo' scrivere
    // sulla bolla sbagliata anche con piu' invii sovrapposti.
    const uid = crypto.randomUUID();
    setMessages((m) => [
      // 'pending' e' il segnaposto sintetico del poll storico (risposta in
      // lavorazione altrove, vedi effetto sopra): un nuovo invio lo sostituisce.
      // Non si tocca nessun'altra bolla: con la coda multipla possono convivere
      // piu' bolle utente "in coda" mentre al piu' una bolla assistant e'
      // davvero in streaming (esclusiva lato server, un turno per sessione).
      ...m.filter((msg) => msg.id !== 'pending'),
      { id: uid, role: 'user', text: message, attachments: attachForBubble.length ? attachForBubble : undefined },
    ]);
    // Sessione a cui appartiene questo invio (fissata all'avvio: se l'utente
    // cambia chat mentre la risposta arriva, il mirror va comunque sulla
    // conversazione giusta, non su quella eventualmente aperta ora).
    const sentSessionId = sessionId;
    let finalAssistantText = '';
    // aid: creato SOLO se il server avvia davvero un turno (evento 'run'); se
    // il messaggio va in coda non esiste alcuna bolla assistant per questa
    // chiamata, quindi patch() e' un no-op finche' aid resta null.
    let aid = null;
    let startedRun = false;
    let streamFailed = false;
    const patch = (fn) => {
      if (!aid) return;
      setMessages((m) => m.map((msg) => {
        if (msg.id !== aid) return msg;
        const next = fn(msg);
        finalAssistantText = next.text;
        return next;
      }));
    };
    const delta = createDeltaBuffer((text) => patch((msg) => ({ ...msg, text: msg.text + text })));

    try {
      const resp = await authFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: tenant.id, agentId: agent.id, message, sessionId, attachments: attachPayload }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      await consumeChatStream(resp, {
        // Sessione occupata: il server ha accodato invece di avviare un turno.
        // Marca la bolla utente appena aggiunta come "in coda" (cancellabile,
        // vedi cancelQueuedMessage/effetto di sync) — nessuna bolla assistant.
        onQueued: (data) => {
          setMessages((m) => m.map((msg) => (msg.id === uid
            ? { ...msg, queued: true, serverMessageId: data.messageId }
            : msg)));
          // Riavvia l'effetto queue-sync (spento se la coda era vuota al mount):
          // deve agganciare subito la bolla appena accodata e, a drain avvenuto,
          // riattivare anche il poll storico per far comparire la risposta (fix
          // bocciatura gate: senza questo, i messaggi #2/#3 restavano "in coda"
          // per sempre finche' non c'era un remount/refresh manuale).
          setPollNonce((n) => n + 1);
        },
        onRun: (data) => {
          startedRun = true;
          runIdRef.current = data.runId;
          setBusy(true);
          busyRef.current = true;
          aid = crypto.randomUUID();
          setMessages((m) => [...m, { id: aid, role: 'assistant', text: '', streaming: true }]);
        },
        onDelta: (data) => delta.push(data.text),
        onStopped: (data) => {
          // Chiusura pulita da stop/pausa manuale: testo parziale mantenuto.
          delta.flush();
          patch((msg) => ({ ...msg, stopped: data.status ?? 'stopped' }));
          // Con la pausa la risposta arriverà alla ripresa: polling riattivo.
          if (data.status === 'paused') streamFailed = true;
        },
        onReset: () => {
          // Il server riparte da zero (retry senza resume): buffer azzerato,
          // altrimenti i due tentativi si concatenerebbero (testo duplicato).
          delta.reset();
          delta.flush();
          patch((msg) => ({ ...msg, text: '' }));
        },
        onDone: (data) => {
          // Testo finale autoritativo dal server: sana eventuali delta persi.
          delta.flush();
          if (typeof data.fullText === 'string' && data.fullText) {
            patch((msg) => ({ ...msg, text: data.fullText }));
          }
        },
        onError: (data) => {
          // Il testo parziale gia' ricevuto NON si tocca: si annota l'errore.
          delta.flush();
          streamFailed = true;
          patch((msg) => ({ ...msg, error: data.message }));
        },
      });
    } catch (e) {
      streamFailed = true;
      if (startedRun) {
        patch((msg) => ({ ...msg, error: `connessione persa (${e.message}) — la risposta continua sul server` }));
      } else {
        // Errore prima ancora di sapere se in coda o avviato subito (rete
        // caduta a meta'): l'errore va sulla bolla utente stessa.
        setMessages((m) => m.map((msg) => (msg.id === uid ? { ...msg, error: `invio fallito (${e.message})` } : msg)));
      }
    } finally {
      delta.flush(); // nessun delta residuo va perso alla chiusura dello stream
      if (startedRun) {
        setMessages((m) => m.map((msg) => (msg.id === aid ? { ...msg, streaming: false } : msg)));
        setBusy(false);
        busyRef.current = false;
        runIdRef.current = null;
        // Stream chiuso male: la run puo' continuare/riprendere lato server.
        // Si riattiva il polling per mostrare la risposta appena persistita.
        if (streamFailed) setPollNonce((n) => n + 1);
      }
      mirrorToConversation(sentSessionId, message, finalAssistantText);
    }
  }

  // Cancella un messaggio ancora in coda (tap sulla × della bolla, task
  // 13aad6c3): DELETE /api/chat/queue/:messageId. Se nel frattempo e' già
  // partito il turno di consegna (404, "già consegnato o mai esistito"), non
  // si rimuove la bolla — il prossimo giro dell'effetto di sync sotto la
  // trova drenata e la marca normale da sola (nessun salto visibile).
  async function cancelQueuedMessage(m) {
    if (!m.serverMessageId) return;
    try {
      await apiJson(`/api/chat/queue/${m.serverMessageId}?tenantId=${encodeURIComponent(tenant.id)}&agentId=${encodeURIComponent(agent.id)}&sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      setMessages((cur) => cur.filter((msg) => msg.id !== m.id));
    } catch {
      // già consegnato o coda svuotata: lasciata al sync qui sotto
    }
  }

  // STOP: riusa la logica delle run (journal sticky + interrupt del claude-cli).
  // Lo stream SSE si chiuderà da solo con l'evento 'stopped' (testo parziale
  // mantenuto in UI e persistito dal server).
  async function stopGeneration() {
    const id = runIdRef.current;
    if (!id) return; // runId non ancora arrivato: la run sta ancora partendo
    try {
      await apiJson(`/api/runs/${id}/stop`, { method: 'POST', body: { tenantId: tenant.id } });
    } catch (e) {
      console.warn('stop fallito:', e.message);
    }
  }

  // Indicatore aggregato "N in coda" (task 13aad6c3): derivato a render, mai
  // stato a parte — resta sempre coerente con le singole bolle "queued".
  const queuedCount = messages.filter((m) => m.queued).length;

  if (view === 'archived' && archivedConv) {
    return <ArchivedView tenant={tenant} conv={archivedConv} onBack={() => setView('archive-list')} />;
  }
  if (view === 'archive-list') {
    return (
      <ArchiveList
        tenant={tenant}
        agent={agent}
        onOpen={(conv) => { setArchivedConv(conv); setView('archived'); }}
        onBack={() => setView('chat')}
      />
    );
  }

  return (
    <>
      <header className="topbar">
        <button className="back" onClick={onBack}>←</button>
        <h1>
          {agent.name}
          <small className="muted"> · {tenant.name}</small>
        </h1>
        <span className="topbar-right">
          <button className="back" title="Conversazioni archiviate" onClick={() => setView('archive-list')}>🗂</button>
          <button className="back" title="Nuova conversazione" onClick={newConversation}>＋</button>
        </span>
      </header>
      {/* Badge stato bloccato (task 967e0385): la chat col CEO resta pienamente
          usabile da bloccato, qui solo l'avviso. */}
      {blocked?.blocked && (
        <div className="chat-blocked-banner" role="status">
          🚫 <strong>BLOCCATO</strong> — solo la chat con il CEO è attiva
        </div>
      )}
      <main
        className={`chat ${dragOver ? 'drag-over' : ''}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
        }}
      >
        {!sessionId && <p className="muted center">Sincronizzazione chat…</p>}
        {sessionId && messages.length === 0 && (
          <p className="muted center">Inizia la conversazione con {agent.name} ({agent.role}).</p>
        )}
        {messages.map((m, i) => <Bubble key={m.id ?? i} m={m} color={tenant.color} onCancelQueued={cancelQueuedMessage} />)}
        <div ref={bottomRef} />
        {dragOver && <div className="drop-overlay">Rilascia i file per allegarli</div>}
      </main>
      <footer className="composer">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          style={{ display: 'none' }}
          onChange={(e) => { if (e.target.files?.length) uploadFiles(e.target.files); e.target.value = ''; }}
        />
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((att) => (
              <AttachmentChip key={att.localId} att={att} onRemove={() => removeAttachment(att.localId)} />
            ))}
          </div>
        )}
        {/* Indicatore coda (task 13aad6c3): visibile solo quando c'e' almeno un
            messaggio in coda, sopra la riga di composizione — sempre attiva. */}
        {queuedCount > 0 && (
          <div className="queue-indicator">
            {queuedCount === 1 ? '1 messaggio in coda' : `${queuedCount} in coda`}
          </div>
        )}
        <div className="composer-row">
          <button
            type="button"
            className="attach"
            title="Allega un file (immagine, PDF, testo)"
            onClick={() => fileInputRef.current?.click()}
          >📎</button>
          <MicButton onText={(text) => setInput((prev) => (prev ? `${prev} ${text}` : text))} />
          <textarea
            ref={taRef}
            rows={1}
            enterKeyHint="enter"
            value={input}
            placeholder={`Scrivi a ${agent.name}…`}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => handleComposerKeyDown(e, send)}
          />
          {/* Composer sempre attivo (task 13aad6c3): il bottone invio resta
              presente ANCHE mentre l'agente risponde — il nuovo messaggio si
              accoda da solo (lato server). STOP resta disponibile in più,
              mai al posto dell'invio. */}
          <div className="composer-actions">
            {busy && (
              <button type="button" className="stop" onClick={stopGeneration} title="Ferma la generazione">■</button>
            )}
            <button
              onClick={send}
              title={busy ? 'Invia (si accoda finché l’agente risponde)' : 'Invia'}
              disabled={(!input.trim() && !attachments.some((a) => a.status === 'done')) || attachments.some((a) => a.status === 'uploading')}
            >➤</button>
          </div>
        </div>
      </footer>
    </>
  );
}
