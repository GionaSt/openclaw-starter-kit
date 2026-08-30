// Model tiering per gerarchia agenti (docs/model-tiering.md).
// tenants.json specifica per ogni agente un alias di tier ("fable-5" | "opus"
// | "sonnet" | "haiku", + "effort" opzionale) invece dell'id modello reale:
// qui si risolve l'alias nell'id da passare all'SDK e si gestisce il degrado
// di un tier quando il modello richiesto non è disponibile nel piano/CLI.
// Un solo posto da cambiare se domani cambiano gli id dei modelli o i prezzi.
import { readFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './store.js';

const catalog = JSON.parse(readFileSync(join(CONFIG_DIR, 'model-tiers.json'), 'utf8'));

export const DEFAULT_TIER = catalog.defaultTier ?? 'sonnet';

function tierInfo(tier) {
  return catalog.tiers[tier] ?? null;
}

// Tier di default per un ruolo (testo libero da tenants.json), usato SOLO
// quando l'agente non specifica `model` esplicitamente: rete di sicurezza
// per agenti aggiunti in futuro senza tiering esplicito, mai un crash per
// assenza di config.
export function defaultTierForRole(role) {
  const r = String(role ?? '').toLowerCase();
  for (const { match, tier } of catalog.roleDefaults ?? []) {
    if (match.some((kw) => r.includes(kw))) return tier;
  }
  return DEFAULT_TIER;
}

// Risolve un alias di tier nell'id modello reale da passare all'SDK.
// Tier sconosciuto (typo in config, tier rimosso dal catalogo) -> degrada al
// tier di default con un warning: mai un crash per un problema di config.
export function resolveModel(tier) {
  const info = tierInfo(tier);
  if (info) return { tier, model: info.model, warning: null };
  const fallbackInfo = tierInfo(DEFAULT_TIER);
  return {
    tier: DEFAULT_TIER,
    model: fallbackInfo.model,
    warning: `tier modello "${tier}" sconosciuto nel catalogo, uso il default "${DEFAULT_TIER}"`,
  };
}

// Prossimo tier nella catena di fallback (null se già al livello più basso:
// a quel punto un errore di disponibilità modello risale come errore normale,
// gestito dal retry/backoff esistente del journal).
export function fallbackTier(tier) {
  return tierInfo(tier)?.fallback ?? null;
}

export function tierLabel(tier) {
  return tierInfo(tier)?.label ?? tier;
}

export function allTiers() {
  return Object.keys(catalog.tiers);
}

// Riconosce gli errori del CLI/piano che segnalano un modello non disponibile
// (niente crediti/seat per quel modello, servizio disabilitato per l'org, id
// modello inesistente) — DA NON confondere con isUsageLimitError di runs.js,
// che riguarda il limite di utilizzo generale della subscription Max (quello
// si ritenta più tardi con lo STESSO modello, questo si degrada di tier subito).
const MODEL_UNAVAILABLE_RE = /requires usage credits|doesn'?t include (extra )?usage|usage allocation has been disabled|usage limit is set to \$0|disabled for your org|model not found|unknown model|invalid model/i;

export function isModelUnavailableError(message) {
  return MODEL_UNAVAILABLE_RE.test(String(message ?? ''));
}
