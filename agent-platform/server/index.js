import express from 'express';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs';
import { execFileSync, spawn } from 'child_process';
import { randomBytes, timingSafeEqual } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { readJson, writeJson, DATA_DIR, CONFIG_DIR } from './lib/store.js';
import {
  ensureSeedAdmin, findUser, verifyPassword, hashPassword, signToken,
  authMiddleware, requireRole, requireTenant, userCanTenant, userCanAgent,
  publicUser, loadUsers, saveUsers, ROLES, verifyToken,
} from './lib/auth.js';
import { logAudit, taskReviewNotes } from './lib/audit.js';
import {
  migrateFlatHistory, loadHistory, appendHistory,
  archiveConversation, listArchived, getArchived,
} from './lib/history.js';
import {
  listConversations, getConversation, createConversation,
  appendMessage as appendConversationMessage, deleteConversation, importConversations,
} from './lib/conversations.js';
import {
  enqueueMessage, listQueued, queueDepth, cancelQueued, drainQueued, listNonEmptyQueues,
} from './lib/messagequeue.js';
import {
  listTasks, createTask, updateTask, setTaskChangeListener,
  buildTasksMcpServer, TASKS_MCP_TOOLS, completedTasksReport, normalizeAssignee,
  countDispatchExhausted, openBlockers,
  DEFAULT_RESULT_TYPE, DEFAULT_RISK_LEVEL,
} from './lib/tasks.js';
import { listArtifacts, getArtifactContent, setArtifactStatus } from './lib/artifacts.js';
import {
  getOperatingSystemOverview, getProject, compileProjectContext, runBrandLint,
  createProject, addProjectMessage, updateProjectStep, applyProjectArchitectSpec,
  activateCustomProject, setProjectArchived,
  configureProjectModels, configureProjectNotificationPolicy, configureReportModel,
  createBrandVersion, activateBrandVersion, addDataSignals, runAutopilot,
  convertOpportunityToProject, createOperatingApproval, resolveOperatingApproval,
  getReportDefinition, createReportDefinition, addReportDefinitionMessage, applyReportDesignerSpec,
  activateReportDefinition, setReportDefinitionArchived, generateReportFromDefinition, runDueReportDefinitions,
  createReusableSkill, updateReusableSkill, setProjectSkills, resolveProjectInput, convertReportToProject,
  markProjectNotificationSent, setProjectArchitectBusy, clearStaleArchitectBusy, clearStaleProjectStepDispatchClaims,
  resumePausedProject, setProjectQueueOrder, setProjectGroup,
} from './lib/operating-system.js';
import { getOpenClawModels, runOpenClawAgent } from './lib/openclaw-gateway.js';
import { memoryAvailable, runAgentWithMemory, stripMemoryToolTags, ARCHITECT_MEMORY_INSTRUCTIONS } from './lib/v2-memory.js';
import { webSearchAvailable, runWebToolCalls, stripWebToolTags, ARCHITECT_WEB_INSTRUCTIONS } from './lib/v2-web.js';
import { onProjectInputResolved, recoverV2Projects, requestProjectPause, resumeFailedProject, runProjectPremiumReview, runProjectSerial } from './lib/v2-executor.js';
import { contextGraphStats, queryContextGraph } from './lib/context-graph.js';
import { getV2ProjectPushCandidate } from './lib/v2-project-push.js';
import {
  listThreads, getThread, listThreadsForTenant, resumeThread, addOwnerMessage, stopThread,
} from './lib/ceomail.js';
import {
  touchSession, pushSessionEvent, listSessions as listAgentSessions,
  initWebSocket, broadcast, broadcastWhere,
} from './lib/status.js';
import { transcriptionStatus, transcribe } from './lib/transcribe.js';
import {
  vapidPublicKey, addSubscription, removeSubscription, notifyTenant, LONG_RUN_THRESHOLD_MS,
} from './lib/push.js';
import * as autoRestart from './lib/autorestart.js';
import {
  listApprovals, resolveApproval, buildCanUseTool, setApprovalListener,
} from './lib/approvals.js';
import {
  listTenantDecisions, answerTaskDecision, listNeedsInputTasks,
} from './lib/decisions.js';
import {
  listBlockedTasks, retryBlockedTask,
} from './lib/blocked.js';
import {
  recordActivityEvent, listActivity, unreadActivityCount, markActivityRead,
  markAllActivityRead, stashDeliveryNote, takeDeliveryNote, classifyNeedsInput,
} from './lib/activity.js';
import { listTaskMessages, addTaskMessage } from './lib/taskchat.js';
import {
  listSchedules, createSchedule, updateSchedule, deleteSchedule, startScheduler,
  registerSystemJob, listSystemJobs, runSystemJobNow,
} from './lib/scheduler.js';
import {
  registerAgentJob, listAgentJobs, updateAgentJob,
} from './lib/agentjobs.js';
import { runBackup, runBackupSync } from './lib/backup.js';
import {
  journalStart, journalUpdate, journalHeartbeat, journalTimeout,
  journalStop, journalPause, journalManualResume, getRun, listRuns, isActiveNow,
  setRunChangeListener, journalRegisterExternal, summarizeRunTitle,
  HEARTBEAT_MS, STALE_HEARTBEAT_MS, RUN_WALLCLOCK_TIMEOUT_MS, recoverOnBoot, countOomFailures24h,
  touchedFilesForTask,
} from './lib/runs.js';
import { RUNNING_STATES, isStickyStatus } from './lib/runstates.js';
import {
  getBudgetState, budgetPolicy,
} from './lib/budget.js';
import { getWeeklyBudgetState } from './lib/weeklybudget.js';
import { resumeDecision } from './lib/runstates.js';
import { watchdogTick } from './lib/watchdog.js';
import { dispatcherTick } from './lib/dispatcher.js';
import { boardCheckTick, boardCheckHealth, requestBoardCheck } from './lib/boardcheck.js';
import { runDigest } from './lib/digest.js';
import { runCodeQuality, PLATFORM_TENANT as CQ_TENANT, CODE_QUALITY_AGENT, focusForDay } from './lib/codequality.js';
import { runPmPlatform, PLATFORM_TENANT as PM_TENANT, PM_PLATFORM_AGENT } from './lib/pmplatform.js';
import { runAutoRecover } from './lib/autorecover.js';
import { listPendingActivation, runObsoleteAskSweep } from './lib/pendingactivation.js';
import { resolveModel } from './lib/models.js';
import {
  saveUpload, resolveUpload, mimeForStored,
  isAllowedType, allowedTypesList, normalizeMime,
  MAX_UPLOAD_BYTES,
} from './lib/uploads.js';
import { buildAttachmentContent } from './lib/v2-content.js';
import {
  listPreviews, getPreview, resolvePreviewFile, mimeForEntry, renderIndexHtml, renderMarkdownDeliverable,
  previewLinksForTask, formatPreviewLinks,
} from './lib/previews.js';
import {
  getAutonomySettings, setAutonomySettings, AUTONOMY_MIN, AUTONOMY_MAX, AUTONOMY_FACTORY_DEFAULT,
} from './lib/settings.js';
import {
  getGlobalCap, setGlobalCap, GLOBAL_CAP_MIN, GLOBAL_CAP_MAX, GLOBAL_CAP_FACTORY_DEFAULT,
  activeAgentCount, queueSnapshot, drainQueue, setCapChangeListener, setQueueChangeListener,
  memoryView, activeSubAgentCount, subAgentEndRun, admissionBlockReason, BLOCK_REASON_LABELS,
  dropQueuedForTenant,
} from './lib/concurrency.js';
import {
  getLimitState, clearRateLimit, setRateLimitChangeListener,
} from './lib/ratelimit.js';
import {
  isPlatformPaused, getPlatformPauseState, pausePlatform, resumePlatform,
  setPlatformPauseChangeListener,
} from './lib/platformpause.js';
import {
  isTenantBlocked, getTenantBlockState, blockTenant, unblockTenant,
} from './lib/tenantblock.js';
import {
  ensureWikiRepo, listPages as listWikiPages, readPage as readWikiPage,
  writePage as writeWikiPage, pageHistory as wikiPageHistory, rollbackPage as rollbackWikiPage,
  WIKI_MCP_TOOLS, wordCount,
} from './lib/wiki.js';
// Turno agente (task 829e29c2): estratto da index.js in server/lib/runturn/
// (prompt/system-prompt, tool/permessi, streaming SDK, persistenza esito) —
// runAgentTurnInner qui sotto resta un thin orchestrator dei 4 helper.
import { ingestIncomingMessages, buildSystemPrompt, buildTurnPreamble } from './lib/runturn/prompt.js';
import { resolveTurnAccess } from './lib/runturn/access.js';
import { streamTurn } from './lib/runturn/stream.js';
import { finalizeTurn } from './lib/runturn/finalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Radice del repo (=/app): base per risolvere path relativi di config, es. il
// campo "knowledge" di un agente ("knowledge/<tenant>" → /app/knowledge/<tenant>).
const REPO_ROOT = dirname(__dirname);

// Seam di test (bug 2671cc26): in produzione si usa sempre il query dell'SDK.
// Solo se CHAT_QUERY_MOCK punta a un modulo, si sostituisce l'implementazione —
// così il regression test può simulare in modo deterministico (senza consumare
// la subscription) il result vuoto "no-op" al resume e verificare il reinvio
// automatico. Fuori dai test la variabile non è mai settata: comportamento reale.
let query = sdkQuery;
if (process.env.CHAT_QUERY_MOCK) {
  const mock = await import(process.env.CHAT_QUERY_MOCK);
  query = mock.query ?? mock.default;
  console.warn(`[test] query SDK sostituito dal mock ${process.env.CHAT_QUERY_MOCK}`);
}

const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');

const tenantsConfig = JSON.parse(readFileSync(join(CONFIG_DIR, 'tenants.json'), 'utf8'));
const platformConfig = readJson(join(CONFIG_DIR, 'platform.json'), {});
const V2_EXCLUSIVE_MODE = platformConfig?.operatingSystemV2?.exclusive === true;

ensureSeedAdmin();
migrateFlatHistory();

// Wiki di conoscenza per tenant: repo git dedicato inizializzato con le pagine
// di default al primo avvio (idempotente sui riavvii successivi).
for (const t of tenantsConfig.tenants) ensureWikiRepo(t);

// Recovery al boot: le run rimaste "running" nel journal (server morto a metà)
// diventano "interrupted"; il watchdog le riprenderà appena maturano il retry.
const recovered = recoverOnBoot();
if (recovered > 0 && !V2_EXCLUSIVE_MODE) console.log(`[recovery] ${recovered} run interrotte dal riavvio, il watchdog le riprenderà`);
if (V2_EXCLUSIVE_MODE) console.log('[runtime] Operating System V2 exclusive: UI e automazioni agentiche V1 disattivate');

// Auth Claude: token subscription Max letto dalla config OpenClaw (nessuna ANTHROPIC_API_KEY).
function loadOauthToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const cfg = JSON.parse(readFileSync(join(process.env.HOME, '.openclaw', 'openclaw.json'), 'utf8'));
    return cfg?.agents?.defaults?.cliBackends?.['claude-cli']?.env?.CLAUDE_CODE_OAUTH_TOKEN ?? null;
  } catch {
    return null;
  }
}
const OAUTH_TOKEN = loadOauthToken();
if (!OAUTH_TOKEN) {
  console.warn('[warn] Nessun CLAUDE_CODE_OAUTH_TOKEN trovato (env o ~/.openclaw/openclaw.json): le chat falliranno con "Not logged in".');
}

// Mappa (tenant:agent:session UI) -> session_id Claude, persistita su disco per il resume.
let sessionMap = readJson(SESSIONS_FILE, {});

function extractProjectArchitectSpec(text) {
  const match = String(text ?? '').match(/<project_spec>\s*([\s\S]*?)\s*<\/project_spec>/i);
  if (!match) return { text: String(text ?? '').trim(), spec: null };
  try {
    return {
      text: String(text).replace(match[0], '').trim(),
      spec: JSON.parse(match[1]),
    };
  } catch {
    return { text: String(text).replace(match[0], '').trim(), spec: null };
  }
}

// ---- Memoria OpenClaw in sola lettura per il Project Architect (task C1) ----
// L'endpoint /v1/chat/completions del Gateway non fa tool-calling server-side,
// quindi il loop e' implementato in lib/v2-memory.js (runAgentWithMemory):
// l'Architect chiede letture con tag nel testo, il server le esegue (solo
// lettura, solo memory/*.md) e rilancia il turno con gli estratti citati
// (percorso + righe). Max 3 round, cosi' una richiesta patologica non puo'
// girare all'infinito.

async function runProjectArchitectTurn(tenantId, projectId, userText, username, attachments = []) {
  const project = getProject(tenantId, projectId);
  if (!project) throw new Error('progetto non trovato');
  const tenant = tenantsConfig.tenants.find((item) => item.id === tenantId);
  // L'Architect e' il cervello di PIANIFICAZIONE: non deve girare sul worker
  // economico del progetto (visto live 2026-08-29: kimi/k3 come defaultModel
  // -> architect prima in errore thinking, poi risposta vuota). Usa il
  // modello premium del progetto (qualityModel), col worker come ripiego.
  const model = project.qualityModel || project.defaultModel || getOpenClawModels().defaultModel;
  const context = compileProjectContext(tenantId, projectId);
  const memoryBlock = memoryAvailable() ? ARCHITECT_MEMORY_INSTRUCTIONS : '';
  // Task D1 — ricerca web read-only: attiva solo se il provider e' configurato
  // (TAVILY_API_KEY o platform.json webSearch.apiKey). Senza chiave il blocco
  // resta spento, cosi' l'Architect non promette una capacita' che non ha.
  const webBlock = webSearchAvailable() ? ARCHITECT_WEB_INSTRUCTIONS : '';
  // Task B2 — pipeline contenuto: l'Architect gira via /v1/chat/completions e
  // NON ha il tool Read. Il server estrae qui il contenuto degli allegati
  // (PDF/testo -> estratto testuale con pdfjs-dist locale, immagini -> parti
  // image_url visive) e passa solo estratti, mai file interi.
  const { block: attachmentBlock, images: attachmentImages } = await buildAttachmentContent(attachments);
  const basePrompt = `Sei il Project Architect di ${tenant?.name ?? tenantId}. Devi trasformare una conversazione naturale in un progetto eseguibile ad altissima qualità.

REGOLE:
- Non eseguire il lavoro e non usare tool di scrittura. In questa fase fai discovery e pianificazione.
- Fai una sola domanda mirata per volta, massimo due solo se strettamente collegate.
- Non imporre workflow preconfezionati. Le task devono nascere dall'obiettivo reale.
- Comprendi e aggiorna: risultato finale, pubblico, deliverable, fonti/context, vincoli, scadenza, criteri di successo, autonomia e permessi.
- Distingui azioni autonome, azioni reversibili e azioni che richiedono approvazione.
- Se mancano informazioni ad alto impatto, chiedile prima di dichiarare il piano pronto.
- ESECUZIONE LINEARE E AUTONOMA: i progetti attivati girano in fila, una task alla volta, e Owner può essere assente per ore. Quindi in discovery raccogli ORA tutte le decisioni, i dati, gli accessi e i vincoli che le task richiederanno: una task che a metà esecuzione deve chiedere qualcosa a Owner è un difetto di pianificazione. Progetta le task il più possibile indipendenti tra loro (se una si ferma, le successive devono poter proseguire) e ordina per prime quelle che sbloccano le altre. Non dichiarare ready un piano che dipende da decisioni non ancora prese.
- Se il progetto è già attivo, interpreta il messaggio come correzione e aggiorna solo ciò che serve.
- Mantieni le task completate già presenti, salvo richiesta esplicita dell'utente.
- Rispondi in italiano, diretto e concreto.${memoryBlock}${webBlock}

Alla fine aggiungi SEMPRE un blocco JSON valido, invisibile all'utente dopo il salvataggio:
<project_spec>{"ready":false,"title":"","objective":"","summary":"","brief":{"audience":"","deliverables":[],"contextNeeded":[],"constraints":[],"deadline":""},"permissions":{"autonomyLevel":"L1","allowedActions":[],"approvalRequired":[],"availableSystems":[]},"successCriteria":[],"tasks":[{"id":"task_slug","label":"","description":"","owner":"system","approvalRequired":false,"status":"proposed"}]}</project_spec>

Imposta ready=true solo quando obiettivo, deliverable, vincoli/permessi essenziali e piano task sono abbastanza chiari da poter essere approvati.

STATO CORRENTE:
${JSON.stringify(context)}

ULTIMO MESSAGGIO DI OWNER:
${userText}${attachmentBlock}`;

  const sessionKey = `agent:main:dashboard:v2-architect-${tenantId}-${projectId}`;
  const { text: fullText, toolLog } = await runAgentWithMemory({
    basePrompt,
    runAgent: async (message) => {
      try {
        const gatewayResult = await runOpenClawAgent({ message, images: attachmentImages, model, sessionKey, idempotencyKey: randomBytes(16).toString('hex'), thinking: 'high' });
        return gatewayResult.text;
      } catch (err) {
        if (!/risposta vuota/i.test(String(err?.message ?? ''))) throw err;
        // Sessione Architect avvelenata (visto 3 volte il 2026-08-29): un turno
        // morto a meta' (crash/restart/errore modello) lascia la sessione CLI
        // che risponde VUOTO per sempre e ogni messaggio successivo muore.
        // Un solo retry su sessione fresca: il prompt e' autosufficiente
        // (stato completo del progetto dentro basePrompt), non serve la
        // cronologia della sessione.
        const freshSessionKey = `${sessionKey}-r${Date.now().toString(36)}`;
        const retry = await runOpenClawAgent({ message, images: attachmentImages, model, sessionKey: freshSessionKey, idempotencyKey: randomBytes(16).toString('hex'), thinking: 'high' });
        return retry.text;
      }
    },
    // I tag web girano nello STESSO loop dei tag memoria (un solo giro di
    // riprompt anche quando l'Architect usa entrambi).
    extraToolRunners: webSearchAvailable() ? [(text) => runWebToolCalls(text)] : [],
    buildFollowUp: ({ basePrompt: base, resultsBlock }) => `${base}\n\nRISULTATI DELLE LETTURE CHE HAI RICHIESTO (sola lettura, gia' eseguite dal server: memoria e/o web):\n${resultsBlock}\n\nOra rispondi a Owner in italiano citando la fonte di ogni fatto: "Source: percorso#Lriga" per la memoria, "Fonte verificata: URL" per il web. Cio' che deduci tu va marcato come "ragionamento:" e senza link. Se ti serve un altro estratto puoi fare un'altra ricerca, altrimenti chiudi con la risposta e il blocco project_spec.`,
  });
  const parsed = extractProjectArchitectSpec(stripWebToolTags(stripMemoryToolTags(fullText)));
  addProjectMessage(tenantId, projectId, { role: 'assistant', text: parsed.text || 'Ho aggiornato il progetto. Dimmi cosa vuoi correggere.' }, 'project-architect');
  if (parsed.spec) applyProjectArchitectSpec(tenantId, projectId, parsed.spec, 'project-architect');
  logAudit({ user: username, tenant: tenantId, event: 'v2_project_architect_turn', detail: {
    projectId,
    ready: Boolean(parsed.spec?.ready),
    memoryReads: toolLog.filter((c) => c.tool?.startsWith('memory_')).length,
    webCalls: toolLog.filter((c) => c.tool?.startsWith('web_')).length,
  } });
  return getProject(tenantId, projectId);
}


function extractReportDesignerSpec(text) {
  const match = String(text ?? '').match(/<report_spec>\s*([\s\S]*?)\s*<\/report_spec>/i);
  if (!match) return { text: String(text ?? '').trim(), spec: null };
  try {
    return { text: String(text).replace(match[0], '').trim(), spec: JSON.parse(match[1]) };
  } catch {
    return { text: String(text).replace(match[0], '').trim(), spec: null };
  }
}

