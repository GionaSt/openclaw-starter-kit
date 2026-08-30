// Registry deliverable multi-tenant per /preview/<tenantId>/<slug> (task
// 4ab8c6b8: globalizzare <your-domain>/preview/, prima solo statico e
// solo per business-a — vedi server/data/wiki/business-a/preview-*-build.md).
//
// Storage per tenant, stesso pattern di uploads.js:
//   server/data/previews/<tenantId>/registry.json   — array di deliverable
//   server/data/previews/<tenantId>/files/<slug>.<ext> — contenuto del deliverable
//
// Un deliverable è identificato da (tenantId, slug); pubblicare di nuovo con lo
// stesso slug SOVRASCRIVE (aggiorna file + entry, preserva createdAt originale).
import { writeFileSync, readFileSync, copyFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, basename, resolve, sep } from 'path';
import { marked } from 'marked';
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { readJson, writeJson, DATA_DIR, safeSegment } from './store.js';
import { tenantUploadDir } from './uploads.js';

export const PREVIEWS_DIR = join(DATA_DIR, 'previews');
const safe = safeSegment;

export const TIPI = ['html', 'markdown', 'immagine', 'pdf'];
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

export function tenantPreviewDir(tenantId) {
  const dir = join(PREVIEWS_DIR, safe(tenantId));
  mkdirSync(dir, { recursive: true });
  return dir;
}
function filesDir(tenantId) {
  const dir = join(tenantPreviewDir(tenantId), 'files');
  mkdirSync(dir, { recursive: true });
  return dir;
}
// Snapshot delle versioni precedenti di un deliverable (ripubblicazione sullo
// stesso slug = nuova versione, niente perdita silenziosa — task 9d1b6ebb):
//   files/versions/<slug>/v<N>.<ext>
function versionsDir(tenantId, slug) {
  const dir = join(filesDir(tenantId), 'versions', safe(slug));
  mkdirSync(dir, { recursive: true });
  return dir;
}
function registryPath(tenantId) {
  return join(tenantPreviewDir(tenantId), 'registry.json');
}

