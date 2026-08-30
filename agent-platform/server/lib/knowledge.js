// Campo "knowledge" per agente (tenants.json): path a una cartella che diventa
// la base di lavoro file dell'agente. Quando un agente NON dev dichiara
// "knowledge", il server (index.js) gli concede i tool file Read/Glob/Grep/Write
// con cwd sulla cartella e vincola gli accessi a quella cartella (path-scoping
// via canUseTool). Write serve SOLO perché l'agente crei/mantenga i propri file
// di indice/memoria dentro la cartella — non fuori.
//
// Estratto in un modulo dedicato così la logica (risoluzione path + scoping) è
// testabile in isolamento senza consumare la subscription — vedi
// server/scripts/knowledge-scope-check.mjs.
import { resolve, sep } from 'path';
import { realpathSync, existsSync, statSync } from 'fs';

// Tool file concessi a un agente con "knowledge". Read/Glob/Grep per consultare,
// Write per mantenere i propri file di indice DENTRO la cartella.
export const KNOWLEDGE_FILE_TOOLS = ['Read', 'Glob', 'Grep', 'Write'];

// Risolve agent.knowledge in un path assoluto canonico. Il path in config può
// essere relativo (risolto rispetto a repoRoot, es. "knowledge/business-a")
// o assoluto. Se la cartella esiste la canonicalizziamo (realpath) così la base
// dello scoping è a prova di symlink. Ritorna null se il campo manca/non è
// valido. NB: non tocca gli agenti dev — è il chiamante a escluderli.
export function resolveKnowledgeDir(agent, repoRoot) {
  if (!agent || typeof agent.knowledge !== 'string' || !agent.knowledge.trim()) return null;
  const abs = resolve(repoRoot, agent.knowledge.trim());
  try {
    if (existsSync(abs) && statSync(abs).isDirectory()) return realpathSync(abs);
  } catch { /* cartella non ancora creata: usiamo il path normalizzato */ }
  return abs;
}

// Estrae dal tool-call il path che vogliamo vincolare, per ciascun tool file.
// Read/Write → file_path; Glob/Grep → path (opzionale: se assente usano cwd,
// che è già dentro la cartella → consentito).
function toolTargetPath(toolName, input) {
  if (!input || typeof input !== 'object') return null;
  switch (toolName) {
    case 'Read':
    case 'Write':
      return typeof input.file_path === 'string' ? input.file_path : null;
    case 'Glob':
    case 'Grep':
      return typeof input.path === 'string' ? input.path : null;
    default:
      return null;
  }
}

// target è dentro una delle root consentite? Confronto lessicale sul path
// normalizzato (uguaglianza esatta o prefisso "<root>/"). I path vengono già
// risolti dal chiamante.
export function isInsideAny(roots, target) {
  for (const root of roots) {
    if (target === root) return true;
    const base = root.endsWith(sep) ? root : root + sep;
    if (target.startsWith(base)) return true;
  }
  return false;
}

// Valuta un tool-call rispetto alle root consentite.
//  { scoped:false }                 → tool non governato (non è un tool file)
//  { scoped:true, allowed:true }    → tool file entro le root (o senza path → cwd)
//  { scoped:true, allowed:false }   → tool file che tenta di uscire dalle root
// roots[0] DEVE essere la knowledge dir (== cwd): i path relativi si risolvono lì.
export function evaluateKnowledgePath(roots, toolName, input) {
  if (!KNOWLEDGE_FILE_TOOLS.includes(toolName)) return { scoped: false };
  const p = toolTargetPath(toolName, input);
  if (p == null) return { scoped: true, allowed: true }; // usa cwd → dentro
  const abs = resolve(roots[0], p); // relativo → risolto sulla knowledge dir; assoluto → invariato
  return { scoped: true, allowed: isInsideAny(roots, abs) };
}

// Costruisce un canUseTool che impone il path-scoping sui tool file e delega
// tutto il resto (tool non file, e i tool file DENTRO la cartella) all'handler
// successivo `next` (es. le approvazioni dei sensitiveTools). Se non c'è un next,
// consente. Firma compatibile con l'SDK: (toolName, input, options).
export function buildKnowledgeCanUseTool(roots, next) {
  return async (toolName, input, options) => {
    const ev = evaluateKnowledgePath(roots, toolName, input);
    if (ev.scoped && !ev.allowed) {
      return {
        behavior: 'deny',
        message: `Accesso negato: «${toolName}» è consentito solo dentro la cartella knowledge dell'agente, non su path esterni.`,
      };
    }
    if (next) return next(toolName, input, options);
    return { behavior: 'allow', updatedInput: input };
  };
}
