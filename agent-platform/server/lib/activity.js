// Feed "Attività" per tenant (task board 31797bb5): traccia persistente,
// server-side, degli eventi rilevanti per Owner — task completate (con nota
// di consegna), task in needs_input, task bloccate dall'escalation del quality
// gate. Complementare alle push (fix a5f06236): le push si possono perdere
// (permesso negato, subscription scaduta, iOS che le droppa), questo feed no —
// Owner lo controlla ad app aperta e vede tutto quello che è successo.
//
// Sorgente eventi: lo stesso hook onChange della board usato per le push
// (setTaskChangeListener in index.js) — un evento per transizione rilevante,
// mai ricalcolato dallo stato corrente della task (che si sovrascrive: una
// task riaperta e richiusa deve generare un NUOVO evento "done").
//
// Persistenza: un file JSON per tenant, come conversations.js (un file per
// oggetto, sync multi-dispositivo perché lo stato letto/non letto vive qui e
// non sul singolo device). Niente file separato per utente: Owner è l'unico
// destinatario di questo feed, come per approvals/decisions.
import { randomUUID } from 'crypto';
import { join } from 'path';
import { readJson, writeJson, DATA_DIR, safeSegment } from './store.js';

const ACTIVITY_DIR = join(DATA_DIR, 'activity');
// Note di consegna dell'operativo (scritte a review_manager) sopravvivono nel
// file solo finché la task non arriva a "done": la nota finale su task.note a
// quel punto è quella dell'ULTIMO reviewer (CEO), non la consegna originale
// (updateTask sovrascrive .note ad ogni step del gate). Le stashiamo qui a
// parte finché non servono per comporre l'evento "done".
const PENDING_NOTES_DIR = join(DATA_DIR, 'activity-pending-notes');

const MAX_EVENTS_PER_TENANT = 300;

const activityFile = (tenantId) => join(ACTIVITY_DIR, `${safeSegment(tenantId)}.json`);
const pendingNotesFile = (tenantId) => join(PENDING_NOTES_DIR, `${safeSegment(tenantId)}.json`);

const clip = (s, n = 300) => {
  const str = String(s ?? '').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

function loadEvents(tenantId) {
  return readJson(activityFile(tenantId), []);
}
function saveEvents(tenantId, events) {
  writeJson(activityFile(tenantId), events);
}

// kind: 'done' | 'needs_input' | 'failed' (escalation del gate dopo 2 bocciature).
export function recordActivityEvent(tenantId, { kind, taskId, title, note }) {
  const events = loadEvents(tenantId);
  const event = {
    id: randomUUID(),
    tenantId,
    kind,
    taskId,
    title: clip(title, 120),
    note: note ? clip(note, 300) : null,
    createdAt: new Date().toISOString(),
    readAt: null,
  };
  events.push(event);
  // Tetto per tenant: tronca le più vecchie, non ha senso un log infinito per
  // un feed che serve a "cosa è successo di recente" (storico completo resta
  // comunque nell'audit log generale).
  const trimmed = events.length > MAX_EVENTS_PER_TENANT ? events.slice(events.length - MAX_EVENTS_PER_TENANT) : events;
  saveEvents(tenantId, trimmed);
  return event;
}

export function listActivity(tenantId) {
  return loadEvents(tenantId).slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function unreadActivityCount(tenantId) {
  return loadEvents(tenantId).filter((e) => !e.readAt).length;
}

export function markActivityRead(tenantId, id) {
  const events = loadEvents(tenantId);
  const event = events.find((e) => e.id === id);
  if (!event) return null;
  if (!event.readAt) {
    event.readAt = new Date().toISOString();
    saveEvents(tenantId, events);
  }
  return event;
}

export function markAllActivityRead(tenantId) {
  const events = loadEvents(tenantId);
  const now = new Date().toISOString();
  let marked = 0;
  for (const e of events) {
    if (!e.readAt) { e.readAt = now; marked += 1; }
  }
  if (marked) saveEvents(tenantId, events);
  return marked;
}

// ---- Stash della nota di consegna (vedi commento in testa al file) ----
function loadPendingNotes(tenantId) {
  return readJson(pendingNotesFile(tenantId), {});
}
function savePendingNotes(tenantId, map) {
  writeJson(pendingNotesFile(tenantId), map);
}

export function stashDeliveryNote(tenantId, taskId, note) {
  if (!note) return;
  const map = loadPendingNotes(tenantId);
  map[taskId] = note;
  savePendingNotes(tenantId, map);
}

// Legge e consuma (one-shot) la nota di consegna stashata per una task.
export function takeDeliveryNote(tenantId, taskId) {
  const map = loadPendingNotes(tenantId);
  const note = map[taskId] ?? null;
  if (note !== undefined && taskId in map) {
    delete map[taskId];
    savePendingNotes(tenantId, map);
  }
  return note;
}

// Task board 03a5a645 (decisione Owner 2026-07-25, "Bloccate" vs "Da
// decidere"): il segnale affidabile è il campo ask, non più la firma
// testuale della nota. 'needs_input' = richiesta vera (ask valorizzato,
// mostrata a Owner con domanda/opzioni); 'failed' = blocco tecnico (ask
// assente — escalation del gate, retry esauriti, o una needs_input impostata
// a mano senza passare da ask_owner): niente domanda a cui rispondere, va
// nella lista "Bloccate" (lib/blocked.js), non nel popup "Da decidere".
export function classifyNeedsInput(task) {
  return task.ask ? 'needs_input' : 'failed';
}
