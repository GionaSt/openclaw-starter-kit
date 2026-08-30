// Wiki di conoscenza per tenant — MVP file-based, git-versionata (niente vector
// DB, per scelta: semplicità prima). Ogni tenant ha un repo git dedicato in
// server/data/wiki/<tenantId>/ (annidato ma escluso dal repo principale via
// .gitignore): ogni scrittura fa un commit automatico -> audit trail + rollback
// gratis con `git log` / `git show`. Pagine markdown brevi (~2000 parole),
// INDEX.md sempre in contesto agli agenti (vedi index.js), le altre pagine si
// leggono on-demand (progressive disclosure) con i tool MCP qui esposti.
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { DATA_DIR, tenantScopedDir } from './store.js';

const WIKI_DIR = join(DATA_DIR, 'wiki');
const PAGE_RE = /^[a-zA-Z0-9_-]+\.md$/;
export const INDEX_PAGE = 'INDEX.md';

function tenantDir(tenantId) {
  return tenantScopedDir(WIKI_DIR, tenantId);
}

function git(dir, args) {
  // LC_ALL=C: forza i messaggi di git in inglese indipendentemente dalla
  // locale del processo server — commit() sotto fa pattern-matching sul
  // testo di errore ("nothing to commit"), che altrimenti sarebbe fragile
  // in un ambiente con locale diversa da POSIX/C.
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
}

function ensureGitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git'))) {
    git(dir, ['init', '-q']);
    // Identità locale al repo: ogni tenant ha il suo, non tocca la config globale.
    git(dir, ['config', 'user.email', 'wiki@agent-platform.local']);
    git(dir, ['config', 'user.name', 'Agent Platform Wiki']);
  }
}

// Commit di tutto lo stato corrente della dir; no-op (ritorna false) se non
// ci sono modifiche, es. write_page con lo stesso contenuto già presente.
//
// Nota perf: niente `git status --porcelain` prima del commit — sarebbe un
// terzo spawn sincrono ridondante (ogni spawn blocca l'intero event loop del
// server, vedi nota "concorrenza" più sotto). `git commit` da solo dice già
// se non c'era nulla da fare: exit code 1 e "nothing to commit" in output.
// Qualsiasi altro errore (hook, identità, ecc.) va ripropagato, non ingoiato.
function commit(dir, message) {
  git(dir, ['add', '-A']);
  try {
    git(dir, ['commit', '-q', '-m', message]);
    return true;
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (/nothing to commit|working tree clean/i.test(out)) return false;
    throw err;
  }
}

export function wordCount(text) {
  const t = String(text ?? '').trim();
  return t ? t.split(/\s+/).length : 0;
}

// Hash corto del contenuto di una pagina, usato come "versione" per il controllo
// di concorrenza ottimistico (vedi writePage/WikiConflictError più sotto): chi
// legge una pagina con wiki_read riceve questo hash e lo ripassa a wiki_write per
// dimostrare di aver visto l'ultima versione. Nessun significato crittografico,
// solo un fingerprint stabile del contenuto.
export function contentHash(content) {
  return createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex').slice(0, 12);
}

function validatePage(page) {
  if (!PAGE_RE.test(String(page ?? ''))) {
    throw new Error('nome pagina non valido: solo lettere, numeri, "-" o "_" e estensione .md (es. clienti.md)');
  }
}

// ---- Contenuti di default per l'inizializzazione (una tantum per tenant) ----
function genericSeed(tenant) {
  const roster = (tenant.agents ?? []).map((a) => `- **${a.id}** (${a.role}) — ${a.name}`).join('\n');
  return {
    [INDEX_PAGE]: `# Wiki — ${tenant.name}\n\nMappa delle pagine di questo business. Aggiornala quando aggiungi o rinomini una pagina.\n\n- \`clienti.md\` — chi sono i clienti/utenti e cosa sappiamo su di loro\n- \`prodotto.md\` — cosa vendiamo/offriamo, stato attuale\n- \`processi.md\` — come lavora questo business (reparti, flussi, convenzioni)\n- \`decisions.md\` — log delle decisioni rilevanti (stile ADR: data, decisione, motivo)\n- \`glossario.md\` — termini ricorrenti del dominio\n\n_Ultimo aggiornamento: inizializzazione MVP wiki._\n`,
    'clienti.md': `# Clienti\n\n${tenant.description ?? ''}\n\n(pagina da popolare)\n`,
    'prodotto.md': `# Prodotto\n\n${tenant.description ?? ''}\n\n(pagina da popolare)\n`,
    'processi.md': `# Processi\n\nAgenti di questo business:\n\n${roster}\n\n(pagina da popolare)\n`,
    'decisions.md': `# Decisioni (log stile ADR)\n\nFormato per ogni voce: **Data** — Decisione — Motivo.\n`,
    'glossario.md': `# Glossario\n\n(termini da aggiungere)\n`,
  };
}

