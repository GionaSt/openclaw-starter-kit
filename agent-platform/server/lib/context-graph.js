import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './store.js';

export const CONTEXT_GRAPH_PATH = process.env.CONTEXT_GRAPH_PATH || join(DATA_DIR, 'context-graph', 'graph.json');

const STOPWORDS = new Set([
  'che', 'con', 'come', 'della', 'delle', 'degli', 'del', 'dei', 'dal', 'dallo', 'dai', 'da', 'di', 'e', 'ed', 'il', 'lo', 'la', 'le', 'gli', 'i',
  'in', 'nel', 'nella', 'nelle', 'nei', 'non', 'per', 'piu', 'più', 'su', 'un', 'una', 'uno', 'the', 'and', 'for', 'from', 'into', 'with', 'this', 'that',
  'sono', 'essere', 'anche', 'tutto', 'tutti', 'tutte', 'questo', 'questa', 'quello', 'quella', 'poi', 'ora', 'ma', 'se', 'o', 'a', 'al', 'alla', 'ai',
]);

let cache = { mtimeMs: 0, graph: null };

function normalize(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('it-IT');
}

export function contextTokens(value) {
  return [...new Set(normalize(value).match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])]
    .filter((token) => !STOPWORDS.has(token));
}

function loadGraph() {
  if (!existsSync(CONTEXT_GRAPH_PATH)) return null;
  const mtimeMs = statSync(CONTEXT_GRAPH_PATH).mtimeMs;
  if (cache.graph && cache.mtimeMs === mtimeMs) return cache.graph;
  try {
    cache = { mtimeMs, graph: JSON.parse(readFileSync(CONTEXT_GRAPH_PATH, 'utf8')) };
  } catch {
    cache = { mtimeMs: 0, graph: null };
  }
  return cache.graph;
}

function recencyScore(updatedAt) {
  const timestamp = Date.parse(updatedAt ?? '');
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  return Math.max(0, 2.5 - Math.log10(ageDays + 1));
}

function nodeScore(node, queryTokens, tenantId) {
  if (tenantId && node.tenantId && !['global', tenantId].includes(node.tenantId)) return -Infinity;
  const label = normalize(node.label);
  const content = normalize(node.search_text || node.content || '');
  const keywords = new Set(node.keywords ?? []);
  let score = recencyScore(node.updatedAt);
  for (const token of queryTokens) {
    if (label.includes(token)) score += 8;
    if (keywords.has(token)) score += 5;
    if (content.includes(token)) score += 2;
  }
  if (tenantId && node.tenantId === tenantId) score += 2;
  if (node.source_kind === 'openclaw-memory') score += 2.5;
  if (node.source_kind === 'v1-wiki') score += 1.75;
  if (node.source_kind === 'v2-project' || node.source_kind === 'v2-report') score += 1.5;
  if (node.source_kind === 'v1-task' || node.source_kind === 'v2-task') score += 0.75;
  return score;
}

export function queryContextGraph(query, { tenantId = null, limit = 8, maxChars = 6500 } = {}) {
  const graph = loadGraph();
  const queryTokens = contextTokens(query);
  if (!graph?.nodes?.length || !queryTokens.length) return { text: '', nodes: [], stats: graph?.graph?.context_stats ?? null };

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const ranked = graph.nodes
    .map((node) => ({ node, score: nodeScore(node, queryTokens, tenantId) }))
    .filter((item) => Number.isFinite(item.score) && item.score > 1.5)
    .sort((a, b) => b.score - a.score || String(b.node.updatedAt ?? '').localeCompare(String(a.node.updatedAt ?? '')))
    .slice(0, Math.max(limit * 3, 20));

  const selected = new Map();
  for (const item of ranked.slice(0, limit)) selected.set(item.node.id, item);
  const links = graph.links ?? graph.edges ?? [];
  for (const link of links) {
    const sourceSelected = selected.has(link.source);
    const targetSelected = selected.has(link.target);
    if (!sourceSelected && !targetSelected) continue;
    const neighborId = sourceSelected ? link.target : link.source;
    const neighbor = byId.get(neighborId);
    if (!neighbor || selected.has(neighborId)) continue;
    const score = nodeScore(neighbor, queryTokens, tenantId);
    if (score > 3 && selected.size < limit + 3) selected.set(neighborId, { node: neighbor, score: score - 0.5 });
  }

  const seenContent = new Set();
  const nodes = [...selected.values()].sort((a, b) => b.score - a.score).map((item) => item.node).filter((node) => {
    const key = node.checksum || normalize(`${node.label} ${String(node.content || '').slice(0, 500)}`);
    if (seenContent.has(key)) return false;
    seenContent.add(key);
    return true;
  });
  const chunks = [];
  let used = 0;
  for (const node of nodes) {
    const content = String(node.content || node.search_text || '').trim().slice(0, 1800);
    const source = `${node.source_file || 'sorgente sconosciuta'}${node.source_location ? `:${node.source_location}` : ''}`;
    const chunk = `### ${node.label}\n${content}\nFonte: ${source}`;
    if (used + chunk.length > maxChars) break;
    chunks.push(chunk);
    used += chunk.length;
  }
  return {
    text: chunks.length ? `## Contesto condiviso dal grafo canonico\n${chunks.join('\n\n')}` : '',
    nodes,
    stats: graph.graph?.context_stats ?? null,
  };
}

export function contextGraphStats() {
  const graph = loadGraph();
  return graph?.graph?.context_stats ?? { ready: false, path: CONTEXT_GRAPH_PATH };
}
