// Blocco (b) di runAgentTurnInner (task 829e29c2, God-function server/index.js):
// costruzione del prompt effettivo per il modello (testo + allegati) e del
// system prompt (wiki/direttiva concisione/governance/scheduling a obiettivo).
// MOVE puro da server/index.js: stessa logica, stesse variabili — zero cambi
// di comportamento.
import { readFileSync } from 'fs';
import { INLINE_TEXT_MAX_BYTES } from '../uploads.js';
import { readIndex as readWikiIndex } from '../wiki.js';
import { queryContextGraph } from '../context-graph.js';
import { budgetObjectiveLine } from '../budget.js';
import { getLimitState } from '../ratelimit.js';
import { appendHistory } from '../history.js';
import { logAudit } from '../audit.js';

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Allegati chat: costruisce il prompt effettivo per il modello a partire dal
// testo utente e dagli allegati. Immagini/PDF (e testo grande) → path da leggere
// col tool Read; testo piccolo → inlinato direttamente nel prompt.
export function buildAttachmentPrompt(message, atts) {
  const toRead = [];
  const inline = [];
  for (const a of atts) {
    if (a.kind === 'text' && a.size <= INLINE_TEXT_MAX_BYTES) {
      let content = '';
      try { content = readFileSync(a.path, 'utf8'); } catch { content = '(impossibile leggere il file)'; }
      inline.push(`### Allegato: ${a.name} (${a.type})\n\`\`\`\n${content}\n\`\`\``);
    } else {
      toRead.push(`- ${a.path}  (${a.name}, ${a.type}, ${formatBytes(a.size)})`);
    }
  }
  let out = (message && message.trim()) ? message : '(nessun testo nel messaggio, vedi gli allegati)';
  if (toRead.length) {
    out += `\n\n---\nAllegati caricati dall'utente in QUESTO messaggio. Leggili con il tool Read (supporta immagini e PDF) prima di rispondere e rispondi nel merito del loro contenuto:\n${toRead.join('\n')}`;
  }
  if (inline.length) {
    out += `\n\n---\nContenuto testuale degli allegati (già incluso qui sotto, non serve rileggerlo):\n\n${inline.join('\n\n')}`;
  }
  return out;
}

// Prompt effettivo per il modello: il testo utente + un blocco che elenca gli
// allegati. Immagini e PDF si leggono col tool Read (nativo, supporta entrambi);
// il testo piccolo si inlina direttamente così l'agente lo vede senza tool.
// `queued`: messaggi accodati (task 311d2946) consegnati nello stesso turno.
export function buildPromptForModel({ message, attachments, queued, tenantId = null }) {
  const atts = Array.isArray(attachments) ? attachments : [];
  const items = Array.isArray(queued) ? queued : [];
  const promptParts = [atts.length ? buildAttachmentPrompt(message, atts) : message];
  for (const item of items) {
    const itemAtts = Array.isArray(item.attachments) ? item.attachments : [];
    promptParts.push(itemAtts.length ? buildAttachmentPrompt(item.message, itemAtts) : item.message);
  }
  const userPrompt = items.length
    ? `L'utente ha inviato ${items.length + 1} messaggi in sequenza mentre lavoravi, eccoli in ordine (rispondi tenendo conto di tutti):\n\n${promptParts.map((p, i) => `### Messaggio ${i + 1}\n${p}`).join('\n\n')}`
    : promptParts[0];
  const sharedContext = queryContextGraph(promptParts.join('\n'), { tenantId, limit: 7, maxChars: 5500 }).text;
  return sharedContext ? `${sharedContext}\n\n---\n## Richiesta corrente\n${userPrompt}` : userPrompt;
}

