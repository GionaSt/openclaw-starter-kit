// Backup automatico di server/data e server/config con rotazione (task a5088334).
// Perché: un disco corrotto oggi cancella tutto (task, wiki, journal, config, chat).
// Un solo archivio tar.gz che include TUTTO server/data (chiavi comprese) e
// server/config: i repo git della wiki finiscono dentro come .git, quindi dopo il
// restore `git log` risponde senza bisogno di git bundle separati — la soluzione
// più semplice che ripristina davvero tutto.
//
// Destinazione FUORI da server/data (default /app/backups, override via
// AGENT_PLATFORM_BACKUP_DIR): così può diventare un volume Docker separato nel
// deploy VPS. Struttura:  <BACKUP_DIR>/daily/  e  <BACKUP_DIR>/weekly/.
// Rotazione: ultimi 7 giornalieri + 4 settimanali (una copia promossa a weekly
// ogni ~7 giorni). Tutto sincrono: usabile anche nel handler SIGTERM pre-riavvio.
import { execFileSync } from 'child_process';
import {
  mkdirSync, readdirSync, statSync, renameSync, copyFileSync, unlinkSync, rmSync,
} from 'fs';
import { join } from 'path';
import { SERVER_DIR } from './store.js';
import { logAudit } from './audit.js';
import { journalRegisterExternal, journalComplete, journalFail } from './runs.js';

// /app/backups di default (SERVER_DIR = /app/server). Override per i test.
export const BACKUP_DIR = process.env.AGENT_PLATFORM_BACKUP_DIR || join(SERVER_DIR, '..', 'backups');
export const DAILY_DIR = join(BACKUP_DIR, 'daily');
export const WEEKLY_DIR = join(BACKUP_DIR, 'weekly');

export const KEEP_DAILY = 7;
export const KEEP_WEEKLY = 4;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Cartelle/pattern esclusi dal tar. node_modules non vive in data/config ma è
// escluso per sicurezza; *.tmp sono i file temporanei della scrittura atomica
// (store.js) e vanno saltati. Le chiavi (agent-registration.key, secret.key,
// vapid.json) stanno in data/ e NON sono escluse: servono al ripristino.
const TAR_EXCLUDES = ['node_modules', '*.tmp'];

const pad = (n) => String(n).padStart(2, '0');
// Timestamp ordinabile lessicograficamente: YYYYMMDD-HHMMSS (ora locale).
function stampOf(now) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// Estrae il ms dell'epoch dal nome file platform-YYYYMMDD-HHMMSS(-reason).tar.gz.
function tsFromName(name) {
  const m = name.match(/platform-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function listBackups(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith('platform-') && f.endsWith('.tar.gz'))
      .sort((a, b) => tsFromName(b) - tsFromName(a)); // più recente prima
  } catch {
    return [];
  }
}

function sha256(file) {
  try {
    return execFileSync('sha256sum', [file], { encoding: 'utf8' }).split(/\s+/)[0];
  } catch {
    return null;
  }
}

// Promuove il backup giornaliero a settimanale se l'ultimo weekly ha >= 7 giorni
// (o non esiste): ~un weekly ogni settimana, deterministico e senza edge di
// calendario. Ritorna il nome del file weekly creato, o null.
export function maybePromoteWeekly({ dailyFile, name, now = new Date() }) {
  mkdirSync(WEEKLY_DIR, { recursive: true });
  const weeklies = listBackups(WEEKLY_DIR);
  const newest = weeklies.length ? tsFromName(weeklies[0]) : 0;
  if (newest && now.getTime() - newest < WEEK_MS) return null;
  const dest = join(WEEKLY_DIR, name);
  copyFileSync(dailyFile, dest);
  return name;
}

// Pota daily e weekly ai limiti di ritenzione (per numero, i più vecchi cadono).
export function pruneRotation({ keepDaily = KEEP_DAILY, keepWeekly = KEEP_WEEKLY } = {}) {
  const removed = { daily: [], weekly: [] };
  for (const [dir, keep, key] of [[DAILY_DIR, keepDaily, 'daily'], [WEEKLY_DIR, keepWeekly, 'weekly']]) {
    const files = listBackups(dir); // già ordinati recente->vecchio
    for (const f of files.slice(keep)) {
      try { unlinkSync(join(dir, f)); removed[key].push(f); } catch { /* già rimosso */ }
    }
  }
  return removed;
}

