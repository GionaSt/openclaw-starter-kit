// Coda persistita dei messaggi chat inviati mentre l'agente sta lavorando un
// turno (task 311d2946: invio multiplo mentre l'agente lavora — oggi il
// messaggio o si perdeva o andava aspettato il turno). Vale per TUTTI i tenant
// e TUTTI gli agenti (portata piattaforma), non solo la chat interattiva coi
// CEO: un file per conversazione, data/message-queues/<tenantId>/<agentId>__<sessionId>.json.
//
// Ordine FIFO (array, push in coda / consuma dall'inizio). Scrittura sempre
// via store.js (writeJson: tmp file + rename atomico) — un crash del server a
// metà scrittura non tronca/corrompe il file, quindi i messaggi accodati
// sopravvivono a un restart (vedi anche index.js: la riconciliazione al boot e
// il drain-a-fine-turno consegnano quanto era rimasto in coda).
//
// Consegna: index.js preleva TUTTI i messaggi in un colpo solo (drainQueued) e
// li passa all'agente come UNICO turno successivo — mai un turno per
// messaggio (requisito esplicito: risparmio token + contesto coerente).
//
// Il file salva anche tenantId/agentId/sessionId (non solo l'array dei
// messaggi): così listNonEmptyQueues non deve reverse-parsare il nome del file
// per risalire alle chiavi (sessionId può contenere "__" a sua volta).
import { existsSync, unlinkSync, readdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { readJson, writeJson, DATA_DIR, safeSegment, tenantScopedDir } from './store.js';

export const QUEUE_DIR = join(DATA_DIR, 'message-queues');

function queueFile(tenantId, agentId, sessionId) {
  return join(tenantScopedDir(QUEUE_DIR, tenantId), `${safeSegment(agentId)}__${safeSegment(sessionId)}.json`);
}

function load(tenantId, agentId, sessionId) {
  return readJson(queueFile(tenantId, agentId, sessionId), { tenantId, agentId, sessionId, items: [] }).items ?? [];
}

function save(tenantId, agentId, sessionId, items) {
  writeJson(queueFile(tenantId, agentId, sessionId), { tenantId, agentId, sessionId, items });
}

// Accoda un messaggio in fondo alla coda (usato da /api/chat quando la sessione
// risulta già occupata da un turno in corso). attachments: solo metadati (id,
// name, stored, type, kind, size, url — MAI il path assoluto, un dettaglio
// interno risolto di nuovo al momento della consegna).
export function enqueueMessage(tenantId, agentId, sessionId, { message, attachments = [], username } = {}) {
  const items = load(tenantId, agentId, sessionId);
  const entry = {
    id: randomUUID(),
    message: String(message ?? ''),
    attachments: (Array.isArray(attachments) ? attachments : []).map(({ path, ...meta }) => meta),
    username: username ?? null,
    enqueuedAt: new Date().toISOString(),
  };
  items.push(entry);
  save(tenantId, agentId, sessionId, items);
  return entry;
}

// Stato coda per conversazione (endpoint GET): n. messaggi pending + elenco.
export function listQueued(tenantId, agentId, sessionId) {
  return load(tenantId, agentId, sessionId);
}

export function queueDepth(tenantId, agentId, sessionId) {
  return load(tenantId, agentId, sessionId).length;
}

// Cancella un messaggio accodato prima della consegna (endpoint DELETE).
// Ritorna true se un messaggio con quell'id è stato trovato e rimosso.
export function cancelQueued(tenantId, agentId, sessionId, messageId) {
  const items = load(tenantId, agentId, sessionId);
  const next = items.filter((m) => m.id !== messageId);
  if (next.length === items.length) return false;
  save(tenantId, agentId, sessionId, next);
  return true;
}

// Preleva TUTTI i messaggi in coda in un solo colpo e svuota il file (ordine
// FIFO preservato): usata a fine turno per consegnarli in blocco nel turno
// successivo. Se il processo muore subito dopo lo svuotamento ma prima che il
// turno successivo li abbia persistiti in history, restano solo nell'array in
// memoria del chiamante — finestra di rischio minima (nessun await nel mezzo,
// vedi index.js) e comunque non nel percorso comune (il crash "durante una
// run" è coperto per intero: il drain avviene solo DOPO che il watchdog ha
// fatto ripartire e concludere la run interrotta).
export function drainQueued(tenantId, agentId, sessionId) {
  const items = load(tenantId, agentId, sessionId);
  if (items.length === 0) return [];
  const file = queueFile(tenantId, agentId, sessionId);
  if (existsSync(file)) unlinkSync(file);
  return items;
}

// Tutte le code non vuote su disco, su tutti i tenant (usata dalla
// riconciliazione al boot, index.js): copre l'edge case raro in cui una coda
// resta persistita senza alcuna run associata a riprenderla da sola.
export function listNonEmptyQueues() {
  if (!existsSync(QUEUE_DIR)) return [];
  const out = [];
  for (const tenantDirName of readdirSync(QUEUE_DIR)) {
    const tenantDir = join(QUEUE_DIR, tenantDirName);
    let files;
    try { files = readdirSync(tenantDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const data = readJson(join(tenantDir, f), null);
      if (data?.items?.length > 0) {
        out.push({ tenantId: data.tenantId, agentId: data.agentId, sessionId: data.sessionId, pending: data.items.length });
      }
    }
  }
  return out;
}
