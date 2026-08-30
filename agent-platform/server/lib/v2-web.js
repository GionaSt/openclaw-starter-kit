// Ricerca web in SOLA LETTURA per il Project Architect V2 (task D1 del progetto
// "fix approvazioni + capacita Architect").
//
// Cosa fa:
//   - web_search  -> ricerca via Tavily (provider gia' in uso su OpenClaw), torna
//                    titolo + URL + estratto per ogni risultato;
//   - web_fetch   -> GET di UNA pagina, HTML/testo -> estratto testuale citabile.
// Cosa NON fa (vincolo del brief: "nessuna pubblicazione"):
//   - nessun metodo diverso da GET verso il web aperto: l'unico POST e' quello
//     all'API di ricerca Tavily, che non pubblica nulla;
//   - nessuna scrittura su disco: il modulo non importa nulla da 'fs';
//   - nessuna chiamata a rete interna: guardia anti-SSRF su ogni URL (loopback,
//     RFC1918, link-local e ULA rifiutati, anche dopo redirect).
//
// Il tutto passa ESTRATTI, mai pagine intere: tetti espliciti su risultati,
// caratteri e byte, ogni troncamento dichiarato in chiaro nel testo.
import { lookup } from 'dns/promises';
import { join } from 'path';
import { CONFIG_DIR, readJson } from './store.js';

// ---- Tetti (estratti, non pagine intere) ----
export const SEARCH_MAX_RESULTS = 5;
export const SEARCH_SNIPPET_MAX_CHARS = 600;
export const FETCH_MAX_CHARS = 6000;          // ~1.5k token per pagina
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;
export const SEARCH_TIMEOUT_MS = 20_000;
export const WEB_TOOL_MAX_ROUNDS = 3;

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const ALLOWED_CONTENT_TYPES = /^(text\/html|text\/plain|text\/markdown|application\/(json|xhtml\+xml|xml)|text\/xml)/i;

// Chiave Tavily: env (compose, da deploy/.env) oppure server/config/platform.json
// -> { "webSearch": { "apiKey": "tvly-..." } }. Nessuna chiave hardcoded qui:
// il file di config e' la stessa fonte usata da push/digest/transcription.
export function getWebSearchConfig() {
  const fileCfg = readJson(join(CONFIG_DIR, 'platform.json'), {})?.webSearch ?? {};
  return {
    apiKey: String(process.env.TAVILY_API_KEY || fileCfg.apiKey || '').trim(),
    provider: 'tavily',
  };
}

// True se la RICERCA e' configurata su questo processo. web_fetch da solo
// funzionerebbe anche senza chiave, ma senza search l'Architect non ha modo di
// trovare un URL da leggere: il blocco istruzioni resta spento tutto insieme.
export function webSearchAvailable() {
  return Boolean(getWebSearchConfig().apiKey);
}

// ---- Guardia anti-SSRF ------------------------------------------------------
// Il server gira in container con accesso a host.docker.internal e alla rete
// docker: senza questa guardia un URL suggerito dal modello (o da una pagina
// che redirige) potrebbe far leggere servizi interni. Solo http/https, solo
// indirizzi pubblici, verifica ripetuta sull'URL FINALE dopo i redirect.
function isPrivateAddress(address, family) {
  if (family === 6) {
    const ip = String(address).toLowerCase();
    if (ip === '::1' || ip === '::') return true;
    if (ip.startsWith('fe80') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1], 4);
    return false;
  }
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                          // multicast / riservati
  return false;
}

