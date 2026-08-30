// Impostazioni runtime modificabili da Owner via UI, persistite in
// server/data/settings.json (gitignored, NON in tenants.json): le modifiche
// sono effettive subito, senza restart del server.
//
// Oggi contiene solo il limite di run autonome del dispatcher: un default
// globale più eventuali override per singolo tenant, sempre nel range 1-8.
import { join } from 'path';
import { readJson, writeJson, DATA_DIR } from './store.js';

const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

export const AUTONOMY_MIN = 1;
export const AUTONOMY_MAX = 8;
export const AUTONOMY_FACTORY_DEFAULT = 2; // il vecchio valore hardcoded

// Intero valido nel range, altrimenti null (valori corrotti nel file inclusi).
function validLimit(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= AUTONOMY_MIN && n <= AUTONOMY_MAX ? n : null;
}

// Lettura sempre dal disco: nessuna cache, così sia il dispatcher (a ogni
// tick) sia le route REST vedono l'ultimo valore salvato.
function load() {
  return readJson(SETTINGS_FILE, {});
}

export function getAutonomySettings() {
  const s = load().autonomy ?? {};
  const perTenant = {};
  for (const [tenantId, v] of Object.entries(s.perTenant ?? {})) {
    const n = validLimit(v);
    if (n !== null) perTenant[tenantId] = n;
  }
  return { default: validLimit(s.default) ?? AUTONOMY_FACTORY_DEFAULT, perTenant };
}

// Usata dal dispatcher a ogni tick: override del tenant se c'è, altrimenti default.
export function autonomyLimitFor(tenantId) {
  const s = getAutonomySettings();
  return s.perTenant[tenantId] ?? s.default;
}

// Aggiornamento parziale: { default } e/o { perTenant: { id: 1..8 | null } }
// (null rimuove l'override: il tenant torna al default globale).
// validTenantIds: gli id ammessi in perTenant (da tenants.json, passati dal chiamante).
export function setAutonomySettings({ default: def, perTenant } = {}, validTenantIds = []) {
  const current = getAutonomySettings();
  const next = { default: current.default, perTenant: { ...current.perTenant } };
  if (def !== undefined) {
    const n = validLimit(def);
    if (n === null) throw new Error(`default deve essere un intero tra ${AUTONOMY_MIN} e ${AUTONOMY_MAX}`);
    next.default = n;
  }
  if (perTenant !== undefined) {
    if (typeof perTenant !== 'object' || perTenant === null || Array.isArray(perTenant)) {
      throw new Error('perTenant deve essere un oggetto { tenantId: limite }');
    }
    for (const [tenantId, v] of Object.entries(perTenant)) {
      if (!validTenantIds.includes(tenantId)) throw new Error(`tenant sconosciuto: ${tenantId}`);
      if (v === null) { delete next.perTenant[tenantId]; continue; }
      const n = validLimit(v);
      if (n === null) throw new Error(`limite per ${tenantId}: intero tra ${AUTONOMY_MIN} e ${AUTONOMY_MAX} (o null per il default)`);
      next.perTenant[tenantId] = n;
    }
  }
  const all = load();
  all.autonomy = next;
  writeJson(SETTINGS_FILE, all);
  return next;
}