const SEEDS = {
  platform: () => ({
    [INDEX_PAGE]: `# Wiki — Platform Org

Mappa delle pagine di questo business. Aggiornala quando aggiungi o rinomini una pagina.

- \`clienti.md\` — i business tenant serviti dalla piattaforma e l'Owner come utente finale
- \`prodotto.md\` — cos'è la Agent Platform, stack, stato delle feature
- \`processi.md\` — come lavora la org platform (board, dispatcher, deploy, convenzioni)
- \`decisions.md\` — log delle decisioni tecniche/di prodotto rilevanti (stile ADR)
- \`glossario.md\` — termini ricorrenti (tenant, run, journal, dispatcher, ecc.)

_Ultimo aggiornamento: inizializzazione MVP wiki._
`,
    'clienti.md': `# Clienti

L'unico "cliente" della Platform Org è l'Owner, proprietario di tutti i business tenant.
I tenant serviti dalla piattaforma (esempio):

- **acme-retail** — Acme Retail (e-commerce demo)
- **acme-services** — Acme Services (agenzia di servizi demo)

Ogni tenant ha i propri agenti (CEO + reparti), la propria task board e la propria wiki.
Le richieste di feature/bugfix per la piattaforma arrivano dall'Owner tramite CEO Platform,
che le scompone in task per CTO Platform.
`,
    'prodotto.md': `# Prodotto — Agent Platform

Piattaforma self-hosted multi-tenant che fa dialogare l'Owner con organizzazioni di
agenti AI (una per business). Stack:

- **server/**: Node.js ESM, Express + SSE per lo streaming chat, \`@anthropic-ai/claude-agent-sdk\`
  con auth via subscription (CLAUDE_CODE_OAUTH_TOKEN, niente API key a consumo).
  Persistenza a file JSON in \`server/data/\` (nessun DB). Config tenant/agenti in
  \`server/config/tenants.json\`.
- **web/**: PWA Vite + React, mobile-first, dark, service worker per notifiche push.

Componenti chiave: task board per tenant (dispatcher autonomo che lavora le task
assegnate agli agenti), journal delle run (tab "Agenti live", stop/pausa/resume,
watchdog per i crash), scheduler (agenti su cron), approvals per tool sensibili,
wiki di conoscenza per tenant (questa — MVP file-based, git-versionata).
`,
    'processi.md': `# Processi della org platform

- Il **CEO Platform** riceve obiettivi dall'Owner, li scompone in task sulla board
  e le assegna (di norma a **CTO Platform**, unico agente dev oggi).
- Il CTO implementa: modifiche server prima, poi la UI che le consuma, poi verifica
  su istanza locale prima di chiudere la task (\`done\`).
- Ogni processo/agente lanciato via Bash fuori dal normale turno di chat DEVE
  registrarsi nel journal: altrimenti l'Owner non lo vede in "Agenti live".
- Commit piccoli e frequenti: un'interruzione di sessione non deve azzerare lavoro.
- A fine task significativa: aggiornare questa wiki (pagina di dominio + INDEX),
  è una convenzione di routine, non un processo a parte.
`,
    'decisions.md': `# Decisioni (log stile ADR)

Formato per ogni voce: **Data** — Decisione — Motivo.

- **(data)** — Wiki di conoscenza per tenant: MVP file-based (markdown + git
  per-tenant), niente vector DB — Semplicità prima; progressive disclosure
  (INDEX sempre in contesto, pagine on-demand) basta per la scala attuale.
`,
    'glossario.md': `# Glossario

- **Tenant**: un business (es. platform, acme-retail, acme-services),
  con i propri agenti, task board, wiki.
- **Run**: un'esecuzione di un turno agente, tracciata nel journal (\`server/data/runs.json\`).
- **Dispatcher**: processo periodico che lavora in autonomia le task \`todo\`/\`revisione\`
  assegnate a un agente, rispettando \`blockedBy\` e il limite di run autonome.
- **Journal**: registro persistente delle run (stato, resume, audit trail).
- **Wiki**: questa knowledge base per tenant, file markdown versionati con git
  (repo dedicato in \`server/data/wiki/<tenantId>/\`, un commit per modifica).
`,
  }),

  'acme-retail': () => ({
    [INDEX_PAGE]: `# Wiki — Acme Retail

- \`clienti.md\` — chi sono i clienti, segmenti, obiezioni ricorrenti
- \`prodotto.md\` — il catalogo prodotti, struttura, pricing
- \`processi.md\` — funnel TOFU/MOFU/BOFU, stagionalità, canali
- \`decisions.md\` — log decisioni commerciali/marketing rilevanti (stile ADR)
- \`glossario.md\` — termini di dominio ricorrenti

_Ultimo aggiornamento: inizializzazione MVP wiki._
`,
    'clienti.md': `# Clienti

Pubblico demo: clienti retail che arrivano da contenuti organici (YouTube/social)
e da campagne Meta/Google Ads verso example.com.

Segmenti e obiezioni ricorrenti: da popolare mano a mano che il marketing e il
supporto raccolgono segnali (commenti, domande support, obiezioni nei form di
vendita).
`,
    'prodotto.md': `# Prodotto

Prodotti/corsi online demo venduti tramite example.com, lista email per
nurturing.

Dettagli su moduli, pricing, struttura: da popolare (chiedere al CEO del tenant
i dati aggiornati).
`,
    'processi.md': `# Processi

- Funnel **TOFU/MOFU/BOFU** calibrato sulla stagionalità del business.
- Canali: organico (hook, titoli CTR, thumbnail), Meta Ads e Google Ads
  con UTM tracciati verso example.com, email marketing.
- Reparti: **marketing** (contenuti/campagne), **support** (supporto clienti,
  tono caldo e pratico).
`,
    'decisions.md': `# Decisioni (log stile ADR)

Formato per ogni voce: **Data** — Decisione — Motivo.
`,
    'glossario.md': `# Glossario

- **TOFU/MOFU/BOFU**: top/middle/bottom of funnel — fasi del percorso da
  spettatore a cliente pagante.
- **Nurturing**: sequenza email che accompagna il lead verso l'acquisto.
`,
  }),

  'acme-services': () => ({
    [INDEX_PAGE]: `# Wiki — Acme Services

- \`clienti.md\` — clienti dell'agenzia, canali di acquisizione
- \`prodotto.md\` — servizi offerti, posizionamento, pricing
- \`processi.md\` — delivery, preventivi, follow-up
- \`decisions.md\` — log decisioni rilevanti (stile ADR)
- \`glossario.md\` — termini di dominio

_Ultimo aggiornamento: inizializzazione MVP wiki._
`,
    'clienti.md': `# Clienti

Clienti demo dell'agenzia di servizi: PMI locali, canali di acquisizione
referral e outreach diretto.

Segmenti, servizi più richiesti, trattative ricorrenti: da popolare.
`,
    'prodotto.md': `# Prodotto

Servizi demo (consulenza, progetti a pacchetto). Metriche chiave di esempio:
margine minimo per progetto, tariffa oraria target.

Listino e posizionamento: da popolare.
`,
    'processi.md': `# Processi

- **Preventivi**: qualifica del lead, stima effort, soglia decisionale di margine.
- **Delivery**: esecuzione a milestone, review interna prima della consegna.
- **Vendita**: descrizioni servizio, pricing coerente col mercato, follow-up.
`,
    'decisions.md': `# Decisioni (log stile ADR)

Formato per ogni voce: **Data** — Decisione — Motivo.
`,
    'glossario.md': `# Glossario

- **Lead**: potenziale cliente entrato in contatto con l'agenzia.
- **Milestone**: tappa di consegna concordata di un progetto.
`,
  }),
};

