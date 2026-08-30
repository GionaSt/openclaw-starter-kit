// Offset deterministico per tenant, usato per sfasare gli spawn schedulati
// (board_check e futuri job "orari" per-tenant) dentro una finestra fissa.
// Task 80ea8344: i 4 CEO board_check partivano nello stesso secondo (:14/:44
// di ogni ora) -> picco di memoria concorrente sopra le run del dispatcher.
//
// Deterministico e stabile: funzione pura di tenantId (hash SHA-256), NIENTE
// Math.random/Date.now nel calcolo -> stessa distribuzione a ogni riavvio,
// nessuna deriva nel tempo. Non e' un "delay" applicato al lancio: va
// combinato con una griglia epoch-allineata (vedi boardcheck.js) cosi' il
// periodo resta esatto e la fase per tenant resta stabile per sempre, anche
// se lo stato persistito era gia' sincronizzato da prima di questo fix.
import { createHash } from 'crypto';

export const DEFAULT_JITTER_WINDOW_MS = 120_000; // 0-120s

export function tenantJitterMs(tenantId, windowMs = DEFAULT_JITTER_WINDOW_MS) {
  if (!windowMs || windowMs <= 0) return 0;
  const digest = createHash('sha256').update(String(tenantId ?? '')).digest();
  return digest.readUInt32BE(0) % windowMs;
}
