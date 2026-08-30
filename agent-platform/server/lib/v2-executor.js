import { randomUUID } from 'crypto';
import { addProjectMessage, activateNextProjectStep, claimProjectStepDispatch, compareProjectPriority, compileProjectContext, deferOverdueInputSteps, findBlockingEarlierProject, getProject, invalidateStepsAfter, listInputWaitingProjects, listPreemptedProjects, listPremiumReviewProjects, listRecoverableProjects, patchProjectExecution, projectHasRunnableSteps, reactivateDependencyDeferredSteps, releaseProjectStepDispatch, requestProjectInput, setProjectFailed, setProjectResumedFromFailed } from './operating-system.js';
import { runOpenClawAgent, isTransportError } from './openclaw-gateway.js';
import { fetchLastTaskResult } from './openclaw-gateway-ws.js';
import { isUsageLimitBanner, usageLimitRetryAt } from './runs.js';
import { isRateLimited, noteUsageLimit } from './ratelimit.js';
import { join } from 'path';
import { CONFIG_DIR, readJson } from './store.js';
import { buildDevelopmentTaskPack, buildTaskHandoff, normalizeUsage, summarizeTaskPack } from './dev-harness.js';

// ---- Retry con backoff per classe di errore (task retry-backoff, 2026-08-14) ----
// Due classi distinte, nessuna riesecuzione cieca:
// - TRASPORTO (connessione morta, watchdog, UND_ERR_*): il lavoro nel gateway non e'
//   perso (sessione + gatewayRunId conservati) -> backoff CORTO e RIAGGANCIO
//   (resumePrompt sulla stessa sessione), mai rilancio del prompt pieno.
// - APPLICATIVO (4xx, risposta vuota, quality gate esaurito): il run e' morto sul
//   serio -> backoff LUNGO con tetto ai tentativi, poi FALLIMENTO DEFINITIVO
//   (progetto 'failed', escluso da listRecoverableProjects, push definitiva
//   gestita dalla task policy-push). Ripresa solo manuale (POST resume).
// Contatori SEPARATI per classe: una caduta di trasporto non consuma tentativi
// applicativi, e un tentativo applicativo riuscito azzera il counter trasporto.
// Valori da server/config/platform.json > gatewayTransport.retry (override env).
const RETRY_CFG = (() => {
  const fileCfg = readJson(join(CONFIG_DIR, 'platform.json'), {})?.gatewayTransport?.retry ?? {};
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    transportBaseMs: num(process.env.V2_RETRY_TRANSPORT_BASE_MS, num(fileCfg.transportBaseMs, 30_000)),
    transportMaxMs: num(process.env.V2_RETRY_TRANSPORT_MAX_MS, num(fileCfg.transportMaxMs, 120_000)),
    transportWarnAfter: num(process.env.V2_RETRY_TRANSPORT_WARN_AFTER, num(fileCfg.transportWarnAfter, 10)),
    applicationMaxAttempts: num(process.env.V2_RETRY_APPLICATION_MAX_ATTEMPTS, num(fileCfg.applicationMaxAttempts, 3)),
    applicationBaseMs: num(process.env.V2_RETRY_APPLICATION_BASE_MS, num(fileCfg.applicationBaseMs, 120_000)),
    applicationMaxMs: num(process.env.V2_RETRY_APPLICATION_MAX_MS, num(fileCfg.applicationMaxMs, 480_000)),
  };
})();

// Cap GLOBALE di progetti V2 in esecuzione simultanea (decisione Owner
// 2026-08-27). Il collo di bottiglia vero non e' CPU/RAM ma la subscription
// Claude: una sola quota condivisa da tutta la piattaforma. Dieci progetti in
// parallelo si tolgono token a vicenda e muoiono tutti sul muro a meta' lavoro;
// meglio POCHE run che arrivano in fondo e smaltiscono la coda in fila. Prima
// l'unico limite era il lock PER PROGETTO (running): N progetti attivi = N run
// insieme, nessun tetto. Default 1, override in
// server/config/platform.json > v2.maxConcurrentProjects (o env V2_MAX_CONCURRENT_PROJECTS).
const MAX_CONCURRENT_PROJECTS = (() => {
  const fileCfg = readJson(join(CONFIG_DIR, 'platform.json'), {})?.v2 ?? {};
  const n = Number(process.env.V2_MAX_CONCURRENT_PROJECTS ?? fileCfg.maxConcurrentProjects ?? 1);
  return Number.isInteger(n) && n >= 1 ? n : 1;
})();

// Fila LINEARE tra progetti (decisione Owner 2026-08-29): i progetti girano in
// ordine (queueOrder, poi createdAt) e il successivo parte solo quando il
// precedente ha finito o e' fermo del tutto su Owner. Kill-switch:
// v2.linearProjectQueue=false (o env V2_LINEAR_PROJECT_QUEUE=0) per tornare
// alla concorrenza libera dei progetti senza toccare il codice.
const LINEAR_PROJECT_QUEUE = (() => {
  const fileCfg = readJson(join(CONFIG_DIR, 'platform.json'), {})?.v2 ?? {};
  const raw = process.env.V2_LINEAR_PROJECT_QUEUE ?? fileCfg.linearProjectQueue ?? true;
  return !(raw === false || raw === 'false' || raw === '0' || raw === 0);
})();

// Soglia di rinvio input (flusso lineare, decisione Owner 2026-08-29): se una
// task resta ferma su una domanda a Owner oltre questa finestra, viene rinviata
// ('deferred', richiesta aperta) e si prosegue con la task successiva. 0 = off.
const INPUT_DEFER_MS = (() => {
  const fileCfg = readJson(join(CONFIG_DIR, 'platform.json'), {})?.v2 ?? {};
  const n = Number(process.env.V2_INPUT_DEFER_MS ?? fileCfg.inputDeferMs ?? 600_000);
  return Number.isFinite(n) && n >= 0 ? n : 600_000;
})();

const running = new Set();
// Controlli run per pausa/stop dalla UI e preemption (cambio task su risposta):
// lockKey -> { abort, pauseRequested, preemptRequested, currentStepId }.
const controls = new Map();

// Hook SOLO per i test: consente di sostituire la chiamata al Gateway con un
// mock (linear-queue-check.mjs) senza toccare il flusso di produzione.
let gatewayAgentRunner = runOpenClawAgent;
export function __setGatewayRunnerForTests(fn) { gatewayAgentRunner = fn ?? runOpenClawAgent; }
let taskResultFetcher = fetchLastTaskResult;
export function __setTaskResultFetcherForTests(fn) { taskResultFetcher = fn ?? fetchLastTaskResult; }

// Verifica se l'utente ha richiesto la pausa PRIMA di una patch che cambia stato.
// Ritorna true se la pausa era richiesta (e la applica), false altrimenti.
// Usato nei punti dove il codice sta per sovrascrivere execution.status.
function pauseIfRequested(tenantId, projectId, notify) {
  const control = controls.get(`${tenantId}:${projectId}`);
  if (!control?.pauseRequested) return false;
  const paused = patchProjectExecution(tenantId, projectId, { project: { status: 'paused', error: null, nextRetryAt: null, pausedAt: new Date().toISOString() } });
  notify(paused);
  return true;
}

// Aborta il run sul Gateway via sessions.abort (stop immediato, non solo socket).
// gatewayRunId e' persistito su step.execution.gatewayRunId (worker) o
// premiumQualityGatewayRunId (premium). Best-effort: non blocca se fallisce.
async function abortGatewayRun(tenantId, projectId, stepId = null) {
  try {
    const project = getProject(tenantId, projectId);
    // Con lo skip-ahead possono esistere DUE step 'active' (task risposta +
    // task in esecuzione): l'abort deve colpire quello in esecuzione. Priorita':
    // stepId esplicito -> step con dispatchLock vivo -> primo active -> currentStepId.
    const step = (stepId ? project?.steps?.find((s) => s.id === stepId) : null)
      ?? project?.steps?.find((s) => s.execution?.dispatchLock)
      ?? project?.steps?.find((s) => s.status === 'active' || s.id === project?.currentStepId);
    const runId = step?.execution?.gatewayRunId ?? step?.execution?.premiumQualityGatewayRunId;
    const sessionKey = step?.execution?.sessionKey;
    if (!runId && !sessionKey) return;
    const { abortGatewaySession } = await import('./openclaw-gateway.js');
    const outcome = await abortGatewaySession(runId, sessionKey);
    // Esito dello stop persistito sullo step: senza questo il tasto Ferma non
    // e' verificabile a posteriori (task E3, dove si e' scoperto che l'abort
    // falliva in silenzio da sempre).
    patchProjectExecution(tenantId, projectId, {
      stepId: step.id,
      step: { stopSignal: { at: new Date().toISOString(), aborted: outcome?.aborted ?? false, runIds: outcome?.runIds ?? [], error: outcome?.error?.message ?? null } },
    }, 'v2-executor');
  } catch { /* best-effort: il run finira' comunque per disconnessione */ }
}

export function isProjectRunning(tenantId, projectId) {
  return running.has(`${tenantId}:${projectId}`);
}

