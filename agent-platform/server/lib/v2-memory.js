// Memoria OpenClaw in SOLA LETTURA per il Project Architect V2
// (task C1 del progetto "fix approvazioni + capacita Architect").
//
// Cosa fa: ricerca lessicale con ranking su MEMORY.md + memory/*.md (flat) e
// lettura mirata di righe da un file di memoria. NIENTE scrittura: il modulo
// importa solo readFileSync/readdirSync, non esiste alcun path di write.
//
// Vincoli (brief progetto):
// - solo estratti, mai file interi in contesto;
// - ogni estratto porta la citazione percorso + righe (Source: path#Lx-Ly);
// - radice memoria configurabile via env per i test (OPENCLAW_MEMORY_ROOT),
//   default = <workspace>/memory dove workspace = OPENCLAW_WORKSPACE_DIR
//   (in produzione /root/.openclaw/workspace, montato read-only nel container).
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, join, resolve, sep } from 'path';
import { OPENCLAW_WORKSPACE } from './openclaw-paths.js';

export const MEMORY_ROOT = process.env.OPENCLAW_MEMORY_ROOT || join(OPENCLAW_WORKSPACE, 'memory');
export const MEMORY_INDEX_FILE = join(OPENCLAW_WORKSPACE, 'MEMORY.md');
const MEMORY_INDEX_IN_ROOT = join(MEMORY_ROOT, '..', 'MEMORY.md');

const TOKEN_RE = /[a-z0-9àèéìòù]{3,}/gi;
const STOPWORDS = new Set([
  'della', 'delle', 'degli', 'dello', 'nella', 'nelle', 'questa', 'questo', 'quando',
  'quanto', 'come', 'cosa', 'dove', 'perche', 'sono', 'stato', 'stata', 'essere',
  'avere', 'fare', 'from', 'with', 'that', 'this', 'have', 'been', 'the', 'and',
  'for', 'non', 'che', 'per', 'una', 'con', 'dei', 'gli', 'lei', 'lui', 'sul',
  'alla', 'allo', 'anche', 'dopo', 'prima', 'senza', 'sotto', 'sopra', 'tra',
]);

const MAX_READ_LINES = 120;
const MAX_LINE_CHARS = 500;
const SNIPPET_RADIUS = 2;
const MAX_PAGE_CHARS = 300_000; // oltre questo una pagina e' quasi certamente un dump: salta

function memoryTokens(text) {
  const tokens = String(text ?? '').toLocaleLowerCase('it-IT').match(TOKEN_RE) ?? [];
  return [...new Set(tokens.filter((token) => !STOPWORDS.has(token)))];
}

