// Task B2 — pipeline contenuto verso l'Architect.
//
// Il Project Architect NON gira col tool-calling dell'SDK: parla col Gateway
// via /v1/chat/completions (vedi lib/openclaw-gateway.js), quindi non ha il
// tool Read. Dire "leggilo con Read" negli allegati non produceva nulla:
// immagini e PDF erano di fatto invisibili. Qui il server fa il lavoro PRIMA
// del turno:
//   - immagine  -> contenuto VISIVO (data URL in una parte image_url del
//                  messaggio, formato OpenAI-compatible supportato dal Gateway)
//   - pdf       -> TESTO estratto localmente con pdfjs-dist (libreria mainstream
//                  pure-JS, nessun servizio esterno, nessuna rete)
//   - text/md   -> testo letto dal file
// In tutti i casi si passano ESTRATTI, non file interi: tetti espliciti su
// caratteri, pagine e byte, e ogni troncamento/scarto e' dichiarato in chiaro
// nel prompt (niente contenuto tagliato in silenzio).
import { readFileSync } from 'fs';

// ---- Tetti (estratti, non file interi) ----
export const TEXT_EXCERPT_MAX_CHARS = 12_000;   // ~3k token per allegato testuale
export const PDF_EXCERPT_MAX_CHARS = 16_000;    // ~4k token per PDF
export const PDF_MAX_PAGES = 40;                // oltre: estratto delle prime N pagine
// Limiti del Gateway su /v1/chat/completions (docs/gateway/openai-http-api.md):
// maxImageParts 8, images.maxBytes 10MB, maxTotalImageBytes 20MB. Restiamo
// dentro questi valori lato client, cosi' l'errore non arriva dal Gateway ma
// diventa un avviso leggibile nel prompt.
export const MAX_IMAGE_PARTS = 8;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_TOTAL_MAX_BYTES = 20 * 1024 * 1024;

