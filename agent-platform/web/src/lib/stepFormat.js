// Formattazione dei passaggi (ask.steps) nella schermata dettaglio richiesta
// (task board f26817e2): isola l'eventuale COMANDO dentro un passaggio in un
// blocco monospace copiabile con un tap, invece di lasciare tutto come prosa
// piatta. Gli step sono testo libero scritto da agenti (tool ask_owner,
// buildAskOwner in server/lib/tasks.js) — NON un formato strutturato — quindi
// qui si va per euristica "best effort", tarata sui pattern osservati nei
// dati reali (server/data/tasks/*.json): quasi sempre "<prosa>: <comando>",
// occasionalmente markdown a backtick se un agente lo adotta in futuro.
// Nessun impatto se l'euristica non riconosce nulla: lo step resta prosa
// normale, nessuna perdita di informazione (mai troncato).

const CMD_VERBS = [
  'docker', 'docker-compose', 'git', 'npm', 'npx', 'node', 'curl', 'wget',
  'sudo', 'cat', 'ls', 'chmod', 'chown', 'systemctl', 'kubectl', 'ssh', 'scp',
  'export', 'echo', 'python3', 'python', 'pip3', 'pip', 'yarn', 'pnpm',
  'make', 'tar', 'grep', 'sed', 'awk', 'mkdir', 'rm', 'cp', 'mv', 'touch',
  'brew', 'apt-get', 'apt', 'psql', 'mysql', 'mongo', 'redis-cli', 'kill',
  'ps', 'vim', 'nano', 'code',
];
const CMD_START_RE = new RegExp(`^(?:${CMD_VERBS.join('|')})\\b`, 'i');
// Flag ("--memory=4g") o percorso ("/sys/...", "~/...", "./...") a inizio testo.
const CODE_START_RE = /^(?:--?[a-zA-Z]|\/|~\/|\.\/)/;

function looksLikeCommand(s) {
  const t = s.trim();
  if (!t) return false;
  return CMD_START_RE.test(t) || CODE_START_RE.test(t);
}

// Ritorna un array di parti { text } | { code } per UN passaggio: il testo
// prosa resta { text }, l'eventuale comando individuato diventa { code }
// (renderizzato come blocco monospace copiabile). Se non si riconosce nulla,
// ritorna [{ text: step }] intero — mai un troncamento silenzioso.
export function splitStepParts(step) {
  const s = String(step ?? '');
  // Segnale più esplicito e affidabile: backtick markdown, se un agente li usa.
  if (s.includes('`')) {
    const parts = [];
    const re = /`([^`]+)`/g;
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push({ text: s.slice(last, m.index) });
      if (m[1].trim()) parts.push({ code: m[1] });
      last = m.index + m[0].length;
    }
    if (last < s.length) parts.push({ text: s.slice(last) });
    return parts.length ? parts : [{ text: s }];
  }
  // Pattern dominante nei dati reali: "<prosa>: <comando>[ — <nota>]".
  const colonIdx = s.indexOf(':');
  if (colonIdx >= 0) {
    const before = s.slice(0, colonIdx + 1);
    const afterFull = s.slice(colonIdx + 1);
    const dashIdx = afterFull.search(/\s+—\s+/);
    const codePart = (dashIdx >= 0 ? afterFull.slice(0, dashIdx) : afterFull).trim();
    if (looksLikeCommand(codePart)) {
      const parts = [{ text: before }, { code: codePart }];
      if (dashIdx >= 0) parts.push({ text: afterFull.slice(dashIdx) });
      return parts;
    }
  }
  // Il passaggio intero È il comando (nessuna prosa introduttiva).
  if (looksLikeCommand(s)) return [{ code: s }];
  return [{ text: s }];
}

// Un passaggio è "da fare da computer" quando l'agente lo ha scritto
// esplicitamente (convenzione richiesta agli agenti per ask_owner, vedi
// system prompt "se desktop-only, scrivilo negli steps o in context") — mai
// una deduzione implicita, per non marcare/etichettare a sproposito.
const DESKTOP_ONLY_RE = /desktop|non\s+(?:è|e')?\s*fattibil\w*\s+da\s+(?:mobile|telefono|smartphone)|da\s+(?:pc|computer)\b/i;
export function isDesktopOnlyStep(step) {
  return DESKTOP_ONLY_RE.test(String(step ?? ''));
}
