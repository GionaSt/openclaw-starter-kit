// Inbox approvazioni: i tool-call sensibili (lista per tenant in tenants.json,
// campo "sensitiveTools") vengono sospesi via canUseTool del SDK finché un
// admin/manager non approva o rifiuta dalla tab "Approvazioni".
import { randomUUID } from 'crypto';
import { join } from 'path';
import { readJson, writeJson, DATA_DIR } from './store.js';
import { logAudit } from './audit.js';

const APPROVALS_FILE = join(DATA_DIR, 'approvals.json');
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000; // dopo 10 minuti la richiesta scade (deny)

let approvals = readJson(APPROVALS_FILE, []);
// Le pending non sopravvivono al riavvio (la run e' comunque persa): scadono.
for (const a of approvals) {
  if (a.status === 'pending') { a.status = 'expired'; a.resolvedAt = new Date().toISOString(); }
}
const persist = () => writeJson(APPROVALS_FILE, approvals);
persist();

const resolvers = new Map(); // id -> resolve({approved, note})

// onEvent(approval): hook per WS/push, impostato da index.js.
let onEvent = null;
export function setApprovalListener(fn) { onEvent = fn; }

export function listApprovals(tenantId) {
  return approvals
    .filter((a) => a.tenantId === tenantId)
    .sort((x, y) => (x.requestedAt < y.requestedAt ? 1 : -1))
    .slice(0, 100);
}

export function resolveApproval(id, { approved, note, resolvedBy }) {
  const a = approvals.find((x) => x.id === id);
  if (!a) throw new Error('richiesta non trovata');
  if (a.status !== 'pending') throw new Error('richiesta già risolta');
  a.status = approved ? 'approved' : 'denied';
  a.note = note ?? '';
  a.resolvedBy = resolvedBy;
  a.resolvedAt = new Date().toISOString();
  persist();
  logAudit({ user: resolvedBy, tenant: a.tenantId, agent: a.agentId, event: approved ? 'approval_granted' : 'approval_denied', detail: { id, tool: a.toolName, note: a.note } });
  resolvers.get(id)?.({ approved, note: a.note });
  resolvers.delete(id);
  onEvent?.(a);
  return a;
}

// Factory del canUseTool per una run: sospende i tool sensibili del tenant.
export function buildCanUseTool({ tenant, agent, sessionKey, onPending }) {
  const sensitive = tenant?.sensitiveTools ?? [];
  if (sensitive.length === 0) return undefined;
  return async (toolName, input) => {
    const isSensitive = sensitive.some((pattern) =>
      pattern.endsWith('*') ? toolName.startsWith(pattern.slice(0, -1)) : toolName === pattern
    );
    if (!isSensitive) return { behavior: 'allow', updatedInput: input };

    const approval = {
      id: randomUUID(),
      tenantId: tenant.id,
      agentId: agent.id,
      agentName: agent.name,
      sessionKey,
      toolName,
      input,
      status: 'pending',
      requestedAt: new Date().toISOString(),
    };
    approvals.push(approval);
    persist();
    logAudit({ tenant: tenant.id, agent: agent.id, event: 'approval_requested', detail: { id: approval.id, tool: toolName } });
    onEvent?.(approval);
    onPending?.(approval);

    const outcome = await new Promise((resolve) => {
      resolvers.set(approval.id, resolve);
      setTimeout(() => {
        if (resolvers.delete(approval.id)) {
          approval.status = 'expired';
          approval.resolvedAt = new Date().toISOString();
          persist();
          onEvent?.(approval);
          resolve({ approved: false, note: 'scaduta senza risposta' });
        }
      }, APPROVAL_TIMEOUT_MS).unref?.();
    });

    if (outcome.approved) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: `Richiesta rifiutata da Owner${outcome.note ? `: ${outcome.note}` : ''}` };
  };
}
