#!/usr/bin/env node
// Pubblica un deliverable nel registry multi-tenant di /preview/ (task 4ab8c6b8).
// Uso diretto da parte degli agenti (Bash tool, stesso filesystem del server —
// nessun token HTTP richiesto, coerente col fatto che gli agenti producono già
// i file su disco durante il turno).
//
// Uso:
//   node scripts/publish-preview.mjs <tenantId> <slug> <tipo> <filePath> \
//        [--titolo "Titolo"] [--task-id <id>] [--agente <agentId>] [--ext <ext>]
//
// tipo: html | markdown | immagine | pdf
// Se il server è già in esecuzione, riavvialo (o attendi il prossimo restart)
// solo se hai cambiato lib/previews.js: la lettura del registry è on-demand a
// ogni richiesta, quindi un nuovo deliverable è visibile SUBITO senza restart.
import { readFileSync } from 'fs';
import { publishPreview } from '../lib/previews.js';

const args = process.argv.slice(2);
const [tenantId, slug, tipo, filePath] = args;
if (!tenantId || !slug || !tipo || !filePath) {
  console.error('uso: node scripts/publish-preview.mjs <tenantId> <slug> <tipo> <filePath> [--titolo T] [--task-id ID] [--agente NOME] [--ext EXT]');
  process.exit(1);
}
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

try {
  const content = readFileSync(filePath);
  const entry = publishPreview(tenantId, {
    slug,
    tipo,
    content,
    titolo: flag('titolo'),
    taskId: flag('task-id'),
    agente: flag('agente'),
    ext: flag('ext'),
  });
  console.log(JSON.stringify(entry, null, 2));
  console.log(`\nURL: /preview/${entry.tenantId}/${entry.slug}`);
} catch (e) {
  console.error(`errore: ${e.message}${e.code ? ` (${e.code})` : ''}`);
  process.exit(1);
}