function resolveMemoryFile(relPath) {
  // Accetta "memory/foo.md", "foo.md" o "MEMORY.md". Rifiuta tutto il resto:
  // la memoria e' FLAT per scelta (wiki-schema), niente sottocartelle.
  let name = String(relPath ?? '').trim().replace(/\\/g, '/');
  if (name === 'MEMORY.md') {
    return existsSync(MEMORY_INDEX_FILE) ? MEMORY_INDEX_FILE
      : (existsSync(MEMORY_INDEX_IN_ROOT) ? resolve(MEMORY_INDEX_IN_ROOT) : null);
  }
  name = name.replace(/^memory\//, '');
  if (name !== basename(name) || !name.endsWith('.md')) return null;
  const abs = resolve(MEMORY_ROOT, name);
  if (!abs.startsWith(resolve(MEMORY_ROOT) + sep)) return null;
  return existsSync(abs) ? abs : null;
}

function listMemoryFiles() {
  const files = [];
  const push = (abs, display) => {
    try {
      const stat = statSync(abs);
      if (stat.isFile() && stat.size <= MAX_PAGE_CHARS) files.push({ abs, display, mtime: stat.mtimeMs });
    } catch { /* file sparito tra listing e stat: ignora */ }
  };
  if (existsSync(MEMORY_INDEX_FILE)) push(MEMORY_INDEX_FILE, 'MEMORY.md');
  else if (existsSync(MEMORY_INDEX_IN_ROOT)) push(resolve(MEMORY_INDEX_IN_ROOT), 'MEMORY.md');
  if (existsSync(MEMORY_ROOT)) {
    for (const entry of readdirSync(MEMORY_ROOT, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) push(join(MEMORY_ROOT, entry.name), `memory/${entry.name}`);
    }
  }
  return files;
}

// Lettura mirata di righe con citazione. from/to sono 1-based, clampati ai
// limiti; oltre MAX_READ_LINES il blocco viene troncato e segnalato.
export function memoryReadExcerpt(relPath, { from = 1, to = null } = {}) {
  const abs = resolveMemoryFile(relPath);
  if (!abs) return { ok: false, error: `file di memoria non trovato o non consentito: ${relPath}` };
  let lines;
  try { lines = readFileSync(abs, 'utf8').split('\n'); } catch { return { ok: false, error: `file illeggibile: ${relPath}` }; }
  const startLine = Math.max(1, Number(from) || 1);
  const endLine = Math.min(lines.length, Number(to) || Math.min(lines.length, startLine + MAX_READ_LINES - 1));
  const clipped = endLine - startLine + 1 > MAX_READ_LINES;
  const finalEnd = clipped ? startLine + MAX_READ_LINES - 1 : endLine;
  const body = [];
  for (let i = startLine; i <= finalEnd; i += 1) {
    const line = lines[i - 1] ?? '';
    body.push(`${i}: ${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line}`);
  }
  const display = abs === resolve(MEMORY_INDEX_FILE) || abs === resolve(MEMORY_INDEX_IN_ROOT) ? 'MEMORY.md' : `memory/${basename(abs)}`;
  return {
    ok: true,
    path: display,
    totalLines: lines.length,
    source: `Source: ${display}#L${startLine}-L${finalEnd}`,
    excerpt: body.join('\n') + (clipped ? `\n[estratto troncato a ${MAX_READ_LINES} righe su ${lines.length} totali]` : ''),
  };
}

// Ricerca lessicale con ranking: ogni pagina prende punteggio = somma dei
// token della query presenti (bonus se nel titolo/prima riga). Estrae solo le
// righe che contengono un token + SNIPPET_RADIUS righe di contesto, con
// citazione per ogni blocco.
export function memorySearch(query, { limit = 5, maxChars = 4000 } = {}) {
  const tokens = memoryTokens(query);
  if (tokens.length === 0) return { ok: true, results: [], text: '' };
  const scored = [];
  for (const file of listMemoryFiles()) {
    let raw;
    try { raw = readFileSync(file.abs, 'utf8'); } catch { continue; }
    const lower = raw.toLocaleLowerCase('it-IT');
    let score = 0;
    const matched = [];
    for (const token of tokens) {
      const hits = lower.split(token).length - 1;
      if (hits > 0) { score += Math.min(hits, 5); matched.push(token); }
    }
    if (score === 0) continue;
    // bonus titolo/heading
    const head = raw.slice(0, 300).toLocaleLowerCase('it-IT');
    for (const token of matched) if (head.includes(token)) score += 3;
    scored.push({ file, raw, score, matched });
  }
  scored.sort((a, b) => b.score - a.score || b.file.mtime - a.file.mtime);
  const results = [];
  let usedChars = 0;
  for (const item of scored.slice(0, Math.max(1, Math.min(10, limit)))) {
    const lines = item.raw.split('\n');
    const hitLines = new Set();
    lines.forEach((line, index) => {
      const l = line.toLocaleLowerCase('it-IT');
      if (item.matched.some((token) => l.includes(token))) {
        for (let i = Math.max(0, index - SNIPPET_RADIUS); i <= Math.min(lines.length - 1, index + SNIPPET_RADIUS); i += 1) hitLines.add(i);
      }
    });
    // Righe hit coalesce in blocchi contigui, max 3 blocchi per pagina.
    const sorted = [...hitLines].sort((a, b) => a - b);
    const blocks = [];
    for (const idx of sorted) {
      const last = blocks.at(-1);
      if (last && idx <= last.end + 1) last.end = idx;
      else if (blocks.length < 3) blocks.push({ start: idx, end: idx });
    }
    for (const block of blocks) {
      const from = block.start + 1;
      const to = block.end + 1;
      const body = [];
      for (let i = from; i <= to; i += 1) {
        const line = lines[i - 1] ?? '';
        body.push(`${i}: ${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line}`);
      }
      const excerpt = body.join('\n');
      const entry = {
        path: item.file.display,
        source: `Source: ${item.file.display}#L${from}-L${to}`,
        excerpt,
      };
      const cost = excerpt.length + entry.source.length + 8;
      if (usedChars + cost > maxChars) return { ok: true, results, text: formatMemoryResults(results) };
      usedChars += cost;
      results.push(entry);
    }
  }
  return { ok: true, results, text: formatMemoryResults(results) };
}

function formatMemoryResults(results) {
  if (results.length === 0) return '';
  return results.map((r) => `${r.source}\n${r.excerpt}`).join('\n\n');
}

// True se la memoria e' raggiungibile da QUESTO processo (test/dev fuori dal
// container: OPENCLAW_MEMORY_ROOT punta a una fixture temporanea).
export function memoryAvailable() {
  return existsSync(MEMORY_ROOT) || existsSync(MEMORY_INDEX_FILE) || existsSync(MEMORY_INDEX_IN_ROOT);
}

// ---- Tool loop per agenti testuali (Architect V2) --------------------------
// L'endpoint /v1/chat/completions del Gateway non fa tool-calling server-side,
// quindi il loop e' qui: il modello chiede letture con tag nel testo, questa
// funzione li esegue (solo lettura, solo memory/*.md) e rilancia il turno con
// gli estratti citati (percorso + righe). Max maxRounds, cosi' una richiesta
// patologica non puo' girare all'infinito. runAgent e' iniettato: testabile
// senza rete/LLM.
export const MEMORY_TOOL_CALL_RE = /<memory_search\s+query="([^"]+)"\s*\/>|<memory_read\s+path="([^"]+)"(?:\s+from="(\d+)")?(?:\s+to="(\d+)")?\s*\/>/g;
export const MEMORY_TOOL_MAX_ROUNDS = 3;

export const ARCHITECT_MEMORY_INSTRUCTIONS = `

MEMORIA OPENCLAW (SOLA LETTURA):
Hai accesso in sola lettura alla memoria persistente di Owner (MEMORY.md e memory/*.md: decisioni passate, strategie, brand, progetti, footgun tecnici). NON puoi scriverla.
Per consultarla inserisci nella risposta UNO di questi tag (poi il turno riparte con gli estratti):
- <memory_search query="parole chiave della ricerca"/>
- <memory_read path="memory/nome-pagina.md" from="1" to="80"/>
Regole d'uso:
- Usala quando la richiesta tocca decisioni/progetti/preferenze gia' registrate: rispondi da memoria invece di richiedere a Owner cose che ha gia' detto.
- Ogni fatto preso dalla memoria va citato con la sua fonte (Source: percorso#Lriga), che ti arriva insieme agli estratti.
- Niente file interi: gli estratti sono gia' limitati, non chiedere piu' di 120 righe per volta.
- La memoria e' un indice curato, non un archivio completo: se un dato operativo recente non c'e', chiedilo a Owner invece di inventarlo.
- Massimo ${MEMORY_TOOL_MAX_ROUNDS} ricerche per messaggio: sintetizza quello che serve.`;

function runMemoryToolCalls(text) {
  const calls = [];
  for (const match of String(text ?? '').matchAll(MEMORY_TOOL_CALL_RE)) {
    if (match[1] !== undefined) {
      const result = memorySearch(match[1], { limit: 5, maxChars: 4000 });
      calls.push({
        tool: 'memory_search', query: match[1],
        output: result.results.length === 0
          ? `[memory_search query="${match[1]}"] Nessun estratto pertinente nella memoria.`
          : `[memory_search query="${match[1]}"] Estratti (sola lettura, cita la fonte):
${result.text}`,
      });
    } else {
      const result = memoryReadExcerpt(match[2], { from: match[3], to: match[4] });
      calls.push({
        tool: 'memory_read', path: match[2],
        output: result.ok
          ? `[memory_read ${result.source}]
${result.excerpt}`
          : `[memory_read path="${match[2]}"] Errore: ${result.error}`,
      });
    }
  }
  return calls;
}

// Rimuove i tag tool dalla risposta visibile in chat (restano in audit log).
export function stripMemoryToolTags(text) {
  return String(text ?? '').replace(MEMORY_TOOL_CALL_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Esegue il loop: runAgent(prompt) -> testo; se il testo contiene tag tool li
// risolve e rilancia con gli estratti. Torna { text, toolLog, rounds }.
// extraToolRunners: lista di funzioni async (text) -> calls[] con la stessa
// forma di runMemoryToolCalls ({ tool, output, ... }). Serve a innestare altri
// tool testuali nello STESSO loop senza duplicarlo (task D1: ricerca web, vedi
// lib/v2-web.js). Default vuoto: il comportamento storico non cambia.
export async function runAgentWithMemory({ basePrompt, runAgent, maxRounds = MEMORY_TOOL_MAX_ROUNDS, buildFollowUp, extraToolRunners = [] }) {
  const toolLog = [];
  let prompt = basePrompt;
  let text = '';
  for (let round = 0; round <= maxRounds; round += 1) {
    text = (await runAgent(prompt)) ?? '';
    if (!String(text).trim()) throw new Error('risposta vuota dall\'agente');
    const calls = runMemoryToolCalls(text);
    for (const runner of extraToolRunners) calls.push(...((await runner(text)) ?? []));
    if (calls.length === 0 || round === maxRounds) {
      if (calls.length > 0) toolLog.push(...calls.map((c) => ({ ...c, round, dropped: true })));
      break;
    }
    toolLog.push(...calls.map((c) => ({ ...c, round })));
    const resultsBlock = calls.map((c) => c.output).join('\n\n');
    prompt = buildFollowUp
      ? buildFollowUp({ basePrompt, resultsBlock, round })
      : `${basePrompt}\n\nRISULTATI DELLE LETTURE DI MEMORIA CHE HAI RICHIESTO (sola lettura, gia' eseguite dal server):\n${resultsBlock}\n\nOra rispondi citando le fonti (Source: percorso#Lriga) per ogni fatto preso dalla memoria. Se ti serve un altro estratto puoi fare un'altra ricerca, altrimenti chiudi con la risposta.`;
  }
  const executedRounds = toolLog.filter((c) => !c.dropped).length > 0
    ? Math.max(...toolLog.filter((c) => !c.dropped).map((c) => c.round)) + 1
    : 0;
  return { text, toolLog, rounds: executedRounds };
}
