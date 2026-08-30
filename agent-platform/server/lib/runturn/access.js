// Blocco (a)/(b) di runAgentTurnInner (task 829e29c2, God-function
// server/index.js): risoluzione dei tool/permessi concessi al turno — MCP
// (wiki/board), allowedTools, canUseTool (approvazioni + path-scoping
// knowledge). MOVE puro da server/index.js: stessa logica, stesse variabili —
// zero cambi di comportamento.
//
// Task 0c814377 (follow-up di 1eed85e7): resolveTurnAccess era ~80 righe
// (criterio "nessun helper >50 righe" non centrato). MOVE puro dei tre blocchi in
// helper dedicati — resolveMcpServers / resolveAllowedTools / resolveCanUseTool —
// con resolveTurnAccess come orchestratore. Stessa logica, stesse variabili.
import { buildWikiMcpServer } from '../wiki.js';
import { buildTasksMcpServer } from '../tasks.js';
import { buildPreviewMcpServer } from '../previews.js';
import { buildArtifactsMcpServer } from '../artifacts.js';
import { buildCeomailMcpServer, CEOMAIL_MCP_TOOLS } from '../ceomail.js';
import { touchSession, pushSessionEvent } from '../status.js';
import { notifyTenant } from '../push.js';
import { loadUsers, userCanTenant } from '../auth.js';
import { allowedToolsFor } from '../agenttools.js';
import { resolveKnowledgeDir, buildKnowledgeCanUseTool } from '../knowledge.js';
import { buildCanUseTool } from '../approvals.js';
import { tenantUploadDir } from '../uploads.js';

const pushDeps = { loadUsers, userCanTenant };

// Tool MCP concessi al turno. La wiki è SEMPRE per tutti gli agenti del tenant
// (lettura on-demand e scrittura di fine task). La board (create_task/update_task/…)
// va al CEO, alle run del dispatcher (operativi che lavorano una task e devono
// chiuderla con update_task) e ai system job code-quality/pm-platform (aprono task
// ai dev e consegnano al gate). Ritorna anche `tasksAccess` (serve ad allowedTools).
function resolveMcpServers({ tenant, agent, agentId, tenantId, isCeo, source, taskId, tenants }) {
  const tasksAccess = isCeo || source === 'dispatcher' || source === 'code-quality' || source === 'pm-platform';
  // Messaggistica cross-tenant tra CEO (task 183ae10d): il tool send_to_ceo va
  // SOLO ai CEO. Serve la lista di tutti i tenant per risolvere il destinatario.
  const ceomailAccess = isCeo && Array.isArray(tenants);
  const mcpServers = {
    wiki: buildWikiMcpServer(tenant, agentId),
    // publish_preview per TUTTI gli agenti di TUTTI i tenant (task 9d1b6ebb): ogni
    // agente può pubblicare un deliverable nella preview globale. taskId di origine
    // preso dal contesto della run; agentIsDev decide se "path" può leggere fuori
    // dalla cartella upload del tenant (i dev hanno già fs pieno).
    preview: buildPreviewMcpServer(tenant, agentId, { taskId: taskId ?? null, agentIsDev: !!agent?.dev }),
    ...(tasksAccess ? {
      tasks: buildTasksMcpServer(tenant, agentId, { notify: (payload) => notifyTenant(tenantId, payload, pushDeps) }),
      artifacts: buildArtifactsMcpServer(tenant, agentId),
    } : {}),
    ...(ceomailAccess ? { ceomail: buildCeomailMcpServer(tenant, agentId, { tenants, notify: (payload) => notifyTenant(tenantId, payload, pushDeps) }) } : {}),
  };
  return { mcpServers, tasksAccess, ceomailAccess };
}