export async function assertPublicUrl(rawUrl, { resolver = lookup } = {}) {
  let url;
  try { url = new URL(String(rawUrl).trim()); } catch { throw new Error(`URL non valido: ${rawUrl}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`schema non consentito (${url.protocol}): solo http/https`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|host\.docker\.internal)$/i.test(host)) {
    throw new Error(`host interno non consentito: ${host}`);
  }
  let addresses;
  try { addresses = await resolver(host, { all: true }); } catch { throw new Error(`host non risolvibile: ${host}`); }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (list.length === 0) throw new Error(`host non risolvibile: ${host}`);
  for (const entry of list) {
    if (isPrivateAddress(entry.address, entry.family)) {
      throw new Error(`indirizzo interno non consentito: ${host} -> ${entry.address}`);
    }
  }
  return url;
}

// ---- HTML -> testo ----------------------------------------------------------
// Entita' nominate frequenti su pagine IT/EN. Le numeriche (&#233; / &#x2019;)
// sono gestite a parte; una entita' sconosciuta resta com'e' invece di sparire.
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  agrave: 'à', egrave: 'è', eacute: 'é', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  agraveu: 'À', Agrave: 'À', Egrave: 'È', Eacute: 'É', Igrave: 'Ì', Ograve: 'Ò', Ugrave: 'Ù',
  ccedil: 'ç', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·',
  euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', plusmn: '±',
  times: '×', divide: '÷', copy: '©', reg: '®', trade: '™',
};

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    const key = code.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key.startsWith('#x')) { const n = parseInt(key.slice(2), 16); return Number.isFinite(n) ? String.fromCodePoint(n) : match; }
    if (key.startsWith('#')) { const n = parseInt(key.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : match; }
    return match;
  });
}

export function htmlToText(html) {
  const raw = String(html ?? '');
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  const text = decodeEntities(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(nav|header|footer|aside|svg|form)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)\s*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

function truncate(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return { text: s, truncated: false };
  return { text: `${s.slice(0, maxChars)}\n[...pagina troncata a ${maxChars} caratteri su ${s.length} totali...]`, truncated: true };
}

// ---- web_search -------------------------------------------------------------
export async function webSearch(query, { limit = SEARCH_MAX_RESULTS, fetchImpl = fetch, apiKey = null } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, error: 'query vuota' };
  const key = apiKey ?? getWebSearchConfig().apiKey;
  if (!key) return { ok: false, error: 'ricerca web non configurata (manca TAVILY_API_KEY / platform.json webSearch.apiKey)' };
  const maxResults = Math.max(1, Math.min(SEARCH_MAX_RESULTS, Number(limit) || SEARCH_MAX_RESULTS));
  let payload;
  try {
    const response = await fetchImpl(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: q, max_results: maxResults, search_depth: 'basic' }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = String(await response.text().catch(() => '')).slice(0, 200);
      return { ok: false, error: `ricerca fallita (HTTP ${response.status})${detail ? `: ${detail}` : ''}` };
    }
    payload = await response.json();
  } catch (error) {
    return { ok: false, error: `ricerca fallita: ${String(error?.message ?? error)}` };
  }
  const results = (Array.isArray(payload?.results) ? payload.results : []).slice(0, maxResults).map((item) => ({
    title: String(item?.title ?? '').trim() || '(senza titolo)',
    url: String(item?.url ?? '').trim(),
    snippet: truncate(String(item?.content ?? '').replace(/\s+/g, ' ').trim(), SEARCH_SNIPPET_MAX_CHARS).text,
    publishedDate: item?.published_date ? String(item.published_date) : null,
  })).filter((item) => item.url);
  return { ok: true, query: q, results, text: formatSearchResults(q, results) };
}

function formatSearchResults(query, results) {
  if (results.length === 0) return `[web_search query="${query}"] Nessun risultato.`;
  const body = results.map((r, i) => [
    `${i + 1}. ${r.title}`,
    `   Fonte verificata: ${r.url}${r.publishedDate ? ` (data: ${r.publishedDate})` : ''}`,
    `   Estratto: ${r.snippet}`,
  ].join('\n')).join('\n\n');
  return `[web_search query="${query}"] Risultati (SOLA LETTURA). Ogni riga "Fonte verificata" e' un dato esterno citabile con il suo link; tutto cio' che aggiungi tu e' ragionamento e va etichettato come tale.\n${body}`;
}

// ---- web_fetch --------------------------------------------------------------
export async function webFetch(rawUrl, { maxChars = FETCH_MAX_CHARS, fetchImpl = fetch, resolver = lookup } = {}) {
  let url;
  try { url = await assertPublicUrl(rawUrl, { resolver }); } catch (error) { return { ok: false, url: String(rawUrl), error: String(error.message) }; }
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET', // read-only: mai altri metodi verso il web aperto
      redirect: 'follow',
      headers: { 'user-agent': 'AgentPlatformV2-Architect/1.0 (read-only)', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, url: url.toString(), error: `lettura fallita: ${String(error?.message ?? error)}` };
  }
  const finalUrl = String(response.url || url.toString());
  if (finalUrl !== url.toString()) {
    // Redirect: rivalida la destinazione, altrimenti la guardia sarebbe aggirabile.
    try { await assertPublicUrl(finalUrl, { resolver }); } catch (error) { return { ok: false, url: finalUrl, error: `redirect bloccato: ${error.message}` }; }
  }
  if (!response.ok) return { ok: false, url: finalUrl, error: `pagina non leggibile (HTTP ${response.status})` };
  const contentType = String(response.headers?.get?.('content-type') ?? '');
  if (contentType && !ALLOWED_CONTENT_TYPES.test(contentType)) {
    return { ok: false, url: finalUrl, error: `tipo di contenuto non supportato (${contentType.split(';')[0]}): leggibili solo pagine HTML/testo` };
  }
  const declared = Number(response.headers?.get?.('content-length') ?? 0);
  if (declared && declared > FETCH_MAX_BYTES) {
    return { ok: false, url: finalUrl, error: `pagina troppo grande (${Math.round(declared / 1024)} KB, limite ${Math.round(FETCH_MAX_BYTES / 1024)} KB)` };
  }
  let body;
  try { body = await readBounded(response, FETCH_MAX_BYTES); } catch (error) { return { ok: false, url: finalUrl, error: `lettura fallita: ${String(error?.message ?? error)}` }; }
  const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
  const parsed = isHtml ? htmlToText(body) : { title: '', text: String(body).trim() };
  const { text, truncated } = truncate(parsed.text, maxChars);
  if (!text) return { ok: false, url: finalUrl, error: 'pagina senza contenuto testuale leggibile' };
  return {
    ok: true,
    url: finalUrl,
    title: parsed.title,
    truncated,
    chars: parsed.text.length,
    text,
    source: `Fonte verificata: ${finalUrl}`,
  };
}

// Legge il corpo con tetto sui byte: una pagina enorme non deve poter riempire
// la memoria del container (mem_limit 1536 MB condiviso con i run).
async function readBounded(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
  }
  try { await reader.cancel(); } catch { /* stream gia' chiuso */ }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer.slice(0, maxBytes));
}

