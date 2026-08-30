import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { contextTokens, CONTEXT_GRAPH_PATH } from '../lib/context-graph.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = dirname(SCRIPT_DIR);
const REPO_DIR = dirname(SERVER_DIR);
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR || resolve(REPO_DIR, '..');
const OPENCLAW_SESSIONS_DIR = process.env.OPENCLAW_SESSIONS_DIR || resolve(WORKSPACE_DIR, '..', 'agents', 'main', 'sessions');
const DATA_DIR = process.env.AGENT_PLATFORM_DATA_DIR || join(SERVER_DIR, 'data');
const GRAPH_PATH = process.env.CONTEXT_GRAPH_PATH || CONTEXT_GRAPH_PATH;
const MAX_NODE_CONTENT = Number(process.env.CONTEXT_GRAPH_MAX_NODE_CHARS || 12_000);

const nodes = new Map();
const links = new Map();
const sources = new Map();

function safeId(value) {
  const normalized = String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (normalized.length <= 150) return normalized || 'node';
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 12);
  return `${normalized.slice(0, 135)}_${hash}`;
}

function checksum(value) { return createHash('sha256').update(String(value ?? '')).digest('hex'); }
function isoFromStat(path) { try { return statSync(path).mtime.toISOString(); } catch { return null; } }
function clip(value, length = MAX_NODE_CONTENT) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  return text.length <= length ? text : `${text.slice(0, length)}\n[contenuto completo nella sorgente]`;
}
function addNode(input) {
  const id = safeId(input.id);
  const content = clip(input.content);
  const node = {
    id, label: String(input.label || id), file_type: input.file_type || 'document',
    source_file: input.source_file || '', source_location: input.source_location || null,
    source_kind: input.source_kind || 'document', tenantId: input.tenantId || 'global',
    updatedAt: input.updatedAt || null, content,
    keywords: contextTokens(`${input.label || ''} ${content}`).slice(0, 160),
    checksum: checksum(content), provenance: input.provenance || 'EXTRACTED',
  };
  nodes.set(id, node);
  if (node.source_file) sources.set(node.source_file, (sources.get(node.source_file) || 0) + 1);
  return id;
}
function addLink(source, target, relation, sourceFile, confidence = 'EXTRACTED') {
  source = safeId(source); target = safeId(target);
  if (!nodes.has(source) || !nodes.has(target) || source === target) return;
  const key = `${source}|${relation}|${target}`;
  links.set(key, { source, target, relation, confidence, confidence_score: confidence === 'EXTRACTED' ? 1 : 0.75, source_file: sourceFile || '', weight: 1 });
}
function walk(dir, predicate, output = []) {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'graphify-out') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, predicate, output);
    else if (predicate(path)) output.push(path);
  }
  return output;
}
function parseMarkdown(path, sourceKind, tenantId = 'global', root = WORKSPACE_DIR) {
  const text = readFileSync(path, 'utf8');
  const rel = relative(root, path) || basename(path);
  const docId = addNode({ id: `${sourceKind}_${rel}`, label: basename(path), content: text.slice(0, 4000), source_file: path, source_kind: sourceKind, tenantId, updatedAt: isoFromStat(path) });
  const headings = [...text.matchAll(/^(#{1,4})\s+(.+)$/gm)];
  if (!headings.length) return;
  headings.forEach((match, index) => {
    const start = match.index;
    const end = headings[index + 1]?.index ?? text.length;
    const section = text.slice(start, end);
    const sectionId = addNode({ id: `${sourceKind}_${rel}_${match[2]}`, label: match[2].trim(), content: section, source_file: path, source_location: `L${text.slice(0, start).split('\n').length}`, source_kind: sourceKind, tenantId, updatedAt: isoFromStat(path), file_type: 'concept' });
    addLink(docId, sectionId, 'contains', path);
  });
}
function inferTenant(value) {
  const text = String(value ?? '').toLocaleLowerCase('en-US');
  // Keyword-based tenant routing: customize these regexes with terms specific
  // to each of your tenants (product names, domains, project code names).
  if (/agent[- ]platform|openclaw|docker|gateway|vps|runtime|graphify|operating system v2/.test(text)) return 'platform';
  if (/acme[- ]services|agency|consulting|quote|milestone/.test(text)) return 'acme-services';
  if (/acme[- ]retail|e-?commerce|storefront|catalog|checkout/.test(text)) return 'acme-retail';
  return 'owner-private';
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n');
}
function parseOpenClawSession(path) {
  const sessionId = basename(path, '.jsonl');
  const rootId = addNode({ id: `openclaw_session_${sessionId}`, label: `OpenClaw session ${sessionId.slice(0, 8)}`, content: `Sessione OpenClaw. Cronologia completa nella sorgente.`, source_file: path, source_kind: 'openclaw-session', tenantId: 'owner-private', updatedAt: isoFromStat(path) });
  let previous = null;
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'message' || !['user', 'assistant'].includes(entry.message?.role)) continue;
    const text = textFromContent(entry.message.content);
    if (!text.trim()) continue;
    const messageId = addNode({ id: `openclaw_message_${sessionId}_${entry.id || lineIndex}`, label: `${entry.message.role === 'user' ? 'Owner' : 'Assistant'} ${entry.timestamp || ''}`, content: text, source_file: path, source_location: `L${lineIndex + 1}`, source_kind: 'openclaw-chat', tenantId: inferTenant(text), updatedAt: entry.timestamp || isoFromStat(path), provenance: 'EXTRACTED' });
    addLink(rootId, messageId, 'contains', path);
    if (previous) addLink(previous, messageId, 'precedes', path);
    previous = messageId;
  }
}
function parseTasks(path) {
  const tenantId = basename(path, '.json');
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
  const tasks = Array.isArray(data) ? data : data.tasks || [];
  for (const task of tasks) {
    const id = addNode({ id: `v1_task_${tenantId}_${task.id}`, label: task.title || `Task ${task.id}`, content: JSON.stringify({ description: task.description, status: task.status, urgency: task.urgency, assignedTo: task.assignedTo, note: task.note, result: task.result, updatedAt: task.updatedAt }, null, 2), source_file: path, source_kind: 'v1-task', tenantId, updatedAt: task.updatedAt || task.createdAt || isoFromStat(path) });
    const tenantNode = addNode({ id: `tenant_${tenantId}`, label: tenantId, content: `Tenant ${tenantId}`, source_file: path, source_kind: 'tenant', tenantId });
    addLink(tenantNode, id, 'owns', path);
  }
}
function parseV2(path) {
  const tenantId = basename(path, '.json');
  let state;
  try { state = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
  for (const project of state.projects || []) {
    const projectId = addNode({ id: `v2_project_${tenantId}_${project.id}`, label: project.title || `Progetto ${project.id}`, content: JSON.stringify({ objective: project.objective, status: project.status, brief: project.brief, permissions: project.permissions, successCriteria: project.successCriteria, decisions: project.decisions, architectSummary: project.architectSummary }, null, 2), source_file: path, source_kind: 'v2-project', tenantId, updatedAt: project.updatedAt || project.createdAt });
    for (const step of project.steps || []) {
      const stepId = addNode({ id: `v2_step_${tenantId}_${project.id}_${step.id}`, label: step.label || step.id, content: JSON.stringify({ description: step.description, status: step.status, model: step.model, execution: step.execution }, null, 2), source_file: path, source_kind: 'v2-task', tenantId, updatedAt: step.completedAt || project.updatedAt });
      addLink(projectId, stepId, 'contains', path);
    }
    for (const message of project.messages || []) {
      const messageId = addNode({ id: `v2_message_${tenantId}_${project.id}_${message.id || checksum(message.text).slice(0, 12)}`, label: `${message.role || 'message'} in ${project.title}`, content: message.text, source_file: path, source_kind: 'v2-chat', tenantId, updatedAt: message.createdAt || project.updatedAt });
      addLink(projectId, messageId, 'contains', path);
    }
  }
  for (const definition of state.reportDefinitions || []) {
    const reportId = addNode({ id: `v2_report_${tenantId}_${definition.id}`, label: definition.title || `Report ${definition.id}`, content: JSON.stringify({ purpose: definition.purpose, status: definition.status, audience: definition.audience, kpis: definition.kpis, dataSources: definition.dataSources, permissions: definition.permissions, schedule: definition.schedule, facsimile: definition.facsimile }, null, 2), source_file: path, source_kind: 'v2-report', tenantId, updatedAt: definition.updatedAt || definition.createdAt });
    for (const message of definition.messages || []) {
      const messageId = addNode({ id: `v2_report_message_${tenantId}_${definition.id}_${message.id || checksum(message.text).slice(0, 12)}`, label: `${message.role || 'message'} in ${definition.title}`, content: message.text, source_file: path, source_kind: 'v2-chat', tenantId, updatedAt: message.createdAt || definition.updatedAt });
      addLink(reportId, messageId, 'contains', path);
    }
  }
}
function parseRunStore(path, sourceKind) {
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
  const items = Array.isArray(data) ? data : Object.values(data || {});
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const tenantId = item.tenantId || item.tenant || 'global';
    addNode({ id: `${sourceKind}_${item.id || checksum(JSON.stringify(item)).slice(0, 16)}`, label: item.title || item.agentId || `${sourceKind} ${item.id || ''}`, content: JSON.stringify({ status: item.status, taskId: item.taskId, agentId: item.agentId, error: item.error, summary: item.summary, result: item.result, note: item.note }, null, 2), source_file: path, source_kind: sourceKind, tenantId, updatedAt: item.updatedAt || item.completedAt || item.createdAt });
  }
}

for (const name of ['MEMORY.md', 'USER.md', 'SOUL.md']) {
  const path = join(WORKSPACE_DIR, name);
  if (existsSync(path)) parseMarkdown(path, 'openclaw-memory', inferTenant(`${path} ${readFileSync(path, 'utf8').slice(0, 8000)}`));
}
for (const path of walk(join(WORKSPACE_DIR, 'memory'), (file) => extname(file) === '.md')) parseMarkdown(path, 'openclaw-memory', inferTenant(`${path} ${readFileSync(path, 'utf8').slice(0, 8000)}`));
for (const path of walk(join(DATA_DIR, 'wiki'), (file) => extname(file) === '.md')) {
  const tenantId = relative(join(DATA_DIR, 'wiki'), path).split(/[\\/]/)[0] || 'global';
  parseMarkdown(path, 'v1-wiki', tenantId, join(DATA_DIR, 'wiki'));
}
for (const path of walk(join(DATA_DIR, 'tasks'), (file) => extname(file) === '.json')) parseTasks(path);
for (const path of walk(join(DATA_DIR, 'operating-system-v2'), (file) => extname(file) === '.json')) parseV2(path);
for (const [file, kind] of [['runs.json', 'v1-run'], ['agent_sessions.json', 'v1-agent-session']]) {
  const path = join(DATA_DIR, file); if (existsSync(path)) parseRunStore(path, kind);
}
if (existsSync(OPENCLAW_SESSIONS_DIR)) {
  for (const path of walk(OPENCLAW_SESSIONS_DIR, (file) => file.endsWith('.jsonl') && !file.endsWith('.trajectory.jsonl'))) parseOpenClawSession(path);
  const indexPath = join(OPENCLAW_SESSIONS_DIR, 'sessions.json');
  if (existsSync(indexPath)) addNode({ id: 'openclaw_sessions_index', label: 'OpenClaw sessions index', content: readFileSync(indexPath, 'utf8'), source_file: indexPath, source_kind: 'openclaw-session-index', tenantId: 'owner-private', updatedAt: isoFromStat(indexPath) });
}

const sourceKinds = {};
for (const node of nodes.values()) sourceKinds[node.source_kind] = (sourceKinds[node.source_kind] || 0) + 1;
const generatedAt = new Date().toISOString();
const graph = {
  directed: true, multigraph: false,
  graph: {
    name: 'Unified Context Graph', format: 'graphify-compatible', graphifyValidatedVersion: '0.9.31', schema_version: 1, generatedAt,
    context_stats: { ready: true, generatedAt, nodes: nodes.size, links: links.size, sources: sources.size, sourceKinds, graphPath: GRAPH_PATH },
  },
  nodes: [...nodes.values()], links: [...links.values()],
};
mkdirSync(dirname(GRAPH_PATH), { recursive: true });
const temp = `${GRAPH_PATH}.tmp`;
writeFileSync(temp, JSON.stringify(graph));
renameSync(temp, GRAPH_PATH);
console.log(JSON.stringify(graph.graph.context_stats));
