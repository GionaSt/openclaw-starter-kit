// Review CEO della board guidata dagli eventi. Le eccezioni reali (needs_input)
// chiedono una review coalescata; una scansione ogni 4h resta solo come rete di
// sicurezza e soltanto se la board ha lavoro aperto.
import { join } from 'path';
import { readJson, writeJson, DATA_DIR } from './store.js';
import { listRuns } from './runs.js';
import { listTasks } from './tasks.js';
import { logAudit } from './audit.js';
import { scheduleRun, isTenantSourceQueued } from './concurrency.js';
import { SLOT_OCCUPYING_STATES } from './runstates.js';

const FILE = join(DATA_DIR, 'board_checks.json');
export const BOARD_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const BOARD_CHECK_STALE_MS = 2 * BOARD_CHECK_INTERVAL_MS;
export const BOARD_CHECK_EVENT_DEBOUNCE_MS = 5 * 60 * 1000;
let state = readJson(FILE, {});
const persist = () => writeJson(FILE, state);

function entryFor(tenantId) {
  const raw = state[tenantId];
  if (typeof raw === 'string') return { lastBoardCheckAt: raw, pendingAt: null };
  if (raw && typeof raw === 'object') {
    return {
      lastBoardCheckAt: typeof raw.lastBoardCheckAt === 'string' ? raw.lastBoardCheckAt : null,
      pendingAt: typeof raw.pendingAt === 'string' ? raw.pendingAt : null,
    };
  }
  return { lastBoardCheckAt: null, pendingAt: null };
}

function saveEntry(tenantId, patch) {
  state[tenantId] = { ...entryFor(tenantId), ...patch };
  persist();
}

export const lastBoardCheckAt = (tenantId) => entryFor(tenantId).lastBoardCheckAt;

function hasOpenBoardWork(tenantId) {
  return listTasks(tenantId).some((task) => task.status !== 'done');
}

export function requestBoardCheck(task, now = Date.now()) {
  if (!task?.tenantId || task.status !== 'needs_input') return false;
  const entry = entryFor(task.tenantId);
  if (entry.pendingAt) return false;
  saveEntry(task.tenantId, { pendingAt: new Date(now).toISOString() });
  return true;
}

export function boardCheckHealth(tenantIds, now = Date.now()) {
  return tenantIds.map((tenantId) => {
    const { lastBoardCheckAt: last, pendingAt } = entryFor(tenantId);
    const hasOpenWork = hasOpenBoardWork(tenantId);
    return {
      tenantId,
      lastBoardCheckAt: last,
      pendingAt,
      intervalMs: BOARD_CHECK_INTERVAL_MS,
      staleAfterMs: BOARD_CHECK_STALE_MS,
      stale: hasOpenWork && Boolean(last) && now - Date.parse(last) > BOARD_CHECK_STALE_MS,
    };
  });
}

function checkPrompt(tenant, trigger) {
  const eventLine = trigger === 'event'
    ? 'È arrivata un’eccezione sulla board: verifica soltanto gli elementi che richiedono attenzione o decisione.'
    : 'Questa è la safety sweep periodica: verifica soltanto gli elementi aperti che richiedono attenzione o decisione.';
  return [
    `Review della board di ${tenant.name}. Sei in modalità silenziosa: niente lavoro operativo, solo review.`,
    eventLine,
    '',
    'Usa list_tasks e valuta:',
    '1. Task "needs_input": aspettano una decisione o un dato di Owner? Se sì e sono ferme, riassumi cosa serve.',
    '2. Task bloccate (openBlockers non vuoto): i blocker sono fermi o falliti? Serve un intervento?',
    '3. Task "revisione" o "todo" ferme con dispatchAttempts esauriti (nota di fallimento): serve una decisione?',
    '',
    'SOLO se serve una decisione o attenzione di Owner: manda UNA push con notify_owner (titolo breve + cosa deve decidere, accorpa i punti).',
    'Se è tutto in ordine NON usare notify_owner, non creare né modificare task: rispondi solo "nulla da segnalare" e termina.',
  ].join('\n');
}

export function boardCheckTick({ tenants, runFn, now = Date.now() }) {
  for (const tenant of tenants) {
    const ceo = tenant.agents.find((a) => a.role === 'CEO');
    if (!ceo) continue;
    const entry = entryFor(tenant.id);
    if (!entry.lastBoardCheckAt && !entry.pendingAt) {
      saveEntry(tenant.id, { lastBoardCheckAt: new Date(now).toISOString() });
      continue;
    }
    const eventDue = Boolean(entry.pendingAt) && now - Date.parse(entry.pendingAt) >= BOARD_CHECK_EVENT_DEBOUNCE_MS;
    const periodicDue = Boolean(entry.lastBoardCheckAt)
      && hasOpenBoardWork(tenant.id)
      && now - Date.parse(entry.lastBoardCheckAt) >= BOARD_CHECK_INTERVAL_MS;
    if (!eventDue && !periodicDue) continue;
    const busy = listRuns(tenant.id).some((run) => run.source === 'board_check' && SLOT_OCCUPYING_STATES.includes(run.status))
      || isTenantSourceQueued(tenant.id, 'board_check');
    if (busy) continue;
    const trigger = eventDue ? 'event' : 'safety_sweep';
    saveEntry(tenant.id, { lastBoardCheckAt: new Date(now).toISOString(), pendingAt: null });
    const sessionId = `boardcheck-${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
    logAudit({ user: 'board-check', tenant: tenant.id, agent: ceo.id, event: 'board_check_run', detail: { sessionId, trigger } });
    scheduleRun(runFn, {
      tenantId: tenant.id,
      agentId: ceo.id,
      sessionId,
      message: checkPrompt(tenant, trigger),
      username: 'board-check',
      source: 'board_check',
      urgency: 'bassa',
      runTitle: trigger === 'event' ? 'Review board su eccezione' : 'Safety sweep della board',
    }).catch((err) => console.error(`[board-check] run CEO ${tenant.id}:`, err.message));
  }
}