// Persiste il messaggio utente (+ eventuali messaggi accodati, task 311d2946)
// in history/audit e restituisce il prompt per il modello. MOVE puro dal
// corpo di runAgentTurnInner in server/index.js: stessa logica, stesse
// variabili — zero cambi di comportamento.
export function ingestIncomingMessages({ tenantId, agentId, sessionId, message, username, attachments, extraQueued }) {
  const atts = Array.isArray(attachments) ? attachments : [];
  // Persistiti con il messaggio utente: restano nello storico e sono ricaricabili
  // (senza il path assoluto, che è un dettaglio interno del server).
  appendHistory(tenantId, agentId, sessionId, {
    role: 'user', text: message, by: username,
    ...(atts.length ? { attachments: atts.map(({ path, ...meta }) => meta) } : {}),
  });
  logAudit({ user: username, tenant: tenantId, agent: agentId, event: 'chat_user_message', detail: atts.length ? { attachments: atts.length } : undefined });

  // Messaggi accodati mentre l'agente lavorava il turno precedente (task
  // 311d2946, coda persistita in lib/messagequeue.js): consegnati QUI in
  // blocco, nello stesso turno del primo — ognuno resta una bolla separata
  // nello storico (persistiti singolarmente, sotto), ma per il modello sono
  // un unico prompt/turno, non N turni separati (risparmio token, contesto
  // coerente in un colpo solo).
  const queued = Array.isArray(extraQueued) ? extraQueued : [];
  for (const item of queued) {
    const itemAtts = Array.isArray(item.attachments) ? item.attachments : [];
    appendHistory(tenantId, agentId, sessionId, {
      role: 'user', text: item.message, by: item.username,
      ...(itemAtts.length ? { attachments: itemAtts.map(({ path, ...meta }) => meta) } : {}),
    });
    logAudit({ user: item.username, tenant: tenantId, agent: agentId, event: 'chat_user_message', detail: itemAtts.length ? { attachments: itemAtts.length } : undefined });
  }

  return { promptForModel: buildPromptForModel({ message, attachments: atts, queued, tenantId }), queued };
}

// Stile "caveman" (task 254cae20): direttiva di output conciso/telegrafico,
// iniettata centralmente per TUTTI gli agenti di TUTTI i tenant — un solo posto
// da mantenere e parte fissa del prompt (buona per il prompt caching). Riduce i
// token di OUTPUT a ogni turno senza perdita di informazione operativa. Stringa
// statica (nessuna interpolazione per-turno): estratta a costante di modulo.
const CONCISE_DIRECTIVE = `---
## Stile di output (risparmio token — vale per tutti)
Asciutto e telegrafico, orientato alla decisione:
- Niente preamboli/convenevoli/meta-commenti ("certo", "ecco", "spero sia utile"): vai dritto al punto.
- Non ripetere o parafrasare contesto/task/domanda: chi legge li ha già.
- Bullet brevi invece di paragrafi; una frase per concetto; taglia aggettivi e ridondanze.
- Prima la conclusione/decisione, poi il perché in due righe (solo se serve).
- Note task, messaggi tra agenti e consegne al gate: compatti — cosa fatto, come verificato, file toccati; bullet secchi, niente prosa.
- Concisione ≠ perdita di info: ometti le parole, mai i fatti operativi che servono ad agire.
- Vale per la TUA comunicazione (risposte, ragionamento, note, coordinamento). NON per i deliverable che la task chiede esplicitamente (copy, script, documenti, codice): quelli seguono la lunghezza/forma richiesta dalla task.

### Output ADHD-friendly (skill i-have-adhd — sempre attiva, vale per tutti)
Chi legge ha ADHD: l'output non è solo breve, è azionabile a colpo d'occhio.
1. Prima riga = la prossima azione concreta (comando, file, decisione), non contesto.
2. Lavoro multi-step = lista numerata; un'azione delimitata per step, il minimo di step che funziona.
3. Chiudi con UNA prossima azione concreta, mai con un ventaglio di opzioni.
4. Niente tangenti: se non serve per agire ora, taglia.
5. Ristabilisci lo stato a ogni turno (dove siamo, cosa manca): la working memory del lettore non conserva i turni precedenti.
6. Stime di tempo specifiche (minuti/ore), mai "un po'" o "a breve".
7. Rendi visibili i progressi (fatto X di Y): le vittorie sepolte non contano.
8. Errori in tono neutro e operativo: cosa è rotto, come si ripara.
9. Liste max 5 voci: oltre, spezza in "ora" vs "dopo".
10. Zero preamboli, zero recap finali, zero convenevoli.
---`;

