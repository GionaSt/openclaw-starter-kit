// Calcolo progress line "fatte vs in coda" (task board 920d5040).
// Finestra: contano solo le task create O aggiornate negli ultimi 3 giorni —
// una vecchia "done" non gonfia la barra, una "todo" parcheggiata da mesi non
// la sporca. "fatte" = done; "in coda" = tutto il resto (todo, in_progress,
// review_manager, review_ceo, revisione, needs_input) — needs_input è anche
// contata a parte per l'evidenza dedicata (Owner in attesa).
export const PROGRESS_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export function computeTaskProgress(tasks, now = Date.now()) {
  const cutoff = now - PROGRESS_WINDOW_MS;
  const recent = (tasks ?? []).filter((t) => {
    const created = new Date(t.createdAt).getTime();
    const updated = new Date(t.updatedAt).getTime();
    return (Number.isFinite(created) && created >= cutoff) || (Number.isFinite(updated) && updated >= cutoff);
  });
  const done = recent.filter((t) => t.status === 'done').length;
  const needsInput = recent.filter((t) => t.status === 'needs_input').length;
  return { total: recent.length, done, queue: recent.length - done, needsInput };
}

// Somma di più stat cross-tenant (aggregato home principale): stessi campi,
// niente ricalcolo — ogni tenant computa già la propria finestra.
export function sumTaskProgress(list) {
  return (list ?? []).reduce((acc, s) => ({
    total: acc.total + s.total,
    done: acc.done + s.done,
    queue: acc.queue + s.queue,
    needsInput: acc.needsInput + s.needsInput,
  }), { total: 0, done: 0, queue: 0, needsInput: 0 });
}