// Tool consentiti per l'agente (vedi lib/agenttools.js): i dev hanno anche
// filesystem/Bash; il qa-verifier (dev + readOnly) esegue e ispeziona ma non
// scrive codice di produzione (niente Write/Edit) — separazione autore/verificatore.
// Campo "knowledge" (tenants.json): un agente NON dev con una cartella di
// conoscenza riceve i tool file Read/Glob/Grep/Write vincolati a quella cartella
// (cwd + path-scoping via canUseTool). Gli agenti dev NON sono toccati (hanno già
// pieni poteri su /app). Agenti senza "knowledge" → knowledgeDir null. Allegati: i
// CEO business non sono dev e non hanno Read; se il turno porta immagini/PDF glielo
// concediamo SOLO per questo turno (l'unico tool filesystem aggiunto, sola lettura).
function resolveAllowedTools({ agent, repoRoot, attachments, tasksAccess, ceomailAccess }) {
  const knowledgeDir = agent.dev ? null : resolveKnowledgeDir(agent, repoRoot);
  let allowedTools = allowedToolsFor(agent, { tasksAccess, knowledgeEnabled: !!knowledgeDir });
  if (ceomailAccess) allowedTools = [...allowedTools, ...CEOMAIL_MCP_TOOLS];
  const atts = Array.isArray(attachments) ? attachments : [];
  const needsRead = atts.some((a) => a.kind === 'image' || a.kind === 'pdf');
  const grantReadForAttachments = needsRead && !allowedTools.includes('Read');
  if (grantReadForAttachments) allowedTools = [...allowedTools, 'Read'];
  return { allowedTools, knowledgeDir, grantReadForAttachments, needsRead };
}

// Callback approvazioni tool sensibili (tenants.json -> sensitiveTools): la run si
// sospende in attesa di approvazione dalla tab "Approvazioni"; stato agente ->
// needs_input + push. Con path-scoping knowledge (roots[0] = knowledgeDir == cwd; +
// upload dir del tenant se il turno porta allegati immagine/PDF) i tool file sono
// consentiti SOLO dentro quelle root: il wrapper delega a canUseTool i tool
// consentiti e nega i path che escono dalla cartella.
function resolveCanUseTool({ tenant, agent, sessionKey, tenantId, knowledgeDir, needsRead }) {
  let canUseTool = buildCanUseTool({
    tenant, agent, sessionKey,
    onPending: (approval) => {
      touchSession(sessionKey, { status: 'needs_input' });
      pushSessionEvent(sessionKey, { type: 'approval_pending', name: approval.toolName });
      notifyTenant(tenantId, {
        title: `❓ ${tenant.name}: ${agent.name} chiede un'approvazione`,
        body: `Autorizzi «${approval.toolName}»? Rispondi dal popup.`,
        tag: `approval-${approval.id}`,
        decision: { kind: 'tool', id: approval.id, tenantId },
      }, pushDeps).catch(() => {});
    },
  });
  if (knowledgeDir) {
    const roots = [knowledgeDir, ...(needsRead ? [tenantUploadDir(tenantId)] : [])];
    canUseTool = buildKnowledgeCanUseTool(roots, canUseTool);
  }
  return canUseTool;
}

// tenantId qui è passato esplicitamente a notifyTenant/buildTasksMcpServer:
// stesso valore di tenant.id, mantenuto per fedeltà 1:1 col codice originale.
// Orchestratore: delega a resolveMcpServers / resolveAllowedTools / resolveCanUseTool.
export function resolveTurnAccess({ tenant, agent, tenantId, agentId, sessionKey, source, taskId, attachments, repoRoot, tenants }) {
  const isCeo = agent.role === 'CEO';
  const { mcpServers, tasksAccess, ceomailAccess } = resolveMcpServers({ tenant, agent, agentId, tenantId, isCeo, source, taskId, tenants });
  const { allowedTools, knowledgeDir, grantReadForAttachments, needsRead } =
    resolveAllowedTools({ agent, repoRoot, attachments, tasksAccess, ceomailAccess });
  const canUseTool = resolveCanUseTool({ tenant, agent, sessionKey, tenantId, knowledgeDir, needsRead });
  return { mcpServers, allowedTools, canUseTool, knowledgeDir, grantReadForAttachments, needsRead, isCeo, tasksAccess };
}
