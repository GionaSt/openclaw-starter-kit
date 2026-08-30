// CLI backup manuale della piattaforma.
//   node scripts/backup.mjs [--reason <motivo>]
// Esegue un backup completo di server/data + server/config, applica la rotazione
// (7 daily + 4 weekly), logga l'esito nel journal/audit. NON invia push (path
// interattivo). Per il backup schedulato/pre-riavvio ci pensa il server.
import { runBackupSync, BACKUP_DIR } from '../lib/backup.js';

const args = process.argv.slice(2);
const ri = args.indexOf('--reason');
const reason = ri >= 0 && args[ri + 1] ? args[ri + 1] : 'manual';

const res = runBackupSync({ reason });
if (res.ok) {
  console.log(`OK  backup creato: ${res.file}`);
  console.log(`    dimensione: ${(res.sizeBytes / 1024).toFixed(1)} KiB  sha256: ${res.sha256}`);
  if (res.weekly) console.log(`    promosso a settimanale: ${res.weekly}`);
  const pr = res.pruned;
  if (pr && (pr.daily.length || pr.weekly.length)) {
    console.log(`    rotazione: rimossi ${pr.daily.length} daily, ${pr.weekly.length} weekly`);
  }
  console.log(`    destinazione: ${BACKUP_DIR}`);
  process.exit(0);
} else {
  console.error(`KO  backup FALLITO: ${res.error}`);
  process.exit(1);
}