function truncate(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, maxChars)}\n\n[...estratto troncato a ${maxChars} caratteri su ${s.length} totali...]`,
    truncated: true,
  };
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- PDF -> testo (locale, pdfjs-dist legacy build) ----
// Import dinamico: pdfjs pesa in avvio e serve solo quando arriva davvero un
// PDF. Se il modulo manca (deploy senza dipendenza installata) l'errore diventa
// un avviso nel prompt, non un 500 sul turno dell'Architect.
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

export async function extractPdfText(path, { maxPages = PDF_MAX_PAGES, maxChars = PDF_EXCERPT_MAX_CHARS } = {}) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(readFileSync(path));
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,   // niente eval: input non fidato (upload utente)
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  const pages = doc.numPages;
  const pagesRead = Math.min(pages, maxPages);
  const chunks = [];
  let chars = 0;
  let stoppedAtPage = null;
  for (let i = 1; i <= pagesRead; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let pageText = '';
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      pageText += item.str;
      if (item.hasEOL) pageText += '\n';
      else if (item.str && !item.str.endsWith(' ')) pageText += ' ';
    }
    page.cleanup();
    pageText = pageText.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!pageText) continue;
    chunks.push(`--- pagina ${i} ---\n${pageText}`);
    chars += pageText.length;
    if (chars >= maxChars) { stoppedAtPage = i; break; }
  }
  await doc.destroy();
  const joined = chunks.join('\n\n');
  const { text, truncated } = truncate(joined, maxChars);
  return {
    text,
    pages,
    pagesRead: stoppedAtPage ?? pagesRead,
    truncated: truncated || stoppedAtPage !== null || pagesRead < pages,
    // PDF scansionato senza layer testo: nessun testo estraibile.
    empty: joined.trim().length === 0,
  };
}

export function extractTextFile(path, { maxChars = TEXT_EXCERPT_MAX_CHARS } = {}) {
  const raw = readFileSync(path, 'utf8');
  return truncate(raw, maxChars);
}

// ---- Classificazione lato server (mai dal client) ----
// `kind`/`type` arrivano nel body della chat: un client (o un bug della UI) puo'
// mandarli sbagliati e far trattare un .txt come immagine o un PDF come testo
// grezzo. L'estensione del file salvato e' invece scelta dal server all'upload
// dalla MIME allowlist (lib/uploads.js), quindi e' la fonte affidabile.
const EXT_KIND = {
  png: { kind: 'image', type: 'image/png' },
  jpg: { kind: 'image', type: 'image/jpeg' },
  jpeg: { kind: 'image', type: 'image/jpeg' },
  webp: { kind: 'image', type: 'image/webp' },
  gif: { kind: 'image', type: 'image/gif' },
  pdf: { kind: 'pdf', type: 'application/pdf' },
  txt: { kind: 'text', type: 'text/plain' },
  md: { kind: 'text', type: 'text/markdown' },
  csv: { kind: 'text', type: 'text/csv' },
};

export function classifyAttachment(a = {}) {
  const source = String(a.stored || a.path || a.name || '');
  const ext = source.split('.').pop()?.toLowerCase() ?? '';
  const byExt = EXT_KIND[ext];
  if (byExt) return byExt;
  // Estensione sconosciuta (non dovrebbe passare l'allowlist di upload):
  // fallback prudente a testo, mai a immagine.
  return { kind: 'text', type: String(a.type ?? 'text/plain') };
}

// ---- Pipeline completa ----
// Ritorna: { block, images, notices }
//  - block:  testo da appendere al prompt (contenuto testuale + elenco visivi)
//  - images: [{ name, type, dataUrl }] da passare come parti image_url
//  - notices: avvisi leggibili (troncamenti, scarti per limite, errori)
export async function buildAttachmentContent(attachments = []) {
  const atts = Array.isArray(attachments) ? attachments : [];
  const sections = [];
  const images = [];
  const notices = [];
  let imageBytes = 0;

  for (const a of atts) {
    const { kind, type } = classifyAttachment(a);
    const label = `${a.name} (${type}, ${humanBytes(a.size ?? 0)})`;
    if (!a.path) {
      notices.push(`Allegato ${label}: file non disponibile sul server, ignorato.`);
      continue;
    }
    try {
      if (kind === 'image') {
        if (images.length >= MAX_IMAGE_PARTS) {
          notices.push(`Immagine ${label}: superato il limite di ${MAX_IMAGE_PARTS} immagini per messaggio, non analizzata visivamente.`);
          continue;
        }
        const buf = readFileSync(a.path);
        if (buf.length > IMAGE_MAX_BYTES) {
          notices.push(`Immagine ${label}: troppo grande per l'analisi visiva (max ${humanBytes(IMAGE_MAX_BYTES)} per immagine), non inviata al modello.`);
          continue;
        }
        if (imageBytes + buf.length > IMAGE_TOTAL_MAX_BYTES) {
          notices.push(`Immagine ${label}: superato il totale di ${humanBytes(IMAGE_TOTAL_MAX_BYTES)} di immagini per messaggio, non inviata al modello.`);
          continue;
        }
        imageBytes += buf.length;
        images.push({ name: a.name, type, dataUrl: `data:${type};base64,${buf.toString('base64')}` });
        sections.push(`### Immagine allegata: ${a.name}\nE' inclusa in questo messaggio come contenuto visivo: guardala e rispondi nel merito di cio' che mostra.`);
        continue;
      }
      if (kind === 'pdf') {
        const res = await extractPdfText(a.path);
        if (res.empty) {
          notices.push(`PDF ${label}: nessun testo estraibile (probabile scansione senza OCR). Chiedi a Owner il contenuto o una versione testuale.`);
          sections.push(`### PDF allegato: ${a.name}\n(nessun testo estraibile: PDF immagine/scansione, ${res.pages} pagine)`);
          continue;
        }
        if (res.truncated) {
          notices.push(`PDF ${label}: incluso solo un ESTRATTO (${res.pagesRead} pagine su ${res.pages}, max ${PDF_EXCERPT_MAX_CHARS} caratteri). Se ti serve altro, chiedi quale parte approfondire.`);
        }
        sections.push(`### PDF allegato: ${a.name} — testo estratto (${res.pagesRead}/${res.pages} pagine)\n\`\`\`\n${res.text}\n\`\`\``);
        continue;
      }
      // text / markdown / csv
      const res = extractTextFile(a.path);
      if (res.truncated) {
        notices.push(`File ${label}: incluso solo un ESTRATTO (primi ${TEXT_EXCERPT_MAX_CHARS} caratteri).`);
      }
      sections.push(`### Allegato testuale: ${a.name}\n\`\`\`\n${res.text}\n\`\`\``);
    } catch (error) {
      notices.push(`Allegato ${label}: estrazione fallita (${String(error?.message ?? error).slice(0, 160)}).`);
    }
  }

  if (!sections.length && !notices.length) return { block: '', images: [], notices: [] };
  let block = "\n\n---\nALLEGATI DI QUESTO MESSAGGIO (gia' elaborati dal server: NON hai tool di lettura file, tutto cio' che serve e' qui sotto).\n";
  if (sections.length) block += `\n${sections.join('\n\n')}\n`;
  if (notices.length) block += `\nAVVISI SUGLI ALLEGATI (dillo a Owner se rilevante):\n${notices.map((n) => `- ${n}`).join('\n')}\n`;
  return { block, images, notices };
}
