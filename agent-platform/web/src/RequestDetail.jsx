import React, { useEffect, useRef, useState } from 'react';
import { apiJson } from './api.js';
import { handleComposerKeyDown } from './lib/composerKeys.js';
import { splitStepParts, isDesktopOnlyStep } from './lib/stepFormat.js';

// Chip di un comando estratto da uno step: tap-to-copy, con conferma visiva
// breve. Fallback a execCommand('copy') per contesti senza Clipboard API
// (Safari/iOS più vecchi, o pagina non servita in https durante lo sviluppo).
function CopyChip({ code }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // copia best-effort: nessun blocco se fallisce (permessi negati, ecc.)
    }
  }
  return (
    <button type="button" className="step-code" onClick={copy} title="Tocca per copiare">
      <code>{code}</code>
      <span className="step-code-copy">{copied ? '✓ copiato' : '⧉ copia'}</span>
    </button>
  );
}

function StepLine({ step }) {
  const parts = splitStepParts(step);
  const desktop = isDesktopOnlyStep(step);
  return (
    <li>
      {desktop && <span className="step-badge">🖥 da fare da computer</span>}
      <span className="step-text">
        {parts.map((p, i) => (
          p.code
            ? <CopyChip key={i} code={p.code} />
            : <React.Fragment key={i}>{p.text}</React.Fragment>
        ))}
      </span>
    </li>
  );
}

