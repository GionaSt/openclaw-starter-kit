// CLI di RIPRISTINO di un backup della piattaforma + verifica integrità.
//   node scripts/restore.mjs <backup.tar.gz> <dir-destinazione> [--force]
//
// Estrae l'archivio in una directory PULITA (crea <dir>/data e <dir>/config),
// poi verifica: (a) tutti i *.json sotto data/ si parsano; (b) ogni repo git
// della wiki (data/wiki/<tenant>) risponde a `git log`. Non tocca mai la
// directory di produzione: il ripristino reale è un passo manuale (fermare il
// server, spostare data/config, riavviare) documentato in docs/backup.md.
import { execFileSync } from 'child_process';
import {
  existsSync, mkdirSync, readdirSync, statSync, readFileSync,
} from 'fs';
import { join } from 'path';

const [backupFile, targetDir, ...rest] = process.argv.slice(2);
const force = rest.includes('--force');

if (!backupFile || !targetDir) {
  console.error('uso: node scripts/restore.mjs <backup.tar.gz> <dir-destinazione> [--force]');
  process.exit(2);
}
if (!existsSync(backupFile)) {
  console.error(`KO  archivio inesistente: ${backupFile}`);
  process.exit(2);
}

// La destinazione deve essere vuota, salvo --force: mai sovrascrivere per sbaglio.
if (existsSync(targetDir)) {
  const entries = readdirSync(targetDir);
  if (entries.length && !force) {
    console.error(`KO  ${targetDir} non è vuota (${entries.length} elementi). Usa --force per procedere comunque.`);
    process.exit(2);
  }
} else {
  mkdirSync(targetDir, { recursive: true });
}

console.log(`Ripristino ${backupFile} → ${targetDir}`);
try {
  execFileSync('tar', ['-xzf', backupFile, '-C', targetDir], { stdio: ['ignore', 'ignore', 'pipe'] });
} catch (err) {
  console.error(`KO  estrazione fallita: ${err.message}`);
  process.exit(1);
}

const dataDir = join(targetDir, 'data');
const configDir = join(targetDir, 'config');
let failures = 0;
const ok = (msg) => console.log(`OK  ${msg}`);
const ko = (msg) => { console.error(`KO  ${msg}`); failures += 1; };

// Struttura di base presente?
if (existsSync(dataDir)) ok('data/ estratta'); else ko('data/ mancante nell\'archivio');
if (existsSync(configDir)) ok('config/ estratta'); else ko('config/ mancante nell\'archivio');

// Chiavi necessarie al ripristino incluse?
for (const key of ['agent-registration.key', 'secret.key', 'vapid.json']) {
  if (existsSync(join(dataDir, key))) ok(`chiave presente: ${key}`);
  else ko(`chiave MANCANTE: ${key}`);
}

// (a) Tutti i JSON sotto data/ e config/ si parsano.
function walkJson(dir) {
  let files = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) files = files.concat(walkJson(full));
    else if (e.name.endsWith('.json')) files.push(full);
  }
  return files;
}
let jsonOk = 0;
for (const base of [dataDir, configDir]) {
  if (!existsSync(base)) continue;
  for (const f of walkJson(base)) {
    try { JSON.parse(readFileSync(f, 'utf8')); jsonOk += 1; }
    catch (err) { ko(`JSON corrotto: ${f} — ${err.message}`); }
  }
}
ok(`${jsonOk} file JSON parsati senza errori`);

// (b) I repo git della wiki rispondono a git log.
const wikiDir = join(dataDir, 'wiki');
if (existsSync(wikiDir)) {
  for (const e of readdirSync(wikiDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const repo = join(wikiDir, e.name);
    if (!existsSync(join(repo, '.git'))) { ko(`wiki/${e.name}: manca .git`); continue; }
    try {
      const out = execFileSync('git', ['-C', repo, 'log', '--oneline', '-1'], { encoding: 'utf8' }).trim();
      ok(`wiki/${e.name}: git log → ${out}`);
    } catch (err) {
      ko(`wiki/${e.name}: git log fallito — ${err.message}`);
    }
  }
} else {
  console.log('..  nessuna wiki nell\'archivio (ok se non ancora inizializzata)');
}

console.log('');
if (failures === 0) {
  console.log('RIPRISTINO OK — integrità verificata.');
  process.exit(0);
} else {
  console.error(`RIPRISTINO CON ${failures} PROBLEMI — vedi sopra.`);
  process.exit(1);
}