// Requisito 3, task 81ea4965 (rilancio del bug critico 212d9b82: run che
// finiscono senza consegna esaurivano i retry e restavano bloccate in
// silenzio). La stessa regola dura era iniettata SOLO nel messaggio per-task
// del dispatcher (taskPrompt/reviewPrompt in dispatcher.js): copre il lancio
// autonomo, ma NON il caso in cui un operativo lavora una task della board
// dentro una sessione interattiva (Owner che ne parla in chat, una ripresa
// manuale) — lì il reminder del dispatcher non c'è. Centralizzata qui, nel
// system prompt universale (stesso meccanismo di CONCISE_DIRECTIVE sopra):
// un solo posto, vale per TUTTI gli agenti di TUTTI i tenant, a ogni turno.
const DELIVERY_DIRECTIVE = `---
## Consegna task (quality gate) — vale per tutti
Se in questo turno stai lavorando una task della board (assegnata dal
dispatcher o da Owner/un manager in chat): la run NON è considerata finita
finché non hai consegnato — update_task a status "review_manager" con nota
(cosa fatto, come verificato), oppure ask_owner se serve una decisione di
Owner (mai un update_task diretto a status "needs_input": senza una domanda
strutturata la task finisce tra le "Bloccate", non da Owner — task board
03a5a645); se sei in fase di review usa submit_review (mai update_task).
Chiudere la run senza quella chiamata la fa trattare come fallita: il lavoro
va rifatto da capo, e dopo gli ultimi tentativi la task resta bloccata finché
non interviene un umano.

### Regola anti-false-done (vincolante)
"Done" NON significa "ho scritto il copy", "esiste una wiki", "il codice è pronto" o "la preview locale risponde". Significa ESCLUSIVAMENTE che la definition of done dichiarata nella task è verificata nel luogo dove il risultato deve vivere: produzione per una pagina/app, account reale per una campagna, file sorgente consegnato per un video, o decisione owner registrata per una scelta.

Prima di consegnare, inserisci nella nota questi quattro campi: OUTPUT (cosa esiste), AMBIENTE (wiki / preview / repository / staging / produzione), PROVA (URL, commit, screenshot, ID esterno o test ripetibile), GAP (l'unico passo residuo, oppure "nessuno").

Se il gap richiede un'azione esterna o desktop di Owner, NON approvare o chiudere la task come outcome completo: usa ask_owner e lasciala in "ready_for_owner" (oppure "needs_input" se manca una decisione). La task che produce l'artifact deve chiamarsi esplicitamente "Artifact" o "Preparazione"; crea o conserva una task separata "GO-LIVE" con proprietario, ambiente, prova richiesta e definition of done. Il reviewer deve bocciare ogni consegna che mescola artifact pronto e risultato live.
---`;