// Schermata dettaglio richiesta full-screen (task board f26817e2, richiesta
// Owner 2026-07-25): dal bottone "ℹ Più informazioni" del bottom-sheet "Da
// decidere" — mostra il messaggio COMPLETO (goal/domanda/contesto/step con
// comandi copiabili) + una sezione "Dettagli task" richiudibile (dipende
// dall'API dettaglio, task ac3067d0: GET /api/tasks/:id) + il thread di chat
// per lo scambio botta e risposta, sempre visibile (non un accordion come il
// "Discuti" del bottom-sheet, qui è la vista principale).
//
// Stato del thread (messages/threadBusy/threadText/...) e delle opzioni/testo
// libero restano di proprietà del DecisionPopup padre e arrivano come prop:
// stessa fonte dati della vista bottom-sheet, niente duplicazione, e la bozza
// nel composer del thread sopravvive al tornare indietro (← non la resetta,
// la resetta solo il cambio di richiesta in coda, in DecisionPopup).
export default function RequestDetail({
  dec, cursor, total, waitAge, overdue, unlockCount, onPrev, onSkip, onBack, onCloseAll,
  busy, error, onChooseOption,
  messages, threadLoading, threadBusy, threadText, setThreadText, threadError, onSendThread,
}) {
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const bottomRef = useRef(null);
  const taRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    apiJson(`/api/tasks/${dec.id}?tenantId=${encodeURIComponent(dec.tenantId)}`)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((err) => { if (!cancelled) setDetailError(err.message); });
    return () => { cancelled = true; };
  }, [dec.id, dec.tenantId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages?.length]);

  // Textarea del composer del thread: auto-espandibile come nel resto della PWA.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [threadText]);

  return (
    <div className="request-detail">
      <div className="request-detail-inner">
      <header className="topbar">
        <button className="back" onClick={onBack} aria-label="Torna alla richiesta">←</button>
        <h1>
          {dec.tenantName}
          {total > 1 && <small className="muted"> · {cursor + 1} di {total}</small>}
        </h1>
        <span className="topbar-right">
          <button className="back" onClick={onCloseAll} aria-label="Chiudi">✕</button>
        </span>
      </header>

      <main className="page request-detail-body">
        {(waitAge || unlockCount > 0) && (
          <div className="decision-meta-row">
            {waitAge && (
              <span className={`decision-age-badge${overdue ? ' overdue' : ''}`}>
                ⏱ in attesa da {waitAge}
              </span>
            )}
            {unlockCount > 0 && (
              <span className="decision-impact-badge">
                🔓 sblocca {unlockCount === 1 ? '1 task' : `${unlockCount} task`}
              </span>
            )}
          </div>
        )}
        {dec.agentName && <div className="decision-agent">🤖 {dec.agentName}</div>}
        {dec.goal && <div className="rd-goal">🎯 {dec.goal}</div>}
        <h2 className="rd-question">{dec.question}</h2>
        {dec.context && <p className="decision-context">{dec.context}</p>}

        {dec.steps?.length > 0 && (
          <ol className="decision-steps rd-steps">
            {dec.steps.map((s, i) => <StepLine key={i} step={s} />)}
          </ol>
        )}

        {dec.options?.length > 0 && (
          <div className="decision-options rd-options">
            {dec.options.map((opt) => (
              <button
                key={opt.value}
                className={`decision-opt opt-${opt.style ?? 'neutral'}`}
                disabled={busy}
                onClick={() => onChooseOption(opt)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
        {error && <p className="error">{error}</p>}

        <section className="rd-section">
          <button
            type="button"
            className="decision-thread-toggle"
            onClick={() => setInfoOpen((o) => !o)}
            aria-expanded={infoOpen}
          >
            {infoOpen ? '▾' : '▸'} Dettagli task
          </button>
          {infoOpen && (
            <div className="rd-details">
              {detailError && <p className="error">Dettagli non disponibili: {detailError}</p>}
              {!detail && !detailError && <p className="muted">Carico…</p>}
              {detail && (
                <>
                  {detail.description && <p className="rd-desc">{detail.description}</p>}
                  <dl className="rd-meta">
                    <div><dt>Richiesta da</dt><dd>{dec.agentName ?? '—'}</dd></div>
                    <div><dt>Assegnata a</dt><dd>{detail.assignedToName ?? detail.workerName ?? '—'}</dd></div>
                    <div><dt>Stato</dt><dd>{detail.status}</dd></div>
                  </dl>
                  {(detail.note || detail.revisionNote) && (
                    <div className="rd-history">
                      <div className="rd-history-title">Nota corrente</div>
                      <p className="rd-desc">{detail.revisionNote || detail.note}</p>
                    </div>
                  )}
                  {detail.reviewHistory?.length > 0 && (
                    <div className="rd-history">
                      <div className="rd-history-title">Cronologia note</div>
                      {detail.reviewHistory.map((r, i) => (
                        <div key={i} className="rd-history-item">
                          <span className={`rd-history-decision ${r.decision}`}>{r.decision === 'approve' ? '✓' : '✕'}</span>
                          <span className="rd-history-note">{r.note || '(nessuna nota)'}</span>
                          {r.at && <span className="rd-history-at">{new Date(r.at).toLocaleString('it-IT')}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </section>

        <section className="rd-thread">
          <div className="rd-thread-title">Conversazione</div>
          {threadLoading && (!messages || messages.length === 0) && <p className="muted">Carico…</p>}
          {messages?.length === 0 && !threadLoading && (
            <p className="decision-thread-empty">Nessun messaggio. Scrivi qui sotto.</p>
          )}
          {messages?.map((m) => (
            <div key={m.id} className={`decision-msg ${m.author?.startsWith('user:') ? 'me' : 'them'}`}>
              <div className="decision-msg-meta">{m.authorName}</div>
              <div className="decision-msg-text">{m.text}</div>
            </div>
          ))}
          {threadError && <p className="error">{threadError}</p>}
          <div ref={bottomRef} />
        </section>
      </main>

      <footer className="composer rd-composer">
        <div className="composer-row">
          <textarea
            ref={taRef}
            rows={1}
            enterKeyHint="send"
            value={threadText}
            placeholder="Rispondi nel thread…"
            disabled={threadBusy}
            onChange={(e) => setThreadText(e.target.value)}
            onKeyDown={(e) => handleComposerKeyDown(e, onSendThread)}
          />
          <button disabled={threadBusy || !threadText.trim()} onClick={onSendThread}>
            {threadBusy ? '…' : '➤'}
          </button>
        </div>
        {total > 1 && (
          <div className="decision-nav rd-nav">
            <button disabled={busy || cursor === 0} onClick={onPrev}>‹ Precedente</button>
            <button disabled={busy || cursor >= total - 1} onClick={onSkip}>Salta ›</button>
          </div>
        )}
      </footer>
      </div>
    </div>
  );
}
