// Registry di deliverable canonici. Gli agenti consegnano artefatti versionati
// e validabili; la chat resta soltanto un riassunto umano.
import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { readJson, writeJson, DATA_DIR, safeSegment } from './store.js';
import { logAudit } from './audit.js';

const ROOT = join(DATA_DIR, 'artifacts');
export const RESULT_TYPES = [
  'decision_memo', 'financial_pack', 'revenue_action_pack', 'conversion_asset_pack',
  'campaign_experiment', 'compliance_memo', 'product_brief', 'technical_rfc',
  'implementation_package', 'release_verdict', 'metrics_pack', 'content_production_pack',
  'cut_decision_sheet', 'listing_deal_pack', 'general',
];
export const RISK_LEVELS = ['R0', 'R1', 'R2', 'R3'];
export const ARTIFACT_STATUSES = ['draft', 'ready_for_review', 'approved', 'published', 'archived'];
const EVIDENCE_REQUIRED = new Set(['conversion_asset_pack', 'compliance_memo', 'financial_pack', 'campaign_experiment']);

function tenantDir(tenantId) {
  const dir = join(ROOT, safeSegment(tenantId));
  mkdirSync(dir, { recursive: true });
  return dir;
}
function registryPath(tenantId) { return join(tenantDir(tenantId), 'registry.json'); }
function filePath(tenantId, id, version, extension) {
  const dir = join(tenantDir(tenantId), 'files', safeSegment(id));
  mkdirSync(dir, { recursive: true });
  return join(dir, 'v' + version + '.' + extension);
}
function registry(tenantId) { return readJson(registryPath(tenantId), []); }
function persist(tenantId, entries) { writeJson(registryPath(tenantId), entries); }
function now() { return new Date().toISOString(); }
function relativePath(path) { return path.startsWith(DATA_DIR + '/') ? path.slice(DATA_DIR.length + 1) : path; }
function validResultType(value) { return RESULT_TYPES.includes(value) ? value : 'general'; }
function validRiskLevel(value) { return RISK_LEVELS.includes(value) ? value : 'R1'; }

export function listArtifacts(tenantId, { taskId = null, status = null } = {}) {
  return registry(tenantId).filter((artifact) => (!taskId || artifact.taskId === taskId) && (!status || artifact.status === status));
}
export function getArtifact(tenantId, artifactId) {
  return registry(tenantId).find((artifact) => artifact.id === artifactId) ?? null;
}
export function artifactsForTask(tenantId, taskId) { return listArtifacts(tenantId, { taskId }); }
export function getArtifactContent(tenantId, artifactId) {
  const artifact = getArtifact(tenantId, artifactId);
  if (!artifact) return null;
  const path = artifact.contentPath ? join(DATA_DIR, artifact.contentPath) : null;
  return { artifact, content: path ? readFileSync(path, 'utf8') : null };
}

export function validateArtifact(artifact) {
  const checks = [
    { name: 'title', pass: Boolean(String(artifact.title ?? '').trim()) },
    { name: 'task', pass: Boolean(artifact.taskId) },
    { name: 'summary', pass: Boolean(String(artifact.executiveSummary ?? '').trim()) },
    { name: 'content_or_link', pass: Boolean(artifact.contentPath || artifact.externalUrl) },
  ];
  if (EVIDENCE_REQUIRED.has(artifact.resultType)) {
    checks.push({ name: 'evidence', pass: Array.isArray(artifact.evidence) && artifact.evidence.length > 0 });
  }
  if (artifact.riskLevel === 'R3' && ['approved', 'published'].includes(artifact.status)) {
    checks.push({ name: 'human_approval', pass: Boolean(artifact.approvedBy) });
  }
  return { passed: checks.every((check) => check.pass), checks };
}

