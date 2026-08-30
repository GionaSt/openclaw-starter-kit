// Lettura della memoria disponibile del container/host (task 16edce3a:
// oom 1112 / oom_kill 188 misurati da pm-platform il 2026-07-25 — il
// container sbatte sul tetto memoria cgroup, 1.5 GiB, e il kernel uccide
// processi Claude in corsa, ~300 MB RSS ciascuno). Fonte di verità unica
// usata dall'admission control a memoria (concurrency.js, punto 1) e dal
// gate di resume post-OOM del watchdog (watchdog.js, punto 2).
//
// cgroup v2 (memory.max / memory.current sotto /sys/fs/cgroup): se i file
// non esistono (dev locale fuori da un container, altri OS) fallback a
// os.totalmem/freemem — meno preciso (non isola il cgroup) ma meglio di
// niente, e comunque non usato in produzione dove il container li espone.
import { readFileSync } from 'fs';
import os from 'os';

const CGROUP_MAX_FILE = '/sys/fs/cgroup/memory.max';
const CGROUP_CURRENT_FILE = '/sys/fs/cgroup/memory.current';
const CGROUP_STAT_FILE = '/sys/fs/cgroup/memory.stat';

// Stima per singolo agente Claude spawnato (RSS osservato ~300 MB nell'evidenza
// pm-platform) + riserva per il resto del processo server e altri figli non-
// Claude (esbuild, git, ecc.). Sotto questo margine libero l'admission control
// NON fa partire un nuovo spawn autonomo: il cap di Owner resta il tetto
// massimo, la memoria può solo abbassare il numero effettivo mai alzarlo.
export const RUN_MEM_ESTIMATE_MB = 350;
export const MEM_RESERVE_MB = 200;
export const MEM_THRESHOLD_MB = RUN_MEM_ESTIMATE_MB + MEM_RESERVE_MB;

function readIntFile(path) {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (raw === 'max') return null; // cgroup senza limite impostato
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // file assente: non siamo in un cgroup v2 con limite
  }
}

const toMb = (bytes) => Math.round(bytes / (1024 * 1024));

// Parsing di /sys/fs/cgroup/memory.stat: righe "chiave valore" (byte). Torna
// una mappa { chiave: numero } o null se il file è assente/illeggibile (dev
// locale fuori da un cgroup v2). Ci interessano inactive_file/active_file (la
// page cache file-backed, riclamabile dal kernel sotto pressione).
function readStatFile(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    const map = {};
    for (const line of raw.split('\n')) {
      const sp = line.indexOf(' ');
      if (sp === -1) continue;
      const n = Number(line.slice(sp + 1).trim());
      if (Number.isFinite(n)) map[line.slice(0, sp)] = n;
    }
    return map;
  } catch {
    return null;
  }
}

// Override per gli script di check: simula memoria disponibile senza dover
// manipolare davvero il cgroup del container in cui gira il test. Due vie:
//  - setMemoryProbe(fn): in-process (Parte unit degli script di check).
//  - env AGENT_PLATFORM_MEM_AVAILABLE_MB: attraversa uno spawn (Parte smoke
//    che avvia `node index.js` come processo figlio — un override in-process
//    non lo raggiungerebbe). Letta ad ogni chiamata, mai cache: gli script
//    che vogliono simulare "memoria che risale" possono cambiarla a runtime.
// Entrambe servono a isolare i test dalla memoria REALE del container in cui
// girano (questo stesso sandbox è il container con l'evidenza OOM della task
// 16edce3a: senza override, ogni test che passa da scheduleRun erediterebbe
// il margine libero reale, spesso già sotto soglia, e fallirebbe a caso).
let probeOverride = null;
export function setMemoryProbe(fn) { probeOverride = fn; }