// ---- Tool loop per l'Architect ---------------------------------------------
// Stessa meccanica della memoria (lib/v2-memory.js): il Gateway non fa
// tool-calling server-side sull'endpoint /v1/chat/completions, quindi i tag
// vengono scritti nel testo dal modello ed eseguiti qui dal server.
export const WEB_TOOL_CALL_RE = /<web_search\s+query="([^"]+)"\s*\/>|<web_fetch\s+url="([^"]+)"\s*\/>/g;

export const ARCHITECT_WEB_INSTRUCTIONS = `

RICERCA WEB (SOLA LETTURA):
Puoi cercare sul web e leggere una pagina. NON puoi pubblicare, inviare, iscriverti o compilare form: le uniche operazioni possibili sono ricerca e lettura.
Per usarla inserisci nella risposta UNO di questi tag (poi il turno riparte con i risultati):
- <web_search query="parole chiave"/>
- <web_fetch url="https://esempio.com/pagina"/>
Regole d'uso OBBLIGATORIE:
- Distingui SEMPRE i due piani quando usi il web:
  * FONTE VERIFICATA: un dato che hai letto davvero nei risultati, riportato con il link ("Fonte verificata: URL").
  * RAGIONAMENTO: deduzioni, stime e opinioni tue. Etichettale come "ragionamento:" e NON metterci un link.
- Non attribuire mai a una fonte un dato che non compare nel suo estratto. Se un numero ti serve e non l'hai letto, dillo e cercalo, oppure dichiaralo come stima.
- Usa il web quando servono dati esterni verificabili (prezzi, normative, concorrenti, dati di mercato, documentazione). Per decisioni gia' prese da Owner usa prima la memoria.
- Prima cerca, poi apri con web_fetch solo le pagine che servono davvero (gli estratti sono limitati a ${FETCH_MAX_CHARS} caratteri).
- Massimo ${WEB_TOOL_MAX_ROUNDS} giri di ricerca/lettura per messaggio: sintetizza.`;

export async function runWebToolCalls(text, options = {}) {
  const calls = [];
  for (const match of String(text ?? '').matchAll(WEB_TOOL_CALL_RE)) {
    if (match[1] !== undefined) {
      const result = await webSearch(match[1], options);
      calls.push({
        tool: 'web_search',
        query: match[1],
        output: result.ok ? result.text : `[web_search query="${match[1]}"] Errore: ${result.error}`,
      });
    } else {
      const result = await webFetch(match[2], options);
      calls.push({
        tool: 'web_fetch',
        url: match[2],
        output: result.ok
          ? `[web_fetch] ${result.source}${result.title ? `\nTitolo: ${result.title}` : ''}\nContenuto letto (dato verificato, citalo con il link sopra):\n${result.text}`
          : `[web_fetch url="${match[2]}"] Errore: ${result.error}`,
      });
    }
  }
  return calls;
}

// Rimuove i tag tool dalla risposta visibile in chat (restano nell'audit log).
export function stripWebToolTags(text) {
  return String(text ?? '').replace(WEB_TOOL_CALL_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}
