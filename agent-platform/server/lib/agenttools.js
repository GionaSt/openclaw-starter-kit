// Tool set consentiti a un agente, in base a ruolo/capacità dichiarate in
// tenants.json. Estratto da index.js (era inline) così è testabile in
// isolamento — vedi server/scripts/org-platform-check.mjs.
//
// Capacità per-agente (org platform, orchestrator-worker):
// - agent.dev = true: agente di sviluppo → tool su filesystem/codice
//   (Read/Grep/Glob/Write/Edit/Bash) oltre a web e MCP wiki/tasks.
// - agent.readOnly = true (ha senso solo con dev): NON scrive codice di
//   produzione → niente Write/Edit. È il qa-verifier: separazione
//   autore/verificatore (best practice). Esegue gli script di check (Bash),
//   legge e ispeziona (Read/Grep/Glob), riproduce i bug, ma non modifica le
//   feature che verifica. La wiki resta scrivibile via il tool MCP wiki_write
//   (non il tool Write), così può comunque assolvere la regola obbligatoria di
//   aggiornamento della wiki.
import { WIKI_MCP_TOOLS } from './wiki.js';
import { TASKS_MCP_TOOLS } from './tasks.js';
import { PREVIEW_MCP_TOOLS } from './previews.js';
import { ARTIFACTS_MCP_TOOLS } from './artifacts.js';
import { KNOWLEDGE_FILE_TOOLS } from './knowledge.js';

// Un agente NON dev con il campo "knowledge" (path a una cartella) riceve i tool
// file Read/Glob/Grep/Write vincolati a quella cartella (cwd + path-scoping,
// vedi index.js e lib/knowledge.js). knowledgeEnabled è deciso dal chiamante
// (index.js risolve il path ed esclude gli agenti dev, che restano invariati).
export function allowedToolsFor(agent, { tasksAccess = false, knowledgeEnabled = false } = {}) {
  // publish_preview è per TUTTI gli agenti di TUTTI i tenant (task 9d1b6ebb):
  // ogni agente può pubblicare un deliverable nella preview globale.
  const wikiAndTasks = [...WIKI_MCP_TOOLS, ...PREVIEW_MCP_TOOLS, ...(tasksAccess ? [...TASKS_MCP_TOOLS, ...ARTIFACTS_MCP_TOOLS] : [])];
  if (!agent?.dev) {
    const knowledgeTools = knowledgeEnabled ? [...KNOWLEDGE_FILE_TOOLS] : [];
    return ['WebSearch', 'WebFetch', ...knowledgeTools, ...wikiAndTasks];
  }
  const fsWrite = agent.readOnly ? [] : ['Write', 'Edit'];
  return ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep', ...fsWrite, 'Bash', 'TodoWrite', ...wikiAndTasks];
}
