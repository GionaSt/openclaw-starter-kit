const MTOK = 1_000_000;

const PROFILES = {
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, source: 'Anthropic API list price 2026-05-27' },
  'claude-sonnet-5': {
    input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2,
    after: { at: '2026-09-01T00:00:00.000Z', input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    source: 'Anthropic Sonnet 5 introductory API price through 2026-08-31',
  },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1, source: 'Anthropic Haiku 4.5 API price' },
};

const TIER_MODELS = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  'opus-5': 'claude-opus-4-8',
  'fable-5': 'claude-opus-4-8',
};

function activeProfile(profile, now) {
  if (!profile.after || now < Date.parse(profile.after.at)) return profile;
  return { ...profile, ...profile.after };
}

export function priceProfileForTier(tier, now = Date.now()) {
  const requestedTier = String(tier ?? 'sonnet');
  const model = TIER_MODELS[requestedTier] ?? 'claude-opus-4-8';
  const profile = activeProfile(PROFILES[model], now);
  return {
    tier: requestedTier,
    pricedAs: model,
    proxy: !TIER_MODELS[requestedTier] || requestedTier === 'opus-5' || requestedTier === 'fable-5',
    ...profile,
  };
}

export function apiEquivalentCost(tier, usage = {}, now = Date.now()) {
  const profile = priceProfileForTier(tier, now);
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheCreation = usage.cacheCreation ?? 0;
  const inputUsd = input * profile.input / MTOK;
  const outputUsd = output * profile.output / MTOK;
  const cacheReadUsd = cacheRead * profile.cacheRead / MTOK;
  const cacheCreationUsd = cacheCreation * profile.cacheWrite / MTOK;
  const usd = inputUsd + outputUsd + cacheReadUsd + cacheCreationUsd;
  return {
    tier: profile.tier,
    pricedAs: profile.pricedAs,
    proxy: profile.proxy,
    source: profile.source,
    usd,
    microUsd: Math.round(usd * MTOK),
    components: { inputUsd, outputUsd, cacheReadUsd, cacheCreationUsd },
  };
}