async function runReportDesignerTurn(tenantId, definitionId, userText, username) {
  const definition = getReportDefinition(tenantId, definitionId);
  if (!definition) throw new Error('definizione report non trovata');
  const tenant = tenantsConfig.tenants.find((item) => item.id === tenantId);
  const ceo = tenant?.agents?.find((agent) => agent.role === 'CEO');
  const model = definition.model || getOpenClawModels().defaultModel;
  const overview = getOperatingSystemOverview(tenantId);
  const compactDefinition = {
    title: definition.title, purpose: definition.purpose, status: definition.status,
    audience: definition.audience, dataSources: definition.dataSources, kpis: definition.kpis,
    permissions: definition.permissions, schedule: definition.schedule, layout: definition.layout,
    delivery: definition.delivery, facsimile: definition.facsimile,
    recentMessages: definition.messages.slice(-14),
    availableSignals: overview.signalCatalog,
    availableReportHistoryCount: overview.reports.length,
  };
  const sharedContext = queryContextGraph(`${userText} ${definition.title} ${definition.purpose}`, { tenantId, limit: 8, maxChars: 6500 }).text;
  const prompt = `Sei il Report Designer di ${tenant?.name ?? tenantId}. Devi progettare con Owner un report ricorrente realmente utile per prendere decisioni.

REGOLE:
- Non inventare dati, accessi o KPI disponibili.
- Fai una sola domanda mirata per volta, massimo due se strettamente collegate.
- Chiarisci prima: decisione supportata, destinatario, frequenza, periodo confrontato e livello di dettaglio.
- Poi definisci KPI essenziali con formula/logica, dimensioni, target e motivo. Evita vanity metrics.
- Identifica fonti dati e permessi necessari: sola lettura, scrittura, dati personali, approvazioni e limiti.
- Proponi una impaginazione stabile e un facsimile Markdown realistico con placeholder [DATO NON COLLEGATO] quando manca la fonte.
- Distingui il report dal progetto operativo: il report osserva, spiega e propone. Non modifica budget o sistemi senza approvazione.
- ready=true solo quando frequenza, KPI, fonti/permessi e facsimile sono abbastanza chiari da essere approvati.
- Rispondi in italiano, diretto e concreto.

Alla fine aggiungi SEMPRE JSON valido:
<report_spec>{"ready":false,"title":"","purpose":"","audience":"Owner","dataSources":[],"permissions":{"read":[],"write":[],"approvalRequired":[],"personalData":false},"schedule":{"cadence":"weekly","timezone":"Europe/Rome","hour":8,"weekday":1,"dayOfMonth":1},"kpis":[{"id":"revenue","metric":"revenue","label":"Revenue","dimension":"all","unit":"€","target":null,"rationale":""}],"layout":{"title":"","sections":["Executive summary","KPI","Decisioni","Qualità dati"]},"delivery":{"channel":"platform","requiresApproval":false},"facsimile":"# Titolo\\n\\n## Executive summary\\n..."}</report_spec>

CONTESTO CONDIVISO OPENCLAW + V1 + V2:
${sharedContext || '(nessun nodo pertinente ancora)'}

STATO CORRENTE:
${JSON.stringify(compactDefinition)}

ULTIMO MESSAGGIO DI OWNER:
${userText}`;

  const gatewayResult = await runOpenClawAgent({ message: prompt, model, sessionKey: `agent:main:dashboard:v2-report-${tenantId}-${definitionId}`, idempotencyKey: randomBytes(16).toString('hex'), thinking: 'high' });
  const fullText = gatewayResult.text;
  if (!fullText.trim()) throw new Error('Report Designer non ha prodotto una risposta');
  const parsed = extractReportDesignerSpec(fullText);
  addReportDefinitionMessage(tenantId, definitionId, { role: 'assistant', text: parsed.text || 'Ho aggiornato il report. Dimmi cosa vuoi correggere.' }, 'report-designer');
  if (parsed.spec) applyReportDesignerSpec(tenantId, definitionId, parsed.spec, 'report-designer');
  logAudit({ user: username, tenant: tenantId, event: 'v2_report_designer_turn', detail: { definitionId, ready: Boolean(parsed.spec?.ready) } });
  return getReportDefinition(tenantId, definitionId);
}
const saveSessionMap = () => writeJson(SESSIONS_FILE, sessionMap);

// Un solo messaggio in lavorazione per conversazione: i successivi si accodano in ordine.
// NB: la coda salvata nella mappa DEVE assorbire i reject (catch), altrimenti
// ogni run fallita (o fermata) lascia una promise rigettata senza handler e
// Node termina l'intero processo (unhandled rejection).
const queues = new Map();
function withLock(key, fn) {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {}).finally(() => { if (queues.get(key) === tail) queues.delete(key); });
  queues.set(key, tail);
  return next;
}

function findAgent(tenantId, agentId) {
  const tenant = tenantsConfig.tenants.find((t) => t.id === tenantId);
  const agent = tenant?.agents.find((a) => a.id === agentId);
  return { tenant, agent };
}

// Interlocutori di chat diretti: SOLO i CEO (decisione di Owner, task 68bd24a2).
// Gli altri agenti restano definiti in tenants.json e continuano a lavorare via
// task board / dispatcher, ma non sono contattabili in chat: il CEO riceve gli
// obiettivi e smista internamente delegando con create_task(assignedTo). È un
// filtro di visibilità/routing sulla CHAT, non una rimozione: gli altri agenti
// restano visibili in Agenti live, board task e journal.
function isChatInterlocutor(agent) {
  return agent.role === 'CEO';
}

// Rete di sicurezza globale: senza questi handler, UNA promise rifiutata o
// un'eccezione sincrona sfuggita in un timer/callback fuori da un handler
// Express (scheduler, WS, job in background) fa crashare l'intero processo —
// blast radius su TUTTI i tenant, non solo quello coinvolto (nessun handler
// del genere esisteva: audit 2026-08-22). unhandledRejection viene solo
// loggato (l'origine resta isolata, il resto del server continua a servire);
// uncaughtException è per definizione uno stato non affidabile: lo logghiamo
// e usciamo, la restart-policy Docker (unless-stopped) risolleva il processo.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
  logAudit({ user: 'system', event: 'unhandled_rejection', detail: { message: reason?.message ?? String(reason) } });
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  try { logAudit({ user: 'system', event: 'uncaught_exception', detail: { message: err?.message ?? String(err) } }); } catch {}
  process.exit(1);
});

const app = express();
app.use(express.json({ limit: '1mb' }));

function requireLegacyRuntime(req, res, next) {
  if (!V2_EXCLUSIVE_MODE) return next();
  return res.status(410).json({
    error: 'runtime V1 disattivato: usa Operating System V2',
    runtime: 'v2-exclusive',
  });
}

// ---- Login con rate limit in-memory (10 tentativi falliti / 15 min per IP) ----
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
function loginLimited(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec || Date.now() - rec.first > LOGIN_WINDOW_MS) return false;
  return rec.fails >= LOGIN_MAX_FAILS;
}
function recordLoginFail(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec || Date.now() - rec.first > LOGIN_WINDOW_MS) loginAttempts.set(ip, { first: Date.now(), fails: 1 });
  else rec.fails += 1;
}

app.post('/api/login', (req, res) => {
  const ip = req.ip ?? 'unknown';
  if (loginLimited(ip)) return res.status(429).json({ error: 'troppi tentativi, riprova tra qualche minuto' });
  const { username, password } = req.body ?? {};
  const user = findUser(String(username ?? '').trim());
  if (!user || !verifyPassword(String(password ?? ''), user.passwordHash)) {
    recordLoginFail(ip);
    logAudit({ user: username ?? null, event: 'login_fail' });
    return res.status(401).json({ error: 'credenziali errate' });
  }
  loginAttempts.delete(ip);
  logAudit({ user: user.username, event: 'login_ok' });
  res.json({ token: signToken(user.username), user: publicUser(user) });
});

// ---- Chiave di registrazione run esterne (governance) ----
// Processi/agenti lanciati fuori da runAgentTurn (es. via Bash dagli agenti dev)
// si registrano nel journal con POST /api/runs/register autenticandosi con
// questa chiave locale (data/agent-registration.key, generata al primo avvio,
// leggibile solo dai processi sulla macchina). In alternativa vale un normale
// token utente Bearer.
const AGENT_KEY_FILE = join(DATA_DIR, 'agent-registration.key');
function loadAgentKey() {
  if (existsSync(AGENT_KEY_FILE)) return readFileSync(AGENT_KEY_FILE, 'utf8').trim();
  const key = randomBytes(24).toString('hex');
  writeFileSync(AGENT_KEY_FILE, key, { mode: 0o600 });
  console.log(`[runs] Chiave di registrazione agenti esterni generata in ${AGENT_KEY_FILE}`);
  return key;
}
const AGENT_KEY = loadAgentKey();
function validAgentKey(candidate) {
  if (!candidate || !AGENT_KEY) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(AGENT_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}
// Solo gli endpoint di registrazione accettano la chiave agente al posto del token.
const AGENT_KEY_PATHS = /^\/runs\/(register|[0-9a-f-]{36}\/(heartbeat|complete))$/;

// Tutte le altre /api richiedono token valido.
app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next();
  if (AGENT_KEY_PATHS.test(req.path) && validAgentKey(req.headers['x-agent-key'])) {
    // Pseudo-utente locale: pieni permessi SOLO su register/heartbeat/complete.
    req.user = { username: 'agent-external', role: 'manager', tenants: ['*'], agents: ['*'] };
    return next();
  }
  authMiddleware(req, res, next);
});

app.get('/api/me', (req, res) => res.json(publicUser(req.user)));

// ---- Gestione utenti (solo admin) ----
app.get('/api/users', requireRole('admin'), (req, res) => {
  res.json(loadUsers().map(publicUser));
});