// Slug URL-safe: minuscolo, [a-z0-9-], niente traversal. Vuoto/non valido -> ''.
export function normalizeSlug(slug) {
  const s = String(slug ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return /^[a-z0-9][a-z0-9-]*$/.test(s) ? s : '';
}

function extFor(tipo, ext) {
  if (tipo === 'html') return 'html';
  if (tipo === 'markdown') return 'md';
  if (tipo === 'pdf') return 'pdf';
  if (tipo === 'immagine') {
    const e = String(ext ?? 'png').toLowerCase().replace(/^\./, '');
    return IMG_EXTS.includes(e) ? e : 'png';
  }
  return null;
}

export function listPreviews(tenantId) {
  return readJson(registryPath(tenantId), []);
}

// Tutti i tenant che hanno almeno un deliverable pubblicato (sotto PREVIEWS_DIR).
export function listPreviewTenantIds() {
  if (!existsSync(PREVIEWS_DIR)) return [];
  return readdirSync(PREVIEWS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

export function listAllPreviews() {
  return listPreviewTenantIds().flatMap((tenantId) => listPreviews(tenantId));
}

export function getPreview(tenantId, slug) {
  const s = normalizeSlug(slug);
  if (!s) return null;
  return listPreviews(tenantId).find((e) => e.slug === s) ?? null;
}

// Pubblica (o sovrascrive) un deliverable. `content` è un Buffer col contenuto
// grezzo del file (per html/markdown anche una string va bene). Lancia Error
// con .code su input non valido: INVALID_TYPE, INVALID_SLUG, EMPTY.
export function publishPreview(tenantId, { slug, titolo, tipo, content, ext, taskId, agente }) {
  if (!TIPI.includes(tipo)) {
    const e = new Error(`tipo non valido: ${tipo} (ammessi: ${TIPI.join(', ')})`);
    e.code = 'INVALID_TYPE';
    throw e;
  }
  const normSlug = normalizeSlug(slug);
  if (!normSlug) {
    const e = new Error('slug non valido: solo minuscole/numeri/trattini, non vuoto');
    e.code = 'INVALID_SLUG';
    throw e;
  }
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  if (buf.length === 0) {
    const e = new Error('contenuto vuoto');
    e.code = 'EMPTY';
    throw e;
  }
  const extension = extFor(tipo, ext);
  const filename = `${normSlug}.${extension}`;
  const registry = listPreviews(tenantId);
  const now = new Date().toISOString();
  const idx = registry.findIndex((e) => e.slug === normSlug);
  const prev = idx >= 0 ? registry[idx] : null;

  // Versioning: prima di sovrascrivere il file corrente, ne conserviamo una copia
  // sotto files/versions/<slug>/v<N>.<ext> — mai perdita silenziosa della versione
  // precedente (task 9d1b6ebb). `version` è il numero della versione ORA corrente
  // (parte da 1); `versions` è lo storico delle precedenti (più recenti in coda).
  const prevVersion = prev?.version ?? (prev ? 1 : 0);
  const versions = Array.isArray(prev?.versions) ? [...prev.versions] : [];
  if (prev) {
    const curPath = join(filesDir(tenantId), prev.file);
    if (existsSync(curPath) && prev.file === basename(prev.file)) {
      const prevExt = String(prev.file).split('.').pop() || 'bin';
      const snapName = `v${prevVersion}.${prevExt}`;
      copyFileSync(curPath, join(versionsDir(tenantId, normSlug), snapName));
      versions.push({
        version: prevVersion,
        file: `versions/${normSlug}/${snapName}`,
        tipo: prev.tipo,
        titolo: prev.titolo,
        taskId: prev.taskId ?? null,
        agente: prev.agente ?? null,
        updatedAt: prev.updatedAt ?? prev.createdAt ?? now,
      });
    }
  }

  writeFileSync(join(filesDir(tenantId), filename), buf);

  const entry = {
    tenantId,
    slug: normSlug,
    titolo: String(titolo ?? normSlug),
    tipo,
    file: filename,
    taskId: taskId ?? null,
    agente: agente ?? null,
    version: prevVersion + 1,
    versions,
    createdAt: prev ? prev.createdAt : now,
    updatedAt: now,
  };
  if (idx >= 0) registry[idx] = entry; else registry.push(entry);
  writeJson(registryPath(tenantId), registry);
  return entry;
}

// ---- URL pubblico + integrazione consegna task (task 9d1b6ebb) ----
// Base URL pubblica configurabile (deploy dietro nginx/HTTPS): PUBLIC_BASE_URL
// in env. Se assente, l'URL resta un path assoluto ("/preview/...") — apribile
// comunque sull'origine dell'app.
export function previewBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}
export function previewUrl(tenantId, slug) {
  return `${previewBaseUrl()}/preview/${encodeURIComponent(tenantId)}/${encodeURIComponent(slug)}`;
}

// Preview pubblicate da una specifica task (matching su taskId nel registry del
// tenant): usato per iniettare l'URL nella nota di consegna e nella push a Owner.
export function previewLinksForTask(tenantId, taskId) {
  if (!taskId) return [];
  return listPreviews(tenantId)
    .filter((e) => e.taskId === taskId)
    .map((e) => ({ slug: e.slug, titolo: e.titolo, tipo: e.tipo, url: previewUrl(tenantId, e.slug) }));
}

// Blocco di testo da appendere a una nota di consegna / corpo push. '' se nessuna preview.
export function formatPreviewLinks(links, { prefix = '🔗 Preview: ' } = {}) {
  if (!links || links.length === 0) return '';
  if (links.length === 1) return `${prefix}${links[0].url}`;
  return `${prefix}\n${links.map((l) => `- ${l.titolo}: ${l.url}`).join('\n')}`;
}

// Risolve il path assoluto del file di un entry, con difesa path traversal
// (entry.file è generato internamente da publishPreview, ma non ci fidiamo mai
// di un basename che non torni identico a se stesso).
export function resolvePreviewFile(tenantId, entry) {
  if (!entry?.file || entry.file !== basename(entry.file)) return null;
  const p = join(filesDir(tenantId), entry.file);
  return existsSync(p) ? p : null;
}

export function mimeForEntry(entry) {
  if (entry.tipo === 'pdf') return 'application/pdf';
  if (entry.tipo === 'immagine') {
    const ext = String(entry.file).split('.').pop()?.toLowerCase();
    return IMG_MIME[ext] ?? 'application/octet-stream';
  }
  return 'text/html; charset=utf-8'; // html e markdown (renderizzato) sono serviti come HTML
}

// ---- Rendering pagine HTML (dark theme coerente col preview business-a esistente) ----
export const PAGE_CSS = `body{margin:0;background:#0f0f10;color:#eee;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overflow-x:hidden}
.wrap{max-width:760px;margin:0 auto;padding:32px 20px 60px}
.pv{background:#000;border-bottom:2px solid #e8b923;color:#d9d4c7;font-size:12.5px;padding:9px 14px;text-align:center}
.pv a{color:#fff}
h1{font-size:24px;margin:0 0 4px}
.s{color:#8a8a8f;font-size:14px;margin:0 0 24px}
a.c{display:block;padding:16px 18px;margin:10px 0;background:#1b1b1e;border:1px solid #2c2c31;border-radius:10px;color:#fff;text-decoration:none}
a.c:hover{border-color:#e8b923}
.t{font-weight:600;overflow-wrap:anywhere}.d{color:#8a8a8f;font-size:13px;margin-top:3px;overflow-wrap:anywhere}
.p{color:#e8b923;font-size:12px;letter-spacing:.08em;text-transform:uppercase}
.tenant-h{margin-top:32px;font-size:13px;color:#e8b923;text-transform:uppercase;letter-spacing:.08em}
.md{overflow-wrap:anywhere}
.md h1,.md h2,.md h3{color:#fff}
.md pre{background:#1b1b1e;border:1px solid #2c2c31;border-radius:8px;padding:12px;overflow:auto}
.md code{background:#1b1b1e;padding:1px 5px;border-radius:4px}
.md a{color:#e8b923;overflow-wrap:anywhere}
.md blockquote{border-left:3px solid #e8b923;margin:0;padding:2px 16px;color:#c9c9cf}
.md table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%}
.md th,.md td{border:1px solid #2c2c31;padding:6px 10px}
.empty{color:#8a8a8f;font-style:italic}`;

function shell(title, body) {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<style>${PAGE_CSS}</style></head><body>${body}</body></html>`;
}

// Indice globale: raggruppato per tenant. `tenants` = [{ id, name, items }].
export function renderIndexHtml(tenants) {
  const groups = tenants.filter((t) => t.items.length > 0).map((t) => `
<div class="tenant-h">${t.name}</div>
${t.items.map((it) => `<a class="c" href="/preview/${encodeURIComponent(t.id)}/${encodeURIComponent(it.slug)}">
  <span class="t">${it.titolo}</span>
  <div class="d">${it.tipo} · pubblicato ${new Date(it.createdAt).toLocaleDateString('it-IT')}${it.agente ? ` · ${it.agente}` : ''}</div>
</a>`).join('')}`).join('');
  const body = `<div class="pv">Preview interna · non indicizzata · Agent Platform</div>
<div class="wrap">
<div class="p">Preview deliverable · tutti i business</div>
<h1>Indice preview</h1>
<p class="s">Deliverable pubblicati dagli agenti, per business.</p>
${groups || '<p class="empty">Nessun deliverable pubblicato ancora.</p>'}
</div>`;
  return shell('Preview — indice', body);
}

export function renderHtmlDeliverable(entry, rawHtml) {
  // L'HTML del deliverable è servito così com'è (sandboxato via CSP a livello di
  // route, non qui) — nessun wrapping, per non alterare markup/stile del file.
  return rawHtml;
}

export function renderMarkdownDeliverable(entry, markdownSource, tenantName) {
  const html = marked.parse(markdownSource);
  const body = `<div class="pv">Preview interna · non indicizzata · <a href="/preview/">← tutte le preview</a></div>
<div class="wrap">
<div class="p">${tenantName}</div>
<h1>${entry.titolo}</h1>
<div class="md">${html}</div>
</div>`;
  return shell(entry.titolo, body);
}

// ---- Tool MCP publish_preview, esposto a TUTTI gli agenti di TUTTI i tenant ----
// (task 9d1b6ebb). Ogni agente può pubblicare un deliverable nella preview
// globale e ricevere l'URL pubblico; taskId di origine e agente sono registrati
// in automatico (presi dal contesto della run, non dal modello).
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

// Legge il contenuto da `path` SOLO se dentro una root consentita: gli agenti dev
// (fs pieno) possono indicare qualunque path — non è escalation, già leggono il
// filesystem; gli altri agenti solo dentro la cartella upload del proprio tenant
// (file caricati in chat). Difende dal far pubblicare a un agente non-dev file
// arbitrari del server via path traversal.
function readContentFromPath(rawPath, { tenantId, allowAnyPath }) {
  const abs = resolve(String(rawPath));
  if (!existsSync(abs)) { const e = new Error(`path non trovato: ${rawPath}`); e.code = 'PATH_NOT_FOUND'; throw e; }
  if (!allowAnyPath) {
    const uploadRoot = resolve(tenantUploadDir(tenantId));
    const inRoot = abs === uploadRoot || abs.startsWith(uploadRoot + sep);
    if (!inRoot) { const e = new Error('path non consentito: usa "contenuto", oppure un file nella cartella upload del tenant'); e.code = 'PATH_FORBIDDEN'; throw e; }
  }
  return readFileSync(abs);
}

export function previewTools(tenant, agentId, { taskId = null, agentIsDev = false } = {}) {
  const tenantId = tenant.id;
  return [
    tool(
      'publish_preview',
      'Pubblica un tuo lavoro (deliverable) nella preview globale della piattaforma e ottieni un URL pubblico apribile come pagina (Owner lo vede così). '
        + 'Passa il contenuto in "contenuto" (testo: HTML o markdown) OPPURE in "path" (per immagini/PDF o file già su disco). '
        + 'tipo: "html" | "markdown" | "immagine" | "pdf". '
        + 'Con "slug" scegli l\'URL (minuscole/numeri/trattini); ripubblicare sullo stesso slug crea una NUOVA VERSIONE (la precedente resta conservata, mai persa). '
        + 'taskId di origine e nome agente sono registrati in automatico. Consiglio: consegna la task con l\'URL restituito nella nota — comparirà anche nella push a Owner.',
      {
        titolo: z.string().describe('Titolo del deliverable, mostrato in cima alla pagina e nell\'indice preview'),
        tipo: z.enum(TIPI).describe('html | markdown | immagine | pdf'),
        contenuto: z.string().optional().describe('Contenuto testuale (HTML o markdown). Alternativo a "path".'),
        path: z.string().optional().describe('Path a un file su disco da pubblicare (immagini/PDF o HTML già generato). Per gli agenti non-dev deve stare nella cartella upload del tenant.'),
        slug: z.string().optional().describe('Slug URL-safe (minuscole/numeri/trattini). Se omesso deriva dal titolo. Stesso slug = nuova versione.'),
        ext: z.string().optional().describe('Estensione per le immagini (png/jpg/jpeg/webp/gif). Default png.'),
      },
      async ({ titolo, tipo, contenuto, path, slug, ext }) => {
        try {
          let content;
          if (path) {
            content = readContentFromPath(path, { tenantId, allowAnyPath: agentIsDev });
          } else if (contenuto !== undefined && contenuto !== null) {
            content = contenuto;
          } else {
            return ok({ published: false, error: 'serve "contenuto" (testo) oppure "path" (file)' });
          }
          const effSlug = normalizeSlug(slug) || normalizeSlug(titolo);
          if (!effSlug) return ok({ published: false, error: 'slug non derivabile: passa "slug" (minuscole/numeri/trattini) o un titolo con caratteri validi' });
          const entry = publishPreview(tenantId, {
            slug: effSlug, titolo, tipo, content, ext, taskId, agente: agentId,
          });
          return ok({
            published: true,
            url: previewUrl(tenantId, entry.slug),
            slug: entry.slug,
            tipo: entry.tipo,
            version: entry.version,
            previousVersions: (entry.versions ?? []).length,
            taskId: entry.taskId,
            agente: entry.agente,
            hint: 'Consegna la task incollando questo url nella nota (update_task): comparirà anche nella push a Owner.',
          });
        } catch (err) {
          return ok({ published: false, error: String(err?.message ?? err), code: err?.code ?? null });
        }
      },
    ),
  ];
}

export function buildPreviewMcpServer(tenant, agentId, opts = {}) {
  return createSdkMcpServer({ name: 'preview', version: '1.0.0', tools: previewTools(tenant, agentId, opts) });
}

export const PREVIEW_MCP_TOOLS = ['mcp__preview__publish_preview'];
