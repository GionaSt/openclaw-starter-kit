// Kill switch PER-TENANT (task 6116efe1). Owner può "bloccare" un singolo
// business (tenant): da bloccato la piattaforma NON lancia agenti per quel
// tenant. Unica eccezione: se Owner scrive in chat al CEO del tenant, QUELLA
// run parte comunque (gestita in /api/chat, non qui).
//
// Semantica (assunzioni dichiarate nella task, non riaprire qui):
//   - blocco PER TENANT, non per singolo agente;
//   - solo on/off, nessun blocco parziale/schedulato;
//   - il tenant "platform" è bloccabile come gli altri.
//
// Rapporto con il kill switch GLOBALE (platformpause.js): sono ortogonali.
// La pausa globale ferma TUTTO in modo soft (run in corso finiscono il giro);
// il blocco per-tenant ferma UN tenant in modo più deciso (le run attive di
// quel tenant vengono fermate al block-time, requisito 5). Stesso pattern
// "deep module a interfaccia minima": un solo posto tiene lo stato, gli
// enforcement point (dispatcher, scheduleRun/drainQueue, /api/chat,
// /api/runs/register) chiamano solo isTenantBlocked(id).
//
// Stato PERSISTITO in server/data/tenant-blocks.json (NON in tenants.json, che
// è config versionata editata a mano): sopravvive a restart/autorestart.
// Verità in memoria (idratata dal disco al boot), scrittura solo sui cambi:
// niente I/O nel path caldo di scheduleRun/dispatcher chiamato a ogni tick.
import { join } from 'path';
import { readJson, writeJson, DATA_DIR } from './store.js';

const BLOCKS_FILE = join(DATA_DIR, 'tenant-blocks.json');

let onChange = null;
export function setTenantBlockChangeListener(fn) { onChange = fn; }

// Map<tenantId, { blockedAt, blockedBy }>. Presenza nella mappa = bloccato.
const state = new Map();
(function hydrate() {
  const raw = readJson(BLOCKS_FILE, {});
  for (const [tenantId, v] of Object.entries(raw)) {
    if (v?.blocked) {
      state.set(tenantId, {
        blockedAt: v.blockedAt ?? null,
        blockedBy: v.blockedBy ?? null,
      });
    }
  }
})();

function persist() {
  const out = {};
  for (const [tenantId, v] of state.entries()) {
    out[tenantId] = { blocked: true, blockedAt: v.blockedAt, blockedBy: v.blockedBy };
  }
  writeJson(BLOCKS_FILE, out);
}

// Unico predicato usato dagli enforcement point (dispatcher, scheduleRun/
// drainQueue, /api/chat, /api/runs/register). Hot path: solo lookup in memoria.
export function isTenantBlocked(tenantId) {
  return state.has(tenantId);
}

// Stato pubblico per API/UI (payload tenant, banner). Sempre un oggetto con
// `blocked` booleano, così il client non deve gestire null.
export function getTenantBlockState(tenantId) {
  const v = state.get(tenantId);
  return v
    ? { blocked: true, blockedAt: v.blockedAt, blockedBy: v.blockedBy }
    : { blocked: false };
}

export function listBlockedTenantIds() {
  return [...state.keys()];
}

// Blocca il tenant. Idempotente: se già bloccato non riazzera blockedAt/By
// (chi ha bloccato per primo e quando). Torna lo stato pubblico.
export function blockTenant(tenantId, { by = 'owner' } = {}) {
  if (!state.has(tenantId)) {
    state.set(tenantId, { blockedAt: new Date().toISOString(), blockedBy: by ?? 'owner' });
    persist();
    onChange?.(tenantId, getTenantBlockState(tenantId));
  }
  return getTenantBlockState(tenantId);
}

// Sblocca il tenant. Idempotente. Torna lo stato pubblico. Al ritorno il
// chiamante (index.js) fa ripartire subito il flusso (drainQueue + tick):
// il dispatcher riprende le task pendenti senza riavvio del server.
export function unblockTenant(tenantId) {
  if (state.has(tenantId)) {
    state.delete(tenantId);
    persist();
    onChange?.(tenantId, getTenantBlockState(tenantId));
  }
  return getTenantBlockState(tenantId);
}