app.post('/api/users', requireRole('admin'), (req, res) => {
  const { username, password, role, tenants = [], agents = [] } = req.body ?? {};
  const name = String(username ?? '').trim();
  if (!name || !password) return res.status(400).json({ error: 'username e password richiesti' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role deve essere uno di: ${ROLES.join(', ')}` });
  if (findUser(name)) return res.status(409).json({ error: 'utente già esistente' });
  const users = loadUsers();
  users.push({
    username: name,
    passwordHash: hashPassword(String(password)),
    role,
    tenants,
    agents,
    createdAt: new Date().toISOString(),
  });
  saveUsers(users);
  logAudit({ user: req.user.username, event: 'user_created', detail: { username: name, role } });
  res.status(201).json({ ok: true });
});

app.patch('/api/users/:username', requireRole('admin'), (req, res) => {
  const users = loadUsers();
  const user = users.find((u) => u.username === req.params.username);
  if (!user) return res.status(404).json({ error: 'utente non trovato' });
  const { password, role, tenants, agents } = req.body ?? {};
  if (role !== undefined) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'role non valido' });
    user.role = role;
  }
  if (password !== undefined) user.passwordHash = hashPassword(String(password));
  if (tenants !== undefined) user.tenants = tenants;
  if (agents !== undefined) user.agents = agents;
  saveUsers(users);
  logAudit({ user: req.user.username, event: 'user_updated', detail: { username: user.username } });
  res.json({ ok: true });
});

// ---- Tenant e agenti: filtrati sui permessi dell'utente ----
app.get('/api/tenants', (req, res) => {
  res.json(tenantsConfig.tenants
    .filter((t) => userCanTenant(req.user, t.id))
    .map(({ id, name, description, color, icon, agents }) => ({
      id, name, description, color, icon,
      agentCount: agents.filter((a) => userCanAgent(req.user, id, a.id)).length,
      // Kill switch per-tenant (task 6116efe1): { blocked, blockedAt, blockedBy }.
      // La UI non deve poter bypassare: la verità è server-side, qui esposta in
      // sola lettura; il toggle è POST /api/tenants/:id/block|unblock (solo admin).
      blocked: getTenantBlockState(id),
    })));
});

// ?all=true restituisce anche gli agenti operativi (non interlocutori di chat):
// serve ai filtri di sola lettura (es. "Completate", task c918de5b) dove si
// vuole scegliere qualunque agente del tenant, non solo il CEO. Senza il
// parametro il comportamento resta quello storico (solo CEO), usato dalla
// selezione dell'interlocutore in chat: nessun impatto lì.
app.get('/api/tenants/:tenantId/agents', requireTenant, (req, res) => {
  const tenant = tenantsConfig.tenants.find((t) => t.id === req.tenantId);
  if (!tenant) return res.status(404).json({ error: 'tenant non trovato' });
  const includeAll = req.query.all === 'true';
  res.json(tenant.agents
    .filter((a) => userCanAgent(req.user, tenant.id, a.id))
    .filter((a) => includeAll || isChatInterlocutor(a))
    .map(({ id, role, name, model }) => ({ id, role, name, model })));
});

// Organigramma: gerarchia (managerId) + stato live per agente, per il tenant.
// Nessun elenco hardcoded: itera tenant.agents dalla config, così i nuovi
// agenti (es. code-quality, pm-platform) compaiono in automatico (task 60afee6e,
// parte 1/3 di 09c9e256 — la UI organigramma è la parte 2).
app.get('/api/tenants/:tenantId/organigramma', requireTenant, (req, res) => {
  const tenant = tenantsConfig.tenants.find((t) => t.id === req.tenantId);
  if (!tenant) return res.status(404).json({ error: 'tenant non trovato' });
  const runs = listRuns(tenant.id);
  const tasks = listTasks(tenant.id);
  res.json(tenant.agents
    .filter((a) => userCanAgent(req.user, tenant.id, a.id))
    .map((a) => {
      const agentRuns = runs.filter((r) => r.agentId === a.id);
      const inRun = agentRuns.some((r) => isActiveNow(r.id) || RUNNING_STATES.has(r.status));
      const lastRunRaw = agentRuns.slice().sort((x, y) => (x.startedAt < y.startedAt ? 1 : -1))[0];
      // normalizeAssignee normalizza sempre al formato 'agent:<id>' (mai l'id
      // nudo): confronto contro normalizeAssignee(a.id), non contro a.id.
      const openTasks = tasks.filter((t) => normalizeAssignee(t.assignedTo) === normalizeAssignee(a.id) && t.status !== 'done').length;
      return {
        id: a.id,
        name: a.name,
        role: a.role,
        managerId: a.managerId ?? null,
        model: a.model,
        readOnly: Boolean(a.readOnly),
        state: inRun ? 'in_run' : 'idle',
        openTasks,
        lastRun: lastRunRaw ? {
          runTitle: lastRunRaw.runTitle || summarizeRunTitle(lastRunRaw.prompt),
          status: lastRunRaw.status,
          startedAt: lastRunRaw.startedAt,
          updatedAt: lastRunRaw.updatedAt,
        } : null,
      };
    }));
});

// ---- Storico e archivio conversazioni ----
app.get('/api/history', requireTenant, (req, res) => {
  const { agentId, sessionId } = req.query;
  if (!agentId || !sessionId) return res.status(400).json({ error: 'agentId e sessionId richiesti' });
  if (!userCanAgent(req.user, req.tenantId, agentId)) return res.status(403).json({ error: 'agente non assegnato' });
  res.json(loadHistory(req.tenantId, agentId, sessionId));
});

// ---- Allegati file in chat (task 4f7337df) ----
// Upload: un file per richiesta come body raw (niente multipart/dipendenze). Il
// content-type della richiesta è il MIME del file; nome originale in header
// X-Filename o ?filename=. Salvataggio per tenant in data/uploads/<tenantId>/.
const rawUpload = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });
app.post('/api/uploads', requireTenant, (req, res) => {
  rawUpload(req, res, (err) => {
    if (err) {
      // Superata la soglia: errore pulito (mostrato in UI), non un 500 opaco.
      if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
        return res.status(413).json({ error: 'file troppo grande (max 20MB)' });
      }
      return res.status(400).json({ error: 'upload non valido' });
    }
    const mime = normalizeMime(req.get('content-type'));
    const originalName = req.get('x-filename')
      ? decodeURIComponent(req.get('x-filename'))
      : (req.query.filename ?? '');
    if (!isAllowedType(mime)) {
      return res.status(415).json({ error: `tipo file non supportato: ${mime || 'sconosciuto'}`, allowed: allowedTypesList() });
    }
    try {
      const meta = saveUpload(req.tenantId, { buffer: req.body, mime, originalName });
      logAudit({ user: req.user.username, tenant: req.tenantId, event: 'upload', detail: { name: meta.name, type: meta.type, size: meta.size } });
      res.status(201).json(meta);
    } catch (e) {
      const status = e.code === 'TOO_LARGE' ? 413 : e.code === 'UNSUPPORTED_TYPE' ? 415 : e.code === 'EMPTY' ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
  });
});

// Upload scopato per progetto V2 (task B1): salva in uploads/<tenant>/project-<id>/
// invece che nella radice del tenant, cosi' gli allegati di ogni progetto sono
// isolati. Stesse regole di tipo/dimensione dell'upload generale.
app.post('/api/v2/projects/:id/uploads', requireTenant, requireManage, (req, res) => {
  rawUpload(req, res, (err) => {
    if (err) {
      if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
        return res.status(413).json({ error: 'file troppo grande (max 20MB)' });
      }
      return res.status(400).json({ error: 'upload non valido' });
    }
    const mime = normalizeMime(req.get('content-type'));
    const originalName = req.get('x-filename')
      ? decodeURIComponent(req.get('x-filename'))
      : (req.query.filename ?? '');
    if (!isAllowedType(mime)) {
      return res.status(415).json({ error: `tipo file non supportato: ${mime || 'sconosciuto'}`, allowed: allowedTypesList() });
    }
    const scope = `project-${req.params.id}`;
    try {
      const meta = saveUpload(req.tenantId, { buffer: req.body, mime, originalName, scope });
      logAudit({ user: req.user.username, tenant: req.tenantId, event: 'v2_project_upload', detail: { projectId: req.params.id, name: meta.name, type: meta.type, size: meta.size } });
      res.status(201).json(meta);
    } catch (e) {
      const status = e.code === 'TOO_LARGE' ? 413 : e.code === 'UNSUPPORTED_TYPE' ? 415 : e.code === 'EMPTY' ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
  });
});

// Download/anteprima di un allegato (per il ricaricamento dello storico). Path
// validato dal tenant con difesa dal traversal in resolveUpload.
app.get('/api/uploads/:tenantId/:file', requireTenant, (req, res) => {
  const path = resolveUpload(req.params.tenantId, req.params.file);
  if (!path) return res.status(404).json({ error: 'allegato non trovato' });
  res.type(mimeForStored(req.params.file));
  res.sendFile(path);
});

// Variante scopata per progetto V2 (task B1): il file vive in
// uploads/<tenant>/project-<id>/ e la route include lo scope nel path.
app.get('/api/uploads/:tenantId/project-:projectId/:file', requireTenant, (req, res) => {
  const scope = `project-${req.params.projectId}`;
  const path = resolveUpload(req.params.tenantId, req.params.file, scope);
  if (!path) return res.status(404).json({ error: 'allegato non trovato' });
  res.type(mimeForStored(req.params.file));
  res.sendFile(path);
});

// ---- Registry deliverable multi-tenant (task 4ab8c6b8) ----
// Elenco JSON per dashboard/integrazioni; il rendering pubblico è su GET
// /preview/<tenantId>/<slug> (route non-/api, registrata più sotto, niente auth:
// stesso comportamento pubblico delle preview statiche preesistenti).
app.get('/api/previews', (req, res) => {
  const visible = tenantsConfig.tenants.filter((t) => userCanTenant(req.user, t.id));
  res.json(visible.map((t) => ({ tenantId: t.id, tenantName: t.name, items: listPreviews(t.id) }))
    .filter((g) => g.items.length > 0));
});

app.get('/api/previews/:tenantId', requireTenant, (req, res) => {
  res.json(listPreviews(req.tenantId));
});

app.post('/api/conversations/archive', requireTenant, (req, res) => {
  const { agentId, sessionId } = req.body ?? {};
  if (!agentId || !sessionId) return res.status(400).json({ error: 'agentId e sessionId richiesti' });
  if (!userCanAgent(req.user, req.tenantId, agentId)) return res.status(403).json({ error: 'agente non assegnato' });
  const result = archiveConversation(req.tenantId, agentId, sessionId, req.user.username);
  const key = `${req.tenantId}:${agentId}:${sessionId}`;
  if (sessionMap[key]) { delete sessionMap[key]; saveSessionMap(); }
  if (result) {
    logAudit({ user: req.user.username, tenant: req.tenantId, agent: agentId, event: 'conversation_archived', detail: { archiveId: result.id } });
  }
  res.json({ ok: true, archived: result });
});

app.get('/api/conversations/archived', requireTenant, (req, res) => {
  const { agentId } = req.query;
  if (agentId && !userCanAgent(req.user, req.tenantId, agentId)) return res.status(403).json({ error: 'agente non assegnato' });
  const list = listArchived(req.tenantId, agentId || null)
    .filter((c) => userCanAgent(req.user, req.tenantId, c.agentId));
  res.json(list);
});

app.get('/api/conversations/archived/:id', requireTenant, (req, res) => {
  const conv = getArchived(req.tenantId, req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversazione non trovata' });
  if (!userCanAgent(req.user, req.tenantId, conv.agentId)) return res.status(403).json({ error: 'agente non assegnato' });
  res.json(conv);
});

// ---- Conversazioni chat persistite server-side (task 8ed6deb8: sync multi-
// dispositivo, prima le chat vivevano solo sul localStorage del device). Layer
// indipendente dallo storico agentId+sessionId sopra: niente rischio per i dati
// esistenti. agentId è opzionale; se presente va verificato come per le altre
// rotte (userCanAgent) sia in lettura che in scrittura.
// Contratto (naming task 5a00d2ca): risponde LEI STESSA con 403 se nega, e
// ritorna false in quel caso — va sempre usata come
// `if (!respondIfConvAgentDenied(...)) return;` per non proseguire dopo la 403.
function respondIfConvAgentDenied(req, res, agentId) {
  if (agentId && !userCanAgent(req.user, req.tenantId, agentId)) {
    res.status(403).json({ error: 'agente non assegnato' });
    return false;
  }
  return true;
}

app.get('/api/conversations', requireTenant, (req, res) => {
  const { agentId } = req.query;
  if (!respondIfConvAgentDenied(req, res, agentId)) return;
  const list = listConversations(req.tenantId, { agentId: agentId || null })
    .filter((c) => !c.agentId || userCanAgent(req.user, req.tenantId, c.agentId));
  res.json(list);
});

app.get('/api/conversations/:id', requireTenant, (req, res) => {
  const conv = getConversation(req.tenantId, req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversazione non trovata' });
  if (!respondIfConvAgentDenied(req, res, conv.agentId)) return;
  res.json(conv);
});

app.post('/api/conversations', requireTenant, (req, res) => {
  try {
    const { agentId, title, messages } = req.body ?? {};
    if (!respondIfConvAgentDenied(req, res, agentId)) return;
    const conv = createConversation(req.tenantId, { agentId: agentId ?? null, title, messages });
    logAudit({ user: req.user.username, tenant: req.tenantId, event: 'conversation_created', detail: { id: conv.id } });
    res.status(201).json(conv);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/conversations/:id/messages', requireTenant, (req, res) => {
  try {
    const conv = getConversation(req.tenantId, req.params.id);
    if (!conv) return res.status(404).json({ error: 'conversazione non trovata' });
    if (!respondIfConvAgentDenied(req, res, conv.agentId)) return;
    const { role, text, tenantId: _tenantId, ...rest } = req.body ?? {};
    const updated = appendConversationMessage(req.tenantId, req.params.id, { role, text, ...rest });
    res.status(201).json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/conversations/:id', requireTenant, (req, res) => {
  const conv = getConversation(req.tenantId, req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversazione non trovata' });
  if (!respondIfConvAgentDenied(req, res, conv.agentId)) return;
  deleteConversation(req.tenantId, req.params.id);
  logAudit({ user: req.user.username, tenant: req.tenantId, event: 'conversation_deleted', detail: { id: req.params.id } });
  res.json({ ok: true });
});

// Import bulk (migrazione chat locali esistenti dal client verso il server).
app.post('/api/conversations/import', requireTenant, (req, res) => {
  const { conversations } = req.body ?? {};
  if (!Array.isArray(conversations) || conversations.length === 0) {
    return res.status(400).json({ error: 'conversations deve essere un array non vuoto' });
  }
  for (const c of conversations) {
    if (!respondIfConvAgentDenied(req, res, c?.agentId)) return;
  }
  const result = importConversations(req.tenantId, conversations);
  logAudit({
    user: req.user.username, tenant: req.tenantId, event: 'conversations_imported',
    detail: { imported: result.imported.length, errors: result.errors.length },
  });
  res.status(201).json(result);
});

// ---- Task board per business ----
// Lettura per tutti i ruoli con accesso al tenant; scrittura solo admin/manager.
function requireManage(req, res, next) {
  if (req.user.role === 'collaborator') return res.status(403).json({ error: 'i collaboratori hanno sola lettura sulle task' });
  next();
}

app.get('/api/tasks', requireTenant, (req, res) => {
  res.json(listTasks(req.tenantId));
});

// assignedTo (se presente) deve essere un agente del tenant.
// Contratto (naming task 5a00d2ca): non ritorna nulla, LANCIA se non valido —
// va sempre chiamata dentro un try/catch che risponde 400/403 (convenzione assert*).
function assertTaskAssignee(tenantId, assignedTo) {
  if (assignedTo === undefined || assignedTo === null || assignedTo === '') return;
  const id = String(assignedTo).replace(/^agent:/, '');
  if (!findAgent(tenantId, id).agent) throw new Error(`assignedTo non valido: nessun agente "${id}" nel tenant`);
}

app.post('/api/tasks', requireTenant, requireManage, (req, res) => {
  try {
    const { title, description, status, urgency, resultType, riskLevel, assignedTo, blockedBy } = req.body ?? {};
    assertTaskAssignee(req.tenantId, assignedTo);
    res.status(201).json(createTask(req.tenantId, {
      title, description,
      ...(status !== undefined ? { status } : {}),
      ...(urgency !== undefined ? { urgency } : {}),
      ...(resultType !== undefined ? { resultType } : { resultType: DEFAULT_RESULT_TYPE }),
      ...(riskLevel !== undefined ? { riskLevel } : { riskLevel: DEFAULT_RISK_LEVEL }),
      ...(assignedTo !== undefined ? { assignedTo } : {}),
      ...(blockedBy !== undefined ? { blockedBy } : {}),
    }, `user:${req.user.username}`));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Deliverables / artefatti versionati -----------------------------------
app.get('/api/artifacts', requireTenant, (req, res) => {
  const { taskId, status } = req.query;
  res.json(listArtifacts(req.tenantId, { taskId: taskId || null, status: status || null }));
});

app.get('/api/artifacts/:id', requireTenant, (req, res) => {
  const result = getArtifactContent(req.tenantId, req.params.id);
  if (!result) return res.status(404).json({ error: 'artefatto non trovato' });
  res.json(result);
});

app.patch('/api/artifacts/:id/status', requireTenant, requireManage, (req, res) => {
  try {
    res.json(setArtifactStatus(req.tenantId, req.params.id, req.body?.status, 'user:' + req.user.username));
  } catch (err) {
    res.status(err.message === 'artefatto non trovato' ? 404 : 400).json({ error: err.message });
  }
});

// ---- Operating System V2 ---------------------------------------------------
// API parallele alla V1: il nuovo modello Project/Workflow non dipende dalla
// task board legacy e puo essere pilotato su un solo tenant senza migrazione
// distruttiva dei dati esistenti.
app.get('/api/v2/overview', requireTenant, (req, res) => {
  res.json(getOperatingSystemOverview(req.tenantId));
});

app.get('/api/v2/models', (_req, res) => res.json(getOpenClawModels()));
app.get('/api/v2/context-graph/status', (_req, res) => res.json(contextGraphStats()));
app.post('/api/v2/context-graph/query', requireTenant, (req, res) => {
  const queryText = String(req.body?.query ?? '').trim();
  if (!queryText) return res.status(400).json({ error: 'query obbligatoria' });
  return res.json(queryContextGraph(queryText, { tenantId: req.tenantId, limit: Math.min(15, Number(req.body?.limit ?? 8)), maxChars: 10_000 }));
});

app.get('/api/v2/projects/:id', requireTenant, (req, res) => {
  const project = getProject(req.tenantId, req.params.id);
  if (!project) return res.status(404).json({ error: 'progetto non trovato' });
  res.json(project);
});

app.get('/api/v2/projects/:id/context', requireTenant, (req, res) => {
  try {
    res.json(compileProjectContext(req.tenantId, req.params.id));
  } catch (err) {
    res.status(err.message === 'progetto non trovato' ? 404 : 400).json({ error: err.message });
  }
});

app.post('/api/v2/projects/:id/brand-lint', requireTenant, requireManage, (req, res) => {
  try {
    res.json(runBrandLint(req.tenantId, req.params.id, req.body ?? {}, `user:${req.user.username}`));
  } catch (err) {
    res.status(err.message === 'progetto non trovato' ? 404 : 400).json({ error: err.message });
  }
});

app.post('/api/v2/projects', requireTenant, requireManage, (req, res) => {
  try {
    res.status(201).json(createProject(req.tenantId, req.body ?? {}, `user:${req.user.username}`));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v2/projects/:id/messages', requireTenant, requireManage, (req, res) => {
  try {
    const tenantId = req.tenantId;
    const projectId = req.params.id;
    const scope = `project-${projectId}`;
    // Allegati opzionali: metadata dal client, il server risolve il path
    // (mai fidarsi del client) e scarta gli allegati non piu' validi.
    const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const attachments = rawAttachments.flatMap((a) => {
      const path = resolveUpload(tenantId, a?.stored, scope);
      return path ? [{ ...a, path }] : [];
    });
    res.status(201).json(addProjectMessage(tenantId, projectId, {
      ...req.body,
      attachments,
    }, `user:${req.user.username}`));
  } catch (err) {
    res.status(err.message === 'progetto non trovato' ? 404 : 400).json({ error: err.message });
  }
});

app.patch('/api/v2/projects/:id/skills', requireTenant, requireManage, (req, res) => {
  try { res.json(setProjectSkills(req.tenantId, req.params.id, req.body?.skillIds, `user:${req.user.username}`)); }
  catch (err) { res.status(/non trovato/.test(err.message) ? 404 : 400).json({ error: err.message }); }
});

app.post('/api/v2/projects/:id/requests/:requestId/respond', requireTenant, requireManage, (req, res) => {
  try {
    const project = resolveProjectInput(req.tenantId, req.params.id, req.params.requestId, req.body ?? {}, `user:${req.user.username}`);
    res.json(project);
    // Flusso lineare: la risposta puo' dover interrompere la task successiva in
    // esecuzione (o un progetto dopo in fila) e ridare la mano alla task appena
    // risposta. onProjectInputResolved gestisce preemption + avvio.
    onProjectInputResolved(req.tenantId, req.params.id, (updated) => handleV2ProjectUpdate(req.tenantId, updated));
  } catch (err) {
    res.status(/non trovat/.test(err.message) ? 404 : 400).json({ error: err.message });
  }
});

// Ordine di fila dei progetti (flusso lineare): numeri bassi partono prima;
// null = in coda per data di creazione. La fila vera la applica l'executor.
app.patch('/api/v2/projects/:id/queue-order', requireTenant, requireManage, (req, res) => {
  try { res.json(setProjectQueueOrder(req.tenantId, req.params.id, req.body?.queueOrder ?? null, `user:${req.user.username}`)); }
  catch (err) { res.status(/non trovato/.test(err.message) ? 404 : 400).json({ error: err.message }); }
});

app.patch('/api/v2/projects/:id/group', requireTenant, requireManage, (req, res) => {
  try { res.json(setProjectGroup(req.tenantId, req.params.id, req.body?.group ?? null, `user:${req.user.username}`)); }
  catch (err) { res.status(/non trovato/.test(err.message) ? 404 : 400).json({ error: err.message }); }
});

app.post('/api/v2/projects/:id/steps', requireTenant, requireManage, (req, res) => {
  try {
    res.json(updateProjectStep(req.tenantId, req.params.id, req.body ?? {}, `user:${req.user.username}`));
  } catch (err) {
    res.status(err.message === 'progetto non trovato' ? 404 : 400).json({ error: err.message });
  }
});

app.patch('/api/v2/projects/:id/models', requireTenant, requireManage, (req, res) => {
  try { res.json(configureProjectModels(req.tenantId, req.params.id, req.body ?? {}, `user:${req.user.username}`)); }
  catch (err) { res.status(/non trovato/.test(err.message) ? 404 : 400).json({ error: err.message }); }
});

app.patch('/api/v2/projects/:id/notifications', requireTenant, requireManage, (req, res) => {
  try { res.json(configureProjectNotificationPolicy(req.tenantId, req.params.id, req.body ?? {}, `user:${req.user.username}`)); }
  catch (err) { res.status(/non trovato/.test(err.message) ? 404 : 400).json({ error: err.message }); }
});


// Turno Architect SERVER-SIDE (fix mobile 2026-08-04): il messaggio utente viene
// persistito, la risposta HTTP torna subito (202) e il turno LLM gira staccato
// dalla richiesta. Se il client va in background o perde la rete, il turno
// continua comunque; il risultato arriva via broadcast WS + push e resta in chat.
// Coda per-progetto: messaggi inviati mentre l'Architect elabora vengono
// serializzati, ogni turno vede lo stato aggiornato.
const architectQueues = new Map();
app.post('/api/v2/projects/:id/architect', requireTenant, requireManage, (req, res) => {
  try {
    const text = String(req.body?.text ?? '').trim();
    const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    if (!text && rawAttachments.length === 0) throw new Error('messaggio o allegati richiesti');
    const tenantId = req.tenantId;
    const projectId = req.params.id;
    const username = `user:${req.user.username}`;
    const scope = `project-${projectId}`;
    // Risoluzione allegati (mai fidarsi del client)
    const attachments = rawAttachments.flatMap((a) => {
      const path = resolveUpload(tenantId, a?.stored, scope);
      return path ? [{ ...a, path }] : [];
    });
    // Instradamento richiesta aperta (bug B): se esiste una richiesta open la chat
    // e' un secondo canale di risposta. Lo stato del client puo' essere stantio e
    // mandare qui la risposta invece che su /respond -> la richiesta restava open
    // e l'Architect "registrava" senza consumare nulla. Risolviamo server-side.
    // La classificazione approva/rifiuta resta in resolveProjectInput (regex rifiuto
    // ancorata, solo intenti espliciti). Intenti non-approval (correzioni, domande)
    // cadono nel ramo fallback e proseguono verso l'Architect come prima.
    const current = getProject(tenantId, projectId);
    if (!current) throw new Error('progetto non trovato');
    const openRequest = current.requests?.find((request) => request.status === 'open');
    // Messaggio di soli allegati (task B3): NON e' una risposta alla richiesta
    // aperta (un'immagine senza testo non approva nulla) e resolveProjectInput
    // rifiuterebbe comunque una risposta vuota. Va all'Architect come contenuto.
    if (openRequest && text) {
      const nonApprovalIntent =/^(?:aspetta|attendi|non ancora|prima (?:di|voglio)|fammi|spiegami|dimmi|mostrami|perch[eé]|come mai|cambia|modifica|correggi|aggiorna|invece|piuttosto|vorrei capire|domanda)\b/i;
      if (openRequest.type === 'approval' && !nonApprovalIntent.test(text)) {
        const project = resolveProjectInput(tenantId, projectId, openRequest.id, { answer: text, attachments }, username);
        res.json(project);
        handleV2ProjectUpdate(tenantId, project);
        onProjectInputResolved(tenantId, projectId, (updated) => handleV2ProjectUpdate(tenantId, updated));
        return;
      }
      if (openRequest.type !== 'approval') {
        // Richiesta di input aperta: la risposta arriva in chat invece che su /respond.
        const project = resolveProjectInput(tenantId, projectId, openRequest.id, { answer: text, attachments }, username);
        res.json(project);
        handleV2ProjectUpdate(tenantId, project);
        onProjectInputResolved(tenantId, projectId, (updated) => handleV2ProjectUpdate(tenantId, updated));
        return;
      }
    }
    addProjectMessage(tenantId, projectId, { role: 'user', text, attachments }, username);
    const project = setProjectArchitectBusy(tenantId, projectId, true);
    res.status(202).json(project);
    broadcast(tenantId, { type: 'v2_project', project });

    const key = `${tenantId}:${projectId}`;
    const prev = architectQueues.get(key) ?? Promise.resolve();
    const turn = prev.then(async () => {
      try {
        await runProjectArchitectTurn(tenantId, projectId, text, username, attachments);
      } catch (err) {
        try {
          addProjectMessage(tenantId, projectId, { role: 'assistant', text: `⚠️ Il Project Architect si è interrotto: ${err.message}\nRiscrivi il messaggio per riprovare.` }, 'project-architect');
        } catch { /* progetto rimosso nel frattempo */ }
        logAudit({ user: username, tenant: tenantId, event: 'v2_project_architect_error', detail: { projectId, message: String(err?.message ?? err).slice(0, 300) } });
      } finally {
        // Chiude lo stato "sta elaborando" solo se questo è l'ultimo turno in coda.
        if (architectQueues.get(key) === turn) {
          architectQueues.delete(key);
          try { broadcast(tenantId, { type: 'v2_project', project: setProjectArchitectBusy(tenantId, projectId, false) }); } catch { /* best-effort */ }
        } else {
          const current = getProject(tenantId, projectId);
          if (current) broadcast(tenantId, { type: 'v2_project', project: current });
        }
      }
    });
    architectQueues.set(key, turn);
  } catch (err) {
    res.status(err.message === 'progetto non trovato' ? 404 : 400).json({ error: err.message });
  }
});

app.post('/api/v2/projects/:id/activate', requireTenant, requireManage, (req, res) => {
  try {
    const project = activateCustomProject(req.tenantId, req.params.id, `user:${req.user.username}`);
    res.json(project);
    runProjectSerial(req.tenantId, req.params.id, (updated) => handleV2ProjectUpdate(req.tenantId, updated));
  } catch (err) {
    res.status(err.message === 'progetto non trovato' ? 404 : 400).json({ error: err.message });
  }
});

app.post('/api/v2/projects/:id/pause', requireTenant, requireManage, (req, res) => {
  try {
    const project = requestProjectPause(req.tenantId, req.params.id, `user:${req.user.username}`);
    logAudit({ user: req.user.username, tenant: req.tenantId, event: 'v2_project_paused', detail: { projectId: req.params.id } });
    broadcast(req.tenantId, { type: 'v2_project', project });
    res.json(project);
  } catch (err) {
    res.status(err.message === 'progetto non trovato' ? 404 : 400).json({ error: err.message });
  }
});

app.post('/api/v2/projects/:id/resume', requireTenant, requireManage, (req, res) => {
  const project = getProject(req.tenantId, req.params.id);
  if (!project) return res.status(404).json({ error: 'progetto non trovato' });
  // Fallimento definitivo (retry applicativi esauriti o quality gate bocciato):
  // il resume e' l'unico modo di ripartire -> riattiva step fallito e progetto,
  // contatori azzerati. Fatto PRIMA del 202 cosi' un errore arriva come 400.
  if (project.status === 'failed') {
    try {
      const resumed = resumeFailedProject(req.tenantId, req.params.id, `user:${req.user.username}`);
      logAudit({ user: req.user.username, tenant: req.tenantId, event: 'v2_project_resumed_from_failed', detail: { projectId: req.params.id } });
      handleV2ProjectUpdate(req.tenantId, resumed);
      res.status(202).json({ ok: true, resumedFromFailed: true });
      runProjectSerial(req.tenantId, req.params.id, (updated) => handleV2ProjectUpdate(req.tenantId, updated));
      return;
    } catch (err) {
      return res.status(err.message === 'progetto non trovato' ? 404 : 400).json({ error: err.message });
    }
  }
  // Progetto in pausa top-level (pausa manuale, rifiuto approvazione, o lo stato
  // residuo del bug storico: paused con currentStepId null e nessuno step attivo):
  // runProjectSerial esce subito se status !== 'active', quindi qui il resume
  // non faceva NULLA e il progetto restava fermo per sempre (bug C, diagnosi
  // 2026-08-15). Riportiamo il progetto ad 'active' riattivando uno step
  // eseguibile: preferiamo lo step del rifiuto/pausa (memorizzato in
  // execution.pausedStepId), altrimenti qualsiasi blocked/needs_approval (caso
  // post-rifiuto: ripremendo Riprendi l'utente conferma l'esecuzione),
  // altrimenti il prossimo pending/proposed.
  if (project.status === 'paused') {
    try {
      const resumed = resumePausedProject(req.tenantId, req.params.id, `user:${req.user.username}`);
      handleV2ProjectUpdate(req.tenantId, resumed);
      res.status(202).json({ ok: true, resumedFromPaused: true });
      runProjectSerial(req.tenantId, req.params.id, (updated) => handleV2ProjectUpdate(req.tenantId, updated));
      return;
    } catch (err) {
      return res.status(err.message === 'progetto non trovato' ? 404 : 400).json({ error: err.message });
    }
  }
  // Stop premuto DURANTE il quality gate premium (task E2): requestProjectPause
  // mette execution.status a 'paused' ma il lifecycle resta
  // 'needs_premium_review', quindi runProjectSerial esce subito (status !=
  // 'active') e il resume non faceva ripartire nulla. Qui la ripresa rilancia
  // il gate premium: la coda riparte dallo step non ancora approvato, gli step
  // gia' approvati restano tali (nessun lavoro rifatto).
  if (project.status === 'needs_premium_review' && project.execution?.status === 'paused') {
    res.status(202).json({ ok: true, resumedPremiumQuality: true });
    runProjectPremiumReview(req.tenantId, req.params.id, (updated) => handleV2ProjectUpdate(req.tenantId, updated))
      .then(({ project: updated }) => {
        if (updated.status === 'active') runProjectSerial(req.tenantId, req.params.id, (next) => handleV2ProjectUpdate(req.tenantId, next));
      })
      .catch((err) => {
        logAudit({ user: req.user.username, tenant: req.tenantId, event: 'v2_premium_quality_error', detail: { projectId: req.params.id, message: String(err?.message ?? err).slice(0, 300) } });
      });
    return;
  }
  res.status(202).json({ ok: true });
  runProjectSerial(req.tenantId, req.params.id, (updated) => handleV2ProjectUpdate(req.tenantId, updated));
});

app.post('/api/v2/projects/:id/premium-review', requireTenant, requireManage, (req, res) => {
  const project = getProject(req.tenantId, req.params.id);
  if (!project) return res.status(404).json({ error: 'progetto non trovato' });
  if (project.status !== 'needs_premium_review') return res.status(400).json({ error: 'il progetto non attende un quality gate premium' });
  res.status(202).json({ ok: true });
  runProjectPremiumReview(req.tenantId, req.params.id, (updated) => handleV2ProjectUpdate(req.tenantId, updated))
    .then(({ project: updated }) => {
      if (updated.status === 'active') runProjectSerial(req.tenantId, req.params.id, (next) => handleV2ProjectUpdate(req.tenantId, next));
    })
    .catch((err) => {
      logAudit({ user: req.user.username, tenant: req.tenantId, event: 'v2_premium_quality_error', detail: { projectId: req.params.id, message: String(err?.message ?? err).slice(0, 300) } });
    });
});

app.post('/api/v2/projects/:id/archive', requireTenant, requireManage, (req, res) => {
  try {
    const archived = req.body?.archived !== false;
    const project = setProjectArchived(req.tenantId, req.params.id, archived, `user:${req.user.username}`);
    res.json(project);
    if (!archived && project.status === 'active') runProjectSerial(req.tenantId, req.params.id, (updated) => handleV2ProjectUpdate(req.tenantId, updated));
  } catch (err) {
    res.status(err.message === 'progetto non trovato' ? 404 : 400).json({ error: err.message });
  }
});

app.get('/api/v2/report-definitions/:id', requireTenant, (req, res) => {
  const definition = getReportDefinition(req.tenantId, req.params.id);
  if (!definition) return res.status(404).json({ error: 'definizione report non trovata' });
  res.json(definition);
});

app.post('/api/v2/report-definitions', requireTenant, requireManage, (req, res) => {
  try {
    res.status(201).json(createReportDefinition(req.tenantId, req.body ?? {}, `user:${req.user.username}`));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v2/report-definitions/:id/designer', requireTenant, requireManage, async (req, res) => {
  try {
    const text = String(req.body?.text ?? '').trim();
    if (!text) throw new Error('messaggio richiesto');
    addReportDefinitionMessage(req.tenantId, req.params.id, { role: 'user', text }, `user:${req.user.username}`);
    res.json(await runReportDesignerTurn(req.tenantId, req.params.id, text, `user:${req.user.username}`));
  } catch (err) {
    res.status(err.message === 'definizione report non trovata' ? 404 : 400).json({ error: err.message });
  }
});

app.patch('/api/v2/report-definitions/:id/model', requireTenant, requireManage, (req, res) => {
  try { res.json(configureReportModel(req.tenantId, req.params.id, req.body?.model, `user:${req.user.username}`)); }
  catch (err) { res.status(/non trovata/.test(err.message) ? 404 : 400).json({ error: err.message }); }
});

app.post('/api/v2/report-definitions/:id/activate', requireTenant, requireManage, (req, res) => {
  try {
    res.json(activateReportDefinition(req.tenantId, req.params.id, `user:${req.user.username}`));
  } catch (err) {
    res.status(err.message === 'definizione report non trovata' ? 404 : 400).json({ error: err.message });
  }
});

app.post('/api/v2/report-definitions/:id/archive', requireTenant, requireManage, (req, res) => {
  try {
    res.json(setReportDefinitionArchived(req.tenantId, req.params.id, req.body?.archived !== false, `user:${req.user.username}`));
  } catch (err) {
    res.status(err.message === 'definizione report non trovata' ? 404 : 400).json({ error: err.message });
  }
});

app.post('/api/v2/report-definitions/:id/run', requireTenant, requireManage, (req, res) => {
  try {
    res.json(generateReportFromDefinition(req.tenantId, req.params.id, { source: 'manual', user: `user:${req.user.username}` }));
  } catch (err) {
    res.status(err.message === 'definizione report non trovata' ? 404 : 400).json({ error: err.message });
  }
});

app.post('/api/v2/reports/:id/project', requireTenant, requireManage, (req, res) => {
  try { res.status(201).json(convertReportToProject(req.tenantId, req.params.id, req.body ?? {}, `user:${req.user.username}`)); }
  catch (err) { res.status(err.message === 'report non trovato' ? 404 : 400).json({ error: err.message }); }
});

app.post('/api/v2/skills', requireTenant, requireManage, (req, res) => {
  try { res.status(201).json(createReusableSkill(req.tenantId, req.body ?? {}, `user:${req.user.username}`)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.patch('/api/v2/skills/:id', requireTenant, requireManage, (req, res) => {
  try { res.json(updateReusableSkill(req.tenantId, req.params.id, req.body ?? {}, `user:${req.user.username}`)); }
  catch (err) { res.status(err.message === 'skill non trovata' ? 404 : 400).json({ error: err.message }); }
});

app.post('/api/v2/brand-versions', requireTenant, requireManage, (req, res) => {
  try {
    res.status(201).json(createBrandVersion(req.tenantId, req.body ?? {}, `user:${req.user.username}`));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v2/brand-versions/:id/activate', requireTenant, requireManage, (req, res) => {
  try {
    res.json(activateBrandVersion(req.tenantId, req.params.id, `user:${req.user.username}`));
  } catch (err) {
    res.status(err.message === 'versione brand non trovata' ? 404 : 400).json({ error: err.message });
  }
});

app.post('/api/v2/signals', requireTenant, requireManage, (req, res) => {
  try {
    res.status(201).json(addDataSignals(req.tenantId, req.body ?? {}, `user:${req.user.username}`));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v2/autopilot/run', requireTenant, requireManage, (req, res) => {
  try {
    res.json(runAutopilot(req.tenantId, { source: 'manual', user: `user:${req.user.username}` }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v2/opportunities/:id/project', requireTenant, requireManage, (req, res) => {
  try {
    res.status(201).json(convertOpportunityToProject(req.tenantId, req.params.id, req.body ?? {}, `user:${req.user.username}`));
  } catch (err) {
    res.status(err.message === 'opportunità non trovata' ? 404 : 400).json({ error: err.message });
  }
});

app.post('/api/v2/approvals', requireTenant, requireManage, (req, res) => {
  try {
    res.status(201).json(createOperatingApproval(req.tenantId, req.body ?? {}, `user:${req.user.username}`));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v2/approvals/:id/resolve', requireTenant, requireManage, (req, res) => {
  try {
    res.json(resolveOperatingApproval(req.tenantId, req.params.id, req.body ?? {}, `user:${req.user.username}`));
  } catch (err) {
    res.status(err.message === 'approvazione non trovata' ? 404 : 400).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id', requireTenant, requireManage, (req, res) => {
  try {
    const { title, description, status, urgency, assignedTo, blockedBy, note } = req.body ?? {};
    assertTaskAssignee(req.tenantId, assignedTo);
    res.json(updateTask(req.tenantId, req.params.id, { title, description, status, urgency, assignedTo, blockedBy, note }, `user:${req.user.username}`));
  } catch (err) {
    res.status(err.message === 'task non trovata' ? 404 : 400).json({ error: err.message });
  }
});

// "Richieste per Owner" (task board 553ea6b1, ristretta a 03a5a645): SOLO le
// task in needs_input CON ask (vere richieste), con la domanda in un campo
// dedicato (richiestaAOwner), per popolare badge/liste senza dover andare a
// scavare nella description. Aggrega su tutti i tenant a cui l'utente ha
// accesso (come /api/decisions) o filtra con ?tenantId.
app.get('/api/tasks/needs-input', (req, res) => {
  const { tenantId } = req.query;
  if (tenantId && !userCanTenant(req.user, tenantId)) return res.status(403).json({ error: 'tenant non assegnato' });
  const tenants = tenantsConfig.tenants.filter((t) => (tenantId ? t.id === tenantId : true) && userCanTenant(req.user, t.id));
  const items = tenants.flatMap((t) => listNeedsInputTasks(t));
  items.sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
  res.json({ count: items.length, items });
});

// "Bloccate" (task board 03a5a645, decisione Owner 2026-07-25): task in
// needs_input SENZA ask — blocco tecnico (run interrotta, retry esauriti,
// gate bocciato troppe volte), non una domanda a cui Owner sa rispondere.
// Separata da "Da decidere"/needs-input sopra (che ora è SOLO ask). Stesso
// pattern di aggregazione cross-tenant (?tenantId opzionale).
app.get('/api/tasks/blocked', (req, res) => {
  const { tenantId } = req.query;
  if (tenantId && !userCanTenant(req.user, tenantId)) return res.status(403).json({ error: 'tenant non assegnato' });
  const tenants = tenantsConfig.tenants.filter((t) => (tenantId ? t.id === tenantId : true) && userCanTenant(req.user, t.id));
  const items = tenants.flatMap((t) => listBlockedTasks(t));
  items.sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
  res.json({ count: items.length, items });
});

// "Riprova" (requisito 3, task 03a5a645): azzera i tentativi di dispatch e
// rimette la task bloccata in coda (todo). Sola azione umana (requireManage,
// come /api/decisions) — i collaboratori restano sola lettura sulla board.
app.post('/api/tasks/:id/retry', requireTenant, requireManage, (req, res) => {
  try {
    const task = retryBlockedTask(req.tenantId, req.params.id, `user:${req.user.username}`);
    res.json({ ok: true, task });
  } catch (err) {
    const code = err.message === 'task non trovata' ? 404 : 409;
    res.status(code).json({ error: err.message });
  }
});

// "Completate" (task board adb782e9): report delle task done per la PWA. Dati
// già sulla task + trail review dal journal, NESSUNA generazione LLM. Filtri:
// ?from=&to= (ISO o YYYY-MM-DD) su data completamento, ?agentId= (assegnatario o
// worker), ?limit=&offset= paginazione. Ordinamento per completamento desc.
// Lettura per tutti i ruoli col tenant (coda informativa, come activity).
app.get('/api/tasks/completed', requireTenant, (req, res) => {
  const { from, to, agentId, limit, offset } = req.query;
  res.json(completedTasksReport(req.tenantId, { from, to, agentId, limit, offset }));
});

// ---- Messaggistica cross-tenant tra CEO (task board 183ae10d) ----
// Lettura dei thread inter-CEO per la PWA. Un thread coinvolge 2 tenant: è
// visibile se l'utente ha accesso ad ALMENO uno dei due partecipanti. ?tenantId
// filtra ai soli thread che coinvolgono quel tenant (dev'essere accessibile).
function threadVisibleTo(user, thread) {
  return (thread.participants ?? []).some((tid) => userCanTenant(user, tid));
}
app.get('/api/ceomail/threads', (req, res) => {
  const { tenantId } = req.query;
  if (tenantId && !userCanTenant(req.user, tenantId)) return res.status(403).json({ error: 'tenant non assegnato' });
  const base = tenantId ? listThreadsForTenant(tenantId) : listThreads();
  const items = base.filter((t) => threadVisibleTo(req.user, t)).map((t) => ({
    id: t.id,
    participants: t.participants,
    status: t.status,
    exchanges: t.exchanges,
    messageCount: (t.messages ?? []).length,
    lastMessage: (t.messages ?? []).at(-1) ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));
  res.json({ count: items.length, items });
});
app.get('/api/ceomail/threads/:id', (req, res) => {
  const thread = getThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'thread non trovato' });
  if (!threadVisibleTo(req.user, thread)) return res.status(403).json({ error: 'thread non accessibile' });
  res.json(thread);
});
// Sblocco di un thread fermato dall'anti-loop (solo admin/manager): riazzera il
// contatore e lo rimette "active" così i CEO possono riprendere.
app.post('/api/ceomail/threads/:id/resume', (req, res) => {
  if (req.user.role === 'collaborator') return res.status(403).json({ error: 'sola lettura' });
  const existing = getThread(req.params.id);
  if (!existing) return res.status(404).json({ error: 'thread non trovato' });
  if (!threadVisibleTo(req.user, existing)) return res.status(403).json({ error: 'thread non accessibile' });
  const thread = resumeThread(req.params.id);
  logAudit({ user: req.user.username, event: 'ceomail_thread_resumed_api', detail: { threadId: req.params.id } });
  res.json({ ok: true, thread });
});
// Messaggio di Owner nel thread (task board a5a5e758, completa 183ae10d per la
// UI 45b4a981): riservato a non-collaborator, stesso controllo di /resume.
// NON passa dal cap anti-loop (vedi commento in ceomail.js) e consegna una run
// a entrambi i CEO partecipanti.
app.post('/api/ceomail/threads/:id/message', (req, res) => {
  if (req.user.role === 'collaborator') return res.status(403).json({ error: 'sola lettura' });
  const existing = getThread(req.params.id);
  if (!existing) return res.status(404).json({ error: 'thread non trovato' });
  if (!threadVisibleTo(req.user, existing)) return res.status(403).json({ error: 'thread non accessibile' });
  try {
    const thread = addOwnerMessage(req.params.id, req.body?.text, { tenants: tenantsConfig.tenants });
    logAudit({ user: req.user.username, event: 'ceomail_owner_message_api', detail: { threadId: req.params.id } });
    res.json({ ok: true, thread });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// Stop manuale di un thread (task board a5a5e758): riservato a non-collaborator.
// Porta lo stato a 'closed' (distinto da 'awaiting_owner', il cap automatico) e
// blocca ulteriori send_to_ceo finché non arriva un resume esplicito.
app.post('/api/ceomail/threads/:id/stop', (req, res) => {
  if (req.user.role === 'collaborator') return res.status(403).json({ error: 'sola lettura' });
  const existing = getThread(req.params.id);
  if (!existing) return res.status(404).json({ error: 'thread non trovato' });
  if (!threadVisibleTo(req.user, existing)) return res.status(403).json({ error: 'thread non accessibile' });
  const thread = stopThread(req.params.id);
  logAudit({ user: req.user.username, event: 'ceomail_thread_stopped_api', detail: { threadId: req.params.id } });
  res.json({ ok: true, thread });
});

// Dettaglio di UNA richiesta/task (task board ac3067d0): tutto il contesto in
// un colpo solo, per aprire una schermata di dettaglio dal popup "Da decidere"
// senza dover andare ad aprire la board. Riusa i pezzi già esistenti (nessuna
// duplicazione): i campi della task, taskReviewNotes (audit.js, cronologia del
// quality gate: chi ha approvato/bocciato cosa e quando) e listTaskMessages
// (taskchat.js, thread di chat introdotto da 553ea6b1) — il thread resta
// leggibile qui anche a task done (nessuna perdita, requisito 5).
// NB: va DOPO le route letterali /needs-input, /blocked, /completed sopra —
// altrimenti :id le intercetterebbe come se fossero id di task.
app.get('/api/tasks/:id', requireTenant, (req, res) => {
  const all = listTasks(req.tenantId);
  const task = all.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'task non trovata' });
  const assignedId = task.assignedTo ? task.assignedTo.replace(/^agent:/, '') : null;
  const workerIdRaw = task.workerId ? task.workerId.replace(/^agent:/, '') : null;
  res.json({
    id: task.id,
    tenantId: task.tenantId,
    title: task.title,
    description: task.description,
    status: task.status,
    urgency: task.urgency,
    createdBy: task.createdBy,
    assignedTo: task.assignedTo,
    assignedToName: assignedId ? (findAgent(req.tenantId, assignedId).agent?.name ?? null) : null,
    workerId: task.workerId ?? null,
    workerName: workerIdRaw ? (findAgent(req.tenantId, workerIdRaw).agent?.name ?? null) : null,
    blockedBy: task.blockedBy ?? [],
    openBlockers: openBlockers(task, all),
    blockCause: task.blockCause ?? null,
    note: task.note ?? null,
    revisionNote: task.revisionNote ?? null,
    // Ask completo (goal/question/context/steps/options/askedBy/askedByName/askedAt),
    // o null se la task non ha mai avuto una richiesta formale a Owner.
    ask: task.ask ?? null,
    gateRejection: task.gateRejection ?? null,
    managerRejections: task.managerRejections ?? 0,
    ceoRejections: task.ceoRejections ?? 0,
    // Cronologia "chi ha chiesto/deciso cosa e quando": review del quality gate
    // dal journal audit + storico discorsivo (thread di chat completo).
    reviewHistory: taskReviewNotes(task.id),
    messages: listTaskMessages(req.tenantId, task.id),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
});

// ---- Feed "Attività" per tenant (task board 31797bb5) ----
// Traccia persistente (server-side, sync multi-dispositivo) degli eventi
// rilevanti per Owner: task completate, in needs_input, bloccate
// dall'escalation del gate. Complementare alle push (una notifica si può
// perdere; questo feed no). Lettura per tutti i ruoli col tenant, come le
// altre code informative (approvals/decisions) — niente requireManage.
app.get('/api/activity', requireTenant, (req, res) => {
  res.json({ events: listActivity(req.tenantId), unreadCount: unreadActivityCount(req.tenantId) });
});

app.post('/api/activity/:id/read', requireTenant, (req, res) => {
  const event = markActivityRead(req.tenantId, req.params.id);
  if (!event) return res.status(404).json({ error: 'evento non trovato' });
  res.json(event);
});

app.post('/api/activity/read-all', requireTenant, (req, res) => {
  res.json({ marked: markAllActivityRead(req.tenantId) });
});

// ---- Thread di chat per task (task board 553ea6b1) ----
// Lettura per tutti i ruoli con accesso al tenant; scrittura come le altre
// mutazioni della board (i collaboratori restano sola lettura sulle task).
app.get('/api/tasks/:id/messages', requireTenant, (req, res) => {
  const task = listTasks(req.tenantId).find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'task non trovata' });
  res.json(listTaskMessages(req.tenantId, req.params.id));
});

app.post('/api/tasks/:id/messages', requireTenant, requireManage, (req, res) => {
  try {
    const task = listTasks(req.tenantId).find((t) => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'task non trovata' });
    const clean = String(req.body?.text ?? '').trim();
    if (!clean) return res.status(400).json({ error: 'text richiesto' });
    const author = `user:${req.user.username}`;
    const message = addTaskMessage(req.tenantId, req.params.id, { author, authorName: req.user.username, text: clean });
    // Se la task è ferma in needs_input, il messaggio di Owner è la risposta
    // che la sblocca: riusa answerTaskDecision (stesso instradamento del
    // popup dedicato) così la task torna all'agente giusto (worker/assignedTo)
    // con la risposta nella nota di revisione; il dispatcher la riprende in
    // in_progress al giro successivo (stesso meccanismo di "revisione").
    const updatedTask = task.status === 'needs_input'
      ? answerTaskDecision(req.tenantId, req.params.id, { answer: clean }, author)
      : task;
    res.status(201).json({ message, task: updatedTask });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Wiki di conoscenza per tenant (file-based, git-versionata) ----
// Lettura per tutti i ruoli con accesso al tenant, scrittura da UI solo
// admin/manager (gli agenti scrivono via tool MCP wiki_write, non da qui).
app.get('/api/tenants/:tenantId/wiki', requireTenant, (req, res) => {
  res.json(listWikiPages(req.tenantId).map((name) => ({
    page: name,
    words: wordCount(readWikiPage(req.tenantId, name) ?? ''),
  })));
});

app.get('/api/tenants/:tenantId/wiki/:page', requireTenant, (req, res) => {
  const content = readWikiPage(req.tenantId, req.params.page);
  if (content === null) return res.status(404).json({ error: 'pagina non trovata' });
  res.json({ page: req.params.page, content, words: wordCount(content) });
});

app.put('/api/tenants/:tenantId/wiki/:page', requireTenant, requireManage, (req, res) => {
  try {
    const { content } = req.body ?? {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content (stringa) richiesto' });
    const result = writeWikiPage(req.tenantId, req.params.page, content, { author: `user:${req.user.username}` });
    logAudit({ user: req.user.username, tenant: req.tenantId, event: 'wiki_page_updated', detail: { page: req.params.page, changed: result.changed } });
    res.json({ ...result, words: wordCount(content) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/tenants/:tenantId/wiki/:page/history', requireTenant, (req, res) => {
  try {
    res.json(wikiPageHistory(req.tenantId, req.params.page));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/tenants/:tenantId/wiki/:page/rollback', requireTenant, requireManage, (req, res) => {
  try {
    const { commit } = req.body ?? {};
    if (!commit) return res.status(400).json({ error: 'commit (hash) richiesto' });
    const result = rollbackWikiPage(req.tenantId, req.params.page, commit, { author: `user:${req.user.username}` });
    logAudit({ user: req.user.username, tenant: req.tenantId, event: 'wiki_page_rollback', detail: { page: req.params.page, commit } });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Trascrizione vocale (provider pluggabile, fallback Web Speech lato client) ----
app.get('/api/transcribe/status', async (req, res) => {
  res.json(await transcriptionStatus());
});

app.post('/api/transcribe', express.raw({ type: 'audio/*', limit: '25mb' }), async (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: 'audio mancante' });
    const text = await transcribe(req.body, req.headers['content-type']);
    logAudit({ user: req.user.username, event: 'transcription', detail: { bytes: req.body.length } });
    res.json({ text });
  } catch (err) {
    if (err.code === 'NO_PROVIDER') return res.status(501).json({ error: err.message, fallback: 'webspeech' });
    res.status(500).json({ error: err.message });
  }
});

// ---- Notifiche push ----
app.get('/api/push/vapid-key', (req, res) => res.json({ key: vapidPublicKey() }));

app.post('/api/push/subscribe', (req, res) => {
  try {
    addSubscription(req.user.username, req.body?.subscription);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/push/unsubscribe', (req, res) => {
  removeSubscription(req.user.username, req.body?.endpoint);
  res.json({ ok: true });
});

const pushDeps = { loadUsers, userCanTenant };

// ---- Sessioni agente (tab "Agenti attivi") ----
app.get('/api/agent-sessions', (req, res) => {
  const { tenantId } = req.query;
  if (tenantId && !userCanTenant(req.user, tenantId)) return res.status(403).json({ error: 'tenant non assegnato' });
  const list = listAgentSessions(tenantId || null).filter((s) => userCanTenant(req.user, s.tenantId));
  res.json(list);
});

// ---- Stop/riprendi manuale delle run (journal) ----
// Query SDK attive in questo processo, per runId: servono a terminare in modo
// pulito il claude-cli di una run fermata dall'utente mentre è ancora viva.
const activeQueries = new Map();
// Sessioni (tenant:agent:session) con un turno in volo in QUESTO processo (task
// 311d2946, coda messaggi): finché la chiave è qui dentro, un nuovo /api/chat
// sulla stessa conversazione si accoda invece di avviare un turno parallelo.
// Vive solo in memoria: non serve persistenza, perché rappresenta lo stato di
// UNA esecuzione in corso ORA — dopo un riavvio nessun turno è "in volo" (il
// journal segna le run vive come interrupted, vedi recoverOnBoot) e la coda
// persistita su disco viene comunque drenata dal watchdog/riconciliazione boot.
const busySessions = new Set();

function loadRunForUser(req, res) {
  const run = getRun(req.params.id);
  if (!run) { res.status(404).json({ error: 'run non trovata' }); return null; }
  if (run.tenantId !== req.tenantId) { res.status(403).json({ error: 'tenant non corrispondente' }); return null; }
  if (!userCanAgent(req.user, run.tenantId, run.agentId)) { res.status(403).json({ error: 'agente non assegnato' }); return null; }
  return run;
}

// Stop manuale esplicito: la run diventa "stopped" (unico stato che vince
// sull'auto-resume) e il processo claude-cli, se ancora vivo, viene interrotto.
app.post('/api/runs/:id/stop', requireTenant, (req, res) => {
  const run = loadRunForUser(req, res);
  if (!run) return;
  if (run.status === 'completed' || run.status === 'failed') {
    return res.status(409).json({ error: `run già ${run.status}, niente da fermare` });
  }
  if (run.status !== 'stopped') {
    const prevStatus = run.status; // getRun restituisce l'oggetto vivo: da salvare prima della mutazione
    journalStop(run.id, req.user.username);
    // Prima il journal, poi l'interrupt: l'errore generato dalla terminazione
    // trova la run già "stopped" (sticky) e non la riporta in interrupted.
    const q = activeQueries.get(run.id);
    if (q) q.interrupt().catch((err) => console.warn(`[stop] interrupt run ${run.id}:`, err.message));
    // Le run esterne non hanno sessione chat (sessionKey null): solo journal.
    if (run.sessionKey) {
      touchSession(run.sessionKey, {
        tenantId: run.tenantId, agentId: run.agentId, sessionId: run.sessionId,
        status: 'stopped', lastError: null, runId: run.id,
      });
      pushSessionEvent(run.sessionKey, { type: 'stopped', text: `fermata manualmente da ${req.user.username}` });
    }
    logAudit({
      user: req.user.username, tenant: run.tenantId, agent: run.agentId,
      event: 'run_stopped', detail: { runId: run.id, wasAlive: Boolean(q), prevStatus },
    });
  }
  res.json(getRun(run.id));
});

// Pausa manuale: come lo stop (sticky, processo vivo interrotto pulito) ma
// pensata per la ripresa. Con resumeAfterMs (pausa a tempo) il watchdog la
// riprende da solo al primo tick dopo resumeAt, da dove era rimasta.
const MAX_PAUSE_MS = 7 * 24 * 60 * 60 * 1000;
app.post('/api/runs/:id/pause', requireTenant, (req, res) => {
  const run = loadRunForUser(req, res);
  if (!run) return;
  if (run.external) return res.status(409).json({ error: 'run esterna: il server non può metterla in pausa (usa Ferma per toglierla dal journal)' });
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'stopped') {
    return res.status(409).json({ error: `run già ${run.status}, niente da mettere in pausa` });
  }
  const raw = req.body?.resumeAfterMs;
  let resumeAfterMs = null;
  if (raw !== undefined && raw !== null) {
    resumeAfterMs = Number(raw);
    if (!Number.isFinite(resumeAfterMs) || resumeAfterMs <= 0 || resumeAfterMs > MAX_PAUSE_MS) {
      return res.status(400).json({ error: 'resumeAfterMs deve essere un numero positivo (max 7 giorni)' });
    }
  }
  const prevStatus = run.status; // oggetto vivo: salvato prima della mutazione
  journalPause(run.id, req.user.username, resumeAfterMs);
  // Prima il journal, poi l'interrupt: l'errore generato dalla terminazione
  // trova la run già "paused" (sticky) e non la riporta in interrupted.
  const q = activeQueries.get(run.id);
  if (q) q.interrupt().catch((err) => console.warn(`[pause] interrupt run ${run.id}:`, err.message));
  touchSession(run.sessionKey, {
    tenantId: run.tenantId, agentId: run.agentId, sessionId: run.sessionId,
    status: 'paused', lastError: null, runId: run.id,
  });
  const updated = getRun(run.id);
  pushSessionEvent(run.sessionKey, {
    type: 'paused',
    text: updated.resumeAt
      ? `in pausa da ${req.user.username}, riprende automaticamente alle ${new Date(updated.resumeAt).toLocaleString('it-IT')}`
      : `in pausa da ${req.user.username} (ripresa manuale)`,
  });
  logAudit({
    user: req.user.username, tenant: run.tenantId, agent: run.agentId,
    event: 'run_paused', detail: { runId: run.id, wasAlive: Boolean(q), prevStatus, resumeAt: updated.resumeAt },
  });
  res.json(updated);
});

// Ripresa manuale (bottone "Riprendi"). L'intento dell'utente è sempre
// "rimettila in moto"; la decisione la prende la macchina a stati unica
// (resumeDecision), non una regola inline. Tre esiti (bug a3d510cb):
//  - nudge  : stato sticky (stopped/paused) → interrupted con retry immediato,
//             il watchdog la riprende al tick successivo (meccanismo esistente);
//  - noop   : la run è GIÀ in esecuzione o già in ripartenza (race UI↔watchdog:
//             la UI mostrava "in pausa" ma il watchdog aveva già ripreso una
//             pausa a tempo, oppure un resume precedente l'aveva già spinta a
//             interrupted). Non è un errore: 200 con lo stato reale;
//  - reject : terminale/esterna → 409 con lo stato REALE nel messaggio.
app.post('/api/runs/:id/resume', requireTenant, (req, res) => {
  const run = loadRunForUser(req, res);
  if (!run) return;
  const decision = resumeDecision(run);
  if (decision.action === 'reject') {
    return res.status(decision.code).json({ error: decision.message, status: run.status });
  }
  if (decision.action === 'noop') {
    // Stato stantio lato UI: la run è già ripartita/ripartente. Nessuna
    // mutazione, si restituisce lo stato reale così la UI si riallinea.
    if (run.sessionKey) {
      pushSessionEvent(run.sessionKey, { type: 'resume', text: `${req.user.username}: ${decision.message}` });
    }
    return res.json(getRun(run.id));
  }
  // action === 'nudge': sticky → interrupted con retry immediato.
  journalManualResume(run.id);
  touchSession(run.sessionKey, {
    tenantId: run.tenantId, agentId: run.agentId, sessionId: run.sessionId,
    status: 'interrupted', lastError: null, runId: run.id,
  });
  pushSessionEvent(run.sessionKey, { type: 'resume', text: `ripresa richiesta da ${req.user.username}, il watchdog la riprenderà a breve` });
  logAudit({
    user: req.user.username, tenant: run.tenantId, agent: run.agentId,
    event: 'run_resumed_manual', detail: { runId: run.id },
  });
  res.json(getRun(run.id));
});

// ---- Registrazione run esterne nel journal (docs/governance.md) ----
// Qualunque processo/agente lanciato FUORI da runAgentTurn (es. via Bash dagli
// agenti dev) deve registrarsi qui: la run entra nel journal e compare in
// "Agenti live" come tutte le altre. Auth: header X-Agent-Key (chiave locale
// in data/agent-registration.key) oppure normale token utente.
// Ciclo: register → heartbeat (< 2 min di intervallo) → complete.
app.post('/api/runs/register', (req, res) => {
  const { tenantId, agentId, title, sessionId, username } = req.body ?? {};
  if (!tenantId || !agentId || !title) {
    return res.status(400).json({ error: 'tenantId, agentId e title richiesti' });
  }
  if (!tenantsConfig.tenants.some((t) => t.id === tenantId)) return res.status(404).json({ error: 'tenant non trovato' });
  if (!userCanTenant(req.user, tenantId)) return res.status(403).json({ error: 'tenant non assegnato' });
  // Kill switch PER-TENANT (task 6116efe1): tenant bloccato → nessuna run
  // esterna con quel tenantId. 409 esplicito così il processo esterno sa perché
  // e non riprova a ciclo. (Le run esterne del tenant già registrate vengono
  // fermate al block-time come le interne, requisito 5.)
  if (isTenantBlocked(tenantId)) {
    return res.status(409).json({ error: 'business bloccato: nessuna nuova run per questo tenant', blocked: getTenantBlockState(tenantId) });
  }
  const run = journalRegisterExternal({
    tenantId, agentId: String(agentId), sessionId,
    prompt: String(title), title: String(title),
    username: username ? String(username) : req.user.username,
  });
  logAudit({ user: req.user.username, tenant: tenantId, agent: run.agentId, event: 'external_run_registered', detail: { runId: run.id, title: run.prompt.slice(0, 120) } });
  res.status(201).json({ id: run.id, heartbeatMs: HEARTBEAT_MS, staleAfterMs: STALE_HEARTBEAT_MS });
});

// Heartbeat della run esterna: senza per più di 2 minuti il watchdog la marca
// failed ("processo sparito") e avvisa Owner con una push.
app.post('/api/runs/:id/heartbeat', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run non trovata' });
  if (!run.external) return res.status(409).json({ error: 'solo le run registrate via /api/runs/register accettano heartbeat esterni' });
  if (!userCanTenant(req.user, run.tenantId)) return res.status(403).json({ error: 'tenant non assegnato' });
  journalHeartbeat(run.id);
  // status nel response: se Owner ha premuto Ferma, il processo esterno lo
  // scopre qui e può terminare da solo (il server non può ucciderlo).
  res.json({ ok: true, status: getRun(run.id).status });
});

// Chiusura della run esterna: status "completed" (default) o "failed" + error.
app.post('/api/runs/:id/complete', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run non trovata' });
  if (!run.external) return res.status(409).json({ error: 'solo le run registrate via /api/runs/register si chiudono da qui' });
  if (!userCanTenant(req.user, run.tenantId)) return res.status(403).json({ error: 'tenant non assegnato' });
  const { status = 'completed', error } = req.body ?? {};
  if (status !== 'completed' && status !== 'failed') return res.status(400).json({ error: 'status deve essere completed o failed' });
  // journalUpdate diretto: l'esito reale del processo vince anche su un
  // eventuale "stopped" (il server non può comunque terminarlo).
  journalUpdate(run.id, {
    status, reason: null, nextRetryAt: null,
    lastError: status === 'failed' ? String(error ?? 'errore non specificato').slice(0, 500) : null,
  });
  logAudit({ user: req.user.username, tenant: run.tenantId, agent: run.agentId, event: 'external_run_completed', detail: { runId: run.id, status } });
  res.json(getRun(run.id));
});

// ---- Health del check periodico CEO (boardcheck.js) ----
// lastBoardCheckAt per ogni tenant (business e platform); stale = oltre 2×
// l'intervallo (la PWA mostra un avviso in "Agenti live"). Filtrato sui
// permessi dell'utente.
app.get('/api/board-checks', (req, res) => {
  const visible = tenantsConfig.tenants.filter((t) => userCanTenant(req.user, t.id));
  const health = boardCheckHealth(visible.map((t) => t.id));
  res.json(health.map((h) => {
    const t = visible.find((x) => x.id === h.tenantId);
    return { ...h, tenantName: t?.name ?? h.tenantId, tenantIcon: t?.icon ?? '' };
  }));
});

// ---- Pagina globale "Agenti live" (tutti gli utenti, filtrata sui permessi) ----
// Ogni utente vede SOLO le run degli agenti che può gestire (userCanAgent:
// admin = tutto, gli altri secondo tenants/agents assegnati). Il filtro è
// server-side, qui e sul broadcast WS. Run arricchite con nome business/agente
// per la UI; le chiuse da più di 24h sono escluse (la pagina mostra cosa gira
// o è ripartibile, non l'archivio storico).
const GLOBAL_CLOSED_HORIZON_MS = 24 * 60 * 60 * 1000;
function enrichRun(r) {
  const { tenant, agent } = findAgent(r.tenantId, r.agentId);
  return {
    ...r,
    // Fallback server-side per le run nel journal da prima della feature runTitle
    // (il campo resta popolato dal server, mai derivato in UI dal prompt).
    runTitle: r.runTitle || summarizeRunTitle(r.prompt),
    tenantName: tenant?.name ?? r.tenantId,
    tenantColor: tenant?.color ?? '#888',
    tenantIcon: tenant?.icon ?? '',
    agentName: agent?.name ?? r.agentId,
  };
}
// Filtro opzionale ?tenantId= (vista per-attività della stessa UI): il tenant
// richiesto deve comunque essere tra quelli dell'utente, e il filtro permessi
// per-agente resta identico — mai fidarsi del client.
app.get('/api/runs/global', (req, res) => {
  const { tenantId } = req.query;
  if (tenantId && !userCanTenant(req.user, tenantId)) return res.status(403).json({ error: 'tenant non assegnato' });
  const cutoff = Date.now() - GLOBAL_CLOSED_HORIZON_MS;
  const closed = ['completed', 'failed'];
  res.json(listRuns(tenantId || undefined)
    .filter((r) => userCanAgent(req.user, r.tenantId, r.agentId))
    .filter((r) => !closed.includes(r.status) || Date.parse(r.updatedAt ?? r.startedAt) >= cutoff)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .map(enrichRun));
});

// ---- Impostazioni runtime (solo admin): limite run autonome del dispatcher ----
// Persistite in server/data/settings.json (gitignored): effettive dal tick
// successivo del dispatcher, senza restart del server.
const autonomyView = (s) => ({ ...s, min: AUTONOMY_MIN, max: AUTONOMY_MAX, factoryDefault: AUTONOMY_FACTORY_DEFAULT });

app.get('/api/settings/autonomy', requireRole('admin'), (req, res) => {
  res.json(autonomyView(getAutonomySettings()));
});

app.put('/api/settings/autonomy', requireRole('admin'), (req, res) => {
  try {
    const next = setAutonomySettings(req.body ?? {}, tenantsConfig.tenants.map((t) => t.id));
    logAudit({ user: req.user.username, event: 'autonomy_limit_updated', detail: next });
    res.json(autonomyView(next));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- "Done" != "live" (task madre 61aea764, superficie server: task 2e6fb2e5) ----
// Task "done" con file server/** più recenti del boot (BOOT_TIME, sotto):
// il processo vivo carica i moduli ESM una sola volta, quindi quel codice è su
// disco ma NON attivo finché non arriva un restart. listPendingActivation stat-a
// solo i file delle task done (numero limitato) — costo accettabile, ma
// concurrencyView è pollato spesso (ping WS + refetch), quindi memoizzato con
// TTL breve per non ripetere gli stat ad ogni fetch.
const PENDING_ACTIVATION_TTL_MS = 15000;
let pendingActivationCache = { at: 0, value: { count: 0, list: [] } };
function pendingActivationView() {
  const now = Date.now();
  if (now - pendingActivationCache.at < PENDING_ACTIVATION_TTL_MS) return pendingActivationCache.value;
  const list = listPendingActivation(tenantsConfig.tenants, Date.parse(BOOT_TIME));
  const value = { count: list.length, list };
  pendingActivationCache = { at: now, value };
  return value;
}

// ---- Cap globale di agenti attivi in parallelo (selettore "agenti paralleli"
// in Agenti live): tutto/tutti gli utenti vedono contatore e coda, solo admin
// può cambiarne il valore. Effettivo subito (drainQueue esplicita se lo si
// alza; se lo si abbassa gli agenti in corso finiscono ma niente di nuovo
// parte finché non si rientra nel cap — vedi lib/concurrency.js). ----
const concurrencyView = () => ({
  cap: getGlobalCap(), min: GLOBAL_CAP_MIN, max: GLOBAL_CAP_MAX, factoryDefault: GLOBAL_CAP_FACTORY_DEFAULT,
  active: activeAgentCount(), queued: queueSnapshot().length,
  // Di cui sub-agenti in volo (fan-out via tool Task/Agent): inclusi in `active`
  // ma spawnati fuori dal journal, esposti a parte per osservabilità (task 19577ebf).
  subAgents: activeSubAgentCount(),
  // Stato globale del limite Claude (task ca71d849): il banner "limite raggiunto,
  // ripresa alle HH:MM" in Agenti live legge da qui (stesso fetch della coda).
  rateLimit: getLimitState(),
  // Kill switch globale (task 16fb8517): { paused, since, by, reason }. Il
  // toggle "pausa piattaforma" + banner in Agenti live legge da qui (stesso
  // fetch di cap/coda/rate-limit).
  platformPaused: getPlatformPauseState(),
  // Budget token empirico della finestra Max (task b8b98175): usato/stimato,
  // orario di reset, proiezione di esaurimento. L'indicatore in Agenti live
  // legge da qui (stesso fetch del cap/coda/rate-limit).
  budget: getBudgetState(),
  // Policy budget-aware del dispatcher (task 5998e8a7): flag derivati dal budget
  // residuo (shouldReserveForReview/shouldHaltAll/shouldThrottle). Rende VISIBILE
  // in UI lo stato "esecuzione in pausa per quota" — invisibile prima: sembrava
  // che gli agenti delegassero ma non partisse nulla. Il banner in Agenti live
  // legge da qui.
  budgetPolicy: budgetPolicy(),
  weeklyBudget: getWeeklyBudgetState(),
  // Task 212d9b82 (osservabilità): task cross-tenant con retry di dispatch
  // esauriti (run finite senza consegna 3 volte), in needs_input in attesa
  // dell'auto-retry o di un intervento umano — badge dedicato in Agenti live.
  dispatchExhausted: countDispatchExhausted(tenantsConfig.tenants),
  // Admission control a memoria (task 16edce3a): memAvailableMb/memLimitMb del
  // cgroup del container, deferredForMemory = run in coda perché il cap le
  // ammetterebbe ma la memoria no, oomFailures24h = run uccise da OOM (SIGKILL/
  // exit 137) nelle ultime 24h. Pronto per badge PWA (follow-up separato) e
  // digest serale.
  ...memoryView(),
  oomFailures24h: countOomFailures24h(),
  // Motivo esplicito per cui il PROSSIMO spawn autonomo non partirebbe subito
  // (task 9181275b, requisito 4): null se niente lo blocca. Stessa funzione
  // usata davvero da scheduleRun/drainQueue per ammettere o accodare — non è
  // una spiegazione a posteriori, è la decisione reale. blockReasonLabel è la
  // frase pronta per la UI ("6 in coda, limite: <label>") senza dover
  // ricostruire il motivo da cap/active/memAvailableMb lato client.
  blockReason: admissionBlockReason(),
  blockReasonLabel: BLOCK_REASON_LABELS[admissionBlockReason()] ?? null,
  // "Done" != "live" (task madre 61aea764): task chiuse dal gate ma il cui
  // codice server è più recente del boot del processo vivo — coda "Da
  // attivare" in Agenti live. count/list capped, vedi pendingActivationView sopra.
  pendingActivation: pendingActivationView(),
});

app.get('/api/settings/concurrency', (req, res) => {
  res.json(concurrencyView());
});

// Sblocco manuale del muro Claude (solo admin): se Owner sa che il limite è
// caduto prima del reset stimato, azzera lo stato e al prossimo tick il lavoro
// autonomo riparte (dispatcher/watchdog/coda). Nessun effetto se non c'è muro.
app.post('/api/settings/rate-limit/clear', requireRole('admin'), (req, res) => {
  clearRateLimit();
  logAudit({ user: req.user.username, event: 'rate_limit_cleared' });
  drainQueue();
  res.json(concurrencyView());
});

// ---- Kill switch globale (task 16fb8517): pausa/ripresa dell'INTERA
// piattaforma. Stato in GET /api/settings/concurrency (platformPaused) e anche
// qui in GET dedicata; toggle in POST (solo admin, stessa auth delle altre
// route di settings). Soft pause: le run in corso finiscono, non parte nulla
// di nuovo (dispatcher, cron/schedulati, chat/board). ----
app.get('/api/settings/platform-pause', requireRole('admin'), (req, res) => {
  res.json(getPlatformPauseState());
});

// Le run "attive" che l'eventuale "hard" fermerebbe: quelle davvero in
// esecuzione ora (running/resumed). Il conteggio serve alla checkbox UI "ferma
// anche le N run attive"; la lista permette al client di riusare il per-run
// stop già esistente (POST /api/runs/:id/stop) — nessun nuovo path di kill lato
// server (assunzione tecnica dichiarata: la pausa è soft, l'hard lo orchestra
// il client run-per-run).
function activeRunsForStop() {
  return listRuns()
    .filter((r) => RUNNING_STATES.has(r.status))
    .map((r) => ({ id: r.id, tenantId: r.tenantId, agentId: r.agentId, title: r.title ?? null, source: r.source ?? null }));
}

app.post('/api/settings/platform-pause', requireRole('admin'), (req, res) => {
  const paused = req.body?.paused;
  if (typeof paused !== 'boolean') {
    return res.status(400).json({ error: 'campo "paused" booleano richiesto (true = pausa, false = ripresa)' });
  }
  if (paused) {
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 200) : null;
    const state = pausePlatform({ by: req.user.username, reason });
    const active = activeRunsForStop();
    logAudit({ user: req.user.username, event: 'platform_paused', detail: { reason, activeRuns: active.length } });
    // activeRuns/activeRunList: per la checkbox "ferma anche le N run attive".
    // Lo stop effettivo lo fa il client sulle route per-run esistenti (hard).
    return res.json({ ...state, activeRuns: active.length, activeRunList: active });
  }
  const state = resumePlatform();
  logAudit({ user: req.user.username, event: 'platform_resumed' });
  drainQueue(); // effetto immediato: eventuali run in coda pre-pausa ripartono subito
  return res.json(state);
});

// ---- Kill switch PER-TENANT (task 6116efe1): blocca/sblocca un singolo
// business. Da bloccato la piattaforma NON lancia agenti per quel tenant
// (dispatcher, cron/system-job, spawn operativi, gate auto-advance, run
// esterne). Unica eccezione: Owner in chat al CEO fa partire la run del CEO.
// Stato persistito in server/data/tenant-blocks.json (sopravvive al riavvio).
// Solo admin, come le altre route di kill switch. Idempotenti. ----

// Stop grazioso di tutte le run attive del tenant (requisito 5): stesso path
// dello stop manuale (POST /api/runs/:id/stop) — journalStop + interrupt della
// query SDK viva — così non restano run zombie in "Agenti live". Torna quante
// ne ha fermate.
function stopTenantActiveRuns(tenantId, by) {
  let stopped = 0;
  for (const run of listRuns(tenantId)) {
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'stopped') continue;
    const prevStatus = run.status;
    journalStop(run.id, by);
    const q = activeQueries.get(run.id);
    if (q) q.interrupt().catch((err) => console.warn(`[tenant-block stop] interrupt run ${run.id}:`, err.message));
    if (run.sessionKey) {
      touchSession(run.sessionKey, {
        tenantId: run.tenantId, agentId: run.agentId, sessionId: run.sessionId,
        status: 'stopped', lastError: null, runId: run.id,
      });
      pushSessionEvent(run.sessionKey, { type: 'stopped', text: `business bloccato da ${by}` });
    }
    logAudit({ user: by, tenant: run.tenantId, agent: run.agentId, event: 'run_stopped', detail: { runId: run.id, wasAlive: Boolean(q), prevStatus, reason: 'tenant blocked' } });
    stopped += 1;
  }
  return stopped;
}

app.post('/api/tenants/:id/block', requireRole('admin'), (req, res) => {
  const tenantId = req.params.id;
  if (!tenantsConfig.tenants.some((t) => t.id === tenantId)) return res.status(404).json({ error: 'tenant non trovato' });
  const wasBlocked = isTenantBlocked(tenantId);
  const state = blockTenant(tenantId, { by: 'owner' });
  // Al primo blocco (idempotente: solo se non era già bloccato) fermiamo le run
  // attive e svuotiamo la coda del tenant, così "Agenti live" non resta con
  // zombie e nulla di accodato riparte.
  let stoppedRuns = 0; let droppedQueued = 0;
  if (!wasBlocked) {
    stoppedRuns = stopTenantActiveRuns(tenantId, req.user.username);
    droppedQueued = dropQueuedForTenant(tenantId);
  }
  logAudit({ user: req.user.username, tenant: tenantId, event: 'tenant_blocked', detail: { stoppedRuns, droppedQueued } });
  res.json({ ...state, stoppedRuns, droppedQueued });
});

app.post('/api/tenants/:id/unblock', requireRole('admin'), (req, res) => {
  const tenantId = req.params.id;
  if (!tenantsConfig.tenants.some((t) => t.id === tenantId)) return res.status(404).json({ error: 'tenant non trovato' });
  const state = unblockTenant(tenantId);
  logAudit({ user: req.user.username, tenant: tenantId, event: 'tenant_unblocked' });
  // Ripresa immediata senza restart (requisito 6): drena la coda e il prossimo
  // tick del dispatcher (già in esecuzione ogni 20s) riprende le task pendenti
  // del tenant da solo.
  drainQueue();
  res.json(state);
});

app.put('/api/settings/concurrency', requireRole('admin'), (req, res) => {
  try {
    const cap = setGlobalCap(req.body?.cap);
    logAudit({ user: req.user.username, event: 'global_cap_updated', detail: { cap } });
    drainQueue(); // effetto immediato se il cap si alza: libera subito eventuali code
    res.json(concurrencyView());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- System job (digest/backup): esecuzione manuale immediata (solo admin) ----
// Follow-up di 409bbf8c: forza un job registrato senza attendere il cron né
// firmare token a mano. Triggera by id (name) con lo STESSO codice del cron
// (source='manuale' distinguibile nel journal via audit system_job_run).
app.get('/api/system-jobs', requireRole('admin'), (req, res) => {
  res.json(listSystemJobs());
});

app.post('/api/system-jobs/:name/run-now', requireRole('admin'), (req, res) => {
  try {
    // Fire-and-forget come il tick del cron: alcuni job sono lunghi (digest
    // avvia una run LLM), non blocchiamo la request. L'esito finisce nel journal.
    runSystemJobNow(req.params.name, { source: 'manuale', user: req.user.username })
      .catch((err) => console.error(`[system-job] run manuale ${req.params.name} fallita:`, err.message));
    res.status(202).json({ ok: true, name: req.params.name, source: 'manuale' });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ---- Job agente configurabili da UI a runtime (task c5ff7ad3) ----------------
// GENERICA per jobId (code-quality, pm-platform, futuri): schedula un system
// job (lib/scheduler.js) ma cron/enabled sono modificabili a caldo — nessun
// restart — e persistiti in config/platform.json. Solo admin (stessa fascia di
// /api/system-jobs): sono leve operative con impatto budget.
app.get('/api/agent-jobs', requireRole('admin'), (req, res) => {
  res.json(listAgentJobs());
});

app.put('/api/agent-jobs/:jobId', requireRole('admin'), requireLegacyRuntime, (req, res) => {
  try {
    const job = updateAgentJob(req.params.jobId, req.body ?? {}, req.user.username);
    res.json(job);
  } catch (err) {
    const notFound = /non trovato/.test(err.message);
    res.status(notFound ? 404 : 400).json({ error: err.message });
  }
});

// Esecuzione immediata di un agent job fuori dal cron (QA/verifica manuale):
// riusa run-now del system job sottostante, stesso comportamento (fire-and-
// forget, source='manuale' nel journal), niente endpoint duplicato.
app.post('/api/agent-jobs/:jobId/run-now', requireRole('admin'), requireLegacyRuntime, (req, res) => {
  try {
    runSystemJobNow(req.params.jobId, { source: 'manuale', user: req.user.username })
      .catch((err) => console.error(`[agent-job] run manuale ${req.params.jobId} fallita:`, err.message));
    res.status(202).json({ ok: true, jobId: req.params.jobId, source: 'manuale' });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Coda di lanci autonomi in attesa di uno slot globale libero: stesso filtro
// permessi di GET /api/runs/global (userCanAgent), arricchita con nomi
// tenant/agente per la UI (badge "in attesa di slot").
app.get('/api/runs/queue', (req, res) => {
  res.json(queueSnapshot()
    .filter((q) => userCanAgent(req.user, q.tenantId, q.agentId))
    .map((q) => {
      const { tenant, agent } = findAgent(q.tenantId, q.agentId);
      return {
        ...q,
        tenantName: tenant?.name ?? q.tenantId,
        tenantIcon: tenant?.icon ?? '',
        tenantColor: tenant?.color ?? '#888',
        agentName: agent?.name ?? q.agentId,
      };
    }));
});

// ---- Inbox approvazioni (tool sensibili sospesi via canUseTool) ----
app.get('/api/approvals', requireTenant, (req, res) => {
  res.json(listApprovals(req.tenantId));
});

app.post('/api/approvals/:id', requireTenant, requireManage, (req, res) => {
  const { action, note } = req.body ?? {};
  if (action !== 'approve' && action !== 'deny') return res.status(400).json({ error: 'action deve essere approve o deny' });
  try {
    const a = resolveApproval(req.params.id, {
      approved: action === 'approve',
      note,
      resolvedBy: req.user.username,
    });
    if (a.tenantId !== req.tenantId) return res.status(403).json({ error: 'tenant non corrispondente' });
    res.json(a);
  } catch (err) {
    res.status(err.message === 'richiesta non trovata' ? 404 : 409).json({ error: err.message });
  }
});

// ---- Coda decisioni (popup dedicato Owner, task board 69413a7e) ----
// Unifica approvazioni tool pending + task in needs_input in una sola coda. Senza
// tenantId aggrega su TUTTI i business a cui l'utente ha accesso (il popup è
// globale: Owner vede tutto). Con tenantId filtra su quel business.
app.get('/api/decisions', (req, res) => {
  const { tenantId } = req.query;
  if (tenantId && !userCanTenant(req.user, tenantId)) return res.status(403).json({ error: 'tenant non assegnato' });
  const tenants = tenantsConfig.tenants.filter((t) => (tenantId ? t.id === tenantId : true) && userCanTenant(req.user, t.id));
  const decisions = tenants.flatMap((t) => listTenantDecisions(t));
  decisions.sort((x, y) => (x.requestedAt < y.requestedAt ? 1 : -1));
  res.json(decisions);
});

// Risoluzione di una decisione dal popup. body: { tenantId, value?, text?, answer? }.
// kind "tool": value approve/deny (+ text = nota). kind "task": answer (opzione+testo).
app.post('/api/decisions/:kind/:id', requireTenant, requireManage, (req, res) => {
  const { kind, id } = req.params;
  const { value, text, answer } = req.body ?? {};
  try {
    if (kind === 'tool') {
      if (value !== 'approve' && value !== 'deny') return res.status(400).json({ error: 'value deve essere approve o deny' });
      const a = resolveApproval(id, { approved: value === 'approve', note: text, resolvedBy: req.user.username });
      if (a.tenantId !== req.tenantId) return res.status(403).json({ error: 'tenant non corrispondente' });
      return res.json({ ok: true, kind, id, status: a.status });
    }
    if (kind === 'task') {
      const updated = answerTaskDecision(req.tenantId, id, { answer: answer ?? text }, `user:${req.user.username}`);
      return res.json({ ok: true, kind, id, status: updated.status });
    }
    return res.status(400).json({ error: 'kind non valido (tool|task)' });
  } catch (err) {
    const code = /non trovata/.test(err.message) ? 404 : /già risolta|non è in attesa/.test(err.message) ? 409 : 400;
    res.status(code).json({ error: err.message });
  }
});

// ---- Agenti schedulati ----
app.get('/api/schedules', requireTenant, (req, res) => {
  res.json(listSchedules(req.tenantId));
});

app.post('/api/schedules', requireTenant, requireManage, requireLegacyRuntime, (req, res) => {
  try {
    const { cron, agentId, prompt, enabled } = req.body ?? {};
    const { agent } = findAgent(req.tenantId, agentId);
    if (!agent) return res.status(404).json({ error: 'agente non trovato' });
    res.status(201).json(createSchedule({ cron, tenantId: req.tenantId, agentId, prompt, enabled }, req.user.username));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/schedules/:id', requireTenant, requireManage, requireLegacyRuntime, (req, res) => {
  try {
    const existing = listSchedules(req.tenantId).find((s) => s.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'schedulazione non trovata' });
    const { cron, prompt, enabled } = req.body ?? {};
    res.json(updateSchedule(req.params.id, { cron, prompt, enabled }, req.user.username));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/schedules/:id', requireTenant, requireManage, requireLegacyRuntime, (req, res) => {
  const existing = listSchedules(req.tenantId).find((s) => s.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'schedulazione non trovata' });
  deleteSchedule(req.params.id, req.user.username);
  res.json({ ok: true });
});

// ---- Esecuzione di un turno agente (usata da /api/chat, scheduler e watchdog) ----
// resumeSessionId/resumeOfRunId: usati dal watchdog per riprendere una run interrotta
// (resume della sessione SDK salvata nel journal, stessa entry di journal).
//
// Thin orchestrator (task 829e29c2 — ex God-function da 498 righe): risolve
// agente/tenant, persiste i messaggi in ingresso, apre il journal e delega i
// 3 blocchi pesanti a server/lib/runturn/ — buildPromptForModel/buildSystemPrompt/
// resolveTurnAccess (prompt + tool/permessi), streamTurn (loop SDK con
// retry/resume/backoff) e finalizeTurn (persistenza esito). Zero cambi di
// comportamento rispetto alla versione monolitica: MOVE puro.
async function runAgentTurnInner(ctx) {
  const {
    tenantId, agentId, sessionId, message, username, onDelta, onReset, onRun,
    resumeSessionId, resumeOfRunId, source, taskId, attachments, runTitle, extraQueued,
  } = ctx;
  const { tenant, agent } = findAgent(tenantId, agentId);
  if (!agent) throw new Error('agente non trovato');
  const key = `${tenantId}:${agentId}:${sessionId}`;
  // Allegati del messaggio (task 4f7337df): {id,name,stored,type,kind,size,url,path}.
  // Il path assoluto è stato risolto e validato lato /api/chat (mai fidarsi del client).
  const atts = Array.isArray(attachments) ? attachments : [];
  // Persistenza messaggio utente + eventuali accodati (task 311d2946) e
  // costruzione del prompt per il modello: vedi server/lib/runturn/prompt.js.
  const { promptForModel: userPrompt } = ingestIncomingMessages({
    tenantId, agentId, sessionId, message, username, attachments: atts, extraQueued,
  });
  // Stato volatile del turno (budget finestra / quota al muro) — solo per chi
  // orchestra. Sta QUI e non nel system prompt (task token-diet): il system
  // prompt deve restare byte-identico fra turni per essere servito dalla cache.
  // Non entra in history: è stato del momento, non un messaggio di Owner.
  const turnPreamble = buildTurnPreamble({ tenant, agent });
  const promptForModel = turnPreamble ? `${turnPreamble}\n\n${userPrompt}` : userPrompt;

  touchSession(key, {
    tenantId, agentId, sessionId,
    agentName: agent.name, status: 'working', lastError: null, startedBy: username,
  });
  pushSessionEvent(key, { type: 'user_message', text: String(message).slice(0, 200) });

  const startedAt = Date.now();

  // Model tiering (docs/model-tiering.md): agent.model è l'alias di tier del
  // manifest ("fable-5"/"opus"/"sonnet"/"haiku"), MAI l'id modello reale —
  // risolto qui, per-agente, non ereditato da chi ha lanciato la run (dispatcher
  // compreso): ogni run usa sempre e solo il tier del proprio ruolo.
  const { tier: modelTier, model: resolvedModel, warning: tierWarning } = resolveModel(agent.model);
  if (tierWarning) console.warn(`[model-tiering] ${key}: ${tierWarning}`);

  // Journal persistente: la run è tracciata su disco prima di partire, con
  // heartbeat periodico. Se il processo muore, il watchdog la riprenderà.
  const runId = journalStart({
    tenantId, agentId, sessionId, sessionKey: key, prompt: message, username, resumeOfRunId, source, taskId,
    model: modelTier, resolvedModel, runTitle,
  });
  if (tierWarning) journalUpdate(runId, { modelWarning: tierWarning });
  const heartbeatTimer = setInterval(() => journalHeartbeat(runId), HEARTBEAT_MS);
  heartbeatTimer.unref?.();
  // Timeout wall-clock (task 019ab89d): una run che non produce un risultato
  // entro RUN_WALLCLOCK_TIMEOUT_MS è impiantata (query SDK bloccata, tool che non
  // ritorna, deadlock). Alla scadenza la marchiamo failed (reason 'timeout') e
  // interrompiamo PULITO la query SDK viva (activeQueries): l'interrupt fa uscire
  // il for-await con errore, finalizeTurn vede lo stato già terminale e NON la
  // rimette in coda (niente resume su un punto morto). Stop/pausa manuali già
  // arrivati vincono (sticky): non li tocchiamo. Il timer è unref: non tiene su
  // l'event-loop, e viene azzerato nel finally a fine turno.
  let deadlineTimer = null;
  if (RUN_WALLCLOCK_TIMEOUT_MS > 0) {
    deadlineTimer = setTimeout(() => {
      if (isStickyStatus(getRun(runId)?.status)) return;
      journalTimeout(runId, RUN_WALLCLOCK_TIMEOUT_MS);
      touchSession(key, { status: 'failed', runId, lastError: getRun(runId)?.lastError ?? 'timeout wall-clock' });
      pushSessionEvent(key, { type: 'timeout', text: `timeout wall-clock (${Math.round(RUN_WALLCLOCK_TIMEOUT_MS / 60000)} min): run terminata` });
      logAudit({ user: 'system', tenant: tenantId, agent: agentId, event: 'run_timeout', detail: { runId, timeoutMs: RUN_WALLCLOCK_TIMEOUT_MS } });
      const q = activeQueries.get(runId);
      if (q) q.interrupt().catch((err) => console.warn(`[timeout] interrupt run ${runId}:`, err.message));
    }, RUN_WALLCLOCK_TIMEOUT_MS);
    deadlineTimer.unref?.();
  }
  // runId esposto alla tab "Agenti attivi": serve al bottone Ferma/Riprendi.
  touchSession(key, { runId });
  // runId anche al chiamante (es. /api/chat lo manda al client per il bottone STOP).
  onRun?.(runId);

  const systemPrompt = buildSystemPrompt({ tenant, tenantId, agent });
  const {
    mcpServers, allowedTools, canUseTool, knowledgeDir, grantReadForAttachments,
  } = resolveTurnAccess({ tenant, agent, tenantId, agentId, sessionKey: key, source, taskId, attachments: atts, repoRoot: REPO_ROOT, tenants: tenantsConfig.tenants });

  try {
    let outcome;
    try {
      const result = await streamTurn(
        {
          tenantId, agentId, sessionId, key, runId, agent, modelTier, resolvedModel,
          promptForModel, systemPrompt, allowedTools, mcpServers, canUseTool,
          knowledgeDir, grantReadForAttachments, resumeSessionId, onDelta, onReset,
          username, startedAt,
        },
        { query, withLock, activeQueries, sessionMap, saveSessionMap, OAUTH_TOKEN },
      );
      outcome = { ok: true, result };
    } catch (err) {
      outcome = { ok: false, err };
    }
    return await finalizeTurn({ tenantId, agentId, sessionId, key, runId, agent }, outcome);
  } finally {
    clearInterval(heartbeatTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    activeQueries.delete(runId);
    // Ripulisci eventuali sub-agenti ancora contati per questa run (fan-out non
    // chiuso da un tool_result, o run morta a metà): niente conteggi fantasma
    // nel cap globale (task 19577ebf).
    subAgentEndRun(runId);
  }
}

// Wrapper pubblico di runAgentTurnInner (task 311d2946, coda messaggi chat):
// marca la sessione "occupata" per tutta la durata del turno (usato da
// /api/chat per decidere se accodare un messaggio in arrivo invece di avviarne
// uno in parallelo) e, SOLO se il turno finisce con successo, drena in
// background la coda persistita e consegna in blocco quanto accodato nel
// frattempo come turno successivo. Su errore/stop/pausa non si drena qui: se
// la run era un errore non-sticky il watchdog la riprenderà con un nuovo giro
// di runAgentTurn (stesso wrapper, drena al suo successo); se sticky (stop/
// pausa) è l'utente ad aver fermato deliberatamente, i messaggi restano in
// coda finché non riparte un turno vero.
async function runAgentTurn(args) {
  const { tenantId, agentId, sessionId } = args;
  const key = `${tenantId}:${agentId}:${sessionId}`;
  busySessions.add(key);
  let succeeded = false;
  try {
    const result = await runAgentTurnInner(args);
    succeeded = true;
    return result;
  } finally {
    busySessions.delete(key);
    if (succeeded) {
      processQueuedFollowup(tenantId, agentId, sessionId).catch((err) => {
        console.error(`[chat-queue] ${key}: drain fallito:`, err.message);
      });
    }
  }
}

// Consegna in blocco (UN turno solo) i messaggi accodati durante il turno
// appena finito con successo. Fire-and-forget: chiamata dal wrapper sopra e
// dalla riconciliazione al boot, mai atteso dal chiamante del turno originale
// (altrimenti la risposta SSE di /api/chat resterebbe appesa in attesa di N
// turni concatenati). Si richiama da sola in loop naturale: ogni turno che
// finisce (incluso questo di follow-up, che passa dallo stesso wrapper) drena
// di nuovo la coda, quindi eventuali messaggi arrivati nel frattempo non
// restano bloccati.
async function processQueuedFollowup(tenantId, agentId, sessionId) {
  const key = `${tenantId}:${agentId}:${sessionId}`;
  // Nel frattempo è ripartito un turno per questa stessa sessione (piccola
  // finestra di corsa tra la fine di un turno e l'avvio del suo follow-up): non
  // partire in parallelo, sarà quel turno a drenare di nuovo al suo termine.
  if (busySessions.has(key)) return;
  const items = drainQueued(tenantId, agentId, sessionId);
  if (items.length === 0) return;
  // Riallegatura: gli allegati in coda sono solo metadati (mai il path assoluto,
  // persistito lato server) — vanno ririsolti e revalidati come farebbe
  // /api/chat in ingresso. Un allegato non più valido (es. cancellato) viene
  // scartato senza bloccare la consegna degli altri messaggi.
  const resolveAtts = (atts) => (Array.isArray(atts) ? atts : []).flatMap((a) => {
    const path = resolveUpload(tenantId, a?.stored);
    return path ? [{ ...a, path }] : [];
  });
  const [first, ...rest] = items;
  try {
    await runAgentTurn({
      tenantId, agentId, sessionId,
      message: first.message,
      attachments: resolveAtts(first.attachments),
      username: first.username,
      extraQueued: rest.map((m) => ({
        message: m.message, attachments: resolveAtts(m.attachments), username: m.username,
      })),
      source: 'chat-queue',
    });
  } catch (err) {
    console.error(`[chat-queue] ${key}: turno accodato fallito:`, err.message);
  }
}

// POST /api/chat — risposta in streaming via SSE.
// Eventi: {type:"delta", text}, {type:"done", sessionId, fullText}, {type:"error", message}
app.post('/api/chat', requireLegacyRuntime, async (req, res) => {
  const { tenantId, agentId, message, sessionId } = req.body ?? {};
  const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  // Il messaggio può essere vuoto SE ci sono allegati (invio del solo file).
  if (!tenantId || !agentId || !sessionId || (!message && rawAttachments.length === 0)) {
    return res.status(400).json({ error: 'tenantId, agentId, sessionId e (message o attachments) richiesti' });
  }
  if (!userCanAgent(req.user, tenantId, agentId)) return res.status(403).json({ error: 'agente non assegnato' });
  const { agent } = findAgent(tenantId, agentId);
  if (!agent) return res.status(404).json({ error: 'agente non trovato' });
  // Kill switch globale (task 16fb8517): piattaforma in pausa → non avviare
  // NUOVE run da chat/board ("non parte nulla di nuovo"). Le run già in corso
  // finiscono il loro giro; qui blocchiamo prima di aprire lo stream SSE con un
  // 423 (Locked) esplicito così la UI mostra "piattaforma in pausa". Il resume
  // è un tap sul toggle in Agenti live (route dedicata), non serve la chat.
  if (isPlatformPaused()) {
    return res.status(423).json({ error: 'piattaforma in pausa: nessuna nuova run', platformPaused: getPlatformPauseState() });
  }
  // Kill switch PER-TENANT (task 6116efe1) + ECCEZIONE CHAT: tenant bloccato →
  // l'UNICO agente raggiungibile è il CEO (Owner può sempre scrivergli e la run
  // del CEO parte comunque). Ogni altro agente del tenant è irraggiungibile
  // (423). In questo stato il CEO può creare/aggiornare task e rispondere in
  // chat, ma NON può dispatchare/spawnare altri agenti: quei path (dispatcher,
  // scheduleRun) restano bloccati dal kill switch, non serve altro qui.
  if (isTenantBlocked(tenantId) && agent.role !== 'CEO') {
    return res.status(423).json({ error: 'business bloccato: solo il CEO è raggiungibile', blocked: getTenantBlockState(tenantId) });
  }
  // Attività interattiva: rimanda ogni auto-restart (idle richiesto >2 min).
  autoRestart.markInteractive();

  // Allegati: si risolve il path assoluto lato server dal solo `stored` (mai dal
  // client) con difesa dal path traversal; se un allegato non esiste → errore.
  const attachments = [];
  for (const a of rawAttachments) {
    const path = resolveUpload(tenantId, a?.stored);
    if (!path) return res.status(400).json({ error: `allegato non valido o mancante: ${a?.name ?? a?.stored ?? '?'}` });
    attachments.push({
      id: a.id, name: a.name, stored: a.stored, type: a.type,
      kind: a.kind, size: a.size, url: a.url, path,
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Coda messaggi in chat (task 311d2946): l'agente sta già lavorando un turno
  // su questa conversazione (sessione occupata) → il messaggio si accoda su
  // disco invece di avviare un turno parallelo (o farlo aspettare). Verrà
  // consegnato in blocco con gli altri eventualmente accodati, come UNICO
  // turno successivo, appena il turno in corso finisce (processQueuedFollowup).
  const sessKey = `${tenantId}:${agentId}:${sessionId}`;
  if (busySessions.has(sessKey)) {
    const entry = enqueueMessage(tenantId, agentId, sessionId, {
      message: message ?? '', attachments, username: req.user.username,
    });
    const pending = queueDepth(tenantId, agentId, sessionId);
    logAudit({ user: req.user.username, tenant: tenantId, agent: agentId, event: 'chat_message_queued', detail: { messageId: entry.id, pending } });
    send({ type: 'queued', messageId: entry.id, pending });
    res.end();
    return;
  }

  let runId = null;
  try {
    const { fullText } = await runAgentTurn({
      tenantId, agentId, sessionId, message: message ?? '', attachments,
      username: req.user.username,
      onDelta: (text) => send({ type: 'delta', text }),
      onReset: () => send({ type: 'reset' }),
      // runId al client appena la run è journaled: serve al bottone STOP
      // (POST /api/runs/:id/stop, stessa logica della tab "Agenti attivi").
      onRun: (id) => { runId = id; send({ type: 'run', runId: id }); },
    });
    send({ type: 'done', sessionId, fullText });
  } catch (err) {
    // Stop/pausa manuale: chiusura pulita, non è un errore — il client tiene
    // il testo parziale (che su stop è anche già persistito in history).
    // `finalStatus` è lo STATO della run ('paused' | 'stopped' | ...), non un
    // booleano: serve sia al predicato sia al payload inviato al client.
    const finalStatus = runId ? getRun(runId)?.status : null;
    if (isStickyStatus(finalStatus)) {
      send({ type: 'stopped', status: finalStatus });
    } else {
      console.error(`[chat] ${tenantId}:${agentId}:${sessionId}:`, err.message);
      send({ type: 'error', message: err.message });
    }
  }
  res.end();
});

// ---- Coda messaggi in chat (task 311d2946) ----
// GET stato: n. messaggi pending + elenco (id, testo, chi l'ha scritto, quando
// — mai il path assoluto degli allegati, solo i metadati già persistiti).
app.get('/api/chat/queue', requireTenant, (req, res) => {
  const { agentId, sessionId } = req.query;
  if (!agentId || !sessionId) return res.status(400).json({ error: 'agentId e sessionId richiesti' });
  if (!userCanAgent(req.user, req.tenantId, agentId)) return res.status(403).json({ error: 'agente non assegnato' });
  const messages = listQueued(req.tenantId, agentId, sessionId);
  res.json({ pending: messages.length, messages });
});

// DELETE cancella un messaggio accodato PRIMA che venga consegnato (se nel
// frattempo è già partito il turno di consegna, non lo trova più: 404).
app.delete('/api/chat/queue/:messageId', requireTenant, (req, res) => {
  const { agentId, sessionId } = req.query;
  if (!agentId || !sessionId) return res.status(400).json({ error: 'agentId e sessionId richiesti' });
  if (!userCanAgent(req.user, req.tenantId, agentId)) return res.status(403).json({ error: 'agente non assegnato' });
  const removed = cancelQueued(req.tenantId, agentId, sessionId, req.params.messageId);
  if (!removed) return res.status(404).json({ error: 'messaggio in coda non trovato (già consegnato o mai esistito)' });
  logAudit({ user: req.user.username, tenant: req.tenantId, agent: agentId, event: 'chat_queue_cancel', detail: { messageId: req.params.messageId } });
  res.json({ ok: true, pending: queueDepth(req.tenantId, agentId, sessionId) });
});

// ---- Serving pubblico /preview/<tenantId>/<slug> (task 4ab8c6b8) ----
// NIENTE auth: stesso comportamento pubblico delle preview statiche preesistenti
// di business-a (link condivisi direttamente, pagina noindex/nofollow).
// Registrate PRIMA di express.static(DIST) sotto, quindi hanno priorità — ma
// il pattern a 2 segmenti (:tenantId/:slug) non intercetta gli URL preesistenti
// a 1 segmento tipo /preview/masterclass.html, che restano serviti da
// express.static com'era prima (compatibilità, nessun redirect necessario:
// schema diverso = niente collisione di path).
const notFoundPreviewPage = (msg) => `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="robots" content="noindex,nofollow"><title>Preview non trovata</title>
<style>body{background:#0f0f10;color:#eee;font:16px system-ui;padding:40px 20px}a{color:#e8b923}</style>
</head><body><p>${msg}</p><p><a href="/preview/">← indice preview</a></p></body></html>`;

// Routing non-strict di Express: '/preview' e '/preview/' matchano la stessa route.
app.get('/preview', (req, res) => {
  const groups = tenantsConfig.tenants.map((t) => ({ id: t.id, name: t.name, items: listPreviews(t.id) }));
  res.type('html').send(renderIndexHtml(groups));
});

app.get('/preview/:tenantId/:slug', (req, res) => {
  const { tenantId, slug } = req.params;
  const entry = getPreview(tenantId, slug);
  const filePath = entry && resolvePreviewFile(tenantId, entry);
  if (!entry || !filePath) return res.status(404).type('html').send(notFoundPreviewPage('Deliverable non trovato.'));
  const tenantName = tenantsConfig.tenants.find((t) => t.id === tenantId)?.name ?? tenantId;
  if (entry.tipo === 'markdown') {
    const md = readFileSync(filePath, 'utf8');
    return res.type('html').send(renderMarkdownDeliverable(entry, md, tenantName));
  }
  if (entry.tipo === 'html') {
    // Sandbox a livello di risposta (non serve un iframe): niente top-navigation,
    // niente popup/form fuori pagina. Il markup del deliverable resta intatto.
    res.set('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups");
  }
  res.set('X-Content-Type-Options', 'nosniff');
  res.type(mimeForEntry(entry));
  if (entry.tipo === 'pdf' || entry.tipo === 'immagine') res.set('Content-Disposition', 'inline');
  res.sendFile(filePath);
});

// In produzione il server serve anche la PWA compilata (web/dist).
const DIST = join(__dirname, '..', 'web', 'dist');
if (existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(join(DIST, 'index.html')));
}

// ---- Stamp di versione del codice (anti stale-code, incidente 2026-07-23 444b2313) ----
// Il server carica i moduli ESM UNA volta all'avvio: una modifica a server/lib
// diventa live SOLO dopo un restart. Per rendere la staleness *rilevabile* senza
// indovinare, allo start fotografiamo lo SHA git e la mtime più recente sotto
// server/lib; /api/version espone questi dati + bootTime, così chiunque (o uno
// script) può confrontare la mtime a disco ADESSO con bootTime: se un file di
// server/lib è più recente del boot → il processo è stantio, serve un restart.
const BOOT_TIME = new Date().toISOString();
function newestLibMtime() {
  try {
    const dir = join(__dirname, 'lib');
    let newest = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const m = statSync(join(dir, f)).mtimeMs;
      if (m > newest) newest = m;
    }
    return newest ? new Date(newest).toISOString() : null;
  } catch { return null; }
}
function gitHead() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: __dirname, encoding: 'utf8' }).trim().length > 0;
    return { sha, dirty };
  } catch { return { sha: null, dirty: null }; }
}
const CODE_VERSION = { bootTime: BOOT_TIME, git: gitHead(), libMtimeAtBoot: newestLibMtime() };
// Endpoint diagnostico (metadati innocui, nessun segreto): confronta la mtime
// a disco col bootTime per capire se il processo serve codice vecchio.
app.get('/api/version', (_req, res) => {
  const liveLib = newestLibMtime();
  const stale = !!(liveLib && liveLib > CODE_VERSION.bootTime);
  res.json({
    ...CODE_VERSION,
    libMtimeNow: liveLib,
    stale,
    restartNeeded: stale, // alias esplicito: una modifica a server/lib è su disco ma non ancora live
  });
});

// ---- Auto-restart della piattaforma (task board 03a4d9d6) -------------------
// Conta le run realmente attive (running/resumed/interrupted, tutti i tenant):
// gate primario dell'auto-restart (mai riavviare mentre un agente lavora).
function countActiveRuns() {
  return listRuns().filter((r) => ['running', 'resumed', 'interrupted'].includes(r.status)).length;
}
function restartStatus(now = Date.now()) {
  const liveLib = newestLibMtime();
  const stale = !!(liveLib && liveLib > CODE_VERSION.bootTime);
  const config = autoRestart.loadConfig();
  const activeRuns = countActiveRuns();
  const idleMs = autoRestart.idleSince(now);
  const decision = autoRestart.decide({ stale, activeRuns, now, config, idleMsNow: idleMs });
  return {
    bootTime: CODE_VERSION.bootTime,
    restartNeeded: decision.restartNeeded,
    shouldRestart: decision.shouldRestart,
    reason: decision.reason,
    detail: decision.detail,
    activeRuns,
    idleMs: Number.isFinite(idleMs) ? idleMs : null,
    restartsLastHour: autoRestart.restartsLastHour(now),
    config: {
      enabled: config.enabled,
      dockerPolicyConfirmed: config.dockerPolicyConfirmed,
      idleMs: config.idleMs,
      maxPerHour: config.maxPerHour,
      windowStart: config.windowStart,
      windowEnd: config.windowEnd,
    },
  };
}
// Stato per la UI (Agenti live): serve a qualunque utente loggato (no segreti).
app.get('/api/restart-status', (_req, res) => res.json(restartStatus()));

// "Riavvia ora" dalla PWA (solo admin): forza il riavvio a mano. Richiede la
// restart-policy Docker confermata (senza, l'uscita lascerebbe il container giù)
// salvo override esplicito { force: true }. Registra il marker di verifica e
// avvia l'uscita pulita (SIGTERM → backup pre-restart già esistente → exit).
app.post('/api/restart', requireRole('admin'), (req, res) => {
  const config = autoRestart.loadConfig();
  const force = req.body?.force === true;
  if (!config.dockerPolicyConfirmed && !force) {
    return res.status(409).json({
      error: 'restart-policy Docker non confermata: senza, il container non risale da solo. Conferma la policy (task 49bcf241) o invia { force: true }.',
    });
  }
  logAudit({ user: req.user.username, event: 'manual_restart', detail: { force } });
  triggerRestart('manuale', req.user.username);
  res.status(202).json({ ok: true, reason: 'manuale' });
});

// Uscita pulita che porta al restart: scrive il marker per la verifica post-boot,
// poi manda SIGTERM a sé stesso → l'handler preRestartBackup fa backup + exit(0)
// → la restart-policy Docker rialza il container col codice nuovo. Guardia
// `restartTriggered` per non inviare due volte. `countedInRateLimit=true` solo
// per i restart AUTOMATICI (l'anti-loop non deve bloccare i riavvii manuali di
// Owner). L'uscita è differita (setImmediate) così la HTTP response fa in tempo
// a flushare.
let restartTriggered = false;
function triggerRestart(reason, by = 'system', { countInRateLimit = false } = {}) {
  if (restartTriggered) return;
  restartTriggered = true;
  const now = Date.now();
  autoRestart.writePendingMarker({
    reason,
    by,
    exitAt: new Date(now).toISOString(),
    bootTimeBefore: BOOT_TIME,
    targetLibMtime: newestLibMtime(),
  });
  if (countInRateLimit) autoRestart.recordRestart(now);
  console.log(`[auto-restart] uscita pulita per restart (motivo: ${reason}, by: ${by})`);
  logAudit({ event: 'restart_triggered', detail: { reason, by } });
  setImmediate(() => {
    try { process.kill(process.pid, 'SIGTERM'); } catch { process.exit(0); }
  });
}

// Tick dell'auto-restart (chiamato dal battito dello scheduler): valuta i gate
// (stale + enabled + policy Docker + nessuna run attiva + idle chat >2min +
// finestra + tetto/ora) e, se tutti verdi, avvia il riavvio. Inerte finché la
// feature è disabilitata o la restart-policy non è confermata (precondizione).
function maybeAutoRestartTick() {
  if (restartTriggered) return;
  const liveLib = newestLibMtime();
  const stale = !!(liveLib && liveLib > CODE_VERSION.bootTime);
  if (!stale) return; // caso comune: niente da fare, zero costo
  const config = autoRestart.loadConfig();
  const decision = autoRestart.decide({ stale, activeRuns: countActiveRuns(), config });
  if (decision.shouldRestart) {
    triggerRestart('auto (codice stantio)', 'system', { countInRateLimit: true });
  }
}

// Verifica post-restart automatica (task 03a4d9d6 punto 3): al boot, se esiste
// un marker di riavvio, confronta il bootTime attuale con la mtime target e lo
// stato stale. Successo → push informativa a Owner col downtime. Se il processo
// è tornato ma è ANCORA stale (il restart non ha caricato il codice nuovo) →
// push di allarme col comando manuale di fallback, e NESSUN secondo tentativo
// (restartTriggered non viene toccato: l'auto-restart resta fermo su questo boot).
// La verifica gira una sola volta e poi cancella il marker.
function verifyPostRestartOnBoot() {
  const marker = autoRestart.readPendingMarker();
  if (!marker) return;
  autoRestart.clearPendingMarker();
  const liveLib = newestLibMtime();
  const stale = !!(liveLib && liveLib > CODE_VERSION.bootTime);
  const bootMs = Date.parse(BOOT_TIME);
  const exitMs = Date.parse(marker.exitAt);
  const downtimeS = Number.isFinite(bootMs) && Number.isFinite(exitMs) ? Math.max(0, Math.round((bootMs - exitMs) / 1000)) : null;
  const bootAfterTarget = marker.targetLibMtime ? bootMs > Date.parse(marker.targetLibMtime) : true;
  const ok = !stale && bootAfterTarget;
  logAudit({ event: 'post_restart_verify', detail: { ok, stale, downtimeS, reason: marker.reason } });
  if (ok) {
    notify('platform', {
      title: '✅ Piattaforma aggiornata e riavviata',
      body: `Aggiornamento server applicato e verificato${downtimeS != null ? ` (${downtimeS}s di downtime)` : ''}.`,
      tag: 'platform-restart',
    });
  } else {
    notify('platform', {
      title: '⚠️ Riavvio piattaforma da verificare',
      body: `Il processo è ripartito ma risulta ancora stale=${stale}. Nessun secondo tentativo automatico. Fallback manuale dall'host: docker restart <container-agent-platform>.`,
      tag: 'platform-restart-alarm',
    });
  }
}

const PORT = process.env.PORT || 3100;
const server = app.listen(PORT, () => {
  console.log(`Agent Platform server su http://localhost:${PORT} — ${tenantsConfig.tenants.length} org caricate`);
  console.log(`[version] boot ${BOOT_TIME} · git ${CODE_VERSION.git.sha ?? '?'}${CODE_VERSION.git.dirty ? '-dirty' : ''} · server/lib mtime ${CODE_VERSION.libMtimeAtBoot ?? '?'}`);
});

// WebSocket per aggiornamenti realtime (sessioni agente, task, approvazioni).
initWebSocket(server, verifyToken, userCanTenant);

// Le richieste di approvazione (e le loro risoluzioni) vanno ai client del tenant.
setApprovalListener((approval) => {
  broadcast(approval.tenantId, { type: 'approval', approval });
  // Alla risoluzione la run riparte: stato agente di nuovo working.
  if (approval.status === 'approved' || approval.status === 'denied') {
    touchSession(approval.sessionKey, { status: 'working' });
    pushSessionEvent(approval.sessionKey, {
      type: 'approval_resolved',
      name: approval.toolName,
      text: approval.status === 'approved' ? 'approvato' : `rifiutato${approval.note ? `: ${approval.note}` : ''}`,
    });
  }
});

// Avvio scheduler degli agenti programmati (le run appaiono in "Agenti attivi").
// Sul suo stesso tick girano il watchdog (riprende le run interrotte e le pause
// a tempo scadute) e il dispatcher delle task autonome (limite run per tenant
// settabile da Owner in settings.json, precedenza alle run interattive).
const notify = (tenantId, payload) => notifyTenant(tenantId, payload, pushDeps);
function maybeNotifyV2Project(tenantId, project) {
  const tenant = tenantsConfig.tenants.find((item) => item.id === tenantId);
  const candidate = getV2ProjectPushCandidate(project, { tenantName: tenant?.name ?? tenantId });
  if (!candidate) return;
  try {
    markProjectNotificationSent(tenantId, project.id, { kind: candidate.kind, stamp: candidate.stamp }, 'system');
  } catch (err) {
    logAudit({ tenant: tenantId, event: 'v2_project_notification_mark_failed', detail: { projectId: project?.id ?? null, kind: candidate.kind, message: String(err?.message ?? err).slice(0, 200) } });
    return;
  }
  notifyTenant(tenantId, candidate.payload, pushDeps).catch((err) => {
    logAudit({ tenant: tenantId, event: 'push_send_error', detail: { projectId: project.id, kind: candidate.kind, message: String(err?.message ?? err).slice(0, 200) } });
  });
}
function handleV2ProjectUpdate(tenantId, project) {
  broadcast(tenantId, { type: 'v2_project', project });
  maybeNotifyV2Project(tenantId, project);
}

// Al boot nessun turno Architect può essere vivo: azzera i flag rimasti stantii.
clearStaleArchitectBusy(tenantsConfig.tenants.map((tenant) => tenant.id));
clearStaleProjectStepDispatchClaims(tenantsConfig.tenants.map((tenant) => tenant.id));
startScheduler(runAgentTurn, () => {
  if (!V2_EXCLUSIVE_MODE) {
    watchdogTick({ runFn: runAgentTurn, notify });
    try {
      dispatcherTick({ tenants: tenantsConfig.tenants, runFn: runAgentTurn, notify });
    } catch (err) {
      console.error('[dispatcher] tick fallito:', err.message);
    }
    try {
      boardCheckTick({ tenants: tenantsConfig.tenants, runFn: runAgentTurn });
    } catch (err) {
      console.error('[board-check] tick fallito:', err.message);
    }
  }
  recoverV2Projects(tenantsConfig.tenants.map((tenant) => tenant.id), handleV2ProjectUpdate);
  // NB: lo sweep di sollecito per needs_input askless ferme >6h (task e09455bd,
  // lib/needsinputsweep.js) è stato ritirato dal tick (task board 03a5a645,
  // decisione Owner 2026-07-25): quella classe di task ora NON è più needs_input
  // "in attesa di risposta" ma "Bloccata" (blocco tecnico, mai una push per
  // task — vedi setTaskChangeListener sotto e GET /api/tasks/blocked). Un
  // sollecito periodico ripeterebbe esattamente il rumore che questa decisione
  // elimina; la visibilità ora è garantita dalla lista "Bloccate" sempre
  // presente (niente reminder one-shot necessario).
  // Cap globale di agenti attivi (Agenti live): fa ripartire da soli i lanci
  // autonomi rimasti in coda non appena si libera capienza sotto il cap.
  if (!V2_EXCLUSIVE_MODE) {
    try {
      drainQueue();
    } catch (err) {
      console.error('[concurrency] drain fallito:', err.message);
    }
  }
  // Auto-restart: valuta i gate e riavvia se il codice è stantio e il momento è
  // sicuro. Inerte finché disabilitato o restart-policy non confermata.
  try {
    if (!process.env.AGENT_PLATFORM_DATA_DIR) maybeAutoRestartTick();
  } catch (err) {
    console.error('[auto-restart] tick fallito:', err.message);
  }
}, { runLegacySchedules: !V2_EXCLUSIVE_MODE });


let contextGraphSyncProcess = null;
function requestContextGraphSync(reason = 'scheduled') {
  if (contextGraphSyncProcess) return;
  const script = join(__dirname, 'scripts', 'context-graph-sync.mjs');
  contextGraphSyncProcess = spawn(process.execPath, [script], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENCLAW_WORKSPACE_DIR: process.env.OPENCLAW_WORKSPACE_DIR || '/root/.openclaw/workspace',
      OPENCLAW_SESSIONS_DIR: process.env.OPENCLAW_SESSIONS_DIR || '/root/.openclaw/agents/main/sessions',
    },
  });
  let stderr = '';
  contextGraphSyncProcess.stdout.on('data', (chunk) => console.log(`[context-graph] ${String(chunk).trim()}`));
  contextGraphSyncProcess.stderr.on('data', (chunk) => { stderr += String(chunk); });
  contextGraphSyncProcess.on('close', (code) => {
    if (code !== 0) console.error(`[context-graph] sync ${reason} fallito (${code}): ${stderr.slice(-1000)}`);
    contextGraphSyncProcess = null;
  });
}

