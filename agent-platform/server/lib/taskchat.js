// Thread di chat per task (task board 553ea6b1): messaggi liberi legati a una
// task, usati soprattutto per la risposta di Owner quando la task è ferma in
// needs_input. Un file JSON per task: data/task_messages/<tenantId>/<taskId>.json
// Schema: { taskId, tenantId, messages: [{id, author, authorName, text, at}], createdAt, updatedAt }
//
// Layer indipendente da conversations.js (chat con gli agenti) e da task.note/
// ask (stato sintetico della task): qui vive lo storico discorsivo legato a
// UNA task, non sostituisce note/ask che restano il campo "di stato".
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { readJson, writeJson, DATA_DIR, tenantScopedFile } from './store.js';

export const TASK_MESSAGES_DIR = join(DATA_DIR, 'task_messages');

const threadFile = (tenantId, taskId) => tenantScopedFile(TASK_MESSAGES_DIR, tenantId, taskId);

function loadThread(tenantId, taskId) {
  return readJson(threadFile(tenantId, taskId), null);
}

// Lista messaggi di una task (array vuoto se il thread non esiste ancora).
export function listTaskMessages(tenantId, taskId) {
  return loadThread(tenantId, taskId)?.messages ?? [];
}

// Aggiunge un messaggio al thread (lo crea al primo messaggio). author =
// 'user:<username>' o 'agent:<id>'; text obbligatorio.
export function addTaskMessage(tenantId, taskId, { author, authorName, text }) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('text richiesto nel messaggio');
  if (!author) throw new Error('author richiesto nel messaggio');
  const now = new Date().toISOString();
  const thread = loadThread(tenantId, taskId) ?? { taskId, tenantId, messages: [], createdAt: now };
  const message = {
    id: randomUUID(),
    author,
    authorName: authorName ?? String(author).replace(/^(user|agent):/, ''),
    text: clean.slice(0, 4000),
    at: now,
  };
  thread.messages.push(message);
  thread.updatedAt = now;
  writeJson(threadFile(tenantId, taskId), thread);
  return message;
}

export function hasTaskThread(tenantId, taskId) {
  return existsSync(threadFile(tenantId, taskId));
}