// Ferma la run in corso (aborta la chiamata LLM attiva) e marca il progetto in pausa.
// Idempotente: su progetto non in run aggiorna solo execution.status.
export function requestProjectPause(tenantId, projectId, updatedBy) {
  const control = controls.get(`${tenantId}:${projectId}`);
  if (control) {
    // Marca lo step in corso PRIMA di abortire (verifica live 2026-08-26: senza
    // questo la ripresa rimandava il prompt PIENO sulla stessa sessione e
    // l'agente rifaceva la task da capo, attempt 1 -> 2). Con il flag il
    // prossimo dispatch fa RIAGGANCIO (resumePrompt), come per il trasporto:
    // stessa sessione, stesso lavoro, l'agente continua da dov'era.
    // Solo se il Gateway aveva gia' accettato il run (gatewayRunId): se lo stop
    // arriva prima, non c'e' nulla da riagganciare e il prompt pieno e' giusto.
    try {
      const snapshot = getProject(tenantId, projectId);
      // Preferisce lo step realmente in esecuzione (control.currentStepId):
      // con lo skip-ahead il primo 'active' puo' essere la task appena
      // risposta, non quella in run.
      const activeStep = (control.currentStepId ? snapshot?.steps?.find((item) => item.id === control.currentStepId) : null)
        ?? snapshot?.steps?.find((item) => item.status === 'active')
        ?? snapshot?.steps?.find((item) => item.id === snapshot?.currentStepId);
      if (activeStep?.execution?.gatewayRunId) {
        patchProjectExecution(tenantId, projectId, {
          project: { pausedStepId: activeStep.id },
          stepId: activeStep.id,
          step: { resumedFromPause: true },
        }, updatedBy ?? 'v2-executor');
      }
    } catch { /* best-effort: la pausa non deve mai fallire per questo */ }
    control.pauseRequested = true;
    control.abort.abort();
    // Propaga l'abort al Gateway: chiude il run lato LLM, non solo il socket.
    abortGatewayRun(tenantId, projectId, control.currentStepId ?? null).catch(() => {});
  }
  return patchProjectExecution(tenantId, projectId, {
    project: { status: 'paused', error: null, nextRetryAt: null, pausedAt: new Date().toISOString(), pausedBy: updatedBy ?? null },
  }, updatedBy ?? 'v2-executor');
}

// PREEMPTION DENTRO IL PROGETTO (flusso lineare 2026-08-29): la risposta di
// Owner su una task rinviata vince sulla task successiva in esecuzione. Ferma
// il turno in volo in modo PULITO (stesso riaggancio del tasto Ferma:
// resumedFromPause + chiave di idempotenza nuova al riaggancio, macchina E2/E3
// gia' verificata live) e il loop riparte dalla PRIMA task attiva in ordine di
// piano, cioe' quella appena risposta. Mai due agent in parallelo: il lock per
// progetto resta uno solo e il cambio avviene solo con abort + re-run.
export function requestProjectPreempt(tenantId, projectId) {
  const control = controls.get(`${tenantId}:${projectId}`);
  if (!control || control.pauseRequested) return false;
  try {
    const snapshot = getProject(tenantId, projectId);
    const firstActive = snapshot?.steps?.find((item) => item.status === 'active') ?? null;
    // Preempt solo se la task in esecuzione NON e' gia' la prima attiva del
    // piano: altrimenti l'abort butterebbe via lavoro buono per niente.
    if (!firstActive || !control.currentStepId || firstActive.id === control.currentStepId) return false;
    const runningStep = snapshot.steps.find((item) => item.id === control.currentStepId);
    if (runningStep?.execution?.gatewayRunId) {
      patchProjectExecution(tenantId, projectId, {
        stepId: runningStep.id,
        step: { resumedFromPause: true },
      }, 'v2-executor');
    }
  } catch { return false; }
  control.preemptRequested = true;
  control.abort.abort();
  abortGatewayRun(tenantId, projectId, control.currentStepId ?? null).catch(() => {});
  return true;
}

// Punto unico chiamato dagli endpoint dopo resolveProjectInput (e dal resume):
// garantisce che a girare sia sempre la task/progetto a priorita' piu' alta.
// 1) dentro il progetto: preemption se la risposta riattiva una task precedente;
// 2) tra progetti: mette in pausa (pausedReason 'preempted') le run di progetti
//    SUCCESSIVI in fila, che riprenderanno da sole al prossimo stallo di questo;
// 3) avvia il progetto risposto (subito, e con un ritenta breve se ha dovuto
//    liberare lo slot; il tick recoverV2Projects resta la rete di sicurezza).
export function onProjectInputResolved(tenantId, projectId, notify = () => {}) {
  const preempted = requestProjectPreempt(tenantId, projectId);
  const answered = getProject(tenantId, projectId);
  let pausedOthers = 0;
  if (answered && LINEAR_PROJECT_QUEUE) {
    for (const key of [...running]) {
      const sep = key.indexOf(':');
      const otherTenant = key.slice(0, sep);
      const otherId = key.slice(sep + 1);
      if (otherTenant === tenantId && otherId === projectId) continue;
      const other = getProject(otherTenant, otherId);
      if (!other) continue;
      // Stessa tenant: vale la fila (queueOrder/createdAt). Tenant DIVERSA: il
      // progetto appena risposto vince sempre — non esiste un ordine di fila
      // cross-tenant e senza questo ramo la risposta di Owner restava 'queued'
      // finche' l'altro tenant non mollava lo slot (visto 2026-08-29: ToS
      // beekeeping fermo dietro la verifica stop-agent del tenant platform).
      if (otherTenant === tenantId && compareProjectPriority(answered, other) >= 0) continue;
      requestProjectPause(otherTenant, otherId, 'linear-preempt');
      patchProjectExecution(otherTenant, otherId, {
        project: { pausedReason: 'preempted', preemptedByProjectId: projectId, queueReason: `in pausa: precedenza a “${answered.title}”` },
      }, 'v2-executor');
      pausedOthers += 1;
    }
  }
  if (!preempted) {
    runProjectSerial(tenantId, projectId, notify);
    if (pausedOthers > 0) {
      setTimeout(() => { runProjectSerial(tenantId, projectId, notify); }, 3_000).unref?.();
    }
  }
  return { preempted, pausedOthers };
}