setTimeout(() => requestContextGraphSync('boot'), 2000).unref?.();
setInterval(() => requestContextGraphSync('periodic'), 60_000).unref?.();

setTimeout(() => recoverV2Projects(tenantsConfig.tenants.map((tenant) => tenant.id), handleV2ProjectUpdate), 1500).unref?.();

// Riconciliazione code messaggi al boot (task 311d2946): il caso comune (crash
// MENTRE un turno girava, con messaggi accodati nel frattempo) è già coperto
// da solo — il watchdog riprende la run interrotta e, al suo completamento con
// successo, il wrapper runAgentTurn drena la coda persistita. Qui si copre
// SOLO l'edge case residuo: una coda non vuota rimasta senza alcuna run attiva
// o in ripartenza automatica per quella sessione (es. crash avvenuto esattamente
// nella finestra tra fine turno e drain). Gira SINCRONO qui al boot, non dopo un
// delay: a questo punto `recoverOnBoot()` (più sopra in questo file) ha già
// marcato interrupted le run "running" del journal, quindi lo stato letto da
// listRuns() è quello definitivo. Se l'ordine di boot cambia, questo blocco deve
// restare DOPO recoverOnBoot() o rischia di vedere run fantasma come attive.
for (const q of V2_EXCLUSIVE_MODE ? [] : listNonEmptyQueues()) {
  const qKey = `${q.tenantId}:${q.agentId}:${q.sessionId}`;
  const hasActiveRun = listRuns().some((r) => r.sessionKey === qKey && ['running', 'resumed', 'interrupted'].includes(r.status));
  if (!hasActiveRun) {
    console.log(`[chat-queue] riconciliazione boot: ${q.pending} messaggi in coda per ${qKey} senza run attiva, li consegno ora`);
    processQueuedFollowup(q.tenantId, q.agentId, q.sessionId).catch((err) => {
      console.error(`[chat-queue] riconciliazione boot ${qKey} fallita:`, err.message);
    });
  }
}

