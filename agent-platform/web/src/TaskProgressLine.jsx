import React from 'react';

// Barra compatta "fatte vs in coda" (task board 920d5040): finestra ultimi 3
// giorni, calcolata client-side da TenantHome/TenantPicker con
// computeTaskProgress. Tap → apre la task board filtrata (onOpen riceve
// 'done' o 'attive' a seconda della parte toccata).
export default function TaskProgressLine({ stats, accent, label, onOpen, compact }) {
  if (!stats || stats.total === 0) return null;
  const { done, queue, needsInput } = stats;
  const donePct = Math.round((done / stats.total) * 100);
  return (
    <div className={`progress-line${compact ? ' compact' : ''}`} style={{ '--accent': accent ?? 'var(--accent)' }}>
      {label && <div className="progress-line-label">{label}</div>}
      <button
        type="button"
        className="progress-line-bar"
        style={{ '--done-pct': `${donePct}%` }}
        onClick={() => onOpen?.(queue > 0 ? 'attive' : 'done')}
        aria-label={`${done} task fatte, ${queue} in coda`}
      >
        <span className="progress-line-fill" />
      </button>
      <div className="progress-line-counts">
        <button type="button" className="progress-line-count" onClick={() => onOpen?.('done')}>
          ✅ {done} fatte
        </button>
        <span className="progress-line-sep">/</span>
        <button type="button" className="progress-line-count" onClick={() => onOpen?.('attive')}>
          🕓 {queue} in coda
        </button>
        {needsInput > 0 && (
          <button type="button" className="progress-line-needs-input" onClick={() => onOpen?.('needs_input')}>
            ⏸️ {needsInput} da Owner
          </button>
        )}
      </div>
    </div>
  );
}
