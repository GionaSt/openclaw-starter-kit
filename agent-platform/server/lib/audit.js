// Audit log minimale, append-only su data/audit.jsonl.
import { readFileSync } from 'fs';
import { join } from 'path';
import { appendJsonl, DATA_DIR } from './store.js';

const AUDIT_FILE = join(DATA_DIR, 'audit.jsonl');

// Legge il journal e ritorna gli eventi filtrati (predicate opzionale).
// Read sincrona dell'intero file: ok per le dimensioni attuali; append-only.
export function readAuditEvents(predicate = null) {
  let raw;
  try { raw = readFileSync(AUDIT_FILE, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!predicate || predicate(ev)) out.push(ev);
  }
  return out;
}

const isReviewEvent = (e) =>
  e.detail?.taskId != null &&
  (e.event === 'task_review_approved' || e.event === 'task_review_rejected');

const toReviewNote = (e) => ({
  stage: e.detail.stage ?? null,
  decision: e.event === 'task_review_approved' ? 'approve' : 'reject',
  note: e.detail.note ?? '',
  at: e.ts ?? null,
});

// Trail delle review del quality gate per una task (manager/CEO, approve/reject),
// in ordine cronologico: { stage, decision, note, at }. Fonte: journal audit.
export function taskReviewNotes(taskId) {
  return readAuditEvents((e) => e.detail?.taskId === taskId && isReviewEvent(e)).map(toReviewNote);
}

// Come taskReviewNotes ma per TUTTE le task in un colpo solo: una sola lettura
// del journal invece di N (una per task). Usare quando serve il trail per un
// insieme di task (es. completedTasksReport), non dentro un .map() task-per-task
// (perf: server/data/audit.jsonl cresce append-only, N letture = N x file intero).
export function reviewNotesByTask() {
  const m = new Map();
  for (const e of readAuditEvents(isReviewEvent)) {
    const taskId = e.detail.taskId;
    const list = m.get(taskId);
    if (list) list.push(toReviewNote(e));
    else m.set(taskId, [toReviewNote(e)]);
  }
  return m;
}

export function logAudit({ user, tenant, agent, event, tokens, detail }) {
  try {
    appendJsonl(AUDIT_FILE, {
      ts: new Date().toISOString(),
      user: user ?? null,
      tenant: tenant ?? null,
      agent: agent ?? null,
      event,
      ...(tokens ? { tokens } : {}),
      ...(detail ? { detail } : {}),
    });
  } catch (err) {
    console.error('[audit]', err.message);
  }
}
