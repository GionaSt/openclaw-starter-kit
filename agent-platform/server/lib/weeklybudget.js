import { join } from 'path';
import { readJson, writeJson, DATA_DIR } from './store.js';
import { apiEquivalentCost } from './claudepricing.js';

const FILE = join(DATA_DIR, 'weekly-budget.json');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, apiUsd: 0 };
}

function validPercent(value) {
  const percent = Number(value);
  return Number.isFinite(percent) && percent >= 0.5 && percent <= 0.9 ? percent : null;
}

let state = readJson(FILE, null);

function persist() {
  writeJson(FILE, state);
}

function ensureWindow(now) {
  if (!state?.window?.resetAt || !state?.config?.ceilingUsd) return null;
  const resetMs = Date.parse(state.window.resetAt);
  if (!Number.isFinite(resetMs)) return null;
  if (now < resetMs) return state.window;
  const elapsedWeeks = Math.floor((now - resetMs) / WEEK_MS) + 1;
  const startMs = resetMs + (elapsedWeeks - 1) * WEEK_MS;
  state.window = {
    startAt: new Date(startMs).toISOString(),
    resetAt: new Date(startMs + WEEK_MS).toISOString(),
    tokens: emptyTokens(),
  };
  persist();
  return state.window;
}

export function configureWeeklyBudget({ percent, ceilingUsd, resetAt, usedTokens = null, usedUsd = null }) {
  const safePercent = validPercent(percent);
  const safeCeiling = Number(ceilingUsd);
  const resetMs = Date.parse(resetAt);
  if (safePercent === null) throw new Error('percent deve essere tra 0.50 e 0.90');
  if (!Number.isFinite(safeCeiling) || safeCeiling <= 0) throw new Error('ceilingUsd deve essere positivo');
  if (!Number.isFinite(resetMs)) throw new Error('resetAt non valido');
  const tokens = { ...emptyTokens(), ...(usedTokens ?? {}) };
  tokens.apiUsd = Number.isFinite(Number(usedUsd)) ? Number(usedUsd) : Number(tokens.apiUsd ?? 0);
  state = {
    config: { percent: safePercent, ceilingUsd: safeCeiling, unit: 'api_usd_equivalent' },
    window: {
      startAt: new Date(resetMs - WEEK_MS).toISOString(),
      resetAt: new Date(resetMs).toISOString(),
      tokens,
    },
  };
  persist();
  return getWeeklyBudgetState();
}

export function recordWeeklyUsage(usage = {}, tier = 'sonnet', now = Date.now()) {
  const window = ensureWindow(now);
  if (!window) return getWeeklyBudgetState(now);
  const cost = apiEquivalentCost(tier, usage, now);
  window.tokens.input += usage.input ?? 0;
  window.tokens.output += usage.output ?? 0;
  window.tokens.cacheRead += usage.cacheRead ?? 0;
  window.tokens.cacheCreation += usage.cacheCreation ?? 0;
  window.tokens.apiUsd = Number((window.tokens.apiUsd + cost.usd).toFixed(9));
  persist();
  return getWeeklyBudgetState(now);
}

export function getWeeklyBudgetState(now = Date.now()) {
  const window = ensureWindow(now);
  if (!window) return { enabled: false };
  const { percent, ceilingUsd } = state.config;
  const thresholdUsd = Number((ceilingUsd * percent).toFixed(6));
  const usdUsed = window.tokens.apiUsd;
  return {
    enabled: true,
    unit: 'api_usd_equivalent',
    percent,
    ceilingUsd,
    thresholdUsd,
    usdUsed,
    pctOfCeiling: ceilingUsd ? usdUsed / ceilingUsd : null,
    resetAt: window.resetAt,
    windowStart: window.startAt,
    halted: usdUsed >= thresholdUsd,
  };
}

export function isWeeklyBudgetHalted(now = Date.now()) {
  return getWeeklyBudgetState(now).halted === true;
}