// Crea un backup completo (sincrono). Ritorna { ok, file, name, stamp, sizeBytes,
// sha256, reason, createdAt, weekly, pruned } oppure { ok:false, error, reason }.
export function createBackupSync({ now = new Date(), reason = 'manual' } = {}) {
  try {
    mkdirSync(DAILY_DIR, { recursive: true });
    const suffix = reason && reason !== 'manual' ? `-${reason}` : '';
    let stamp = stampOf(now);
    let name = `platform-${stamp}${suffix}.tar.gz`;
    let file = join(DAILY_DIR, name);
    // Collisione sullo stesso secondo (raro): rendi unico con un contatore.
    let n = 2;
    while (safeExists(file)) { name = `platform-${stamp}${suffix}-${n}.tar.gz`; file = join(DAILY_DIR, name); n += 1; }

    // Scrittura atomica: tar su .inprogress, poi rename → un backup parziale non
    // sembra mai completo. -C SERVER_DIR così l'archivio contiene data/ e config/
    // con path relativi (restore pulito). node_modules non è sotto data/config,
    // ma resta escluso per sicurezza insieme ai *.tmp.
    const tmp = `${file}.inprogress`;
    const args = ['-czf', tmp, '-C', SERVER_DIR];
    for (const ex of TAR_EXCLUDES) args.push(`--exclude=${ex}`);
    args.push('data', 'config');
    // Il server scrive in server/data DURANTE il backup (runs.json, audit,
    // sessioni…). GNU tar allora esce con status 1 ("file changed as we read
    // it"): NON è un errore fatale, l'archivio è valido e — grazie alle scritture
    // atomiche di store.js (write .tmp + rename) — contiene uno snapshot coerente
    // del file (la vecchia versione completa, l'inode aperto sopravvive al rename).
    // status >= 2 = errore vero (disco pieno, permessi…): lì il backup fallisce.
    let warnings = false;
    try {
      execFileSync('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      if (err.status === 1) warnings = true;
      else { try { unlinkSync(tmp); } catch { /* noop */ } throw err; }
    }
    renameSync(tmp, file);

    const sizeBytes = statSync(file).size;
    const hash = sha256(file);
    const weekly = maybePromoteWeekly({ dailyFile: file, name, now });
    const pruned = pruneRotation();
    return {
      ok: true, file, name, stamp, sizeBytes, sha256: hash, warnings,
      reason, createdAt: now.toISOString(), weekly, pruned,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), reason };
  }
}

function safeExists(file) {
  try { statSync(file); return true; } catch { return false; }
}

// Registra l'esito nel journal (run esterna platform/backup, subito chiusa così
// il watchdog non prova mai a riprenderla) e nell'audit. Sincrono: usabile anche
// nel handler SIGTERM. Ritorna res invariato.
export function journalBackup(res, reason) {
  try {
    const run = journalRegisterExternal({
      tenantId: 'platform',
      agentId: 'backup',
      sessionId: `backup-${reason}-${res.stamp ?? Date.now()}`,
      prompt: `Backup ${reason}`,
      username: 'system',
    });
    if (res.ok) journalComplete(run.id);
    else journalFail(run.id, res.error);
  } catch { /* il journal non deve mai far fallire un backup */ }
  logAudit({
    user: 'system', tenant: 'platform', agent: 'backup',
    event: res.ok ? 'backup_completed' : 'backup_failed',
    detail: {
      reason, file: res.name ?? null, sizeBytes: res.sizeBytes ?? null,
      sha256: res.sha256 ?? null, weekly: res.weekly ?? null,
      warnings: res.warnings ?? false, error: res.error ?? null,
    },
  });
  return res;
}

// Backup + journal, sincrono, SENZA push (per il path pre-riavvio SIGTERM).
export function runBackupSync({ reason = 'manual', now = new Date() } = {}) {
  return journalBackup(createBackupSync({ now, reason }), reason);
}

// Backup + journal + push a Owner SOLO se fallisce. notify(tenantId, payload) è
// iniettata da index.js (notifyTenant). Usato dal job schedulato delle 04:00.
export async function runBackup({ notify, reason = 'scheduled', now = new Date() } = {}) {
  const res = runBackupSync({ reason, now });
  if (!res.ok && notify) {
    try {
      await notify('platform', {
        title: '⚠️ Backup piattaforma FALLITO',
        body: `Backup "${reason}" non riuscito: ${res.error}`,
        tag: 'backup-failed',
      });
    } catch (err) {
      console.error('[backup] push di fallimento non inviata:', err.message);
    }
  }
  return res;
}

// Utility per i test/CLI: azzera la cartella di backup (solo override esplicito).
export function _resetBackupDirForTest() {
  if (!process.env.AGENT_PLATFORM_BACKUP_DIR) throw new Error('reset consentito solo con AGENT_PLATFORM_BACKUP_DIR');
  try { rmSync(BACKUP_DIR, { recursive: true, force: true }); } catch { /* noop */ }
}
