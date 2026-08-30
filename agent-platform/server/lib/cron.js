// Parser cron minimale (5 campi: min ora giorno-mese mese giorno-settimana).
// Nessuna dipendenza esterna: supporta *, liste (1,2), range (1-5), step (*/15).

function parseField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (!step || step < 1) throw new Error(`step non valido: ${part}`);
    let lo = min;
    let hi = max;
    if (rangePart !== '*' && rangePart !== '') {
      if (rangePart.includes('-')) {
        const [a, b] = rangePart.split('-').map((n) => parseInt(n, 10));
        if (Number.isNaN(a) || Number.isNaN(b)) throw new Error(`range non valido: ${part}`);
        lo = a; hi = b;
      } else {
        const v = parseInt(rangePart, 10);
        if (Number.isNaN(v)) throw new Error(`valore non valido: ${part}`);
        lo = v; hi = stepPart ? max : v;
      }
    }
    for (let v = lo; v <= hi; v += step) {
      if (v < min || v > max) throw new Error(`fuori intervallo [${min}-${max}]: ${part}`);
      values.add(v);
    }
  }
  return values;
}

export function parseCron(expr) {
  const fields = String(expr ?? '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('espressione cron: servono 5 campi (min ora giorno mese giorno-settimana)');
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dayOfMonth: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    dayOfWeek: parseField(fields[4].replaceAll('7', '0'), 0, 6),
  };
}

export function cronMatches(parsed, date = new Date()) {
  if (!parsed.minute.has(date.getMinutes())) return false;
  if (!parsed.hour.has(date.getHours())) return false;
  if (!parsed.month.has(date.getMonth() + 1)) return false;
  const domOk = parsed.dayOfMonth.has(date.getDate());
  const dowOk = parsed.dayOfWeek.has(date.getDay());
  // Semantica cron standard: se entrambi i campi giorno sono vincolati basta
  // che uno corrisponda; se uno dei due e' *, devono valere entrambi.
  const domAny = parsed.dayOfMonth.size === 31;
  const dowAny = parsed.dayOfWeek.size === 7;
  if (domAny || dowAny) return domOk && dowOk;
  return domOk || dowOk;
}

export function isValidCron(expr) {
  try { parseCron(expr); return true; } catch { return false; }
}

// Prossima occorrenza (>= from + 1 minuto) di un'espressione cron, o null se
// nessuna entro l'orizzonte (cron probabilmente incoerente, es. "30 * 31 2 *").
// Brute-force minuto-per-minuto: costoso solo nel caso patologico, in pratica
// risolve in poche iterazioni (orizzonte di default 1 anno).
export function nextRunAt(expr, from = new Date(), { maxMinutes = 366 * 24 * 60 } = {}) {
  const parsed = parseCron(expr); // lancia se l'espressione non è valida
  const start = new Date(from);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  for (let i = 0; i < maxMinutes; i++) {
    const t = new Date(start.getTime() + i * 60000);
    if (cronMatches(parsed, t)) return t;
  }
  return null;
}

// Intervallo minimo (in minuti) tra due occorrenze consecutive a partire da
// `from`: usato come guardrail (es. "almeno ogni 3h") su cron arbitrari, non
// solo sui preset. Infinity se non si riesce a determinarlo (nessuna delle due
// occorrenze trovata entro l'orizzonte).
export function minGapMinutes(expr, from = new Date()) {
  const t1 = nextRunAt(expr, from);
  if (!t1) return Infinity;
  const t2 = nextRunAt(expr, t1);
  if (!t2) return Infinity;
  return Math.round((t2 - t1) / 60000);
}
