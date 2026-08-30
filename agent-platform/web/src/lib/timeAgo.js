// Età di un'attesa a partire da un timestamp ISO (task board a5c38265: la
// coda "Da decidere" non mostrava da quanto una richiesta era ferma — Owner
// la vedeva identica a una arrivata 5 minuti fa). Formato compatto italiano:
// minuti sotto l'ora, ore sotto il giorno, giorni+ore oltre.
export function formatWaitAge(iso) {
  const ms = waitMs(iso);
  if (ms == null) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'meno di 1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}g ${remHours}h` : `${days}g`;
}

// Ore trascorse (float), per soglie tipo "evidenzia oltre le 12h". null se il
// timestamp manca/non è valido.
export function waitHours(iso) {
  const ms = waitMs(iso);
  return ms == null ? 0 : ms / 3600000;
}

function waitMs(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const ms = Date.now() - t;
  return ms > 0 ? ms : 0;
}