// Backup automatico giornaliero (task a5088334) — solo in produzione: i test
// girano con AGENT_PLATFORM_DATA_DIR isolato e non devono scrivere in /app/backups
// né agganciare il backup pre-riavvio quando li si termina con SIGTERM.
if (!process.env.AGENT_PLATFORM_DATA_DIR) {
  // Pilot Operating System V2: sentinella deterministica quotidiana sul tenant
  // USA. Nessuna run LLM e nessuna azione esterna: legge soltanto KPI gia
  // normalizzati, genera report e Opportunity Card da approvare/trasformare.
  registerSystemJob({
    cron: '15 6 * * *',
    name: 'v2-autopilot-usa',
    fn: () => runAutopilot('business-a', { source: 'schedule', user: 'v2-autopilot-usa' }),
  });
  // Report ricorrenti definiti da Owner via Report Designer. Il job gira ogni
  // ora, ma genera solo le definizioni il cui slot locale e dovuto e non ancora
  // eseguito. Calcoli deterministici sui KPI normalizzati, zero azioni esterne.
  registerSystemJob({
    cron: '5 * * * *',
    name: 'v2-custom-reports',
    fn: (now) => {
      const generated = tenantsConfig.tenants.flatMap((tenant) => runDueReportDefinitions(tenant.id, { now, user: 'v2-custom-reports' }));
      for (const report of generated) {
        notify(report.tenantId, {
          title: `📊 ${report.title}`,
          body: report.summary,
          tag: `v2-report-${report.definitionId}`,
          url: '/',
        });
      }
      return generated;
    },
  });
  // Job schedulato alle 04:00 sull'infrastruttura Schedules (system job in-process):
  // esegue il backup, lo logga nel journal e avvisa Owner SOLO se fallisce.
  registerSystemJob({
    cron: '0 4 * * *',
    name: 'backup-giornaliero',
    fn: () => runBackup({ notify, reason: 'scheduled' }),
  });
  // Digest serale a Owner (task c5ac40a1): riassunto del giorno aggregato su tutti
  // i tenant, consegnato via push e archiviato in wiki platform (digest.md). Cron
  // configurabile in config/platform.json (digest.cron, default 21:00); si può
  // disattivare con digest.enabled=false. Giorno vuoto → una riga deterministica
  // (nessuna run LLM); giorno con attività → run breve del CEO platform che compone.
  const digestCfg = readJson(join(CONFIG_DIR, 'platform.json'), {})?.digest ?? {};
  if (!V2_EXCLUSIVE_MODE && digestCfg.enabled !== false) {
    registerSystemJob({
      cron: digestCfg.cron || '0 21 * * *',
      name: 'digest-serale',
      fn: (now) => runDigest({ tenants: tenantsConfig.tenants, runFn: runAgentTurn, notify, now: now?.getTime?.() ?? Date.now(), bootTimeMs: Date.parse(BOOT_TIME) }),
    });
  }
  // Bonifica automatica ricorrente (task board 2e2d918f): ogni 20 min, su TUTTI
  // i tenant, recupera da sola le needs_input SENZA ask (blocco tecnico — mai
  // una vera domanda, vedi lib/blocked.js) invece di aspettare un click manuale
  // di Owner/CEO. Una task recuperata >3 volte senza mai completare viene
  // segnalata al CEO platform (nuova task, non una needs_input) invece di
  // continuare il loop. Nessuna run LLM: system job puramente deterministico,
  // costo trascurabile anche a questa frequenza.
  if (!V2_EXCLUSIVE_MODE) {
    registerSystemJob({
      cron: '*/20 * * * *',
      name: 'bonifica-needs-input',
      fn: (now) => runAutoRecover({ tenants: tenantsConfig.tenants, now: now?.getTime?.() ?? Date.now() }),
    });
  }
  // "Done" != "live" — auto-close ask decadute (task madre 61aea764, questa
  // task 2e6fb2e5): ogni 20 min, su TUTTI i tenant, chiude da sola le ask a
  // Owner la cui premessa "serve un restart per attivare X" è deterministicamente
  // decaduta (i file server/** citati sono già tutti più vecchi del boot
  // corrente — un restart li ha già caricati). Conservativo per design (vedi
  // lib/pendingactivation.js): dati insufficienti -> lascia l'ask intatta, mai
  // una chiusura per conto di Owner su un'ask ancora valida. Nessuna run LLM.
  if (!V2_EXCLUSIVE_MODE) {
    registerSystemJob({
      cron: '*/20 * * * *',
      name: 'attivazione-ask-decay',
      fn: (now) => runObsoleteAskSweep({
        tenants: tenantsConfig.tenants,
        bootTimeMs: Date.parse(BOOT_TIME),
        now: now?.getTime?.() ?? Date.now(),
      }),
    });
  }
  // Code-quality (task aabd54ca): run giornaliera di qualità del codice, registrata
  // come "agent job" generico (task c5ff7ad3, lib/agentjobs.js) — cron/enabled
  // modificabili a runtime da GET/PUT /api/agent-jobs, persistiti in
  // config/platform.json (codeQuality.cron/enabled), default 05:00/attivo.
  // Skip deterministico se budget finestra <25% (dentro runCodeQuality): non spende
  // una run quando la quota Max è quasi esaurita. Run journaled e visibile in
  // "Agenti live"; focus del giorno calcolato dalla data e iniettato nel prompt.
  if (!V2_EXCLUSIVE_MODE) {
    registerAgentJob({
      jobId: 'code-quality',
      label: 'Code quality — review qualità del codice',
      tenantId: CQ_TENANT,
      agentId: CODE_QUALITY_AGENT,
      configKey: 'codeQuality',
      defaultCron: '0 5 * * *',
      defaultEnabled: false,
      fn: (now) => runCodeQuality({ runFn: runAgentTurn, now: now?.getTime?.() ?? Date.now() }),
      extra: (now) => ({ focus: focusForDay(now) }),
    });
  }
  // pm-platform (task 5352926c): manager di miglioramento proattivo. Stesso
  // pattern generico agent-job — cron/enabled a runtime via /api/agent-jobs,
  // persistiti in config/platform.json (pmPlatform.cron/enabled), default 06:00.
  // Skip deterministico se budget finestra <25% (dentro runPmPlatform). Run
  // journaled e visibile in "Agenti live"; apre ≤3 task motivate ai dev/CTO.
  if (!V2_EXCLUSIVE_MODE) {
    registerAgentJob({
      jobId: 'pm-platform',
      label: 'PM Platform — miglioramento proattivo',
      tenantId: PM_TENANT,
      agentId: PM_PLATFORM_AGENT,
      configKey: 'pmPlatform',
      defaultCron: '0 6 * * *',
      defaultEnabled: false,
      fn: (now) => runPmPlatform({ runFn: runAgentTurn, now: now?.getTime?.() ?? Date.now() }),
    });
  }
  // Backup pre-riavvio (aggancio alla procedura di riavvio 7e42fc33): su SIGTERM/
  // SIGINT (docker restart/stop) si prende un ultimo backup SINCRONO prima di
  // uscire, così il restart coordinato non perde mai l'ultimo stato.
  let shuttingDown = false;
  const preRestartBackup = (signal) => {
    if (shuttingDown) return; // un solo backup anche se arrivano più segnali
    shuttingDown = true;
    console.log(`[shutdown] ${signal}: backup pre-riavvio in corso...`);
    try {
      const res = runBackupSync({ reason: 'pre-restart' });
      console.log(res.ok
        ? `[shutdown] backup pre-riavvio ok: ${res.name} (${res.sizeBytes} byte)`
        : `[shutdown] backup pre-riavvio FALLITO: ${res.error}`);
    } catch (err) {
      console.error('[shutdown] backup pre-riavvio errore:', err.message);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => preRestartBackup('SIGTERM'));
  process.on('SIGINT', () => preRestartBackup('SIGINT'));
  // Verifica post-restart (task 03a4d9d6): se veniamo da un riavvio automatico o
  // manuale, conferma a Owner l'esito (o allarme se ancora stale). Una sola volta.
  try { verifyPostRestartOnBoot(); } catch (err) { console.error('[auto-restart] verifica post-boot fallita:', err.message); }
}

// Ogni mutazione di stato delle run (non gli heartbeat) va in broadcast, ma
// SOLO alle connessioni di utenti che possono gestire quell'agente (stesso
// filtro server-side di GET /api/runs/global): la pagina globale "Agenti live"
// è realtime per tutti, ognuno con le sole run che gli competono.
setRunChangeListener((run) => {
  broadcastWhere((user) => userCanAgent(user, run.tenantId, run.agentId), { type: 'run', run: enrichRun(run) });
});

// Cap globale/coda (Agenti live): a ogni variazione un ping broadcast a tutti
// i client connessi, che ri-fetchano GET /api/settings/concurrency e
// /api/runs/queue (già filtrate sui permessi lato server) — niente payload
// da filtrare per-connessione qui, stesso pattern "signal + refetch" usato
// altrove per dati cross-tenant.
const pingConcurrency = () => broadcast(null, { type: 'concurrency' });
setCapChangeListener(pingConcurrency);
setQueueChangeListener(pingConcurrency);
// Stato globale del limite Claude (task ca71d849): ogni cambio (muro alzato al
// primo rate limit, oppure sceso al reset) fa refetch della concorrenza ai
// client → il banner in Agenti live compare/sparisce da solo, realtime.
setRateLimitChangeListener(pingConcurrency);
// Kill switch globale (task 16fb8517): ogni pausa/ripresa fa refetch della
// concorrenza ai client → il banner "piattaforma in pausa" in Agenti live
// compare/sparisce da solo, realtime (stesso pattern del muro Claude).
setPlatformPauseChangeListener(pingConcurrency);

// Le modifiche alle task vengono propagate ai client del tenant.
setTaskChangeListener((task, action) => {
  broadcast(task.tenantId, { type: 'task', action, task });
  requestBoardCheck(task);
  // Nota di consegna dell'operativo (scritta quando consegna al gate): va
  // stashata QUI, prima che un'eventuale approvazione di manager/CEO la
  // sovrascriva con la propria nota di review (updateTask riscrive task.note
  // ad ogni step del gate) — altrimenti il feed Attività mostrerebbe la nota
  // del reviewer invece del lavoro consegnato (task board 31797bb5).
  if (task.status === 'review_manager' && task.note) {
    stashDeliveryNote(task.tenantId, task.id, task.note);
  }
  if (task.status === 'needs_input') {
    // Bloccate vs Da decidere (task board 03a5a645, decisione Owner 2026-07-25):
    // classifyNeedsInput ora guarda SOLO task.ask. 'needs_input' = richiesta
    // vera (ask_owner) -> push con la domanda secca nel testo, il popup "Da
    // decidere" si apre dal tap. 'failed' = blocco tecnico (gate esaurito,
    // retry esauriti, o una needs_input impostata a mano senza ask) -> NIENTE
    // push per task (requisito 4: solo il feed Attività qui sotto + una riga
    // aggregata nel digest serale, vedi lib/digest.js); resta visibile e
    // riprovabile in "Bloccate" (lib/blocked.js, GET /api/tasks/blocked).
    const kind = classifyNeedsInput(task);
    const ask = task.ask ?? null;
    if (kind === 'needs_input') {
      const { tenant } = findAgent(task.tenantId, null);
      const tName = tenant?.name ?? task.tenantId;
      notifyTenant(task.tenantId, {
        title: `❓ ${tName}: serve una tua risposta`,
        body: (ask?.question ?? task.title).slice(0, 240),
        tag: `task-${task.id}`,
        decision: { kind: 'task', id: task.id, tenantId: task.tenantId },
      }, pushDeps).catch(() => {});
    }
    // Feed "Attività" (task board 31797bb5): traccia persistente in-app, non si
    // perde come una push mancata — vale per entrambe le classi (una bloccata
    // resta comunque visibile qui, solo senza push individuale).
    recordActivityEvent(task.tenantId, {
      kind,
      taskId: task.id,
      title: task.title,
      note: ask?.question ?? task.note ?? null,
    });
  } else if (task.status === 'done' && !task.doneNotifiedAt) {
    // La push su singola task done e' stata ritirata: Owner vuole un solo push
    // sul progetto terminale, non spam per ogni consegna intermedia.
    updateTask(task.tenantId, task.id, { doneNotifiedAt: new Date().toISOString() }, 'system');
    // Feed "Attività": stessa guardia "una volta sola per chiusura" delle push
    // (doneNotifiedAt), con la nota di consegna originale se stashata (altrimenti
    // fallback sulla nota di approvazione del CEO, comunque informativa).
    recordActivityEvent(task.tenantId, {
      kind: 'done',
      taskId: task.id,
      title: task.title,
      note: takeDeliveryNote(task.tenantId, task.id) ?? task.note ?? null,
    });
  }
});