export function createArtifact(tenantId, input, createdBy) {
  if (!String(input.taskId ?? '').trim()) throw new Error('taskId richiesto');
  if (!String(input.title ?? '').trim()) throw new Error('title richiesto');
  const resultType = validResultType(input.resultType);
  const riskLevel = validRiskLevel(input.riskLevel);
  const status = ARTIFACT_STATUSES.includes(input.status) ? input.status : 'draft';
  if (['approved', 'published'].includes(status) && riskLevel === 'R3') {
    throw new Error('un artefatto R3 può essere approvato o pubblicato soltanto da un umano');
  }
  const entries = registry(tenantId);
  const sameTask = entries.filter((artifact) => artifact.taskId === input.taskId && artifact.title === input.title);
  const version = sameTask.length ? Math.max(...sameTask.map((artifact) => artifact.version ?? 1)) + 1 : 1;
  const id = randomUUID();
  let contentPath = null;
  if (String(input.content ?? '').trim()) {
    const extension = input.format === 'html' ? 'html' : input.format === 'json' ? 'json' : 'md';
    const path = filePath(tenantId, id, version, extension);
    writeFileSync(path, input.content);
    contentPath = relativePath(path);
  }
  const artifact = {
    id, tenantId, taskId: input.taskId, title: input.title.trim(), resultType, riskLevel, status,
    executiveSummary: String(input.executiveSummary ?? '').trim(), assumptions: input.assumptions ?? [],
    evidence: input.evidence ?? [], contentPath, externalUrl: String(input.externalUrl ?? '').trim() || null,
    format: input.format ?? 'markdown', version, createdBy, createdAt: now(), updatedAt: now(),
    approvedBy: null, approvedAt: null,
  };
  artifact.validation = validateArtifact(artifact);
  entries.push(artifact);
  persist(tenantId, entries);
  logAudit({ user: createdBy, tenant: tenantId, event: 'artifact_created', detail: { artifactId: id, taskId: artifact.taskId, resultType, riskLevel, version } });
  return artifact;
}

export function setArtifactStatus(tenantId, artifactId, status, updatedBy) {
  if (!ARTIFACT_STATUSES.includes(status)) throw new Error('status artefatto non valido');
  const entries = registry(tenantId);
  const artifact = entries.find((entry) => entry.id === artifactId);
  if (!artifact) throw new Error('artefatto non trovato');
  const humanAction = String(updatedBy ?? '').startsWith('user:');
  if (['approved', 'published'].includes(status) && ['R2', 'R3'].includes(artifact.riskLevel) && !humanAction) {
    throw new Error(`un artefatto ${artifact.riskLevel} richiede approvazione umana`);
  }
  if (status === 'published' && ['R2', 'R3'].includes(artifact.riskLevel) && !artifact.approvedBy) {
    throw new Error(`un artefatto ${artifact.riskLevel} deve essere approvato prima della pubblicazione`);
  }
  artifact.status = status;
  artifact.updatedAt = now();
  if (status === 'approved') { artifact.approvedBy = updatedBy; artifact.approvedAt = artifact.updatedAt; }
  artifact.validation = validateArtifact(artifact);
  persist(tenantId, entries);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'artifact_status_updated', detail: { artifactId, status } });
  return artifact;
}

export const ARTIFACTS_MCP_TOOLS = [
  'mcp__artifacts__create_artifact', 'mcp__artifacts__list_artifacts', 'mcp__artifacts__set_artifact_status',
];

export function buildArtifactsMcpServer(tenant, agentId) {
  const tenantId = tenant.id;
  const createdBy = 'agent:' + agentId;
  const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  return createSdkMcpServer({
    name: 'artifacts',
    tools: [
      tool('create_artifact', 'Crea il deliverable canonico di una task. Per consegnare una task tipizzata devi creare un artefatto valido e portarlo a ready_for_review.', {
        taskId: z.string(), title: z.string(), resultType: z.enum(RESULT_TYPES).optional(), riskLevel: z.enum(RISK_LEVELS).optional(),
        executiveSummary: z.string(), content: z.string().optional(), format: z.enum(['markdown', 'html', 'json']).optional(),
        externalUrl: z.string().url().optional(), assumptions: z.array(z.string()).optional(), evidence: z.array(z.string()).optional(),
        status: z.enum(ARTIFACT_STATUSES).optional(),
      }, async (input) => text(createArtifact(tenantId, input, createdBy))),
      tool('list_artifacts', 'Elenca gli artefatti di una task o del tenant, con stato, rischio, versione e validazione.', {
        taskId: z.string().optional(), status: z.enum(ARTIFACT_STATUSES).optional(),
      }, async (input) => text(listArtifacts(tenantId, input))),
      tool('set_artifact_status', 'Porta un artefatto in ready_for_review quando è completo. Le approvazioni R3 restano esclusivamente umane.', {
        artifactId: z.string(), status: z.enum(ARTIFACT_STATUSES),
      }, async ({ artifactId, status }) => text(setArtifactStatus(tenantId, artifactId, status, createdBy))),
    ],
  });
}