// Wiki sempre nel contesto (INDEX.md) + convenzione di aggiornamento a fine
// task: iniettata qui centralmente (non nei singoli systemPrompt di
// tenants.json) così vale per tutti gli agenti ed è un solo posto da mantenere.
// Estratta da buildSystemPrompt (task 829e29c2) per restare sotto le ~50 righe
// per funzione: stessa logica, MOVE puro.
//
// Ottimizzazione cache (task token-diet): questo blocco è il PIÙ volatile fra
// gli statici (l'INDEX cambia a ogni wiki_write) → va per ULTIMO nel system
// prompt, così una modifica all'INDEX invalida solo la coda della cache e non
// anche ruolo/direttive/governance che stanno prima.
function buildWikiSystemPrompt({ tenant, tenantId }) {
  return `---
## Wiki di conoscenza di ${tenant.name}

Hai una wiki markdown versionata con git e un grafo canonico condiviso con OpenClaw, V1 e V2. Il turno riceve automaticamente solo il sottografo pertinente alla richiesta, con provenance verso le sorgenti. Usa wiki_read o wiki_list quando serve il documento completo.

Indice compatto, solo struttura:

${String(readWikiIndex(tenantId) || '').split('\n').filter((line) => /^#{1,3} |^- \[/.test(line)).slice(0, 80).join('\n') || '(INDEX.md vuoto)'}

Convenzione: a fine di ogni task significativa, se hai imparato qualcosa di utile
per il business (una decisione presa, un fatto su un cliente/prodotto/processo, un
termine nuovo) registralo nella pagina di dominio pertinente (decisions.md in stile
ADR: data, decisione, motivo — per le decisioni). Se crei o rinomini una pagina
aggiorna anche INDEX.md. Pagine brevi (~2000 parole): dividi se crescono troppo. È
una tua responsabilità di routine, non serve chiedere permesso né aprire una task
per farlo.

PER AGGIUNGERE UNA VOCE (caso più comune, es. decisions.md a fine task): usa
wiki_append, NON wiki_write. Manda solo il markdown della voce nuova (es. "##
2026-07-25 — Titolo\n- **Problema**: ...\n- **Fix**: ..."): il server la inserisce
in cima alle voci esistenti senza che tu debba leggere/ricostruire l'intera pagina
— elimina alla radice il rischio di clobber su scritture concorrenti (due run che
aggiungono una voce nello stesso momento), niente hash da gestire.

wiki_write serve solo per riscritture STRUTTURALI dell'intera pagina (INDEX.md,
riordino/dedup, pagina nuova da zero). In quel caso, se la pagina esiste già,
leggila PRIMA con wiki_read e ripassa il suo campo "hash" come base_hash in
wiki_write — serve al server per accorgersi se un'altra run ha scritto la stessa
pagina nel frattempo. Se wiki_write torna blocked:"conflict", NON è stato salvato
nulla (né il tuo contenuto né quello altrui sono andati persi): rileggi con
wiki_read, riapplica la tua modifica sul contenuto aggiornato e ripeti wiki_write
con il nuovo hash.

REGOLA OBBLIGATORIA (decisione di Owner, non opzionale): se in questa run modifichi
o crei un file del progetto/tenant (Write/Edit/Bash che tocca file), DEVI aggiornare
la wiki di conseguenza NELLA STESSA run/task, prima di chiudere — non rimandarlo.
Per gli agenti dev (codice della piattaforma): logga la modifica in decisions.md
(o nella pagina di dominio pertinente) della wiki "platform". Questo può essere
verificato dal quality gate del manager in revisione.
---`;
}

// Registrazione run esterne (docs/governance.md): procedura operativa iniettata
// centralmente SOLO agli agenti dev — gli unici con Bash, quindi gli unici che
// possono lanciare processi esterni. Prima era copiata verbatim in ~18 system
// prompt di tenants.json, anche in agenti senza Bash dove era inerte (task
// 254cae20): ora è un solo posto e non pesa sui prompt di chi non ne ha bisogno.
function buildGovernanceSystemPrompt({ tenantId, agent }) {
  if (!agent.dev) return '';
  return `---
## Registrazione run esterne (OBBLIGATORIA — docs/governance.md)
Ogni processo/agente che lanci via Bash FUORI dalla piattaforma DEVE registrarsi nel journal, o Owner non lo vede in "Agenti live". Server http://localhost:3100; header su ogni chiamata: -H "X-Agent-Key: $(cat /app/server/data/agent-registration.key)".
1. Registra: POST /api/runs/register -H 'Content-Type: application/json' -d '{"tenantId":"${tenantId}","agentId":"<id-processo>","title":"<cosa fa>"}' → salva l'id dalla risposta.
2. Heartbeat ≤60s: POST /api/runs/<id>/heartbeat; se la risposta ha status "stopped", Owner ha fermato la run → termina il processo.
3. Fine: POST /api/runs/<id>/complete -d '{"status":"completed"}' (o "failed" con "error").
Oltre 2 min senza heartbeat → run marcata failed + push a Owner. Imponi lo stesso obbligo a ogni sub-agente che deleghi.
---`;
}