function safeKey(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80); }
function extractJson(text, tag) {
  const match = String(text ?? '').match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i'));
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

// Blocco di contesto aggiunto ai prompt worker quando task PRECEDENTI del piano
// sono state rinviate in attesa di una risposta di Owner (flusso lineare):
// l'agente non deve assumerne gli output e, se la dipendenza e' stretta, deve
// dichiararlo subito invece di lavorare a vuoto o inventare.
function deferredNoticeBlock(deferredEarlier) {
  if (!deferredEarlier?.length) return '';
  const labels = deferredEarlier.map((item) => `"${item.label}" (id ${item.id})`).join(', ');
  return `

ATTENZIONE — TASK PRECEDENTI SOSPESE: ${labels} sono in attesa di una risposta di Owner e NON sono state eseguite. Non dare per scontato il loro output e non provare a farle tu. Se la tua task NON può essere svolta correttamente senza il loro risultato, NON lavorare a vuoto e non inventare: rispondi SOLO con
<task_result>{"status":"blocked_on_dependency","summary":"perché serve la task sospesa","dependsOn":"id della task sospesa"}</task_result>
Se invece è svolgibile in modo indipendente, procedi normalmente.`;
}

function workerPrompt(taskPack, feedback, deferredNotice = '') {
  return `Sei l'agente operativo di un progetto approvato nell'Operating System V2. Esegui SOLO la task corrente usando gli strumenti OpenClaw disponibili. Lavora realmente sui file e sistemi consentiti, verifica il risultato e non dichiarare completato ciò che non hai provato.

REGOLA ANTI-TIMEOUT (obbligatoria): mentre lavori NON restare in silenzio. Scrivi una breve riga di stato almeno ogni minuto (cosa stai facendo in quel momento). Spezza i comandi lunghi in passi più corti: nessuna singola operazione muta sopra i 3 minuti, niente poll/attese lunghe in un solo comando. Un run silenzioso troppo a lungo viene interrotto e devi ricominciare: perdi tu il lavoro.

TASK PACK COMPATTO:\n${JSON.stringify(taskPack)}
${feedback ? `\nFEEDBACK QUALITY GATE DA CORREGGERE:\n${feedback}` : ''}${deferredNotice}

Se ti serve una decisione, un dato, una credenziale o un intervento di Owner, fermati e formula UNA domanda diretta. La richiesta la legge Owner dal telefono e deve essere azionabile in 10 secondi, quindi rispetta OBBLIGATORIAMENTE questo schema:
- "question" apre con l'AZIONE concreta che Owner deve fare, imperativo, zero gergo (es. "Lancia da root questo comando: ..." / "Dimmi se scegli A o B"). MAI aprire con lo stato tecnico del sistema.
- "context" = perché serve + quanto tempo gli costa (es. "Serve per chiudere la sicurezza del token. 2 minuti."). Il dettaglio tecnico, se indispensabile, va in UNA riga alla fine.
- "options" = azioni pronte da cliccare, formulate come cosa succede se le sceglie, non descrizioni tecniche.
Alla fine aggiungi SEMPRE uno dei due formati:
<task_result>{"status":"completed","summary":"risultato concreto","evidence":["verifica eseguita"],"artifacts":["file o output prodotti"]}</task_result>
<task_result>{"status":"needs_input","summary":"cosa hai già fatto","question":"AZIONE per Owner, poi il resto","context":"perché + quanto tempo, tecnica in fondo","options":["opzione A","opzione B"]}</task_result>`;
}

// Prompt di RIAGGANCIO: usato quando il tentativo precedente e' caduto per un
// errore di TRASPORTO (connessione morta, watchdog di silenzio) e la sessione
// gateway aveva gia' accettato il run (gatewayRunId presente). Il Gateway
// accoda i turni per sessione e conserva il contesto anche se il client si
// stacca (provato con test-replay-session.mjs e test-requeue-inflight.mjs il
// 2026-08-14), quindi rimandare il prompt intero rieseguirebbe la task da
// capo nella stessa sessione. Qui invece chiediamo all'agente di riprendere
// il SUO lavoro precedente: niente rilancio, niente riesecuzione cieca.
function resumePrompt(step, taskPack, deferredNotice = '') {
  return `Il run precedente su questa task si è interrotto (stop dalla UI oppure caduta di connessione) mentre la eseguivi (id "${step.id}", "${step.label}").${deferredNotice}

ATTENZIONE, il contesto della conversazione precedente può essere andato perso: dopo uno stop il Gateway riparte su una sessione CLI nuova, senza i messaggi di prima (provato il 2026-08-27: un riaggancio è finito a lavorare su un altro progetto perché l'agente aveva "ricordato" la cosa sbagliata). Quindi NON dare per scontato di ricordare cosa stavi facendo e NON dedurlo dalla memoria, dai file di appunti o da altri progetti: le uniche fonti valide sono la task qui sotto e lo stato reale del filesystem.

TASK PACK COMPATTO:\n${JSON.stringify(taskPack)}

Procedi così: 1) verifica sul filesystem che cosa risulta già prodotto per QUESTA task; 2) riprendi dal primo pezzo mancante, senza rifare e senza riscrivere ciò che esiste già; 3) porta la task a completamento. Se non trovi nessuna traccia di lavoro precedente, esegui da capo la task come è descritta qui, senza ricostruire un contesto diverso. Non lavorare su nessun altro progetto o task, per nessun motivo.

REGOLA ANTI-TIMEOUT (obbligatoria): mentre lavori NON restare in silenzio. Scrivi una breve riga di stato almeno ogni minuto, spezza i comandi lunghi, nessuna operazione muta sopra i 3 minuti: un run silenzioso viene interrotto e ricominci da capo.

Descrizione originale della task:
${step.description}

Se ti serve una decisione, un dato, una credenziale o un intervento di Owner, fermati e formula UNA domanda diretta. La richiesta la legge Owner dal telefono e deve essere azionabile in 10 secondi: "question" apre con l'AZIONE concreta che deve fare lui (imperativo, zero gergo), "context" dice perché serve e quanto tempo gli costa con la tecnica in UNA riga alla fine, "options" sono azioni pronte da cliccare. Alla fine aggiungi SEMPRE uno dei due formati:
<task_result>{"status":"completed","summary":"risultato concreto","evidence":["verifica eseguita"],"artifacts":["file o output prodotti"]}</task_result>
<task_result>{"status":"needs_input","summary":"cosa hai già fatto","question":"AZIONE per Owner, poi il resto","context":"perché + quanto tempo, tecnica in fondo","options":["opzione A","opzione B"]}</task_result>`;
}

function qualityPrompt(taskPack, workerText) {
  return `Sei il Quality Gate indipendente dell'Operating System V2. Controlla severamente il risultato della task rispetto a obiettivo, descrizione, criteri di successo, vincoli e prove. Non modificare nulla. Approva solo se il lavoro è realmente completo e verificato.

TASK PACK COMPATTO:\n${JSON.stringify(taskPack)}
RISULTATO AGENTE:\n${workerText}

Rispondi brevemente e aggiungi SEMPRE:
<quality_gate>{"approved":false,"score":0,"feedback":"motivo dettagliato","checks":["controllo effettuato"]}</quality_gate>`;
}

export async function runProjectSerial(tenantId, projectId, notify = () => {}) {
  const lockKey = `${tenantId}:${projectId}`;
  if (running.has(lockKey)) return;
  // FILA TRA PROGETTI (flusso lineare 2026-08-29): un progetto parte solo se
  // nessun progetto PRECEDENTE (queueOrder, poi createdAt) sta ancora lavorando
  // o puo' ancora avanzare da solo. Resta 'queued' con il motivo in chiaro;
  // recoverV2Projects lo ri-triggera quando la fila si libera. Gli stati di
  // attesa su Owner (needs_input/waiting_approval/paused) NON vengono toccati.
  const blocking = LINEAR_PROJECT_QUEUE ? findBlockingEarlierProject(tenantId, projectId) : null;
  if (blocking) {
    const waiting = getProject(tenantId, projectId);
    const exec = waiting?.execution?.status ?? 'idle';
    if (waiting?.status === 'active' && ['idle', 'queued', 'running', 'error'].includes(exec)) {
      const queueReason = `in fila: prima tocca a “${blocking.title}”`;
      if (exec !== 'queued' || waiting.execution?.queueReason !== queueReason) {
        notify(patchProjectExecution(tenantId, projectId, {
          project: { status: 'queued', error: null, nextRetryAt: null, queueReason },
        }));
      }
    }
    return;
  }
  // Fila d'attesa globale (cap subscription): oltre il tetto NON si parte e non
  // si fallisce — il progetto resta 'queued' e recoverV2Projects (tick 20s) lo
  // ri-triggera appena uno slot si libera. Nessun contatore consumato, nessuna
  // push: e' attesa, non errore.
  if (running.size >= MAX_CONCURRENT_PROJECTS) {
    const waiting = getProject(tenantId, projectId);
    if (waiting?.status === 'active' && waiting.execution?.status !== 'queued') {
      notify(patchProjectExecution(tenantId, projectId, {
        project: {
          status: 'queued', error: null, nextRetryAt: null,
          queueReason: `in coda: ${running.size}/${MAX_CONCURRENT_PROJECTS} slot occupati`,
        },
      }));
    }
    return;
  }
  running.add(lockKey);
  const control = { abort: new AbortController(), pauseRequested: false, preemptRequested: false, currentStepId: null };
  controls.set(lockKey, control);
  let claimedStep = null;
  const releaseClaim = () => {
    if (!claimedStep) return;
    try {
      releaseProjectStepDispatch(tenantId, projectId, claimedStep);
    } catch { /* best-effort */ }
    claimedStep = null;
  };
  const pauseNow = () => {
    releaseClaim();
    const paused = patchProjectExecution(tenantId, projectId, { project: { status: 'paused', error: null, nextRetryAt: null } });
    notify(paused);
  };
  try {
    let project = getProject(tenantId, projectId);
    if (!project || project.status !== 'active') return;
    // queueReason azzerato all'avvio vero: e' il motivo dell'ATTESA (slot o muro
    // Claude), se restasse appiccicato la card mostrerebbe "in coda" su una run viva.
    patchProjectExecution(tenantId, projectId, { project: { status: 'running', error: null, nextRetryAt: null, queueReason: null } });
    notify(getProject(tenantId, projectId));

    while ((project = getProject(tenantId, projectId))?.status === 'active') {
      if (control.pauseRequested) { pauseNow(); return; }
      let step = project.steps.find((item) => item.status === 'active');
      if (!step) {
        project = activateNextProjectStep(tenantId, projectId);
        step = project.steps.find((item) => item.status === 'active');
      }
      if (!step) break;
      // Gate di approvazione CONSUMATO una sola volta per step (fix bug A,
      // diagnosi 2026-08-15-approval-loop-beekeeping): approvalRequired resta
      // sullo step (invariante di piano), ma una volta che una richiesta
      // 'approval' e' stata risolta, resolveProjectInput marca
      // execution.approvedAt e il runner NON ricrea piu' la richiesta al
      // rilancio. Cosi' la N-esima approvazione dello stesso step non genera
      // una nuova richiesta identica (loop osservato su business-a).
      if (step.approvalRequired && !step.execution?.approvedAt) {
        project = patchProjectExecution(tenantId, projectId, { project: { status: 'waiting_approval' }, stepId: step.id, step: { status: 'needs_approval' } });
        requestProjectInput(tenantId, projectId, {
          type: 'approval', stepId: step.id,
          context: `La task “${step.label}” è pronta ma richiede approvazione prima di procedere.`,
          question: 'Approvi l’esecuzione di questa task?', options: ['Approva', 'Non approvare'],
        });
        project = getProject(tenantId, projectId);
        notify(project);
        break;
      }

      const attempt = Number(step.execution?.attempt ?? 0) + 1;
      // Il Gateway normalizza le session key in minuscolo: una key con maiuscole
      // (es. step id "us_run_A3_3") fallisce il lookup al secondo turno con
      // "Session changed while starting work" -> HTTP 500.
      const sessionKey = (step.execution?.sessionKey || `agent:main:dashboard:v2-${safeKey(tenantId)}-${safeKey(projectId)}-${safeKey(step.id)}`).toLowerCase();
      const idempotencyKey = step.execution?.idempotencyKey || randomUUID();
      const dispatchOwner = randomUUID();
      const claim = claimProjectStepDispatch(tenantId, projectId, { stepId: step.id, owner: dispatchOwner });
      if (!claim.ok) {
        notify(claim.project ?? getProject(tenantId, projectId));
        return;
      }
      claimedStep = { stepId: step.id, owner: dispatchOwner };
      control.currentStepId = step.id;
      project = patchProjectExecution(tenantId, projectId, {
        project: { status: 'running', currentStepId: step.id },
        stepId: step.id,
        step: { status: 'active', phase: 'execution', attempt, sessionKey, idempotencyKey, model: step.model || project.defaultModel, startedAt: step.execution?.startedAt || new Date().toISOString(), error: null },
      });
      notify(project);

      let feedback = step.execution?.quality?.feedback || '';
      let approved = false;
      let deferredHandled = false;
      let dependencyDeferred = false;
      // Task precedenti del piano rinviate in attesa di Owner: il worker le deve
      // conoscere per non assumerne gli output (flusso lineare 2026-08-29).
      const stepIndex = project.steps.findIndex((item) => item.id === step.id);
      const deferredEarlierSteps = stepIndex > 0 ? project.steps.slice(0, stepIndex).filter((item) => item.status === 'deferred') : [];
      const deferredNotice = deferredNoticeBlock(deferredEarlierSteps);
      // Rinvio per DIPENDENZA: la task dichiara di non poter procedere senza una
      // task sospesa -> viene rinviata anche lei (tornera' 'pending' quando la
      // dipendenza si chiude) e si prosegue con la successiva.
      const deferForDependency = (resultText, resultJson, usagePatch) => {
        project = patchProjectExecution(tenantId, projectId, {
          stepId: step.id,
          step: {
            status: 'deferred', phase: 'blocked_on_dependency', deferredReason: 'dependency',
            deferredAt: new Date().toISOString(), dependsOn: resultJson?.dependsOn ?? null,
            output: resultText, result: resultJson, ...(usagePatch ? { usage: usagePatch } : {}),
          },
        });
        releaseClaim();
        addProjectMessage(tenantId, projectId, { role: 'assistant', text: `⏭️ **${step.label}** dipende da una task in attesa di una tua risposta: la rimando a dopo e proseguo con la successiva.` }, 'v2-executor');
        project = activateNextProjectStep(tenantId, projectId);
        notify(project);
        dependencyDeferred = true;
      };
      for (let qualityAttempt = 0; qualityAttempt < 3 && !approved; qualityAttempt += 1) {
        if (control.pauseRequested) { pauseNow(); return; }
        const context = compileProjectContext(tenantId, projectId);
        const taskPack = buildDevelopmentTaskPack(context, step);
        // Riaggancio: se il tentativo precedente e' morto di trasporto DOPO che
        // il gateway aveva accettato il run (gatewayRunId salvato), non rilancio
        // il prompt pieno: mando un prompt di ripresa sulla STESSA sessione, cosi'
        // l'agente continua il lavoro invece di rieseguirlo da zero.
        // Stesso riaggancio dopo uno STOP manuale (task E2): requestProjectPause
        // marca lo step con resumedFromPause, quindi la ripresa continua il
        // lavoro invece di rieseguire la task da capo.
        // Solo al primo giro: se il quality gate boccia, i giri successivi
        // devono mandare il prompt pieno CON il feedback, non un riaggancio.
        const reattach = qualityAttempt === 0
          && Boolean(step.execution?.gatewayRunId)
          && (step.execution?.lastErrorKind === 'transport' || step.execution?.resumedFromPause === true);
        // RIPRESA DOPO IL TASTO FERMA: chiave di idempotenza NUOVA, obbligatoria.
        // La chiave dello step viene riusata apposta sul riaggancio da TRASPORTO,
        // dove il run puo' essere ancora vivo nel Gateway e la dedup ci riattacca
        // a quello (vedi il blocco "Sul trasporto conservo sessionKey,
        // idempotencyKey e gatewayRunId" piu' sotto). Dopo uno stop manuale il run
        // e' MORTO: l'abbiamo ucciso noi con chat.abort. Li' la stessa dedup
        // diventa il bug: il Gateway risponde ok ma con il runId del run abortito
        // e non avvia niente, la ripresa resta muta fino al watchdog e finisce in
        // execution.status=error / lastErrorKind=transport senza un file nuovo
        // (era l'unico criterio E3 ancora rosso il 2026-08-26).
        // A/B provato: docs/spike-e3-resume-idempotency-2026-08-27.mjs
        // (chiave riusata -> 0 file in 90 s; chiave nuova -> riprende in 14 s).
        const reattachAfterStop = reattach && step.execution?.resumedFromPause === true;
        const turnIdempotencyKey = reattachAfterStop ? randomUUID() : idempotencyKey;
        // RACCOLTO PRIMA DEL RIAGGANCIO (fix 541 redispatch, 2026-08-30): il
        // "morto di trasporto" spesso aveva gia' consegnato il task_result
        // finale, buttato dal watchdog; sta ancora nel transcript della
        // sessione e riprenderlo da li' costa ZERO token, contro un turno
        // intero di riaggancio (riverifica filesystem + risposta rifatta).
        // Solo senza feedback del quality gate: se il gate ha gia' bocciato,
        // quel task_result e' il risultato respinto e va rifatto davvero.
        let harvested = null;
        if (reattach && !reattachAfterStop && !feedback) {
          const startedMs = Date.parse(step.execution?.startedAt ?? '') || 0;
          harvested = await taskResultFetcher(sessionKey, { afterTs: startedMs }).catch(() => null);
          // Vale solo un task_result che si lascia PARSARE: un tag rotto in un
          // testo a meta' passerebbe al quality gate spazzatura gia' nota.
          if (harvested?.text && !extractJson(harvested.text, 'task_result')) harvested = null;
          if (harvested?.text) {
            project = patchProjectExecution(tenantId, projectId, {
              project: { status: 'running', error: null, nextRetryAt: null, transportRecoveryCount: 0, transportWarning: null },
              stepId: step.id, step: { phase: 'execution', harvestedFinalAt: new Date().toISOString() },
            });
            notify(project);
          } else {
            harvested = null;
          }
        }
        if (reattach && !harvested) {
          project = patchProjectExecution(tenantId, projectId, {
            project: { status: 'running', error: null, nextRetryAt: null, transportRecoveryCount: 0, transportWarning: null },
            // La chiave della ripresa sta in un campo suo: `idempotencyKey` deve
            // restare quella del turno originale, altrimenti un retry successivo
            // non riaggancerebbe piu' il run giusto.
            stepId: step.id, step: { phase: 'execution', reattached: true, resumedFromPause: false, ...(reattachAfterStop ? { resumeIdempotencyKey: turnIdempotencyKey } : {}) },
          });
          notify(project);
        }
        const worker = harvested
          ? { text: harvested.text, usage: null, transport: 'ws', modelUsed: step.model || project.defaultModel }
          : await gatewayAgentRunner({
            message: reattach ? resumePrompt(step, taskPack, deferredNotice) : workerPrompt(taskPack, feedback, deferredNotice), model: step.model || project.defaultModel,
            sessionKey, idempotencyKey: qualityAttempt === 0 ? turnIdempotencyKey : randomUUID(), thinking: 'high', signal: control.abort.signal,
            onAccepted: ({ runId }) => { const updated = patchProjectExecution(tenantId, projectId, { stepId: step.id, step: { gatewayRunId: runId } }); notify(updated); },
          });
        // Trasporto realmente usato per il turno ('ws' = abortabile, 'http' =
        // fallback non abortabile): serve a capire dallo stato se il tasto
        // Ferma su quel run poteva funzionare.
        if (worker.transport) {
          project = patchProjectExecution(tenantId, projectId, { stepId: step.id, step: { gatewayTransport: worker.transport } });
        }
        const taskResult = extractJson(worker.text, 'task_result');
        if (taskResult?.status === 'blocked_on_dependency') {
          deferForDependency(worker.text, taskResult, { worker: normalizeUsage(worker.usage, worker.modelUsed) });
          break;
        }
        if (taskResult?.status === 'needs_input') {
          project = patchProjectExecution(tenantId, projectId, {
            project: { status: 'needs_input' }, stepId: step.id,
            step: { status: 'blocked', phase: 'needs_input', output: worker.text, result: taskResult, taskPack: summarizeTaskPack(taskPack), usage: { worker: normalizeUsage(worker.usage, worker.modelUsed) } },
          });
          requestProjectInput(tenantId, projectId, {
            type: 'input', stepId: step.id, question: taskResult.question,
            context: taskResult.context || taskResult.summary, options: taskResult.options,
          });
          project = getProject(tenantId, projectId);
          releaseClaim();
          notify(project);
          return;
        }
        const qaKey = randomUUID();
        const workerUsage = normalizeUsage(worker.usage, worker.modelUsed);
        if (project.qualityGateMode === 'deferred') {
          let finalWorker = worker;
          let finalTaskResult = taskResult;
          let finalWorkerUsage = workerUsage;
          let economicGate = null;
          let economicOutput = '';
          let economicUsage = null;
          let economicPreReview = null;

          const maxEconomicCycles = project.economicPreReviewEnabled === true
            ? Math.max(0, Math.min(3, Number(project.economicPreReviewMaxCycles) || 0))
            : 0;

          if (maxEconomicCycles > 0) {
            economicPreReview = {
              model: project.economicPreReviewModel || 'deepseek/deepseek-v4-pro',
              maxCycles: maxEconomicCycles,
              reviewCount: 0,
              revisionCount: 0,
              approved: false,
              limitReached: false,
              revisionPerformed: false,
              reviews: [],
            };

            while (true) {
              project = patchProjectExecution(tenantId, projectId, {
                stepId: step.id,
                step: {
                  phase: 'economic_pre_review', output: finalWorker.text, result: finalTaskResult, taskPack: summarizeTaskPack(taskPack),
                  economicPreReview, usage: { worker: finalWorkerUsage, economicPreReview: economicUsage },
                },
              });
              notify(project);
              if (control.pauseRequested) { pauseNow(); return; }

              const economicReview = await gatewayAgentRunner({
                message: qualityPrompt(taskPack, finalWorker.text), model: project.economicPreReviewModel || 'deepseek/deepseek-v4-pro',
                sessionKey: `${sessionKey}-economic-qa-${economicPreReview.reviewCount + 1}`, idempotencyKey: randomUUID(), thinking: 'high', signal: control.abort.signal,
              });
              economicGate = extractJson(economicReview.text, 'quality_gate') ?? { approved: false, score: 0, feedback: 'Pre-controllo economico senza risposta strutturata.' };
              economicOutput = economicReview.text;
              const reviewUsage = normalizeUsage(economicReview.usage, economicReview.modelUsed);
              economicUsage = reviewUsage;
              const reviewRecord = {
                index: economicPreReview.reviewCount + 1,
                model: economicReview.modelUsed || project.economicPreReviewModel || 'deepseek/deepseek-v4-pro',
                approved: economicGate.approved === true,
                score: Number(economicGate.score) || 0,
                feedback: economicGate.feedback || '',
                checks: Array.isArray(economicGate.checks) ? economicGate.checks : [],
                usage: reviewUsage,
              };
              economicPreReview.model = reviewRecord.model;
              economicPreReview.reviewCount += 1;
              economicPreReview.approved = reviewRecord.approved;
              economicPreReview.score = reviewRecord.score;
              economicPreReview.feedback = reviewRecord.feedback;
              economicPreReview.checks = reviewRecord.checks;
              economicPreReview.reviews.push(reviewRecord);

              if (economicGate.approved === true) break;
              if (economicPreReview.revisionCount >= maxEconomicCycles) {
                economicPreReview.limitReached = true;
                break;
              }

              const revisionFeedback = economicGate.feedback || 'Correggi il risultato in base al pre-controllo economico e aggiungi prove verificabili.';
              project = patchProjectExecution(tenantId, projectId, {
                stepId: step.id,
                step: {
                  phase: 'economic_revision', quality: economicGate, qualityOutput: economicOutput, economicPreReview,
                  usage: { worker: finalWorkerUsage, economicPreReview: economicUsage },
                },
              });
              notify(project);
              if (control.pauseRequested) { pauseNow(); return; }

              const revision = await gatewayAgentRunner({
                message: workerPrompt(taskPack, revisionFeedback, deferredNotice), model: step.model || project.defaultModel,
                sessionKey, idempotencyKey: randomUUID(), thinking: 'high', signal: control.abort.signal,
                onAccepted: ({ runId }) => { const updated = patchProjectExecution(tenantId, projectId, { stepId: step.id, step: { gatewayRunId: runId } }); notify(updated); },
              });
              const revisionResult = extractJson(revision.text, 'task_result');
              const revisionUsage = normalizeUsage(revision.usage, revision.modelUsed);
              if (revisionResult?.status === 'blocked_on_dependency') {
                deferForDependency(revision.text, revisionResult, { worker: revisionUsage, initialWorker: workerUsage, economicPreReview: economicUsage });
                break;
              }
              if (revisionResult?.status === 'needs_input') {
                project = patchProjectExecution(tenantId, projectId, {
                  project: { status: 'needs_input' }, stepId: step.id,
                  step: {
                    status: 'blocked', phase: 'needs_input', output: revision.text, result: revisionResult, taskPack: summarizeTaskPack(taskPack),
                    quality: economicGate, qualityOutput: economicOutput, economicPreReview,
                    usage: { worker: revisionUsage, initialWorker: workerUsage, economicPreReview: economicUsage },
                  },
                });
                requestProjectInput(tenantId, projectId, {
                  type: 'input', stepId: step.id, question: revisionResult.question,
                  context: revisionResult.context || revisionResult.summary, options: revisionResult.options,
                });
                project = getProject(tenantId, projectId);
                releaseClaim();
                notify(project);
                return;
              }
              finalWorker = revision;
              finalTaskResult = revisionResult;
              finalWorkerUsage = revisionUsage;
              economicPreReview.revisionCount += 1;
              economicPreReview.revisionPerformed = true;
            }
          }
          // La revisione ha dichiarato una dipendenza da una task sospesa: lo
          // step e' gia' stato rinviato dentro il ciclo economico, si prosegue
          // con la task successiva senza accodarlo al premium.
          if (dependencyDeferred) break;

          const handoff = buildTaskHandoff({ pack: taskPack, taskResult: finalTaskResult, worker: finalWorker, quality: economicGate, qualityOutput: economicOutput, workerUsage: finalWorkerUsage, qualityUsage: economicUsage, economicPreReview });
          // BATCH: lo step è pronto per il premium ma NON fermiamo il progetto.
          // Segnamo lo step 'needs_premium_review' e avanziamo subito al
          // successivo, così il worker economico scorre TUTTA la pipeline. Il
          // progetto andrà in 'needs_premium_review' solo dopo l'ultimo step.
          project = patchProjectExecution(tenantId, projectId, {
            project: { status: 'running', currentStepId: step.id, error: null, nextRetryAt: null },
            stepId: step.id,
            step: {
              status: 'needs_premium_review', phase: 'needs_premium_review', output: finalWorker.text, result: finalTaskResult, taskPack: summarizeTaskPack(taskPack),
              quality: economicGate, qualityOutput: economicOutput, economicPreReview, handoff,
              usage: { worker: finalWorkerUsage, ...(economicUsage ? { economicPreReview: economicUsage, initialWorker: workerUsage } : {}) },
            },
          });
          releaseClaim();
          const preReviewSummary = economicPreReview
            ? (economicPreReview.approved ? `Pre-controllo economico approvato dopo ${economicPreReview.reviewCount} verific${economicPreReview.reviewCount === 1 ? 'a' : 'he'} e ${economicPreReview.revisionCount} revision${economicPreReview.revisionCount === 1 ? 'e' : 'i'}.` : `Pre-controllo economico concluso al limite: ${economicPreReview.reviewCount} verifiche e ${economicPreReview.revisionCount} revision${economicPreReview.revisionCount === 1 ? 'e' : 'i'}; rilievi residui salvati nell’handoff.`)
            : 'Nessun pre-controllo economico configurato.';
          addProjectMessage(tenantId, projectId, { role: 'assistant', text: `🧪 **${step.label}** pronta: ${preReviewSummary} In coda per il quality gate premium.` }, 'v2-executor');
          project = activateNextProjectStep(tenantId, projectId);
          notify(project);
          deferredHandled = true;
          break;
        }
        project = patchProjectExecution(tenantId, projectId, { stepId: step.id, step: { phase: 'quality', output: worker.text, result: taskResult, taskPack: summarizeTaskPack(taskPack), usage: { worker: workerUsage } } });
        notify(project);
        if (control.pauseRequested) { pauseNow(); return; }
        const quality = await gatewayAgentRunner({
          message: qualityPrompt(taskPack, worker.text), model: project.qualityModel || project.defaultModel,
          sessionKey: `${sessionKey}-qa`, idempotencyKey: qaKey, thinking: 'high', signal: control.abort.signal,
        });
        const gate = extractJson(quality.text, 'quality_gate') ?? { approved: false, score: 0, feedback: 'Quality gate senza risposta strutturata.' };
        approved = gate.approved === true;
        feedback = gate.feedback || 'Correggi il risultato e aggiungi prove verificabili.';
        const qualityUsage = normalizeUsage(quality.usage, quality.modelUsed);
        const handoff = buildTaskHandoff({ pack: taskPack, taskResult, worker, quality: gate, qualityOutput: quality.text, workerUsage, qualityUsage });
        project = patchProjectExecution(tenantId, projectId, { stepId: step.id, step: { phase: approved ? 'completed' : 'revision', quality: gate, qualityOutput: quality.text, handoff, usage: { worker: workerUsage, quality: qualityUsage } } });
        notify(project);
      }

      if (deferredHandled || dependencyDeferred) { continue; }
      if (!approved) {
        // Quality gate esaurito (3 revisioni): e' un fallimento APPLICATIVO
        // definitivo dello step, non un errore di trasporto. Marcato
        // qualityExhausted: il catch lo porta SUBITO a definitivo, senza
        // bruciare i tentativi applicativi in riesecuzioni identiche.
        const err = new Error(`Quality gate non superato per ${step.label} dopo 3 tentativi`);
        err.qualityExhausted = true;
        throw err;
      }
      project = patchProjectExecution(tenantId, projectId, { stepId: step.id, step: { status: 'completed', completedAt: new Date().toISOString() } });
      releaseClaim();
      addProjectMessage(tenantId, projectId, { role: 'assistant', text: `✅ **${step.label}** completata e approvata dal quality gate.` }, 'v2-executor');
      // Una task completata puo' sbloccare task rinviate per dipendenza: tornano
      // 'pending' (in ordine di piano) prima di scegliere la prossima.
      try { reactivateDependencyDeferredSteps(tenantId, projectId); } catch { /* best-effort */ }
      project = activateNextProjectStep(tenantId, projectId);
      notify(project);
    }
    project = getProject(tenantId, projectId);
    const premiumQueue = project?.steps?.filter((s) => s.status === 'needs_premium_review') ?? [];
    if (premiumQueue.length > 0) {
      // Batch deferred concluso: tutta la coda di step è pronta per il premium.
      // CONTROLLO PAUSA: se l'utente ha premuto Ferma mentre usciva dal while,
      // la pausa vince e non entra in needs_premium_review.
      if (control.pauseRequested) { pauseNow(); return; }
      project = patchProjectExecution(tenantId, projectId, {
        project: { status: 'needs_premium_review', lifecycleStatus: 'needs_premium_review', error: null, nextRetryAt: null },
      });
      addProjectMessage(tenantId, projectId, { role: 'assistant', text: `📦 Pipeline completata: ${premiumQueue.length} step in attesa del quality gate premium (in sequenza).` }, 'v2-executor');
      notify(project);
    } else if (project?.status === 'active'
      && !project.steps.some((item) => ['active', 'pending', 'proposed', 'needs_approval', 'blocked'].includes(item.status))
      && project.steps.some((item) => item.status === 'deferred')) {
      // Eseguito tutto il possibile: restano solo task rinviate in attesa di
      // Owner. Il progetto va in attesa piena (needs_input) e LIBERA la fila:
      // parte il progetto successivo. Alla risposta questo riprende con
      // priorita' (onProjectInputResolved).
      if (control.pauseRequested) { pauseNow(); return; }
      const waitingCount = project.steps.filter((item) => item.status === 'deferred').length;
      project = patchProjectExecution(tenantId, projectId, {
        project: { status: 'needs_input', error: null, nextRetryAt: null, queueReason: null },
      });
      addProjectMessage(tenantId, projectId, { role: 'assistant', text: `⏸️ Ho completato tutto il possibile: restano ${waitingCount} task in attesa di una tua risposta. La fila passa al progetto successivo; appena rispondi questo progetto riprende con priorità.` }, 'v2-executor');
      notify(project);
    } else if (project?.status === 'completed') {
      notify(project);
    }
  } catch (err) {
    if (control.pauseRequested) { pauseNow(); return; }
    // PREEMPTION (flusso lineare): l'abort e' voluto, non e' un errore. Nessun
    // contatore consumato: lo step interrotto e' gia' marcato resumedFromPause
    // (riaggancio pulito al prossimo giro) e il re-run riparte dalla PRIMA task
    // attiva del piano, cioe' quella appena risposta da Owner. Il re-run parte
    // via setImmediate DOPO il finally, quando il lock 'running' e' libero.
    if (control.preemptRequested) {
      releaseClaim();
      const updated = patchProjectExecution(tenantId, projectId, {
        project: { status: 'queued', error: null, nextRetryAt: null, queueReason: 'risposta arrivata su una task precedente: cambio task' },
      });
      notify(updated);
      setImmediate(() => { runProjectSerial(tenantId, projectId, notify); });
      return;
    }
    const current = getProject(tenantId, projectId);
    const currentStep = current?.steps?.find((item) => item.status === 'active');
    // Classificazione centralizzata: isTransportError copre fetch failed,
    // UND_ERR_*, watchdog di silenzio, stream interrotto, socket hang up ecc.
    // Sul trasporto conservo sessionKey, idempotencyKey e gatewayRunId: il
    // prossimo dispatch fara' RIAGGANCIO (resumePrompt) invece di rilancio.
    // TERZA CLASSE: muro della subscription Claude ("You've hit your limit ·
    // resets HH:MM"). Prima finiva tra gli errori APPLICATIVI: bruciava 1 dei 3
    // tentativi con backoff 2-4-8 min, quindi in ~15 minuti il progetto era
    // 'failed' senza che nessuno avesse sbagliato niente — la causa vera del
    // "gli agenti terminano tutto subito". Ora: nessun contatore consumato,
    // nextRetryAt = orario di reset (+1 min di buffer), sessione/idempotency/
    // gatewayRunId conservati come sul trasporto (al reset RIAGGANCIA il lavoro
    // invece di rifare la task da capo) e noteUsageLimit() alza il muro GLOBALE
    // condiviso con V1 (dispatcher, watchdog, coda concorrenza): nessun altro
    // spawn parte per sbattere sullo stesso muro fino al reset.
    if (isUsageLimitBanner(err.message)) {
      const resumeAt = usageLimitRetryAt(err.message);
      noteUsageLimit({ resumeAt, tenantId, agentId: `v2:${projectId}`, message: err.message });
      const updated = patchProjectExecution(tenantId, projectId, {
        project: {
          status: 'error', error: err.message, nextRetryAt: resumeAt,
          queueReason: `limite Claude raggiunto, ripresa automatica alle ${new Date(resumeAt).toISOString().slice(11, 16)} UTC`,
        },
        stepId: currentStep?.id ?? null,
        step: currentStep ? {
          error: err.message, lastErrorKind: 'usage_limit',
          idempotencyKey: currentStep.execution?.idempotencyKey,
          gatewayRunId: currentStep.execution?.gatewayRunId,
        } : {},
      });
      releaseClaim();
      notify(updated);
      return;
    }
    const transport = isTransportError(err);
    // Backoff per classe (RETRY_CFG, platform.json > gatewayTransport.retry):
    // - trasporto: counter dedicato, backoff corto 30s->60s->120s, riaggancio.
    // - applicativo: max applicationMaxAttempts con backoff 2->4->8 min, poi
    //   progetto 'failed' (definitivo): escluso da listRecoverableProjects,
    //   push finale gestita da policy-push, ripresa solo manuale (resume).
    if (transport) {
      const transportRecoveries = Number(current?.execution?.transportRecoveryCount ?? 0) + 1;
      const delayMs = Math.min(RETRY_CFG.transportMaxMs, RETRY_CFG.transportBaseMs * (2 ** Math.min(transportRecoveries - 1, 4)));
      const warn = transportRecoveries >= RETRY_CFG.transportWarnAfter;
      // RISPOSTA VUOTA: classe trasporto (nessun tentativo bruciato) ma senza
      // riaggancio: il run e' FINITO male, non e' vivo nel Gateway. Riusare la
      // chiave restituirebbe lo stesso run morto (lezione E3) e la stessa
      // sessione puo' essere avvelenata (visto 2026-08-29 sugli Architect):
      // chiavi azzerate + sessione RUOTATA, il prossimo dispatch riparte con
      // prompt pieno su sessione pulita.
      const emptyResponse = /risposta vuota/i.test(String(err.message ?? ''));
      const rotatedSessionKey = currentStep?.execution?.sessionKey
        ? `${String(currentStep.execution.sessionKey).replace(/-r[a-z0-9]+$/, '')}-r${Date.now().toString(36)}`
        : null;
      const updated = patchProjectExecution(tenantId, projectId, {
        project: {
          status: 'error', error: err.message, transportRecoveryCount: transportRecoveries,
          nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
          ...(warn ? { transportWarning: `trasporto caduto ${transportRecoveries} volte di seguito: verificare il gateway` } : {}),
        },
        stepId: currentStep?.id ?? null,
        step: currentStep ? (emptyResponse ? {
          error: err.message, lastErrorKind: 'transport',
          idempotencyKey: null, gatewayRunId: null,
          ...(rotatedSessionKey ? { sessionKey: rotatedSessionKey } : {}),
        } : {
          error: err.message, lastErrorKind: 'transport',
          idempotencyKey: currentStep.execution?.idempotencyKey,
          gatewayRunId: currentStep.execution?.gatewayRunId,
        }) : {},
      });
      releaseClaim();
      notify(updated);
      return;
    }
    const applicationAttempts = Number(current?.execution?.applicationRecoveryCount ?? 0) + 1;
    const definitive = err.qualityExhausted === true || applicationAttempts >= RETRY_CFG.applicationMaxAttempts;
    if (definitive) {
      const reason = err.qualityExhausted === true ? 'quality-gate-exhausted' : 'application-retries-exhausted';
      // setProjectFailed marca project.status TOP-LEVEL (non solo execution),
      // cosi' runProjectSerial esce e listRecoverableProjects lo esclude.
      const updated = setProjectFailed(tenantId, projectId, {
        stepId: currentStep?.id ?? null, error: err.message,
        failureReason: reason, applicationRecoveryCount: applicationAttempts,
      });
      addProjectMessage(tenantId, projectId, { role: 'assistant', text: `⛔ **${currentStep?.label ?? 'Task'}** fallita in modo definitivo (${reason === 'quality-gate-exhausted' ? 'quality gate non superato' : `esauriti ${applicationAttempts} tentativi applicativi`}). Il progetto è fermo: serve un tuo intervento o il resume manuale.` }, 'v2-executor');
      releaseClaim();
      notify(updated);
      return;
    }
    const delayMs = Math.min(RETRY_CFG.applicationMaxMs, RETRY_CFG.applicationBaseMs * (2 ** Math.min(applicationAttempts - 1, 4)));
    const updated = patchProjectExecution(tenantId, projectId, {
      project: {
        status: 'error', error: err.message, applicationRecoveryCount: applicationAttempts,
        applicationAttemptsLeft: RETRY_CFG.applicationMaxAttempts - applicationAttempts,
        nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
      },
      stepId: currentStep?.id ?? null,
      step: currentStep ? {
        error: err.message, lastErrorKind: 'application',
        idempotencyKey: null, gatewayRunId: null,
      } : {},
    });
    releaseClaim();
    notify(updated);
  } finally { releaseClaim(); running.delete(lockKey); controls.delete(lockKey); }
}

export async function runProjectPremiumReview(tenantId, projectId, notify = () => {}) {
  const lockKey = `${tenantId}:${projectId}`;
  if (running.has(lockKey)) throw new Error('quality gate già in esecuzione');
  running.add(lockKey);
  const control = { abort: new AbortController(), pauseRequested: false, preemptRequested: false, currentStepId: null };
  controls.set(lockKey, control);
  try {
    let project = getProject(tenantId, projectId);
    if (!project) throw new Error('progetto non trovato');
    if (project.status !== 'needs_premium_review') throw new Error('il progetto non attende un quality gate premium');

    // BATCH: il gate premium scorre in SEQUENZA tutti gli step accumulati in
    // coda dal worker economico (status 'needs_premium_review'), nell'ordine di
    // piano. Approvare N prima di N+1 e' sicuro con le dipendenze: se boccia lo
    // step N, invalido N+1..M e il runner riparte da N con il feedback.
    const queue = project.steps.filter((item) => item.status === 'needs_premium_review');
    if (queue.length === 0) throw new Error('nessuna task pronta per il quality gate premium');

    for (const step of queue) {
      // CONTROLLO PAUSA: se l'utente ha premuto Ferma durante il premium,
      // la pausa vince e non continua la coda.
      if (pauseIfRequested(tenantId, projectId, notify)) return;
      // Rilegge lo step fresco a ogni iterazione: dopo un eventuale reject non
      // si prosegue comunque la coda (break immediato), ma restare fedeli allo
      // stato su disco evita di approvare uno step ormai invalidato altrove.
      const fresh = getProject(tenantId, projectId);
      const current = fresh?.steps?.find((item) => item.id === step.id);
      if (!current || current.status !== 'needs_premium_review') continue;

      const workerText = String(current.execution?.output ?? '').trim();
      if (!workerText) throw new Error(`handoff worker mancante su ${current.label}: quality gate non avviabile`);
      const context = compileProjectContext(tenantId, projectId);
      const taskPack = buildDevelopmentTaskPack(context, current);
      // CONTROLLO PAUSA: prima di patchare in premium_quality_running.
      if (pauseIfRequested(tenantId, projectId, notify)) return;
      project = patchProjectExecution(tenantId, projectId, {
        project: { status: 'premium_quality_running', lifecycleStatus: 'needs_premium_review', error: null, nextRetryAt: null },
        stepId: current.id, step: { phase: 'premium_quality' },
      });
      notify(project);
      // Retry sul TRASPORTO del gate premium: il modello premium (es. fable-5)
      // puo' interrompere lo stream ("terminated") senza che sia un errore
      // applicativo. Ritentiamo con backoff breve invece di lasciare il progetto
      // bloccato in needs_premium_review per sempre (radice del blocco osservato).
      const premiumModel = project.qualityModel || project.defaultModel;
      const premiumSessionKey = `${current.execution?.sessionKey || `agent:main:dashboard:v2-${safeKey(tenantId)}-${safeKey(projectId)}-${safeKey(current.id)}`}-premium-qa`.toLowerCase();
      let quality;
      let premiumAttempts = 0;
      while (true) {
        premiumAttempts += 1;
        try {
          // CONTROLLO PAUSA: prima di ogni tentativo premium.
          if (control.pauseRequested) {
            const paused = patchProjectExecution(tenantId, projectId, { project: { status: 'paused', error: null, nextRetryAt: null, pausedAt: new Date().toISOString() } });
            notify(paused);
            return { project: paused, approved: false, paused: true };
          }
          quality = await gatewayAgentRunner({
            message: qualityPrompt(taskPack, workerText), model: premiumModel,
            sessionKey: premiumSessionKey, idempotencyKey: randomUUID(), thinking: 'high', signal: control.abort.signal,
            onAccepted: ({ runId }) => { const updated = patchProjectExecution(tenantId, projectId, { stepId: current.id, step: { premiumQualityGatewayRunId: runId } }); notify(updated); },
          });
          break;
        } catch (gateErr) {
          if (control.pauseRequested) {
            const paused = patchProjectExecution(tenantId, projectId, { project: { status: 'paused', error: null, nextRetryAt: null, pausedAt: new Date().toISOString() } });
            notify(paused);
            return { project: paused, approved: false, paused: true };
          }
          if (!isTransportError(gateErr) || premiumAttempts >= 3) throw gateErr;
          const delayMs = Math.min(RETRY_CFG.transportMaxMs, RETRY_CFG.transportBaseMs * (2 ** (premiumAttempts - 1)));
          project = patchProjectExecution(tenantId, projectId, {
            project: { status: 'premium_quality_running', lifecycleStatus: 'needs_premium_review', error: gateErr.message, nextRetryAt: new Date(Date.now() + delayMs).toISOString() },
            stepId: current.id, step: { phase: 'premium_quality_retry', error: gateErr.message },
          });
          notify(project);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      // CONTROLLO PAUSA: dopo la chiamata premium, prima di patchare il risultato.
      if (control.pauseRequested) {
        const paused = patchProjectExecution(tenantId, projectId, { project: { status: 'paused', error: null, nextRetryAt: null, pausedAt: new Date().toISOString() } });
        notify(paused);
        return { project: paused, approved: false, paused: true };
      }
      const gate = extractJson(quality.text, 'quality_gate') ?? { approved: false, score: 0, feedback: 'Quality gate senza risposta strutturata.' };
      const qualityUsage = normalizeUsage(quality.usage, quality.modelUsed);
      const workerUsage = current.execution?.usage?.worker ?? normalizeUsage(null, current.execution?.model);
      const handoff = buildTaskHandoff({ pack: taskPack, taskResult: current.execution?.result, worker: { modelUsed: workerUsage.model }, quality: gate, qualityOutput: quality.text, workerUsage, qualityUsage });

      if (gate.approved === true) {
        project = patchProjectExecution(tenantId, projectId, {
          project: { status: 'premium_quality_running', lifecycleStatus: 'needs_premium_review', error: null, nextRetryAt: null },
          stepId: current.id, step: { status: 'completed', phase: 'completed', quality: gate, qualityOutput: quality.text, handoff, usage: { worker: workerUsage, quality: qualityUsage }, completedAt: new Date().toISOString() },
        });
        addProjectMessage(tenantId, projectId, { role: 'assistant', text: `✅ **${current.label}** approvata dal quality gate premium.` }, 'v2-executor');
        notify(project);
        continue;
      }

      // REJECT: bocciato lo step N. Invalida N+1..M (costruiti sul suo output
      // ora rifiutato), riporta N ad 'active' in revisione e rimanda il progetto
      // all'esecuzione economica. Il feedback arriva al worker via
      // step.execution.quality.feedback. L'endpoint ri-triggera runProjectSerial.
      invalidateStepsAfter(tenantId, projectId, current.id);
      project = patchProjectExecution(tenantId, projectId, {
        project: { status: 'queued', lifecycleStatus: 'active', error: null, nextRetryAt: null },
        stepId: current.id, step: { status: 'active', phase: 'revision', quality: gate, qualityOutput: quality.text, handoff, usage: { worker: workerUsage, quality: qualityUsage } },
      });
      addProjectMessage(tenantId, projectId, { role: 'assistant', text: `↩️ **${current.label}** richiede una revisione: il worker riprende dal feedback del quality gate premium.` }, 'v2-executor');
      notify(project);
      return { project, approved: false };
    }

    // Tutta la coda approvata. Se restano step non-passati (pending/proposed,
    // tipico dei progetti VECCHI fermi con coda parziale: 1 step in coda e i
    // successivi mai eseguiti) riattiva UNO step e riporta il progetto ad
    // 'active', cosi' l'endpoint ri-triggera runProjectSerial. Senza il
    // lifecycleStatus 'active' qui il progetto restava bloccato in
    // 'needs_premium_review' (bug batch-v1).
    // Gli step approvati dal premium possono sbloccare task rinviate per
    // dipendenza: tornano 'pending' prima di decidere se il progetto e' finito.
    try { reactivateDependencyDeferredSteps(tenantId, projectId); } catch { /* best-effort */ }
    project = getProject(tenantId, projectId);
    const remaining = project?.steps?.find((item) => ['pending', 'proposed', 'needs_premium_review'].includes(item.status));
    if (remaining) {
      project = activateNextProjectStep(tenantId, projectId);
      project = patchProjectExecution(tenantId, projectId, {
        project: { status: 'queued', lifecycleStatus: 'active', error: null, nextRetryAt: null },
      });
      addProjectMessage(tenantId, projectId, { role: 'assistant', text: `▶️ Coda premium approvata, riprendo l'esecuzione degli step rimanenti.` }, 'v2-executor');
      notify(project);
      return { project, approved: true };
    }
    // Restano task rinviate in attesa di Owner: il progetto NON e' completato.
    // Va in attesa piena e libera la fila (flusso lineare); riprende con
    // priorita' alla risposta.
    const deferredLeft = project?.steps?.filter((item) => item.status === 'deferred') ?? [];
    if (deferredLeft.length > 0) {
      project = patchProjectExecution(tenantId, projectId, {
        project: { status: 'needs_input', lifecycleStatus: 'active', error: null, nextRetryAt: null, queueReason: null },
      });
      addProjectMessage(tenantId, projectId, { role: 'assistant', text: `⏸️ Quality gate premium concluso: restano ${deferredLeft.length} task in attesa di una tua risposta prima di poter chiudere il progetto.` }, 'v2-executor');
      notify(project);
      return { project, approved: true };
    }
    project = patchProjectExecution(tenantId, projectId, {
      project: { status: 'completed', lifecycleStatus: 'completed', error: null, nextRetryAt: null },
    });
    addProjectMessage(tenantId, projectId, { role: 'assistant', text: `🎯 Progetto completato: tutti gli step approvati dal quality gate premium.` }, 'v2-executor');
    notify(project);
    return { project, approved: true };
  } catch (err) {
    const project = getProject(tenantId, projectId);
    const step = project?.steps?.find((item) => item.status === 'needs_premium_review' || item.id === project.currentStepId);
    if (project && step) {
      // Sul trasporto programmiamo un retry automatico (nextRetryAt con backoff)
      // invece di lasciare il progetto fermo: recoverV2Projects ri-triggera il
      // gate quando il timer scade. Su errore applicativo nextRetryAt resta null.
      // Muro Claude anche sul gate premium: senza questo il progetto restava in
      // needs_premium_review con nextRetryAt null, quindi recoverV2Projects lo
      // ri-triggerava a ogni tick (20s) contro il muro fino al reset.
      if (isUsageLimitBanner(err.message)) {
        const resumeAt = usageLimitRetryAt(err.message);
        noteUsageLimit({ resumeAt, tenantId, agentId: `v2:${projectId}`, message: err.message });
        const limited = patchProjectExecution(tenantId, projectId, {
          project: {
            status: 'needs_premium_review', lifecycleStatus: 'needs_premium_review',
            error: err.message, nextRetryAt: resumeAt,
          },
          stepId: step.id,
          step: { status: 'needs_premium_review', phase: 'premium_quality_error', error: err.message, lastErrorKind: 'usage_limit' },
        });
        notify(limited);
        throw err;
      }
      const transport = isTransportError(err);
      const transportRecoveries = transport ? Number(project.execution?.transportRecoveryCount ?? 0) + 1 : 0;
      const delayMs = transport ? Math.min(RETRY_CFG.transportMaxMs, RETRY_CFG.transportBaseMs * (2 ** Math.min(transportRecoveries - 1, 4))) : 0;
      const updated = patchProjectExecution(tenantId, projectId, {
        project: {
          status: 'needs_premium_review', lifecycleStatus: 'needs_premium_review', error: err.message,
          nextRetryAt: transport ? new Date(Date.now() + delayMs).toISOString() : null,
          ...(transport ? { transportRecoveryCount: transportRecoveries } : {}),
        },
        stepId: step.id, step: { status: 'needs_premium_review', phase: 'premium_quality_error', error: err.message },
      });
      notify(updated);
    }
    throw err;
  } finally {
    running.delete(lockKey);
    controls.delete(lockKey);
  }
}

// Ripresa manuale di un progetto fallito in modo definitivo: riporta lo step
// fallito ad 'active' e il progetto ad 'active' con i contatori azzerati.
// Rifiuta progetti non 'failed' (niente doppie attivazioni).
export function resumeFailedProject(tenantId, projectId, updatedBy = 'v2-executor') {
  // Delega a setProjectResumedFromFailed: scrive project.status TOP-LEVEL
  // (patchProjectExecution non lo puo' fare), riporta lo step fallito ad
  // 'active' e azzera tutti i contatori. Rifiuta stati diversi da 'failed'.
  return setProjectResumedFromFailed(tenantId, projectId, updatedBy);
}

export function recoverV2Projects(tenantIds, notify) {
  // Muro Claude attivo: nessun ri-trigger AUTOMATICO nella finestra (stessa
  // guardia di watchdogTick/drainQueue lato V1). Ripartirebbero solo per
  // rimorire sul muro e bruciare i primi token del reset. I resume espliciti
  // via API restano possibili. Al reset isRateLimited() torna false da solo e
  // il tick riprende la coda.
  if (isRateLimited()) return;
  // RINVIO INPUT SCADUTI (flusso lineare 2026-08-29): le task ferme su una
  // domanda a Owner oltre la finestra INPUT_DEFER_MS vengono rinviate e il
  // progetto prosegue con la task successiva; se non resta nulla di eseguibile
  // il progetto libera la fila e parte il successivo.
  if (INPUT_DEFER_MS > 0) {
    for (const item of listInputWaitingProjects(tenantIds)) {
      try {
        const { deferred, hasRunnableNext, project } = deferOverdueInputSteps(item.tenantId, item.projectId, { olderThanMs: INPUT_DEFER_MS });
        if (!deferred.length) continue;
        const labels = deferred.map((entry) => `“${entry.label}”`).join(', ');
        const minutes = Math.max(1, Math.round(INPUT_DEFER_MS / 60_000));
        addProjectMessage(item.tenantId, item.projectId, {
          role: 'assistant',
          text: hasRunnableNext
            ? `⏭️ Nessuna risposta da ${minutes} min su ${labels}: non perdo tempo, proseguo con la task successiva. Appena rispondi, metto in pausa il lavoro successivo e riprendo da lì.`
            : `⏸️ ${labels} in attesa della tua risposta e nessun'altra task eseguibile: la fila passa al progetto successivo. Appena rispondi, questo progetto riprende con priorità.`,
        }, 'v2-executor');
        notify(item.tenantId, project);
        if (hasRunnableNext) runProjectSerial(item.tenantId, item.projectId, (updated) => notify(item.tenantId, updated));
      } catch { /* best-effort: riprova al prossimo tick */ }
    }
  }
  // RIPRESA AUTOMATICA dei progetti messi in pausa dalla preemption (precedenza
  // a un progetto prima in fila): quando quel progetto non tiene piu' la fila,
  // ripartono da soli dal punto esatto (step resumedFromPause -> riaggancio).
  for (const item of listPreemptedProjects(tenantIds)) {
    try {
      if (LINEAR_PROJECT_QUEUE && findBlockingEarlierProject(item.tenantId, item.projectId)) continue;
      const cleared = patchProjectExecution(item.tenantId, item.projectId, {
        project: { status: 'queued', error: null, nextRetryAt: null, pausedReason: null, preemptedByProjectId: null, pausedAt: null, pausedBy: null, queueReason: 'ripresa automatica dopo la precedenza' },
      });
      notify(item.tenantId, cleared);
      if (item.lifecycle === 'needs_premium_review') {
        runProjectPremiumReview(item.tenantId, item.projectId, (updated) => notify(item.tenantId, updated))
          .catch(() => { /* errore gia' gestito dentro runProjectPremiumReview */ });
      } else {
        runProjectSerial(item.tenantId, item.projectId, (updated) => notify(item.tenantId, updated));
      }
    } catch { /* best-effort: riprova al prossimo tick */ }
  }
  for (const item of listRecoverableProjects(tenantIds)) {
    const project = getProject(item.tenantId, item.projectId);
    if (project?.execution?.nextRetryAt && Date.parse(project.execution.nextRetryAt) > Date.now()) continue;
    runProjectSerial(item.tenantId, item.projectId, (updated) => notify(item.tenantId, updated));
  }
  // Recovery dei progetti in coda premium (batch deferred) morti su trasporto:
  // senza questo, un errore di trasporto durante il gate (es. stream "terminated"
  // su fable-5) lasciava il progetto bloccato in needs_premium_review per sempre,
  // perche' runProjectSerial non riparte da quello stato e nessuno ri-triggerava
  // il gate. Qui ri-triggeriamo runProjectPremiumReview quando il backoff scade.
  for (const item of listPremiumReviewProjects(tenantIds)) {
    const project = getProject(item.tenantId, item.projectId);
    if (project?.execution?.nextRetryAt && Date.parse(project.execution.nextRetryAt) > Date.now()) continue;
    runProjectPremiumReview(item.tenantId, item.projectId, (updated) => notify(item.tenantId, updated))
      .catch(() => { /* errore gia' loggato dentro runProjectPremiumReview */ });
  }
}