// { limitMb, currentMb, availableMb, source: 'cgroup' | 'os' | 'env' }
export function readMemoryStatus() {
  if (probeOverride) return probeOverride();
  if (process.env.AGENT_PLATFORM_MEM_AVAILABLE_MB != null) {
    const availableMb = Number(process.env.AGENT_PLATFORM_MEM_AVAILABLE_MB);
    const limitMb = Number(process.env.AGENT_PLATFORM_MEM_LIMIT_MB ?? 99999);
    return {
      limitMb, currentMb: Math.max(0, limitMb - availableMb), availableMb, source: 'env',
    };
  }
  const maxBytes = readIntFile(CGROUP_MAX_FILE);
  const currentBytes = readIntFile(CGROUP_CURRENT_FILE);
  if (maxBytes != null && currentBytes != null) {
    // Bug radice ab256fba: memory.current include la page cache riclamabile,
    // quindi `max − current` sottostima la memoria disponibile (a container
    // caldo, cache piena, dava ≈1MB pur con centinaia di MB liberi → stallo).
    // Correzione: la memoria "vera" usata è current MENO la page cache
    // file-backed (inactive_file + active_file), che il kernel riclama sotto
    // pressione prima di andare in OOM. availableMb = max − usato_reale.
    const stat = readStatFile(CGROUP_STAT_FILE);
    const reclaimableBytes = stat
      ? (stat.inactive_file ?? 0) + (stat.active_file ?? 0)
      : 0;
    const usedBytes = Math.max(0, currentBytes - reclaimableBytes);
    return {
      limitMb: toMb(maxBytes),
      currentMb: toMb(currentBytes),
      reclaimableMb: toMb(reclaimableBytes),
      availableMb: Math.max(0, toMb(maxBytes - usedBytes)),
      source: 'cgroup',
    };
  }
  const totalMb = toMb(os.totalmem());
  const freeMb = toMb(os.freemem());
  return {
    limitMb: totalMb, currentMb: totalMb - freeMb, availableMb: freeMb, source: 'os',
  };
}

// --- Riserva per gli spawn "in volo" (anti thundering-herd, task ab256fba) ---
// Una run appena ammessa (runFn appena invocata) non ha ancora fatto crescere
// il suo RSS, quindi non compare ancora in memory.current: la lettura della
// memoria resta "vecchia" per qualche secondo. Senza contarla, drainQueue
// ammetterebbe un'intera raffica leggendo tutti la stessa memoria libera (38
// OOM in raffica dopo il restart 14:09). Ogni spawn autonomo PRENOTA
// RUN_MEM_ESTIMATE_MB per SPAWN_RSS_GRACE_MS — il tempo stimato perché il
// processo raggiunga un RSS misurabile e rientri in memory.current — poi la
// prenotazione scade da sola (nessuna doppia contabilità dopo il grace).
export const SPAWN_RSS_GRACE_MS = 30000;
let reservations = []; // array di timestamp di scadenza (ms epoch)

export function reserveSpawnMemory(now = Date.now()) {
  reservations.push(now + SPAWN_RSS_GRACE_MS);
}

// MB attualmente prenotati da spawn in volo (scaduti esclusi, con pulizia
// pigra). Esportato per osservabilità (memoryView in concurrency.js).
export function reservedSpawnMb(now = Date.now()) {
  reservations = reservations.filter((expiry) => expiry > now);
  return reservations.length * RUN_MEM_ESTIMATE_MB;
}

// Solo per gli script di check: azzera le prenotazioni tra un caso e l'altro.
export function resetSpawnReservations() { reservations = []; }

// True se c'è margine sufficiente per far partire un altro spawn autonomo
// (RUN_MEM_ESTIMATE_MB) mantenendo la riserva (MEM_RESERVE_MB), AL NETTO della
// memoria già prenotata dagli spawn in volo non ancora visibili in current.
export function hasMemoryHeadroom() {
  return readMemoryStatus().availableMb - reservedSpawnMb() >= MEM_THRESHOLD_MB;
}