function defaultPages(tenant) {
  return (SEEDS[tenant.id] ?? (() => genericSeed(tenant)))();
}

// ---- API di base ----

// Crea il repo git del tenant se non esiste e vi scrive le pagine di default
// mancanti (idempotente: non tocca pagine già esistenti/modificate). Da
// chiamare per ogni tenant all'avvio del server.
export function ensureWikiRepo(tenant) {
  const dir = tenantDir(tenant.id);
  ensureGitRepo(dir);
  const seeds = defaultPages(tenant);
  let created = false;
  for (const [name, content] of Object.entries(seeds)) {
    const p = join(dir, name);
    if (!existsSync(p)) {
      writeFileSync(p, content);
      created = true;
    }
  }
  if (created) commit(dir, 'wiki: inizializzazione pagine di default');
  return dir;
}

export function listPages(tenantId) {
  const dir = tenantDir(tenantId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => PAGE_RE.test(f))
    .sort((a, b) => (a === INDEX_PAGE ? -1 : b === INDEX_PAGE ? 1 : a.localeCompare(b)));
}

export function readPage(tenantId, page) {
  validatePage(page);
  const p = join(tenantDir(tenantId), page);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

export function readIndex(tenantId) {
  return readPage(tenantId, INDEX_PAGE) ?? '';
}

// Guardia anti-svuotamento/troncamento (v1: incidente 2026-07-23, commit e4bd4ef,
// decisions.md ~16KB -> "// placeholder"; v2: incidente 2026-07-24, task 19c98bd9,
// origine di QUESTA guardia estesa — la run code-quality ha mandato a wiki_write
// SOLO la sezione nuova invece della pagina intera: la pagina non finiva vuota,
// solo troncata, e la v1 (soglia assoluta <100B) non se ne accorgeva perché la
// sezione inviata era comunque "sostanziosa" in byte assoluti). Rifiutiamo se,
// rispetto alla versione su disco:
//  - il nuovo contenuto scende sotto SHRINK_RATIO_MAX (60%) dei byte precedenti
//    (solo se la pagina precedente supera SHRINK_MIN_PREV_BYTES: sotto è una
//    pagina-stub, il rapporto percentuale non è un segnale affidabile), oppure
//  - il nuovo contenuto fa sparire una o più intestazioni "## " presenti prima
//    (a QUALSIASI dimensione: è il caso "sostituito con solo una sezione" —
//    l'incidente 19c98bd9 esatto, dove il rapporto sui byte da solo non basta).
// Quasi sempre lost-update o invio di contenuto parziale: rifiutiamo salvo
// conferma esplicita (allowShrink / tool: confirm_shrink). Il contenuto resta
// comunque in git, ma meglio non perderlo dal file vivo. Rollback e ripristini
// legittimi passano allowShrink. Sulle pagine-log (LOG_PAGES) la perdita di
// intestazioni è già gestita a parte da WikiEntryLossError/confirm_restructure
// (guardia dedicata più sotto): qui il controllo heading si applica solo alle
// pagine NON di log, per non richiedere due flag diversi sullo stesso errore.
export const SHRINK_MIN_PREV_BYTES = 500; // sotto: pagina troppo corta per un check sul rapporto byte
export const SHRINK_RATIO_MAX = 0.6;      // nuovo contenuto sotto il 60% del precedente = shrink sospetto
export class WikiShrinkGuardError extends Error {
  constructor(page, prevBytes, newBytes, lostHeadings = []) {
    const pct = prevBytes > 0 ? Math.round((newBytes / prevBytes) * 100) : 0;
    const headingsMsg = lostHeadings.length
      ? ` e farebbe sparire ${lostHeadings.length} intestazione/i "## " gia presenti (${lostHeadings.map((h) => `"${h}"`).join(', ')})`
      : '';
    super(`guardia wiki: la pagina "${page}" passa da ${prevBytes} a ${newBytes} byte (${pct}% del precedente)${headingsMsg} `
      + '— troncamento/svuotamento sospetto, nessuna scrittura effettuata. Se ti serve solo AGGIUNGERE contenuto usa '
      + 'wiki_append (manda solo la voce nuova, mai un replace integrale: elimina alla radice il rischio di troncare '
      + 'il resto). Se invece è una riscrittura strutturale VOLUTA (reset, riordino, INDEX.md) rilancia wiki_write con '
      + 'confirm_shrink: true. Il contenuto precedente resta comunque in git (rollback disponibile).');
    this.name = 'WikiShrinkGuardError';
    this.code = 'wiki_shrink_guard';
    this.prevBytes = prevBytes;
    this.newBytes = newBytes;
    this.lostHeadings = lostHeadings;
  }
}

// Bug ricorrente (2ª occorrenza, vedi task 7f204be4 e review 30f8a474): due
// scritture concorrenti sulla stessa pagina (due run diverse, entrambe fanno
// wiki_read -> ragionano -> wiki_write con il contenuto INTERO della pagina)
// sono un classico "lost update": la seconda write, basata su un read ormai
// stale, sovrascrive senza errore la modifica della prima. Prima di questo fix
// writePage non aveva alcun controllo di versione: ultima scrittura vince,
// silenziosamente. Fix: controllo di concorrenza ottimistico via hash del
// contenuto (vedi contentHash) + WikiConflictError esplicito quando l'hash
// atteso (baseHash, quello restituito dall'ultimo wiki_read) non combacia più
// con quello attuale su disco. Il tool MCP wiki_write (più sotto) impone
// sempre baseHash (default null = "mi aspetto una pagina nuova"), quindi ogni
// scrittura di un agente passa da qui; i chiamanti interni "autoritativi"
// (rollbackPage, seed iniziale, PUT admin da UI) continuano a non passare
// baseHash (== undefined) e mantengono il comportamento di overwrite diretto.
export class WikiConflictError extends Error {
  constructor(page, currentHash, baseHash, { missingPage = false, missingBaseHash = false } = {}) {
    const msg = missingPage
      ? `conflitto wiki: la pagina "${page}" non esiste (più o non ancora), ma la scrittura si aspettava la `
        + `versione ${baseHash}. Rileggi con wiki_read (o scrivi senza base_hash se la pagina è davvero nuova) e riprova.`
      : missingBaseHash
      ? `conflitto wiki: la pagina "${page}" esiste già (hash attuale ${currentHash}) ma la scrittura non ha `
        + 'passato base_hash (o ne ha passato uno non corrispondente a una pagina nuova). Leggi la pagina con '
        + 'wiki_read, prendi il campo "hash" e ripassalo come base_hash in wiki_write: così il server può '
        + 'verificare che non stai sovrascrivendo una modifica concorrente. Nessuna scrittura è stata effettuata.'
      : `conflitto wiki: la pagina "${page}" è stata modificata da un'altra scrittura nel frattempo `
        + `(base_hash atteso ${baseHash}, hash attuale ${currentHash}). Nessuna scrittura è stata effettuata `
        + '(mai perdita silenziosa). Rileggi la pagina con wiki_read, riapplica la tua modifica sul contenuto '
        + 'aggiornato e riprova wiki_write con il nuovo hash.';
    super(msg);
    this.name = 'WikiConflictError';
    this.code = 'wiki_conflict';
    this.page = page;
    this.currentHash = currentHash;
    this.baseHash = baseHash;
  }
}

// Pagine "log" append-only: contenuto = sequenza di voci "## ..." in ordine
// cronologico (più recenti in cima), scritte in concorrenza da più run a fine
// task ("wiki obbligatoria"). Su queste, un wiki_write full-page può perdere una
// voce anche col base_hash GIUSTO (vedi WikiEntryLossError sotto): la guardia
// entry-loss protegge esattamente queste. digest.md/code-quality.md/roadmap.md
// sono potate dai rispettivi job schedulati (che passano allowEntryLoss).
export const LOG_PAGES = new Set(['decisions.md', 'digest.md', 'code-quality.md', 'roadmap.md']);
export function isLogPage(page) {
  return LOG_PAGES.has(String(page ?? ''));
}

// Titoli delle intestazioni di livello 2 ("## ...") presenti in `prev` ma NON in
// `next` (confronto case-insensitive): sono le voci che una scrittura full-page
// farebbe sparire. Usato dalla guardia entry-loss su pagine-log.
function droppedHeadings(prev, next) {
  const nextSet = new Set(pageSections(String(next ?? '')).map((h) => h.title.trim().toLowerCase()));
  const seen = new Set();
  const lost = [];
  for (const h of pageSections(String(prev ?? ''))) {
    const key = h.title.trim().toLowerCase();
    if (!nextSet.has(key) && !seen.has(key)) { seen.add(key); lost.push(h.title.trim()); }
  }
  return lost;
}

// Il buco che base_hash NON può chiudere (incidente 2026-07-25, commit d1c6134
// su 711022e; riprodotto in wiki-check A3.8): su una pagina-log l'agente B
// RILEGGE la versione fresca (base_hash corretto, include la voce di A) ma
// SOTTOMETTE un contenuto full-page ricostruito da un piano/lettura STALE che
// quella voce non la contiene. base_hash combacia (B ha davvero riletto) → la
// scrittura passa → la voce di A sparisce in silenzio. base_hash dimostra "ho
// visto la versione X", non "il mio contenuto preserva le voci di X". La guardia
// entry-loss chiude proprio questo: su pagina-log, se il nuovo contenuto rimuove
// una "## voce" presente sul disco, rifiuta (usa wiki_append per aggiungere; o
// confirm_restructure/allowEntryLoss per una potatura/riscrittura intenzionale).
export class WikiEntryLossError extends Error {
  constructor(page, lostHeadings) {
    super(`guardia wiki (pagina-log "${page}"): la scrittura rimuoverebbe ${lostHeadings.length} voce/i gia` +
      ` presenti sul disco (${lostHeadings.map((h) => `"${h}"`).join(', ')}). Quasi sempre e un lost-update: hai` +
      ' ricostruito la pagina da una versione che non includeva una voce aggiunta da un\'altra run nel frattempo' +
      ' (il base_hash combacia perche hai riletto, ma il contenuto che invii non contiene quella voce). Per' +
      ' AGGIUNGERE una voce usa wiki_append (mandi solo la voce nuova: nessun clobber possibile). Se invece e una' +
      ' potatura/riscrittura INTENZIONALE (archiviazione voci vecchie, job di pruning) rilancia con' +
      ' confirm_restructure: true. Nessuna scrittura e stata effettuata.');
    this.name = 'WikiEntryLossError';
    this.code = 'wiki_entry_loss';
    this.page = page;
    this.lostHeadings = lostHeadings;
  }
}

// Nota su concorrenza: tutte le operazioni fs/git qui sotto sono sincrone
// (execFileSync/readFileSync/writeFileSync), e il MCP server della wiki gira
// in-process nel server Node (vedi runturn/access.js) condiviso da tutte le
// run — quindi due chiamate a writePage non possono mai interleavarsi a metà:
// una gira per intero (read, check, write, commit) prima che l'altra inizi.
// Questo esclude la corruzione a livello di file/commit. Il bug reale era a
// livello applicativo: un lost update fra wiki_read e wiki_write, due tool
// call separate con in mezzo il "pensiero" dell'agente (secondi, non tick di
// JS) — durante quella finestra un'altra run può scrivere la stessa pagina, e
// la wiki_write successiva, basata su un read ormai stale, la sovrascriveva
// senza errore. Il controllo di versione qui sotto chiude quella finestra.

// author: stringa libera per il messaggio di commit (es. "agent:marketing-ita"
// o "user:admin"), finisce nel log git come audit trail.
// baseHash: hash atteso del contenuto attuale (da contentHash/wiki_read), per il
// controllo di concorrenza ottimistico. undefined = nessun controllo (chiamanti
// interni autoritativi: rollback, seed, PUT admin). null = "mi aspetto che la
// pagina non esista ancora". Su mismatch: WikiConflictError, nessuna scrittura.
// allowEntryLoss: bypassa la guardia entry-loss su pagine-log (potatura/riscrittura
// intenzionale, es. job di pruning). I chiamanti interni autoritativi (baseHash
// === undefined: rollback, seed, PUT admin, writeArchive del digest) non passano
// mai dalla guardia — è attiva solo sul percorso agent-facing (baseHash definito).
export function writePage(tenantId, page, content, { author = 'system', allowShrink = false, baseHash, allowEntryLoss = false } = {}) {
  validatePage(page);
  const dir = tenantDir(tenantId);
  ensureGitRepo(dir);
  const target = join(dir, page);
  const next = String(content ?? '');
  const exists = existsSync(target);
  const prevContent = exists ? readFileSync(target, 'utf8') : null;

  if (baseHash !== undefined) {
    const currentHash = exists ? contentHash(prevContent) : null;
    if (!exists) {
      if (baseHash !== null) throw new WikiConflictError(page, null, baseHash, { missingPage: true });
    } else if (baseHash === null) {
      throw new WikiConflictError(page, currentHash, null, { missingBaseHash: true });
    } else if (baseHash !== currentHash) {
      throw new WikiConflictError(page, currentHash, baseHash);
    }
  }

  // Guardia entry-loss: solo percorso agent-facing (baseHash definito) e solo su
  // pagine-log. Chiude il lost-update che base_hash non vede (vedi WikiEntryLossError).
  const lostHeadings = exists ? droppedHeadings(prevContent, next) : [];
  if (baseHash !== undefined && !allowEntryLoss && exists && isLogPage(page) && lostHeadings.length) {
    throw new WikiEntryLossError(page, lostHeadings);
  }

  // Guardia shrink generale (vedi commento su WikiShrinkGuardError sopra): rapporto
  // byte sotto soglia SEMPRE, perdita di heading "## " solo per le pagine NON-log
  // (le pagine-log hanno già la loro guardia dedicata subito sopra, con un flag
  // di conferma diverso — confirm_restructure invece di confirm_shrink).
  if (!allowShrink && exists) {
    const prevBytes = Buffer.byteLength(prevContent, 'utf8');
    const newBytes = Buffer.byteLength(next, 'utf8');
    const ratioShrink = prevBytes >= SHRINK_MIN_PREV_BYTES && newBytes < prevBytes * SHRINK_RATIO_MAX;
    const headingShrink = !isLogPage(page) && lostHeadings.length > 0;
    if (ratioShrink || headingShrink) {
      throw new WikiShrinkGuardError(page, prevBytes, newBytes, headingShrink ? lostHeadings : []);
    }
  }
  writeFileSync(target, next);
  const changed = commit(dir, `wiki: aggiorna ${page} (${author})`);
  return { page, changed, hash: contentHash(next) };
}

// Append atomico server-side (task 97655082, difesa aggiuntiva oltre a baseHash
// qui sopra): per pagine "log" tipo decisions.md, il pattern normale di un
// agente è wiki_read -> ragiona -> wiki_write con la pagina INTERA ricostruita.
// Quel round-trip lascia una finestra fra read e write in cui un'altra run può
// scrivere la stessa pagina; baseHash la chiude con un conflitto esplicito, ma
// il recupero corretto richiede che l'agente, dopo il conflitto, rilegga E
// riapplichi la propria voce sul contenuto FRESCO — se invece ripropone il
// contenuto già pianificato (es. da un turno di ragionamento precedente,
// ignorando il read fresco) il conflitto si "risolve" con un clobber lo
// stesso, solo un turno più tardi. appendPage elimina il round-trip alla
// radice per il caso comune (una voce sola): l'agente manda SOLO la voce
// nuova, il server legge+inserisce+scrive dentro un'unica chiamata sincrona.
// Stessa garanzia di serializzazione di writePage (vedi nota "concorrenza"
// sopra: nessun await fra read e write, quindi due appendPage non possono mai
// interleavarsi) — ma qui non serve nemmeno baseHash, perché non c'è nulla da
// proteggere: il server stesso fa la "lettura fresca" appena prima di scrivere.
//
// anchor: regex che individua l'inizio della prima voce esistente (default: la
// prima riga "## ..." di livello 2, il formato usato da decisions.md per ogni
// voce). La nuova voce viene inserita subito PRIMA di quel punto (voci più
// recenti in cima, stessa convenzione già in uso). Se la regex non trova nulla
// (pagina senza intestazioni di livello 2, es. liste puntate come glossario.md)
// la voce viene semplicemente accodata in fondo alla pagina.
export function appendPage(tenantId, page, entry, { author = 'system', anchor = /^##\s/m } = {}) {
  validatePage(page);
  const dir = tenantDir(tenantId);
  ensureGitRepo(dir);
  const target = join(dir, page);
  const exists = existsSync(target);
  const current = exists ? readFileSync(target, 'utf8') : `# ${page.replace(/\.md$/, '')}\n\n`;
  const block = `${String(entry ?? '').replace(/\s+$/, '')}\n\n`;
  const m = current.match(anchor);
  let next;
  if (m && typeof m.index === 'number') {
    next = current.slice(0, m.index) + block + current.slice(m.index);
  } else {
    next = /\n\n$/.test(current) ? current + block : `${current.replace(/\n*$/, '')}\n\n${block}`;
  }
  writeFileSync(target, next);
  const changed = commit(dir, `wiki: aggiungi voce a ${page} (${author})`);
  return { page, changed, hash: contentHash(next) };
}

export function pageHistory(tenantId, page, limit = 30) {
  validatePage(page);
  const dir = tenantDir(tenantId);
  if (!existsSync(join(dir, page))) return [];
  try {
    const out = git(dir, ['log', `-n${limit}`, '--date=iso-strict', '--pretty=format:%H|%ad|%s', '--', page]);
    return out.split('\n').filter(Boolean).map((line) => {
      const [hash, date, ...rest] = line.split('|');
      return { hash, date, message: rest.join('|') };
    });
  } catch {
    return [];
  }
}

export function pageAt(tenantId, page, commitHash) {
  validatePage(page);
  const dir = tenantDir(tenantId);
  try {
    return git(dir, ['show', `${String(commitHash).replace(/[^a-zA-Z0-9]/g, '')}:${page}`]);
  } catch {
    return null;
  }
}

// Rollback = scrivi il contenuto di una versione passata e commit (nessuna
// history persa: il rollback stesso è un nuovo commit, coerente con l'audit trail).
export function rollbackPage(tenantId, page, commitHash, { author = 'system' } = {}) {
  const content = pageAt(tenantId, page, commitHash);
  if (content === null) throw new Error('versione non trovata per questa pagina');
  // Un rollback è deliberato: non lo blocca la guardia anti-svuotamento.
  return writePage(tenantId, page, content, { author: `${author}, rollback a ${String(commitHash).slice(0, 7)}`, allowShrink: true });
}

// ---- Tool MCP esposti a TUTTI gli agenti del tenant (non solo CEO/dev) ----
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

// wiki_read (task board 521ccde0): pagine oltre questa soglia sforavano il
// limite token del tool (decisions.md, 59K caratteri, ha fatto troncare la
// risposta a runtime — l'unico aggiro era leggere il file a mano). Oltre
// soglia, di default torniamo solo la prima porzione + truncated:true, invece
// di far esplodere il tool: l'agente continua con offset o legge un capitolo
// con "section". L'hash di versione (per wiki_write/base_hash, fix 7f204be4 /
// 97655082) resta SEMPRE quello del contenuto INTERO, mai della porzione
// restituita: altrimenti un wiki_write dopo una lettura parziale userebbe un
// hash che non corrisponde più al file su disco e romperebbe il controllo di
// concorrenza ottimistica.
const WIKI_READ_TRUNCATE_CHARS = 40000;

// Intestazioni di livello 2 ("## Titolo") di una pagina, con la riga (0-based)
// in cui iniziano: usato sia da wiki_read({section}) per isolare un capitolo,
// sia come suggerimento ("sezioni disponibili") quando la sezione richiesta
// non esiste o quando la pagina viene troncata.
function pageSections(content) {
  const lines = content.split('\n');
  const heads = [];
  lines.forEach((line, i) => {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) heads.push({ title: m[1], line: i });
  });
  return heads;
}

// Le definizioni dei tool (oggetti { name, description, inputSchema, handler }
// prodotti da tool()) sono in una funzione separata da buildWikiMcpServer così
// gli script di verifica possono chiamare .handler(...) direttamente — stesso
// codice che gira dentro una run reale, nessuna simulazione — per riprodurre
// scenari di concorrenza sul vero livello MCP (vedi scripts/wiki-check.mjs
// Parte A3, task 97655082) senza dover far girare un agente reale via SDK.
export function wikiTools(tenant, agentId) {
  const tenantId = tenant.id;
  const author = `agent:${agentId}`;
  return [
      tool(
        'wiki_list',
        'Elenca le pagine della wiki di conoscenza di questo business, con la dimensione in parole. L\'INDEX.md è già nel tuo contesto (system prompt): usa questo tool solo per vedere se è cambiato o per orientarti prima di wiki_read/wiki_write.',
        {},
        async () => ok(listPages(tenantId).map((name) => ({ page: name, words: wordCount(readPage(tenantId, name) ?? '') }))),
      ),
      tool(
        'wiki_read',
        `Legge una pagina della wiki (progressive disclosure: caricala solo quando ti serve davvero, non tutte insieme). Senza parametri torna il contenuto intero, TRANNE quando la pagina supera ~${WIKI_READ_TRUNCATE_CHARS} caratteri: in quel caso torna solo la prima porzione con "truncated": true, "totalLines" e un "hint" su come leggere il resto — per continuare usa "offset" (in righe, prosegue da dove ti sei fermato) oppure "section" (titolo di un'intestazione "## ..." per leggere solo quel capitolo, utile su pagine-log lunghe come decisions.md). La risposta include SEMPRE "hash" del contenuto INTERO della pagina (non della porzione restituita): passalo come base_hash alla tua prossima wiki_write su questa pagina, per far verificare al server che nel frattempo nessun\'altra run l\'abbia modificata (altrimenti wiki_write rifiuta con un conflitto esplicito invece di sovrascrivere in silenzio).`,
        {
          page: z.string().describe('Nome file, es. clienti.md, decisions.md'),
          offset: z.number().int().nonnegative().optional().describe('Riga (0-based) da cui iniziare a leggere. Usalo per proseguire dopo una risposta con "truncated": true (offset = "linesReturned" della risposta precedente).'),
          limit: z.number().int().positive().optional().describe('Quante righe leggere a partire da offset (default: fino alla fine della pagina).'),
          section: z.string().optional().describe('Titolo di un\'intestazione di livello 2 ("## Titolo") da leggere da sola, senza il resto della pagina (es. per una voce di decisions.md). Alternativo a offset/limit.'),
        },
        async ({ page, offset, limit, section }) => {
          const content = readPage(tenantId, page);
          if (content === null) return ok({ error: `pagina "${page}" non trovata`, pages: listPages(tenantId) });
          // Hash SEMPRE sul contenuto intero (vedi commento su WIKI_READ_TRUNCATE_CHARS):
          // il controllo di concorrenza di wiki_write deve restare valido anche dopo
          // una lettura parziale/troncata.
          const hash = contentHash(content);
          const lines = content.split('\n');
          const totalLines = lines.length;
          const totalChars = content.length;

          if (section) {
            const heads = pageSections(content);
            const idx = heads.findIndex((h) => h.title.trim().toLowerCase() === section.trim().toLowerCase());
            if (idx === -1) {
              return ok({
                error: `sezione "${section}" non trovata in ${page}`, page, hash,
                availableSections: heads.map((h) => h.title),
              });
            }
            const start = heads[idx].line;
            const end = idx + 1 < heads.length ? heads[idx + 1].line : totalLines;
            const sliceLines = lines.slice(start, end);
            return ok({ page, section: heads[idx].title, content: sliceLines.join('\n'), hash, totalLines, linesReturned: sliceLines.length });
          }

          if (offset !== undefined || limit !== undefined) {
            const off = Math.max(0, offset ?? 0);
            const sliceLines = limit !== undefined ? lines.slice(off, off + limit) : lines.slice(off);
            const truncated = off + sliceLines.length < totalLines;
            const result = {
              page, content: sliceLines.join('\n'), hash, offset: off, linesReturned: sliceLines.length, totalLines, truncated,
            };
            if (truncated) {
              result.hint = `Altre ${totalLines - off - sliceLines.length} righe: richiama wiki_read con offset:${off + sliceLines.length} per continuare, oppure "section" per leggere solo un capitolo.`;
            }
            return ok(result);
          }

          if (totalChars > WIKI_READ_TRUNCATE_CHARS) {
            let cut = 0;
            let chars = 0;
            while (cut < lines.length && chars + lines[cut].length + 1 <= WIKI_READ_TRUNCATE_CHARS) {
              chars += lines[cut].length + 1;
              cut += 1;
            }
            cut = Math.max(cut, 1); // almeno una riga, anche se la prima da sola supera la soglia
            const sliceLines = lines.slice(0, cut);
            const sections = pageSections(content);
            return ok({
              page, content: sliceLines.join('\n'), hash, truncated: true, totalLines, totalChars, linesReturned: sliceLines.length,
              hint: `Pagina di ${totalChars} caratteri / ${totalLines} righe, oltre la soglia di sicurezza (${WIKI_READ_TRUNCATE_CHARS}): mostrate le prime ${sliceLines.length} righe. Continua con wiki_read({page:"${page}", offset:${sliceLines.length}}), oppure leggi un capitolo con wiki_read({page:"${page}", section:"<titolo>"})`
                + `${sections.length ? ` — sezioni disponibili: ${sections.map((h) => h.title).join(', ')}` : ''}.`,
            });
          }

          return ok({ page, content, hash });
        },
      ),
      tool(
        'wiki_write',
        'Crea o sovrascrive una pagina della wiki (commit git automatico: audit trail e rollback lato server). USALA a fine di ogni task significativa per registrare fatti utili al business: decisioni -> decisions.md in stile ADR (data, decisione, motivo), termini nuovi -> glossario.md, altro nella pagina di dominio pertinente (clienti/prodotto/processi, o una nuova pagina). Se crei o rinomini una pagina, aggiorna anche INDEX.md con una riga che la descrive. Manda SEMPRE il contenuto completo della pagina (sostituisce quello esistente, non fa merge). Tieni le pagine brevi (~2000 parole): dividi se cresce troppo. '
          + 'CONCORRENZA: se la pagina esiste già, DEVI prima leggerla con wiki_read e passare qui il suo campo "hash" come base_hash — è la prova che stai scrivendo sopra l\'ultima versione. Se nel frattempo un\'altra run ha scritto la stessa pagina, la scrittura viene RIFIUTATA con un conflitto esplicito (mai perso in silenzio): in quel caso rileggi con wiki_read, riapplica la tua modifica sul contenuto aggiornato e ripeti wiki_write con il nuovo hash. Per una pagina NUOVA ometti base_hash. '
          + 'GUARDIA ANTI-TRONCAMENTO (task 53ffbc1c, incidente 24/07: un agente ha mandato SOLO la sezione nuova al posto della pagina intera): se la pagina esiste, la scrittura viene RIFIUTATA (blocked: "shrink") quando il nuovo contenuto scende sotto il 60% dei byte della versione attuale, OPPURE fa sparire una o più intestazioni "## " già presenti — a prescindere dai byte, è esattamente il pattern "mandata solo una sezione". Il messaggio d\'errore dice quanti byte/heading si perderebbero. Se ti serve solo AGGIUNGERE contenuto usa wiki_append (niente replace integrale, a prova di clobber). Se è una riscrittura strutturale VOLUTA (reset, riordino di INDEX.md o di una pagina) passa confirm_shrink: true per bypassare la guardia. '
          + 'PAGINE-LOG (decisions.md, digest.md, code-quality.md, roadmap.md): per AGGIUNGERE una voce usa wiki_append, non wiki_write — è a prova di clobber. Se usi comunque wiki_write e il contenuto che invii rimuove una "## voce" già presente sul disco (tipico lost-update: hai ricostruito la pagina da una versione stale), la scrittura viene RIFIUTATA (blocked: entry_loss). Solo per una potatura/riscrittura intenzionale passa confirm_restructure: true.',
        {
          page: z.string().describe('Nome file, es. clienti.md, decisions.md, INDEX.md'),
          content: z.string().describe('Contenuto markdown completo della pagina'),
          base_hash: z.string().optional().describe('Campo "hash" ricevuto dall\'ultima wiki_read su questa pagina. Obbligatorio (di fatto) se la pagina esiste già: senza, la scrittura viene rifiutata per sicurezza. Ometti solo se la pagina è nuova.'),
          confirm_shrink: z.boolean().optional().describe('Override esplicito della guardia anti-troncamento (equivalente a un "allow_shrink"): metti true SOLO se vuoi davvero ridurre/ristrutturare una pagina esistente (reset, riordino, INDEX.md) riducendo i byte oltre il 60% o rimuovendo intestazioni "## " esistenti. Senza, la scrittura viene rifiutata (blocked: "shrink") — quasi sempre significa che hai mandato contenuto parziale invece della pagina intera: usa wiki_append per aggiungere solo una sezione.'),
          confirm_restructure: z.boolean().optional().describe('Solo per pagine-log (decisions.md, digest.md, code-quality.md, roadmap.md): metti true SOLO se stai deliberatamente potando/riscrivendo la pagina rimuovendo voci "## " esistenti (es. archiviazione, job di pruning). Altrimenti la guardia entry-loss rifiuta la scrittura per evitare di cancellare in silenzio una voce aggiunta da un\'altra run. Per aggiungere una voce usa wiki_append.'),
        },
        async ({ page, content, base_hash, confirm_shrink, confirm_restructure }) => {
          let result;
          try {
            result = writePage(tenantId, page, content, {
              author, allowShrink: !!confirm_shrink, allowEntryLoss: !!confirm_restructure,
              baseHash: base_hash === undefined ? null : base_hash,
            });
          } catch (err) {
            if (err && err.code === 'wiki_shrink_guard') {
              return ok({
                page, saved: false, blocked: 'shrink',
                prevBytes: err.prevBytes, newBytes: err.newBytes, lostHeadings: err.lostHeadings,
                error: err.message,
                hint: err.lostHeadings.length
                  ? `Il contenuto che hai mandato fa sparire ${err.lostHeadings.length} intestazione/i "## " già presenti sulla pagina: probabilmente hai mandato solo una sezione invece della pagina intera. Per AGGIUNGERE contenuto usa wiki_append (a prova di clobber). Se è voluto (riscrittura strutturale), rilancia wiki_write con confirm_shrink: true.`
                  : 'Il nuovo contenuto è molto più piccolo del precedente (possibile troncamento/placeholder). Se è voluto (reset intenzionale), rilancia con confirm_shrink: true. Se NON lo è, rimanda la pagina COMPLETA (non solo la parte nuova) — per aggiungere solo contenuto nuovo usa wiki_append.',
              });
            }
            if (err && err.code === 'wiki_conflict') {
              return ok({
                page, saved: false, blocked: 'conflict',
                currentHash: err.currentHash, baseHash: err.baseHash,
                error: err.message,
                hint: 'Scrittura concorrente rilevata: NESSUNA modifica è stata salvata (né la tua né quella altrui sono state perse). Rileggi la pagina con wiki_read, riapplica la tua modifica sul contenuto aggiornato e riprova wiki_write con il nuovo base_hash.',
              });
            }
            if (err && err.code === 'wiki_entry_loss') {
              return ok({
                page, saved: false, blocked: 'entry_loss',
                lostHeadings: err.lostHeadings,
                error: err.message,
                hint: 'Pagina-log: la tua scrittura full-page cancellerebbe una voce aggiunta da un\'altra run. Per AGGIUNGERE una voce usa wiki_append (mandi solo la voce nuova, nessun clobber). Se è davvero una potatura/riscrittura intenzionale, rilancia wiki_write con confirm_restructure: true.',
              });
            }
            throw err;
          }
          const words = wordCount(content);
          return ok({
            page, saved: true, changed: result.changed, hash: result.hash, words,
            ...(words > 2000 ? { warning: 'pagina oltre ~2000 parole: valuta di dividerla in più pagine' } : {}),
          });
        },
      ),
      tool(
        'wiki_append',
        'Aggiunge UNA voce a una pagina "log" della wiki (es. decisions.md in stile ADR) senza leggere/riscrivere l\'intera pagina: PREFERISCILO a wiki_write quando devi solo registrare una voce nuova a fine task (il caso più comune) — elimina alla radice il rischio di lost-update fra run concorrenti, non serve nemmeno base_hash. Manda SOLO il markdown della voce nuova (es. "## 2026-07-25 — Titolo\\n- **Problema**: ...\\n- **Fix**: ...\\n- **Verifica**: ...\\n- **File toccati**: ..."), MAI l\'intera pagina. Viene inserita in cima alle voci esistenti (prima della prima intestazione "## " della pagina); se la pagina non ha intestazioni "## " (es. glossario.md) viene accodata in fondo. Se la pagina non esiste ancora viene creata. Usa wiki_write invece per riscritture strutturali (INDEX.md, riordino/dedup di una pagina).',
        {
          page: z.string().describe('Nome file, es. decisions.md'),
          entry: z.string().describe('Markdown della sola voce nuova da aggiungere (non l\'intera pagina)'),
        },
        async ({ page, entry }) => {
          const result = appendPage(tenantId, page, entry, { author });
          const words = wordCount(readPage(tenantId, page) ?? '');
          return ok({
            page, saved: true, changed: result.changed, hash: result.hash, words,
            ...(words > 2000 ? { warning: 'pagina oltre ~2000 parole: valuta di dividerla in più pagine' } : {}),
          });
        },
      ),
  ];
}

export function buildWikiMcpServer(tenant, agentId) {
  return createSdkMcpServer({ name: 'wiki', version: '1.0.0', tools: wikiTools(tenant, agentId) });
}

export const WIKI_MCP_TOOLS = ['mcp__wiki__wiki_list', 'mcp__wiki__wiki_read', 'mcp__wiki__wiki_write', 'mcp__wiki__wiki_append'];
