import { readFileSync, writeFileSync, accessSync, constants } from 'fs';
import { join } from 'path';
import { DATA_DIR, CONFIG_DIR } from '../lib/store.js';
import { apiEquivalentCost } from '../lib/claudepricing.js';
import { configureWeeklyBudget } from '../lib/weeklybudget.js';

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const percent = Number(option('percent', '65')) / 100;
const resetAt = option('reset-at');
const hitAt = option('hit-at', resetAt);
if (!resetAt) throw new Error('uso: node scripts/configure-api-cost-guards.mjs --reset-at=ISO [--hit-at=ISO] [--percent=65]');
const resetMs = Date.parse(resetAt);
const hitMs = Date.parse(hitAt);
if (!Number.isFinite(resetMs) || !Number.isFinite(hitMs)) throw new Error('reset-at e hit-at devono essere date ISO valide');

const budgetFile = join(DATA_DIR, 'budget.json');
try { accessSync(budgetFile, constants.W_OK); } catch { throw new Error(`budget.json non scrivibile: esegui questo script dal VPS host dopo il redeploy (${budgetFile})`); }
const runsFile = join(DATA_DIR, 'runs.json');
const runs = Object.values(JSON.parse(readFileSync(runsFile, 'utf8')));
const tenants = JSON.parse(readFileSync(join(CONFIG_DIR, 'tenants.json'), 'utf8')).tenants;
const tierByAgent = new Map();
for (const tenant of tenants) for (const agent of tenant.agents ?? []) tierByAgent.set(`${tenant.id}:${agent.id}`, agent.model ?? 'sonnet');

function usageOf(run) {
  const usage = run.usage ?? {};
  return { input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheCreation: usage.cacheCreation ?? 0 };
}

function costFor(run, at) {
  const tier = run.modelTier ?? tierByAgent.get(`${run.tenantId}:${run.agentId}`) ?? 'opus';
  return apiEquivalentCost(tier, usageOf(run), at);
}

function sumInRange(startMs, endMs) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, apiUsd: 0, proxyRuns: 0, runs: 0 };
  for (const run of runs) {
    const at = Date.parse(run.updatedAt ?? run.startedAt ?? '');
    if (!Number.isFinite(at) || at < startMs || at > endMs) continue;
    const usage = usageOf(run);
    if (!(usage.input || usage.output || usage.cacheRead || usage.cacheCreation)) continue;
    const cost = Number.isFinite(run.apiCostUsd) ? { usd: run.apiCostUsd, proxy: run.pricingProxy } : costFor(run, at);
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheCreation += usage.cacheCreation;
    totals.apiUsd += cost.usd;
    totals.proxyRuns += cost.proxy ? 1 : 0;
    totals.runs += 1;
  }
  totals.apiUsd = Number(totals.apiUsd.toFixed(9));
  return totals;
}

const weeklyStart = resetMs - 7 * 24 * 60 * 60 * 1000;
const weekly = sumInRange(weeklyStart, hitMs);
const weeklyState = configureWeeklyBudget({ percent, ceilingUsd: weekly.apiUsd, resetAt, usedTokens: weekly, usedUsd: weekly.apiUsd });

const budget = JSON.parse(readFileSync(budgetFile, 'utf8'));
for (const event of budget.limitEvents ?? []) {
  const eventAt = Date.parse(event.at);
  if (!Number.isFinite(eventAt)) continue;
  const sample = sumInRange(eventAt - 5 * 60 * 60 * 1000, eventAt);
  event.windowTokens = Math.round(sample.apiUsd * 1_000_000);
  event.costUsd = sample.apiUsd;
  event.components = { ...sample };
  event.weightAtRecord = 'api_usd_equivalent';
}
const now = Date.now();
const current = sumInRange(now - 5 * 60 * 60 * 1000, now);
if (budget.window) budget.window.tokens = { input: Math.round(current.apiUsd * 1_000_000), output: 0, cacheRead: 0, cacheCreation: 0, billable: Math.round(current.apiUsd * 1_000_000), apiUsd: current.apiUsd };
budget.unit = 'api_usd_equivalent';
writeFileSync(budgetFile, `${JSON.stringify(budget, null, 2)}\n`);
console.log(JSON.stringify({ weekly: weeklyState, weeklySource: weekly, fiveHourSamples: budget.limitEvents?.map((event) => ({ at: event.at, costUsd: event.costUsd })) }, null, 2));
