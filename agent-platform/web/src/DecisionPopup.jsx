import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiJson } from './api.js';
import { handleComposerKeyDown } from './lib/composerKeys.js';
import { formatWaitAge, waitHours } from './lib/timeAgo.js';
import RequestDetail from './RequestDetail.jsx';

// Soglia di trascinamento (px) oltre la quale lo swipe-down sul grabber chiude
// il popup (fix bug Owner 2026-07-25, task a21fb75c: X/Salta irraggiungibili
// con richieste lunghe).
const SWIPE_CLOSE_PX = 70;

// Sopra questa soglia una richiesta è "vecchia": badge evidenziato (task board
// a5c38265, evidenza Owner 25-27/07: richieste ferme >12h senza segnalazione).
const OVERDUE_HOURS = 12;

// Popup/schermata dedicata delle decisioni (task board 69413a7e): mostra UNA
// cosa da decidere alla volta (stile inbox), con contesto breve, domanda secca,
// bottoni opzione + campo testo libero. La risposta torna all'agente/task senza
// che Owner navighi altrove. Coda: se ce n'è più di una, avanza alla successiva.
const decKey = (d) => `${d.kind}:${d.id}`;

export default function DecisionPopup({ decisions, focusKey, onResolved, onClose }) {
  const [cursor, setCursor] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Thread multi-turno (task f1333f2d): riporta la conversazione botta-e-risposta
  // sulla singola richiesta DENTRO il popup unificato, senza viste/FAB separati.
  // Consuma GET/POST /api/tasks/:id/messages già esistenti (server/lib/taskchat.js).
  const [threadOpen, setThreadOpen] = useState(false);
  const [messages, setMessages] = useState(null); // null = non ancora caricato
  const [threadBusy, setThreadBusy] = useState(false);
  const [threadText, setThreadText] = useState('');
  const [threadError, setThreadError] = useState(null);
  // Schermata dettaglio full-screen (task board f26817e2, richiesta Owner
  // 2026-07-25: "ℹ Più informazioni" nel popup "Da decidere"). Dipende
  // dall'API dettaglio task (ac3067d0, GET /api/tasks/:id): disponibile solo
  // per kind 'task' (le richieste vere), non per le approvazioni tool — un
  // effetto sotto la richiude in automatico se la coda avanza su un tool.
  const [detailOpen, setDetailOpen] = useState(false);
  const taRef = useRef(null);
  const threadTaRef = useRef(null);
  const touchStartY = useRef(null);

  // Impatto di ogni richiesta "task" sulla board (task board a5c38265, evidenza
  // pm-platform: board ferma perché una sola richiesta senza risposta blocca 3
  // task e in nessun punto della UI si vede). Nessun endpoint nuovo: riusa
  // GET /api/tasks?tenantId= (già consumato da TaskBoard) per contare, per ogni
  // decisione di tipo 'task', quante task ANCORA aperte hanno il suo id in
  // blockedBy. Le approvazioni tool ('kind: tool') non bloccano task e restano
  // fuori dal conteggio.
  const [blockCounts, setBlockCounts] = useState({});
  useEffect(() => {
    const tenantIds = [...new Set(decisions.filter((d) => d.kind === 'task').map((d) => d.tenantId))];
    if (tenantIds.length === 0) { setBlockCounts({}); return undefined; }
    let cancelled = false;
    Promise.all(tenantIds.map((tid) => apiJson(`/api/tasks?tenantId=${encodeURIComponent(tid)}`).catch(() => [])))
      .then((lists) => {
        if (cancelled) return;
        const counts = {};
        lists.flat().forEach((t) => {
          if (t.status === 'done') return; // già chiusa: non "ferma in attesa"
          (t.blockedBy ?? []).forEach((id) => { counts[id] = (counts[id] ?? 0) + 1; });
        });
        setBlockCounts(counts);
      });
    return () => { cancelled = true; };
  }, [decisions]);

  // Coda riordinata per impatto (chi sblocca più lavoro prima), poi per età
  // (chi aspetta di più a parità di impatto) — requisito 3 task a5c38265.
  // decisions dal server arriva già ordinata per data; qui si ridefinisce
  // SOLO l'ordine mostrato, l'id/i dati restano quelli del server.
  const orderedDecisions = useMemo(() => {
    return decisions
      .map((d) => ({ ...d, unlockCount: d.kind === 'task' ? (blockCounts[d.id] ?? 0) : 0 }))
      .sort((a, b) => {
        if (b.unlockCount !== a.unlockCount) return b.unlockCount - a.unlockCount;
        if (a.requestedAt !== b.requestedAt) return a.requestedAt < b.requestedAt ? -1 : 1; // più vecchia prima
        return 0;
      });
  }, [decisions, blockCounts]);

  // Riepilogo in testa alla coda (requisito 4): quante richieste, da quanto
  // aspetta la più vecchia, quante task della board restano ferme per colpa
  // loro. Calcolato sull'INTERA coda, non sulla sola richiesta a schermo.
  const queueSummary = useMemo(() => {
    if (orderedDecisions.length === 0) return null;
    const oldest = orderedDecisions.reduce((acc, d) => (d.requestedAt < acc ? d.requestedAt : acc), orderedDecisions[0].requestedAt);
    const totalUnlocked = orderedDecisions.reduce((sum, d) => sum + d.unlockCount, 0);
    return {
      count: orderedDecisions.length,
      oldestAge: formatWaitAge(oldest),
      totalUnlocked,
    };
  }, [orderedDecisions]);

  // Chiusura con Esc da desktop: la X e i controlli di navigazione possono
  // finire fuori viewport con richieste lunghe, Esc resta sempre disponibile.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Tap fuori dalla card (sull'overlay) chiude, come Esc.
  function onOverlayClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  // Swipe-down sul grabber (mobile, bottom-sheet) chiude il popup.
  function onGrabberTouchStart(e) { touchStartY.current = e.touches[0].clientY; }
  function onGrabberTouchEnd(e) {
    if (touchStartY.current == null) return;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    touchStartY.current = null;
    if (dy > SWIPE_CLOSE_PX) onClose();
  }

  // Textarea auto-espandibile fino a ~5 righe (poi scroll interno), come negli
  // altri campi di composizione messaggio (Chat, Requests).
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  // All'apertura (o quando cambia il focus da una push) salta sulla decisione giusta.
  useEffect(() => {
    if (!focusKey) return;
    const i = orderedDecisions.findIndex((d) => decKey(d) === focusKey);
    if (i >= 0) setCursor(i);
  }, [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mantieni il cursore in un range valido quando la coda si accorcia.
  useEffect(() => {
    if (decisions.length === 0) { onClose(); return; }
    if (cursor > decisions.length - 1) setCursor(decisions.length - 1);
  }, [decisions.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset del campo testo e del thread passando da una decisione all'altra.
  useEffect(() => {
    setText('');
    setError(null);
    setThreadOpen(false);
    setMessages(null);
    setThreadText('');
    setThreadError(null);
  }, [cursor]);

  const dec = orderedDecisions[Math.min(cursor, orderedDecisions.length - 1)];
  const accent = useMemo(() => dec?.tenantColor ?? '#7c6cf0', [dec]);
  const waitAge = dec ? formatWaitAge(dec.requestedAt) : null;
  const overdue = dec ? waitHours(dec.requestedAt) >= OVERDUE_HOURS : false;

  // La schermata dettaglio esiste solo per kind 'task' (dipende da GET
  // /api/tasks/:id): se la coda avanza su un'approvazione tool mentre è
  // aperta, si torna al bottom-sheet invece di mostrare un dettaglio vuoto.
  useEffect(() => {
    if (detailOpen && dec?.kind !== 'task') setDetailOpen(false);
  }, [detailOpen, dec]);

  if (!dec) return null;

  async function send(body) {
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/decisions/${dec.kind}/${dec.id}?tenantId=${encodeURIComponent(dec.tenantId)}`, {
        method: 'POST',
        body: { tenantId: dec.tenantId, ...body },
      });
      setText('');
      await onResolved(); // refetch: la coda si aggiorna, l'effetto avanza da solo
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Auto-resize della textarea del thread (stesso comportamento del composer principale).
  useEffect(() => {
    const el = threadTaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [threadText, threadOpen]);

  // Carica lo storico messaggi della task alla prima apertura del thread.
  async function loadThread() {
    if (!dec || dec.kind !== 'task') return;
    setThreadBusy(true);
    setThreadError(null);
    try {
      const list = await apiJson(`/api/tasks/${dec.id}/messages?tenantId=${encodeURIComponent(dec.tenantId)}`);
      setMessages(Array.isArray(list) ? list : []);
    } catch (err) {
      setThreadError(err.message);
    } finally {
      setThreadBusy(false);
    }
  }

  // Toggle "Discuti": apre/chiude il thread; carica i messaggi solo al primo apri.
  function toggleThread() {
    const next = !threadOpen;
    setThreadOpen(next);
    if (next && messages === null) loadThread();
  }

  // Apre la schermata dettaglio a schermo intero (bottone "ℹ Più informazioni").
  function openDetail() {
    setDetailOpen(true);
  }

  // Nel dettaglio il thread è SEMPRE visibile (non un accordion come
  // "Discuti"): va ricaricato all'apertura e ad ogni cambio di richiesta
  // (Precedente/Salta dentro RequestDetail cambia `cursor`, che azzera già
  // `messages` a null nell'effetto sopra).
  useEffect(() => {
    if (detailOpen) loadThread();
  }, [detailOpen, cursor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Invia un messaggio nel thread. Endpoint già presente: per una task in
  // needs_input il server instrada il testo come risposta (answerTaskDecision)
  // e la task esce dalla coda -> onResolved avanza alla successiva.
  async function sendThread() {
    const t = threadText.trim();
    if (!t) return;
    setThreadBusy(true);
    setThreadError(null);
    try {
      await apiJson(`/api/tasks/${dec.id}/messages?tenantId=${encodeURIComponent(dec.tenantId)}`, {
        method: 'POST',
        body: { tenantId: dec.tenantId, text: t },
      });
      setThreadText('');
      await loadThread();
      await onResolved(); // la coda si aggiorna (la task risolta esce), l'effetto avanza
    } catch (err) {
      setThreadError(err.message);
    } finally {
      setThreadBusy(false);
    }
  }

  // Click su un'opzione a bottone.
  function chooseOption(opt) {
    if (dec.kind === 'tool') {
      // Tool: value = approve/deny, il testo è una nota facoltativa.
      send({ value: opt.value, text: text.trim() || undefined });
    } else {
      // Task: componi la risposta (etichetta opzione + eventuale testo libero).
      const answer = [opt.label, text.trim()].filter(Boolean).join(' — ');
      send({ value: opt.value, answer });
    }
  }

  // Invio del solo testo libero (risposta "come in chat", senza scegliere un bottone).
  function sendText() {
    const t = text.trim();
    if (!t) { setError('Scrivi una risposta o scegli un\'opzione.'); return; }
    if (dec.kind === 'tool') send({ value: 'approve', text: t }); // testo su tool = approva con nota
    else send({ answer: t });
  }

  // Schermata dettaglio full-screen (non un altro popup, vedi RequestDetail):
  // sostituisce l'intero bottom-sheet finché aperta, "← Torna" riporta qui
  // senza perdere la bozza (text/thread restano nello stato di questo
  // componente, non vengono resettati dal toggle di detailOpen).
  if (detailOpen) {
    return (
      <RequestDetail
        dec={dec}
        cursor={cursor}
        total={orderedDecisions.length}
        waitAge={waitAge}
        overdue={overdue}
        unlockCount={dec.unlockCount}
        onPrev={() => setCursor((c) => Math.max(0, c - 1))}
        onSkip={() => setCursor((c) => Math.min(orderedDecisions.length - 1, c + 1))}
        onBack={() => setDetailOpen(false)}
        onCloseAll={onClose}
        busy={busy}
        error={error}
        onChooseOption={chooseOption}
        messages={messages}
        threadLoading={threadBusy && messages === null}
        threadBusy={threadBusy}
        threadText={threadText}
        setThreadText={setThreadText}
        threadError={threadError}
        onSendThread={sendThread}
      />
    );
  }

  return (
    <div className="decision-overlay" role="dialog" aria-modal="true" onClick={onOverlayClick}>
      <div className="decision-card" style={{ '--accent': accent }}>
        {/* Grabber: solo mobile, drag-handle per lo swipe-down di chiusura. */}
        <div
          className="decision-grabber"
          onTouchStart={onGrabberTouchStart}
          onTouchEnd={onGrabberTouchEnd}
        />

        {/* Header fisso: titolo/contatore/X sempre visibili e cliccabili
            qualunque sia la lunghezza del contenuto (fix bug X/Salta fuori
            viewport, task a21fb75c). */}
        <div className="decision-head">
          <span className="decision-count">{cursor + 1} di {orderedDecisions.length}</span>
          <span className="decision-tenant">{dec.tenantName}</span>
          <button className="decision-x" onClick={onClose} aria-label="Chiudi">✕</button>
        </div>

        {/* Riepilogo coda (requisito 4, task a5c38265): a colpo d'occhio quante
            richieste ci sono, da quanto aspetta la più vecchia e quanto lavoro
            della board resta fermo — senza dover scorrere una per una. */}
        {queueSummary && (
          <div className="decision-queue-summary">
            {queueSummary.count === 1 ? '1 richiesta' : `${queueSummary.count} richieste`}
            {queueSummary.oldestAge && `, la più vecchia da ${queueSummary.oldestAge}`}
            {queueSummary.totalUnlocked > 0 && (
              queueSummary.totalUnlocked === 1
                ? ', 1 task ferma in attesa'
                : `, ${queueSummary.totalUnlocked} task ferme in attesa`
            )}
          </div>
        )}

        {/* Corpo: unica parte scrollabile della card. */}
        <div className="decision-body">
          {/* Età + impatto DI QUESTA richiesta (requisiti 1-2): prima cosa
              visibile aprendo la card, badge evidente sopra le 12h di attesa. */}
          <div className="decision-meta-row">
            {waitAge && (
              <span className={`decision-age-badge${overdue ? ' overdue' : ''}`}>
                ⏱ in attesa da {waitAge}
              </span>
            )}
            {dec.kind === 'task' && dec.unlockCount > 0 && (
              <span className="decision-impact-badge">
                🔓 sblocca {dec.unlockCount === 1 ? '1 task' : `${dec.unlockCount} task`}
              </span>
            )}
          </div>
          {dec.kind === 'task' && dec.title && <div className="decision-task-title">{dec.title}</div>}
          {dec.agentName && <div className="decision-agent">🤖 {dec.agentName}</div>}
          {dec.goal && <div className="decision-goal">🎯 {dec.goal}</div>}
          <h2 className="decision-question">{dec.question}</h2>
          {dec.context && <p className="decision-context">{dec.context}</p>}
          {dec.steps?.length > 0 && (
            <ol className="decision-steps">
              {dec.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          )}
          {error && <p className="error">{error}</p>}

          {/* Thread multi-turno (solo task): azione opzionale che espande la
              conversazione esistente senza reintrodurre viste/FAB separati.
              Vive nel corpo scrollabile: header/footer restano fissi. */}
          {dec.kind === 'task' && (
            <div className="decision-thread">
              <button
                className="decision-thread-toggle"
                onClick={toggleThread}
                aria-expanded={threadOpen}
              >
                {threadOpen ? '▾' : '▸'} Discuti
                {messages?.length > 0 && <span className="decision-thread-count">{messages.length}</span>}
              </button>

              {threadOpen && (
                <div className="decision-thread-body">
                  {threadBusy && messages === null && <p className="decision-thread-empty">Carico…</p>}
                  {messages?.length === 0 && !threadBusy && (
                    <p className="decision-thread-empty">Nessun messaggio. Scrivi il primo qui sotto.</p>
                  )}
                  {messages?.map((m) => (
                    <div key={m.id} className={`decision-msg ${m.author?.startsWith('user:') ? 'me' : 'them'}`}>
                      <div className="decision-msg-meta">{m.authorName}</div>
                      <div className="decision-msg-text">{m.text}</div>
                    </div>
                  ))}
                  {threadError && <p className="error">{threadError}</p>}

                  <div className="decision-thread-composer">
                    <textarea
                      ref={threadTaRef}
                      value={threadText}
                      placeholder="Scrivi nel thread…"
                      rows={1}
                      enterKeyHint="send"
                      disabled={threadBusy}
                      onChange={(e) => setThreadText(e.target.value)}
                      onKeyDown={(e) => handleComposerKeyDown(e, sendThread)}
                    />
                    <button
                      className="decision-send"
                      disabled={threadBusy || !threadText.trim()}
                      onClick={sendThread}
                    >
                      {threadBusy ? '…' : 'Invia'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer fisso: opzioni + composer + Precedente/Salta, sempre
            raggiungibili senza scroll di pagina. */}
        <div className="decision-footer">
          {dec.options.length > 0 && (
            <div className="decision-options">
              {dec.options.map((opt) => (
                <button
                  key={opt.value}
                  className={`decision-opt opt-${opt.style ?? 'neutral'}`}
                  disabled={busy}
                  onClick={() => chooseOption(opt)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}

          {dec.allowText && (
            <div className="decision-text">
              <textarea
                ref={taRef}
                value={text}
                placeholder={dec.textLabel ?? 'Rispondi come in chat…'}
                rows={1}
                enterKeyHint="enter"
                disabled={busy}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => handleComposerKeyDown(e, sendText)}
              />
              {/* "ℹ Più informazioni" (task board f26817e2, richiesta Owner
                  2026-07-25): apre il messaggio completo + thread a schermo
                  intero. Solo kind 'task' (dipende da GET /api/tasks/:id). */}
              {dec.kind === 'task' && (
                <button
                  type="button"
                  className="decision-info-btn"
                  onClick={openDetail}
                  aria-label="Più informazioni"
                  title="Più informazioni"
                >
                  ℹ
                </button>
              )}
              <button className="decision-send" disabled={busy || !text.trim()} onClick={sendText}>
                {busy ? '…' : 'Rispondi'}
              </button>
            </div>
          )}

          {orderedDecisions.length > 1 && (
            <div className="decision-nav">
              <button disabled={busy || cursor === 0} onClick={() => setCursor((c) => Math.max(0, c - 1))}>‹ Precedente</button>
              <button disabled={busy || cursor >= orderedDecisions.length - 1} onClick={() => setCursor((c) => Math.min(orderedDecisions.length - 1, c + 1))}>Salta ›</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