// Obiettivo di scheduling + stato budget della finestra (task b8b98175,
// requisito 6): iniettato SOLO per chi orchestra le priorità — il CEO e i
// manager reali (un agente citato come managerId di qualcun altro, o con un
// ruolo da orchestratore). Una riga a ogni turno, così il ragionamento su cosa
// lanciare/in che ordine tiene conto del budget residuo e del reset.
//
// Task token-diet: questo blocco NON sta più nel system prompt. Conteneva le
// UNICHE interpolazioni per-turno (% budget residuo, ora di reset, stato del
// rate limit): cambiando a ogni turno invalidava la cache del prompt INTERO —
// ruolo, direttive, governance e soprattutto l'INDEX della wiki (~6k token per
// il tenant USA) venivano riscritti in cache invece che riletti, a ogni turno
// di ogni manager. Ora viaggia come preambolo del MESSAGGIO del turno: stessa
// informazione, stessa visibilità per il modello, ma il system prompt resta
// byte-identico fra turni consecutivi → cache hit invece di cache write.
// Ritorna '' per chi non orchestra (nessun preambolo da aggiungere).
export function buildTurnPreamble({ tenant, agent }) {
  const isManagerAgent = agent.role === 'CEO'
    || tenant.agents.some((a) => a.managerId && a.managerId === agent.id)
    || /manager|responsabile|cto|chief|lead|direzione|head/i.test(String(agent.role ?? ''));
  if (!isManagerAgent) return '';
  // Nota "coda per quota" per CEO/manager (task 5998e8a7): quando l'esecuzione
  // autonoma è in pausa (muro reale del rate limit OPPURE halt stimato del budget),
  // le task delegate NON partono finché non torna la quota. Il CEO DEVE dirlo a
  // Owner — «board in coda per quota, riparte alle HH:MM» — invece di far credere
  // che parta subito (era il vero problema: sembrava delegassero e non partiva nulla).
  const limitNow = getLimitState();
  let executionPausedNote = '';
  if (limitNow?.limited) {
    const rHH = limitNow.resumeAt ? new Date(limitNow.resumeAt).toISOString().slice(11, 16) : '—';
    executionPausedNote = `\n\n⏸️ ESECUZIONE IN PAUSA: quota Claude al muro (finestra Max condivisa). Le run autonome NON partono fino al reset (~${rHH} UTC). Le task che deleghi ora restano IN CODA e ripartono da sole al reset, per urgenza. Se Owner ti chiede lo stato, dillo esplicitamente: «board in coda per quota, riparte alle ${rHH}» — non dire che parte subito.`;
  }
  return `---\n## Scheduling a obiettivo (finestra token Max) — stato ADESSO, a questo messaggio\n${budgetObjectiveLine()}\nParallelizza le task indipendenti (ambiti diversi, nessuna dipendenza) fino al cap globale; usa blockedBy solo per ciò che deve essere serializzato. Ordine: urgenza prima, poi ciò che sblocca altre task, poi le più brevi (throughput).${executionPausedNote}\n---`;
}

// System prompt del turno: ruolo + direttiva di concisione + consegna +
// governance run esterne (solo dev) + wiki. Iniettato centralmente per tutti
// gli agenti/tenant — un solo posto da mantenere.
//
// Task token-diet: il risultato è ora COMPLETAMENTE STATICO a parità di
// (agente, INDEX della wiki) — nessuna interpolazione per-turno. È il
// requisito del prompt caching: prefisso byte-identico = cache hit. I blocchi
// sono ordinati per stabilità DECRESCENTE (ruolo → direttive → governance →
// wiki), così una modifica all'INDEX invalida solo la coda.
// Lo stato volatile (budget/quota) è passato a parte da buildTurnPreamble.
export function buildSystemPrompt({ tenant, tenantId, agent }) {
  return [
    agent.systemPrompt,
    CONCISE_DIRECTIVE,
    DELIVERY_DIRECTIVE,
    buildGovernanceSystemPrompt({ tenantId, agent }),
    buildWikiSystemPrompt({ tenant, tenantId }),
  ].filter(Boolean).join('\n\n');
}
