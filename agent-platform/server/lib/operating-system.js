import { randomUUID } from 'crypto';
import { join } from 'path';
import { DATA_DIR, readJson, writeJson, safeSegment } from './store.js';
import { logAudit } from './audit.js';
import { queryContextGraph } from './context-graph.js';
import { resolveUpload } from './uploads.js';

const V2_DIR = join(DATA_DIR, 'operating-system-v2');

export const WORKFLOW_TEMPLATES = {
  page_factory: { label: 'Page Factory', steps: [['brief', 'Brief e obiettivo'], ['strategy', 'Strategia e primo quadrante'], ['copy', 'Copy completo'], ['images', 'Direzione immagini'], ['frontend', 'Frontend in staging'], ['brand_qa', 'Brand e claims QA'], ['technical_qa', 'Form, tracking e responsive'], ['publish', 'Pubblicazione e prova']] },
  course_lesson_factory: { label: 'Course Lesson Factory', steps: [['lesson_card', 'Lesson card'], ['outline', 'Outline didattico'], ['script', 'Script lezione'], ['critic', 'Critic didattico'], ['terminology_qa', 'Terminologia USA'], ['revision', 'Revisione finale'], ['assets', 'Overlay e B-roll'], ['approval', 'Approvazione']] },
  research_factory: { label: 'Research Factory', steps: [['question', 'Domanda e decisione'], ['sources', 'Fonti ed evidence table'], ['analysis', 'Analisi'], ['critic', 'Controanalisi'], ['memo', 'Decision memo']] },
  funnel_optimization: { label: 'Funnel Optimization', steps: [['diagnosis', 'Diagnosi dati'], ['hypotheses', 'Ipotesi ordinate'], ['intervention', 'Intervento proposto'], ['qa', 'QA e rischio'], ['test_plan', 'Piano test'], ['measurement', 'Misurazione risultato']] },
};

const METRIC_RULES = [
  { pattern: /(cac|cpa|cpl|refund|churn|cost)/i, better: 'lower' },
  { pattern: /(revenue|margin|profit|roas|conversion|completion|aov|lead|sale)/i, better: 'higher' },
];

const nowIso = () => new Date().toISOString();
const fileForTenant = (tenantId) => join(V2_DIR, `${safeSegment(tenantId)}.json`);

function normalizeEconomicPreReviewMaxCycles(value, fallback = 1) {
  const cycles = Number(value);
  return Number.isInteger(cycles) && cycles >= 0 && cycles <= 3 ? cycles : fallback;
}

function normalizeProjectNotificationPolicy(input) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  if ('completed' in source) out.completed = Boolean(source.completed);
  if ('failed' in source) out.failed = Boolean(source.failed);
  if ('waitingApproval' in source) out.waitingApproval = Boolean(source.waitingApproval);
  if ('needsInput' in source) out.needsInput = Boolean(source.needsInput);
  return out;
}

function clearDispatchLock(execution, releasedAt = nowIso()) {
  if (!execution || typeof execution !== 'object') return {};
  const next = { ...execution };
  delete next.dispatchLock;
  next.dispatchReleasedAt = releasedAt;
  return next;
}

function normalizeProjectTasks(tasks, now = nowIso()) {
  if (!Array.isArray(tasks)) return [];
  return tasks.map((task, index) => ({
    id: String(task?.id ?? '').trim() || `task_${randomUUID()}`,
    label: String(task?.label ?? task?.title ?? '').trim() || `Task ${index + 1}`,
    description: String(task?.description ?? '').trim(),
    owner: String(task?.owner ?? 'system').trim() || 'system',
    approvalRequired: Boolean(task?.approvalRequired),
    model: String(task?.model ?? '').trim() || null,
    status: ['active', 'pending', 'completed', 'blocked', 'needs_approval', 'needs_premium_review', 'proposed', 'failed', 'deferred'].includes(task?.status)
      ? task.status
      : 'proposed',
    updatedAt: task?.updatedAt ?? now,
    execution: task?.execution && typeof task.execution === 'object' ? task.execution : {},
  }));
}

function emptyState(tenantId) {
  const now = nowIso();
  return {
    schemaVersion: 1,
    tenantId,
    projects: [],
    brandVersions: [{
      id: randomUUID(), version: 'v0.1-draft', status: 'draft', name: `${tenantId} Brand Canon`,
      core: { voice: '', audience: '', promisesAllowed: [], forbiddenTerms: [], requiredTerms: [], callsToAction: [], designTokensRef: '' },
      notes: 'Bozza iniziale: completare e attivare prima della produzione pubblica.', createdAt: now, createdBy: 'system',
    }],
    opportunities: [], approvals: [], signals: [], reports: [], reportDefinitions: [], skills: [], createdAt: now, updatedAt: now,
  };
}

function loadState(tenantId) {
  const state = readJson(fileForTenant(tenantId), null) ?? emptyState(tenantId);
  state.projects ??= [];
  state.brandVersions ??= emptyState(tenantId).brandVersions;
  state.opportunities ??= [];
  state.approvals ??= [];
  state.signals ??= [];
  state.reports ??= [];
  state.reportDefinitions ??= [];
  state.skills ??= [];
  for (const project of state.projects) {
    project.queueOrder ??= null;
    project.group ??= null;
    project.defaultModel ??= 'anthropic/claude-opus-5';
    project.qualityModel ??= project.defaultModel;
    project.execution ??= { status: project.status === 'active' ? 'queued' : 'idle', recoveryCount: 0 };
    project.notificationPolicy = normalizeProjectNotificationPolicy(project.notificationPolicy);
    project.qualityGateMode ??= 'immediate';
    project.economicPreReviewEnabled ??= project.qualityGateMode === 'deferred';
    project.economicPreReviewModel ??= 'deepseek/deepseek-v4-pro';
    project.economicPreReviewMaxCycles ??= project.economicPreReviewEnabled ? 1 : 0;
    project.economicPreReviewMaxCycles = normalizeEconomicPreReviewMaxCycles(project.economicPreReviewMaxCycles, project.economicPreReviewEnabled ? 1 : 0);
    project.steps = normalizeProjectTasks(project.steps);
    project.skillIds ??= [];
    project.contextSources ??= [];
    project.requests ??= [];
    // "completed" vale per il run concluso, non per il progetto: se una fase successiva
    // ha aggiunto step eseguibili, il progetto torna attivo e rientra nel loop executor.
    if (project.status === 'completed' && project.steps.length && !project.steps.every((step) => step.status === 'completed')) {
      // Un progetto con step eseguibili rimasti torna attivo SOLO se era
      // 'completed' per il run concluso. Stati terminali negativi ('failed')
      // NON vengono riattivati qui: richiedono resumeFailedProject esplicito.
      project.status = 'active';
      project.currentStepId = (project.steps.find((step) => step.status === 'active')
        ?? project.steps.find((step) => ['pending', 'proposed'].includes(step.status)))?.id ?? null;
      project.execution = { ...project.execution, status: 'queued', error: null, nextRetryAt: null, recoveryCount: 0 };
    }
  }
  for (const definition of state.reportDefinitions) definition.model ??= 'anthropic/claude-opus-5';
  return state;
}

function saveState(state) {
  state.updatedAt = nowIso();
  writeJson(fileForTenant(state.tenantId), state);
  return state;
}

const currentBrand = (state) => state.brandVersions.find((version) => version.status === 'active') ?? state.brandVersions.at(-1) ?? null;

export function getOperatingSystemOverview(tenantId) {
  const state = loadState(tenantId);
  const signalCatalog = [...new Map(state.signals.map((signal) => [
    `${signal.metric}:${signal.dimension}:${signal.source}`,
    { metric: signal.metric, dimension: signal.dimension, source: signal.source, unit: signal.unit },
  ])).values()];
  return {
    tenantId,
    projects: state.projects.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    opportunities: state.opportunities.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    approvals: state.approvals.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    reports: state.reports.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    reportDefinitions: state.reportDefinitions.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    skills: state.skills.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    signalCount: state.signals.length,
    signalCatalog,
    brand: currentBrand(state),
    brandVersions: state.brandVersions.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    workflows: Object.entries(WORKFLOW_TEMPLATES).map(([id, workflow]) => ({ id, label: workflow.label })),
  };
}

export function getProject(tenantId, projectId) {
  return loadState(tenantId).projects.find((project) => project.id === projectId) ?? null;
}
export function getReportDefinition(tenantId, definitionId) {
  return loadState(tenantId).reportDefinitions.find((definition) => definition.id === definitionId) ?? null;
}

export function createReusableSkill(tenantId, input, createdBy) {
  const state = loadState(tenantId);
  const now = nowIso();
  const name = String(input.name ?? '').trim();
  const instructions = String(input.instructions ?? '').trim();
  if (!name || !instructions) throw new Error('nome e istruzioni skill richiesti');
  const skill = {
    id: randomUUID(), tenantId, name,
    key: String(input.key ?? name).trim().toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    description: String(input.description ?? '').trim(), instructions,
    inputs: Array.isArray(input.inputs) ? input.inputs.map(String).filter(Boolean) : [],
    outputs: Array.isArray(input.outputs) ? input.outputs.map(String).filter(Boolean) : [],
    version: String(input.version ?? '1.0.0').trim(), status: 'active',
    createdAt: now, createdBy, updatedAt: now,
  };
  if (!skill.key) throw new Error('key skill non valida');
  if (state.skills.some((item) => item.key === skill.key && item.status !== 'archived')) throw new Error('esiste già una skill con questa key');
  state.skills.push(skill);
  saveState(state);
  logAudit({ user: createdBy, tenant: tenantId, event: 'v2_skill_created', detail: { skillId: skill.id, key: skill.key } });
  return skill;
}

export function updateReusableSkill(tenantId, skillId, input, updatedBy) {
  const state = loadState(tenantId);
  const skill = state.skills.find((item) => item.id === skillId);
  if (!skill) throw new Error('skill non trovata');
  for (const field of ['name', 'description', 'instructions', 'version']) {
    if (input[field] !== undefined) skill[field] = String(input[field]).trim();
  }
  if (Array.isArray(input.inputs)) skill.inputs = input.inputs.map(String).filter(Boolean);
  if (Array.isArray(input.outputs)) skill.outputs = input.outputs.map(String).filter(Boolean);
  if (input.archived !== undefined) skill.status = input.archived ? 'archived' : 'active';
  skill.updatedAt = nowIso();
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_skill_updated', detail: { skillId, status: skill.status } });
  return skill;
}

export function setProjectSkills(tenantId, projectId, skillIds, updatedBy) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const requested = [...new Set((Array.isArray(skillIds) ? skillIds : []).map(String))];
  const activeIds = new Set(state.skills.filter((skill) => skill.status === 'active').map((skill) => skill.id));
  if (requested.some((id) => !activeIds.has(id))) throw new Error('una o più skill non sono disponibili');
  project.skillIds = requested;
  project.updatedAt = nowIso();
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_project_skills_updated', detail: { projectId, skillIds: requested } });
  return project;
}

export function createReportDefinition(tenantId, input, createdBy) {
  const state = loadState(tenantId);
  const now = nowIso();
  const definition = {
    id: randomUUID(), tenantId, title: String(input.title ?? '').trim() || 'Nuovo report',
    model: String(input.model ?? '').trim() || 'anthropic/claude-opus-5',
    purpose: '', status: 'discovery', ready: false, audience: '', dataSources: [], kpis: [],
    permissions: {}, schedule: { cadence: 'weekly', timezone: 'Europe/Rome', hour: 8, weekday: 1, dayOfMonth: 1 },
    layout: { title: '', sections: [] }, delivery: { channel: 'platform', requiresApproval: false },
    facsimile: '', messages: [{
      id: randomUUID(), role: 'assistant',
      text: 'Che decisione vuoi riuscire a prendere grazie a questo report, e con quale frequenza?',
      createdAt: now, createdBy: 'report-designer',
    }],
    lastRunAt: null, lastSlotKey: null, archivedAt: null, createdAt: now, createdBy, updatedAt: now,
  };
  state.reportDefinitions.push(definition);
  saveState(state);
  logAudit({ user: createdBy, tenant: tenantId, event: 'v2_report_definition_created', detail: { definitionId: definition.id } });
  return definition;
}

export function addReportDefinitionMessage(tenantId, definitionId, input, createdBy) {
  const state = loadState(tenantId);
  const definition = state.reportDefinitions.find((item) => item.id === definitionId);
  if (!definition) throw new Error('definizione report non trovata');
  const text = String(input.text ?? '').trim();
  if (!text) throw new Error('messaggio richiesto');
  const message = {
    id: randomUUID(), role: input.role === 'assistant' ? 'assistant' : 'user', text,
    kind: String(input.kind ?? 'message'), requestId: input.requestId ?? null,
    createdAt: nowIso(), createdBy,
  };
  definition.messages.push(message);
  definition.updatedAt = message.createdAt;
  saveState(state);
  return message;
}

export function requestProjectInput(tenantId, projectId, input, createdBy = 'v2-executor') {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const question = String(input.question ?? '').trim();
  if (!question) throw new Error('domanda richiesta');
  const stepId = input.stepId ?? project.currentStepId ?? null;
  const type = String(input.type ?? 'input');
  const existing = project.requests.find((request) => request.status === 'open' && request.stepId === stepId && request.type === type);
  if (existing) return existing;
  const now = nowIso();
  const request = {
    id: randomUUID(), type, status: 'open', stepId, question,
    context: String(input.context ?? '').trim(), options: Array.isArray(input.options) ? input.options.map(String).filter(Boolean) : [],
    createdAt: now, createdBy, resolvedAt: null, resolvedBy: null, answer: null,
  };
  project.requests.push(request);
  project.messages.push({
    id: randomUUID(), role: 'assistant', kind: 'request', requestId: request.id,
    text: `${request.context ? `${request.context}\n\n` : ''}**Serve il tuo intervento:** ${request.question}${request.options.length ? `\n\nOpzioni: ${request.options.join(' · ')}` : ''}`,
    createdAt: now, createdBy,
  });
  project.updatedAt = now;
  saveState(state);
  logAudit({ user: createdBy, tenant: tenantId, event: 'v2_project_input_requested', detail: { projectId, requestId: request.id, stepId, type } });
  return request;
}

export function resolveProjectInput(tenantId, projectId, requestId, input, resolvedBy) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const request = project.requests.find((item) => item.id === requestId);
  if (!request) throw new Error('richiesta non trovata');
  if (request.status !== 'open') throw new Error('richiesta già risolta');
  const answer = String(input.answer ?? '').trim();
  if (!answer) throw new Error('risposta richiesta');
  const now = nowIso();
  request.status = 'resolved'; request.answer = answer; request.resolvedAt = now; request.resolvedBy = resolvedBy;
  // Allegati opzionali sulla risposta (task B3): arrivano gia' risolti da
  // index.js (path verificato lato server) e restano in chat come metadata,
  // cosi' il file resta consultabile riaprendo il progetto.
  const answerAttachments = Array.isArray(input.attachments) ? input.attachments : [];
  project.messages.push({
    id: randomUUID(), role: 'user', kind: 'request_answer', requestId, text: answer, createdAt: now, createdBy: resolvedBy,
    ...(answerAttachments.length ? { attachments: answerAttachments.map(({ path, ...meta }) => meta) } : {}),
  });
  project.decisions.push({ id: randomUUID(), type: request.type, requestId, stepId: request.stepId, decision: answer, createdAt: now, createdBy: resolvedBy });
  const step = project.steps.find((item) => item.id === request.stepId);
  // Rifiuto SOLO su intenti espliciti: "no", "non approvare", "rifiuta", "stop", "ferma"
  // come comando autonomo. Un "non" qualsiasi dentro una frase normale NON e' rifiuto.
  const explicitReject = /^(?:no[.!]?|non\s+(?:approvare|approvo|voglio|va\s+bene|ok)|rifiut\w*|stop[.!]?|ferm\w*[.!]?|annulla[.!]?)\b/i;
  // Un rifiuto non puo' riaprire uno step gia' completato o saltato: la
  // richiesta si consuma comunque, ma lo step resta al suo stato finale
  // (altrimenti un 'no' su step chiuso lo riporterebbe a blocked e il
  // resume successivo riattiverebbe un progetto di fatto concluso).
  const approvalRejected = request.type === 'approval' && explicitReject.test(answer) && !['completed', 'skipped'].includes(step?.status);
  if (approvalRejected) {
    if (step) {
      step.status = 'blocked';
      step.execution = { ...(step.execution ?? {}), phase: 'rejected', userAnswer: answer, error: `Task rifiutata dall'utente: ${answer.slice(0, 200)}` };
    }
    project.status = 'paused';
    project.execution.status = 'paused';
    project.execution.pausedAt = now;
    project.execution.pausedReason = 'approval_rejected';
    project.execution.pausedStepId = step?.id ?? request.stepId ?? null;
  } else if (step && ['needs_approval', 'blocked', 'deferred'].includes(step.status)) {
    // 'deferred' = task saltata in avanti perche' Owner non rispondeva (flusso
    // lineare 2026-08-29): la risposta la riattiva e, essendo PRIMA nell'array
    // steps, il runner la riprende con priorita' sulla task saltata in avanti
    // (preemption gestita da onProjectInputResolved in v2-executor).
    step.status = 'active';
    // Ripresa pulita: niente errori/feedback di tentativi precedenti, conserva solo sessionKey
    // cosi' la chat dell'agent continua. approvalRequired resta sullo step (invariante di piano),
    // ma per le richieste di APPROVAZIONE il gate e' consumato QUI (approvedAt): il runner
    // (v2-executor) non ricrea piu' la richiesta quando riparte (bug A del loop infinito).
    // Le richieste di input non toccano approvedAt: un gate mai incontrato resta tale.
    // Il gate di approvazione consumato SOPRAVVIVE alle risposte di tipo 'input':
    // prima questo rebuild azzerava approvedAt anche quando Owner rispondeva a una
    // domanda a meta' step, il runner ricreava il gate nello stesso secondo e Owner
    // doveva mandare il messaggio due volte (una per l'input, una per ri-approvare).
    step.execution = {
      sessionKey: step.execution?.sessionKey ?? null, phase: 'execution', userAnswer: answer, error: null,
      approvedAt: step.execution?.approvedAt ?? null, approvedBy: step.execution?.approvedBy ?? null,
      ...(request.type === 'approval' ? { approvedAt: now, approvedBy: resolvedBy } : {}),
    };
  }
  if (!approvalRejected) {
    // Ripristino project.status da QUALUNQUE stato di attesa, incluso paused (caso bug storico:
    // risposta classificata rifiuto per regex larga -> progetto paused con currentStepId null).
    if (['waiting_approval', 'needs_input', 'paused', 'error'].includes(project.status)) project.status = 'active';
    // Con lo skip-ahead una run puo' essere VIVA su una task successiva mentre
    // arriva la risposta sulla task rinviata: non sovrascrivere 'running', la
    // preemption (v2-executor) fara' il cambio task in modo pulito.
    if (project.execution.status !== 'running') project.execution.status = 'queued';
    project.execution.error = null;
    project.execution.pausedReason = null;
    if (step && step.status === 'active') project.currentStepId = step.id;
    else project.currentStepId = project.steps.find((item) => item.status === 'active')?.id ?? project.currentStepId;
  }
  project.updatedAt = now;
  saveState(state);
  logAudit({ user: resolvedBy, tenant: tenantId, event: 'v2_project_input_resolved', detail: { projectId, requestId, stepId: request.stepId } });
  return project;
}

export function applyReportDesignerSpec(tenantId, definitionId, input, updatedBy) {
  const state = loadState(tenantId);
  const definition = state.reportDefinitions.find((item) => item.id === definitionId);
  if (!definition) throw new Error('definizione report non trovata');
  const now = nowIso();
  if (String(input.title ?? '').trim()) definition.title = String(input.title).trim();
  if (String(input.purpose ?? '').trim()) definition.purpose = String(input.purpose).trim();
  if (String(input.audience ?? '').trim()) definition.audience = String(input.audience).trim();
  if (Array.isArray(input.dataSources)) definition.dataSources = input.dataSources.map((item) => String(item).trim()).filter(Boolean);
  if (Array.isArray(input.kpis)) definition.kpis = input.kpis.map((kpi) => ({
    id: String(kpi?.id ?? kpi?.metric ?? '').trim() || `kpi_${randomUUID()}`,
    metric: String(kpi?.metric ?? '').trim(), label: String(kpi?.label ?? kpi?.metric ?? '').trim(),
    dimension: String(kpi?.dimension ?? 'all').trim(), unit: String(kpi?.unit ?? '').trim(),
    target: kpi?.target ?? null, rationale: String(kpi?.rationale ?? '').trim(),
  })).filter((kpi) => kpi.metric);
  if (input.permissions && typeof input.permissions === 'object') definition.permissions = { ...definition.permissions, ...input.permissions };
  if (input.schedule && typeof input.schedule === 'object') definition.schedule = { ...definition.schedule, ...input.schedule };
  if (input.layout && typeof input.layout === 'object') definition.layout = { ...definition.layout, ...input.layout };
  if (input.delivery && typeof input.delivery === 'object') definition.delivery = { ...definition.delivery, ...input.delivery };
  if (String(input.facsimile ?? '').trim()) definition.facsimile = String(input.facsimile).trim();
  definition.ready = Boolean(input.ready);
  definition.updatedAt = now;
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_report_designer_spec', detail: { definitionId, ready: definition.ready, kpis: definition.kpis.length } });
  return definition;
}

export function activateReportDefinition(tenantId, definitionId, updatedBy) {
  const state = loadState(tenantId);
  const definition = state.reportDefinitions.find((item) => item.id === definitionId);
  if (!definition) throw new Error('definizione report non trovata');
  if (!definition.ready || !definition.purpose || definition.kpis.length === 0) throw new Error('report non pronto: completare scopo, KPI e facsimile');
  definition.status = 'active';
  definition.activatedAt = nowIso();
  definition.activatedBy = updatedBy;
  definition.updatedAt = definition.activatedAt;
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_report_definition_activated', detail: { definitionId } });
  return definition;
}

export function setReportDefinitionArchived(tenantId, definitionId, archived, updatedBy) {
  const state = loadState(tenantId);
  const definition = state.reportDefinitions.find((item) => item.id === definitionId);
  if (!definition) throw new Error('definizione report non trovata');
  const now = nowIso();
  if (archived) {
    definition.statusBeforeArchive = definition.status;
    definition.status = 'archived';
    definition.archivedAt = now;
  } else {
    definition.status = definition.statusBeforeArchive || 'discovery';
    definition.archivedAt = null;
  }
  definition.updatedAt = now;
  saveState(state);
  return definition;
}

export function compileProjectContext(tenantId, projectId) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const brand = state.brandVersions.find((version) => version.id === project.brandVersionId) ?? null;
  const workflow = WORKFLOW_TEMPLATES[project.workflowType];
  const currentStep = project.steps.find((step) => step.id === project.currentStepId || step.status === 'active');
  const skills = state.skills.filter((skill) => project.skillIds.includes(skill.id) && skill.status === 'active');
  const sharedContext = queryContextGraph(`${project.title} ${project.objective} ${currentStep?.label ?? ''} ${currentStep?.description ?? ''}`, { tenantId, limit: 8, maxChars: 6500 }).text;
  return {
    contextVersion: 2,
    sharedContext,
    platformRules: {
      doneRequiresFinalEnvironmentEvidence: true,
      noInventedClaims: true,
      externalHighImpactActionsRequireApproval: true,
      outputMustUseProjectBrandVersion: true,
    },
    brand: brand ? { id: brand.id, version: brand.version, status: brand.status, name: brand.name, core: brand.core, notes: brand.notes } : null,
    workflow: { id: project.workflowType, label: workflow?.label ?? project.workflowLabel, steps: project.steps },
    skills: skills.map((skill) => ({ id: skill.id, key: skill.key, name: skill.name, version: skill.version, description: skill.description, instructions: skill.instructions, inputs: skill.inputs, outputs: skill.outputs })),
    project: {
      id: project.id, title: project.title, objective: project.objective, brief: project.brief,
      permissions: project.permissions ?? {}, successCriteria: project.successCriteria ?? [],
      currentStepId: project.currentStepId, status: project.status, qualityGateMode: project.qualityGateMode === 'deferred' ? 'deferred' : 'immediate',
    },
    relevantArtifacts: project.artifacts.filter((artifact) => artifact.stepId === project.currentStepId || artifact.pinned === true),
    contextSources: project.contextSources,
    openRequests: project.requests.filter((request) => request.status === 'open'),
    recentDecisions: project.decisions.slice(-10),
    recentMessages: project.messages.slice(-12),
  };
}

export function runBrandLint(tenantId, projectId, input, checkedBy) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const brand = state.brandVersions.find((version) => version.id === project.brandVersionId);
  if (!brand) throw new Error('Brand Canon del progetto non trovato');
  const content = String(input.content ?? '');
  if (!content.trim()) throw new Error('contenuto richiesto');
  const normalized = content.toLocaleLowerCase('en-US');
  const forbiddenHits = (brand.core?.forbiddenTerms ?? []).filter((term) => normalized.includes(String(term).toLocaleLowerCase('en-US')));
  const missingRequired = (brand.core?.requiredTerms ?? []).filter((term) => !normalized.includes(String(term).toLocaleLowerCase('en-US')));
  const issues = [
    ...(brand.status !== 'active' ? [{ type: 'brand_not_active', value: brand.version }] : []),
    ...forbiddenHits.map((value) => ({ type: 'forbidden_term', value })),
    ...missingRequired.map((value) => ({ type: 'missing_required_term', value })),
  ];
  const result = { ok: issues.length === 0, brandVersionId: brand.id, brandVersion: brand.version, issues, checkedAt: nowIso(), checkedBy };
  project.evidence.push({ id: randomUUID(), stepId: 'brand_qa', type: 'brand-lint', ...result, createdAt: result.checkedAt, createdBy: checkedBy });
  project.updatedAt = result.checkedAt;
  saveState(state);
  logAudit({ user: checkedBy, tenant: tenantId, event: 'v2_brand_lint', detail: { projectId, ok: result.ok, issues: issues.length } });
  return result;
}

export function createProject(tenantId, input, createdBy) {
  const state = loadState(tenantId);
  const workflow = WORKFLOW_TEMPLATES[input.workflowType] ?? null;
  const chatFirst = !workflow;
  const title = String(input.title ?? '').trim() || 'Nuovo progetto';
  const objective = String(input.objective ?? '').trim();
  const now = nowIso();
  const brand = currentBrand(state);
  const project = {
    id: randomUUID(), tenantId, title, objective,
    queueOrder: Number.isFinite(Number(input.queueOrder)) ? Number(input.queueOrder) : null,
    group: String(input.group ?? '').trim() || null,
    workflowType: workflow ? input.workflowType : 'custom', workflowLabel: workflow?.label ?? 'Progetto su misura',
    status: chatFirst ? 'discovery' : 'active', brief: input.brief ?? {}, permissions: input.permissions ?? {},
    defaultModel: String(input.defaultModel ?? '').trim() || 'anthropic/claude-opus-5',
    qualityModel: String(input.qualityModel ?? input.defaultModel ?? '').trim() || 'anthropic/claude-opus-5',
    qualityGateMode: input.qualityGateMode === 'deferred' ? 'deferred' : 'immediate',
    economicPreReviewEnabled: input.economicPreReviewEnabled ?? input.qualityGateMode === 'deferred',
    economicPreReviewModel: String(input.economicPreReviewModel ?? '').trim() || 'deepseek/deepseek-v4-pro',
    economicPreReviewMaxCycles: normalizeEconomicPreReviewMaxCycles(input.economicPreReviewMaxCycles, (input.economicPreReviewEnabled ?? input.qualityGateMode === 'deferred') ? 1 : 0),
    execution: { status: 'idle', recoveryCount: 0, currentStepId: null, updatedAt: now },
    successCriteria: Array.isArray(input.successCriteria) ? input.successCriteria : [],
    notificationPolicy: normalizeProjectNotificationPolicy(input.notificationPolicy),
    sourceOpportunityId: input.sourceOpportunityId ?? null,
    sourceReportId: input.sourceReportId ?? null,
    skillIds: Array.isArray(input.skillIds) ? input.skillIds.filter((id) => state.skills.some((skill) => skill.id === id && skill.status === 'active')) : [],
    contextSources: Array.isArray(input.contextSources) ? input.contextSources : [],
    brandVersionId: brand?.id ?? null, brandVersion: brand?.version ?? null,
    currentStepId: workflow?.steps?.[0]?.[0] ?? null,
    steps: workflow
      ? workflow.steps.map(([id, label], index) => ({ id, label, status: index === 0 ? 'active' : 'pending', updatedAt: index === 0 ? now : null }))
      : [],
    messages: chatFirst ? [{
      id: randomUUID(), role: 'assistant',
      text: input.contextSources?.some((source) => source?.type === 'report')
        ? `Ho importato il report completo **${input.contextSources.find((source) => source?.type === 'report')?.title ?? ''}** come fonte primaria. Cosa vuoi migliorare o cambiare sulla base di questo report?`
        : 'Partiamo dal risultato. Cosa vuoi ottenere concretamente con questo progetto?',
      createdAt: now, createdBy: 'project-architect',
    }] : [],
    artifacts: [], evidence: [], decisions: [], requests: [], archivedAt: null, createdAt: now, createdBy, updatedAt: now,
  };
  state.projects.push(project);
  saveState(state);
  logAudit({ user: createdBy, tenant: tenantId, event: 'v2_project_created', detail: { projectId: project.id, workflowType: project.workflowType } });
  return getProject(tenantId, project.id);
}

// Listener unico sui messaggi di progetto (registrato da index.js): è il punto
// centrale da cui partono le push quando un agente scrive in chat, qualunque
// sia il mittente (Architect, executor, futuri agenti).
let projectMessageListener = null;
export function setProjectMessageListener(fn) { projectMessageListener = fn; }

export function addProjectMessage(tenantId, projectId, input, createdBy) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const text = String(input.text ?? '').trim();
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  if (!text && attachments.length === 0) throw new Error('messaggio richiesto');
  const message = {
    id: randomUUID(), role: input.role === 'assistant' ? 'assistant' : 'user', text,
    createdAt: nowIso(), createdBy,
    ...(attachments.length ? { attachments: attachments.map(({ path, ...meta }) => meta) } : {}),
  };
  project.messages.push(message);
  project.updatedAt = message.createdAt;
  saveState(state);
  if (projectMessageListener) {
    try { projectMessageListener(tenantId, project, message); } catch { /* best-effort */ }
  }
  return message;
}

// Flag persistito "l'Architect sta elaborando": sopravvive a refresh/riconnessioni
// del client, così la UI mostra lo stato reale anche riaprendo l'app da mobile.
export function setProjectArchitectBusy(tenantId, projectId, busy) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  project.architectBusy = Boolean(busy);
  project.updatedAt = nowIso();
  saveState(state);
  return getProject(tenantId, projectId);
}

export function applyProjectArchitectSpec(tenantId, projectId, input, updatedBy) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const now = nowIso();
  if (String(input.title ?? '').trim()) project.title = String(input.title).trim();
  if (String(input.objective ?? '').trim()) project.objective = String(input.objective).trim();
  if (input.brief && typeof input.brief === 'object') project.brief = { ...project.brief, ...input.brief };
  if (input.permissions && typeof input.permissions === 'object') project.permissions = { ...project.permissions, ...input.permissions };
  if (Array.isArray(input.successCriteria)) project.successCriteria = input.successCriteria.map((item) => String(item).trim()).filter(Boolean);
  if (Array.isArray(input.tasks)) {
    const existingById = new Map(project.steps.map((step) => [step.id, step]));
    const existingByLabel = new Map(project.steps.map((step) => [step.label.toLocaleLowerCase('it-IT'), step]));
    project.steps = normalizeProjectTasks(input.tasks.map((task) => {
      const existing = existingById.get(task?.id) ?? existingByLabel.get(String(task?.label ?? task?.title ?? '').toLocaleLowerCase('it-IT'));
      if (!existing) return task;
      // Lo stato di RUNTIME dello step sopravvive alla ri-emissione del piano da
      // parte dell'Architect: la spec LLM non contiene execution, e perderla
      // azzerava approvedAt (gate di approvazione ricreato -> doppio invio) e
      // sessionKey (continuita' della sessione worker persa). Visto live il
      // 2026-08-19 11:30:41Z: architect spec -> re-approval alle 11:32:12Z.
      return { ...task, id: existing.id, status: task?.status ?? existing.status, execution: existing.execution ?? {}, updatedAt: now };
    }), now);
    project.currentStepId = project.steps.find((step) => step.status === 'active')?.id ?? null;
  }
  project.architectReady = Boolean(input.ready);
  project.architectSummary = String(input.summary ?? '').trim();
  project.updatedAt = now;
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_project_architect_spec', detail: { projectId, ready: project.architectReady, tasks: project.steps.length } });
  return project;
}

export function activateCustomProject(tenantId, projectId, updatedBy) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  if (project.status !== 'discovery') throw new Error('il progetto non è in discovery');
  if (!project.objective.trim()) throw new Error('obiettivo non definito');
  if (project.steps.length === 0) throw new Error('task non definite');
  const now = nowIso();
  project.steps = project.steps.map((step, index) => ({ ...step, status: index === 0 ? 'active' : 'pending', updatedAt: now }));
  project.currentStepId = project.steps[0].id;
  project.status = 'active';
  project.execution = { ...project.execution, status: 'queued', currentStepId: project.steps[0].id, startedAt: now, updatedAt: now, error: null };
  project.updatedAt = now;
  project.decisions.push({ id: randomUUID(), type: 'project-plan-approved', createdAt: now, createdBy: updatedBy });
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_project_activated', detail: { projectId, tasks: project.steps.length } });
  return project;
}

export function setProjectArchived(tenantId, projectId, archived, updatedBy) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const now = nowIso();
  if (archived) {
    project.statusBeforeArchive = project.status;
    project.status = 'archived';
    project.archivedAt = now;
    project.execution = { ...project.execution, status: 'paused', updatedAt: now };
  } else {
    project.status = project.statusBeforeArchive || (project.steps.length ? 'active' : 'discovery');
    project.archivedAt = null;
    if (project.status === 'active') project.execution = { ...project.execution, status: 'queued', updatedAt: now, error: null };
  }
  project.updatedAt = now;
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: archived ? 'v2_project_archived' : 'v2_project_restored', detail: { projectId } });
  return project;
}

// Claim persistita sullo step corrente: il guard rail vive nello stato V2, non
// nella logica dell'agente. Finché una run possiede la claim, un secondo
// dispatch dello STESSO step viene rifiutato prima di chiamare il gateway.
export function claimProjectStepDispatch(tenantId, projectId, { stepId, owner }, updatedBy = 'v2-executor') {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const step = project.steps.find((item) => item.id === stepId);
  if (!step) throw new Error('step non trovato');
  const now = nowIso();
  if (step.status !== 'active') {
    return { ok: false, reason: 'step-not-active', project };
  }
  if (project.currentStepId && project.currentStepId !== stepId) {
    return { ok: false, reason: 'step-not-current', project };
  }
  const existing = step.execution?.dispatchLock ?? null;
  if (existing && existing.owner !== owner) {
    return { ok: false, reason: 'already-claimed', lock: existing, project };
  }
  step.execution = {
    ...(step.execution ?? {}),
    dispatchLock: {
      owner,
      claimedAt: existing?.claimedAt ?? now,
      touchedAt: now,
      updatedBy,
    },
    dispatchReleasedAt: null,
    updatedAt: now,
  };
  step.updatedAt = now;
  project.execution = { ...project.execution, currentStepId: stepId, updatedAt: now };
  project.updatedAt = now;
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_project_step_dispatch_claimed', detail: { projectId, stepId, owner } });
  return { ok: true, lock: step.execution.dispatchLock, project };
}

export function releaseProjectStepDispatch(tenantId, projectId, { stepId, owner = null }, updatedBy = 'v2-executor') {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const step = project.steps.find((item) => item.id === stepId);
  if (!step) throw new Error('step non trovato');
  const existing = step.execution?.dispatchLock ?? null;
  if (!existing) return project;
  if (owner && existing.owner !== owner) return project;
  const now = nowIso();
  step.execution = clearDispatchLock(step.execution, now);
  step.updatedAt = now;
  project.updatedAt = now;
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_project_step_dispatch_released', detail: { projectId, stepId, owner: existing.owner } });
  return project;
}

// Al boot non esistono run executor vive: ogni claim residua è orfana e va
// rimossa, altrimenti il recovery resterebbe bloccato su uno step già morto.
export function clearStaleProjectStepDispatchClaims(tenantIds) {
  for (const tenantId of tenantIds) {
    const state = loadState(tenantId);
    let dirty = false;
    const now = nowIso();
    for (const project of state.projects) {
      for (const step of project.steps ?? []) {
        if (!step.execution?.dispatchLock) continue;
        step.execution = clearDispatchLock(step.execution, now);
        step.updatedAt = now;
        project.updatedAt = now;
        dirty = true;
      }
    }
    if (dirty) saveState(state);
  }
}

// Fallimento definitivo di un progetto: scrive project.status top-level
// (patchProjectExecution non lo puo' fare, scrive solo execution.status).
// Un progetto 'failed' e' escluso da listRecoverableProjects e da
// runProjectSerial (che esce se project.status !== 'active'), quindi fermo
// davvero: riparte solo via resumeFailedProject (v2-executor) dopo intervento.
export function setProjectFailed(tenantId, projectId, { stepId = null, error = '', failureReason = 'application-retries-exhausted', applicationRecoveryCount = 0 } = {}, updatedBy = 'v2-executor') {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const now = nowIso();
  project.status = 'failed';
  project.execution = {
    ...project.execution,
    status: 'failed', error, failureReason, applicationRecoveryCount,
    nextRetryAt: null, failedAt: now, updatedAt: now,
  };
  if (stepId) {
    const step = project.steps.find((item) => item.id === stepId);
    if (step) {
      step.status = 'failed';
      step.execution = { ...step.execution, status: 'failed', error, lastErrorKind: 'application', idempotencyKey: null, gatewayRunId: null, updatedAt: now };
      step.updatedAt = now;
    }
  }
  project.updatedAt = now;
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_project_failed', detail: { projectId, stepId, failureReason, applicationRecoveryCount } });
  return project;
}

// Ripresa manuale da 'failed': riporta project.status top-level ad 'active',
// lo step fallito ad 'active' e azzera TUTTI i contatori di retry (cosi' il
// progetto ha un ciclo pulito). Rifiuta stati diversi da 'failed'.
export function setProjectResumedFromFailed(tenantId, projectId, updatedBy = 'v2-executor') {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  if (project.status !== 'failed') throw new Error(`progetto non in stato failed (stato: ${project.status})`);
  const now = nowIso();
  project.status = 'active';
  project.execution = {
    ...project.execution,
    status: 'queued', error: null, nextRetryAt: null,
    recoveryCount: 0, transportRecoveryCount: 0, applicationRecoveryCount: 0,
    applicationAttemptsLeft: null, failureReason: null, failedAt: null, transportWarning: null,
    updatedAt: now,
  };
  const failedStep = project.steps.find((item) => item.status === 'failed');
  if (failedStep) {
    failedStep.status = 'active';
    failedStep.execution = { ...failedStep.execution, status: 'active', phase: 'execution', error: null, lastErrorKind: null, idempotencyKey: null, gatewayRunId: null, updatedAt: now };
    failedStep.updatedAt = now;
    project.currentStepId = failedStep.id;
  }
  project.updatedAt = now;
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_project_resumed_from_failed', detail: { projectId, stepId: failedStep?.id ?? null } });
  return project;
}

export function updateProjectStep(tenantId, projectId, input, updatedBy) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const step = project.steps.find((item) => item.id === input.stepId);
  if (!step) throw new Error('step non trovato');
  if (!['pending', 'active', 'completed', 'blocked', 'needs_approval'].includes(input.status)) throw new Error('status step non valido');
  if (step.id === 'publish' && input.status === 'completed') {
    const brand = state.brandVersions.find((version) => version.id === project.brandVersionId);
    if (brand?.status !== 'active') throw new Error('pubblicazione bloccata: il progetto non usa un Brand Canon attivo');
    if (!input.evidence) throw new Error('pubblicazione bloccata: prova finale richiesta');
  }
  if (step.id === 'brand_qa' && input.status === 'completed') {
    const passedLint = project.evidence.some((evidence) => evidence.type === 'brand-lint' && evidence.ok === true && evidence.brandVersionId === project.brandVersionId);
    if (!passedLint) throw new Error('brand QA bloccata: eseguire un Brand/Claims Linter valido');
  }
  const now = nowIso();
  if (input.model !== undefined) step.model = String(input.model ?? '').trim() || null;
  step.status = input.status;
  step.updatedAt = now;
  if (input.note) step.note = String(input.note);
  if (input.artifact) project.artifacts.push({ id: randomUUID(), stepId: step.id, ...input.artifact, createdAt: now, createdBy: updatedBy });
  if (input.evidence) project.evidence.push({ id: randomUUID(), stepId: step.id, ...input.evidence, createdAt: now, createdBy: updatedBy });
  if (input.status === 'completed') {
    const next = project.steps.find((item) => item.status === 'pending');
    if (next) { next.status = 'active'; next.updatedAt = now; }
  }
  project.currentStepId = project.steps.find((item) => item.status === 'active')?.id ?? null;
  if (project.steps.every((item) => item.status === 'completed')) project.status = 'completed';
  project.updatedAt = now;
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_project_step_updated', detail: { projectId, stepId: step.id, status: step.status } });
  return project;
}

export function configureProjectModels(tenantId, projectId, input, updatedBy) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  if (input.defaultModel) project.defaultModel = String(input.defaultModel);
  if (input.qualityModel) project.qualityModel = String(input.qualityModel);
  if (input.qualityGateMode !== undefined) {
    const qualityGateMode = String(input.qualityGateMode);
    if (!['immediate', 'deferred'].includes(qualityGateMode)) throw new Error('qualityGateMode non valido');
    project.qualityGateMode = qualityGateMode;
  }
  if (input.economicPreReviewEnabled !== undefined) {
    if (typeof input.economicPreReviewEnabled !== 'boolean') throw new Error('economicPreReviewEnabled non valido');
    project.economicPreReviewEnabled = input.economicPreReviewEnabled;
  }
  if (input.economicPreReviewModel) project.economicPreReviewModel = String(input.economicPreReviewModel);
  if (input.economicPreReviewMaxCycles !== undefined) {
    const cycles = Number(input.economicPreReviewMaxCycles);
    if (!Number.isInteger(cycles) || cycles < 0 || cycles > 3) throw new Error('economicPreReviewMaxCycles non valido');
    project.economicPreReviewMaxCycles = cycles;
  }
  if (input.stepId) {
    const step = project.steps.find((item) => item.id === input.stepId);
    if (!step) throw new Error('step non trovato');
    step.model = String(input.model ?? '').trim() || null;
  }
  project.updatedAt = nowIso();
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_project_models_updated', detail: { projectId, stepId: input.stepId ?? null } });
  return project;
}

export function configureProjectNotificationPolicy(tenantId, projectId, input, updatedBy) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  project.notificationPolicy = normalizeProjectNotificationPolicy({
    ...(project.notificationPolicy ?? {}),
    ...(input && typeof input === 'object' ? input : {}),
  });
  project.updatedAt = nowIso();
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_project_notification_policy_updated', detail: { projectId } });
  return project;
}

export function markProjectNotificationSent(tenantId, projectId, { kind, stamp }, updatedBy = 'system') {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const now = nowIso();
  const notificationState = { ...(project.execution?.notificationState ?? {}), lastKind: kind ?? null, lastSentAt: now };
  if (kind === 'completed') notificationState.completedStamp = String(stamp ?? '');
  if (kind === 'failed') notificationState.failedStamp = String(stamp ?? '');
  if (kind === 'waitingApproval') notificationState.waitingApprovalStamp = String(stamp ?? '');
  if (kind === 'needsInput') notificationState.needsInputStamp = String(stamp ?? '');
  project.execution = { ...project.execution, notificationState, updatedAt: project.execution?.updatedAt ?? now };
  project.updatedAt = now;
  saveState(state);
  if (updatedBy) {
    logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_project_notification_sent', detail: { projectId, kind } });
  }
  return project;
}

export function configureReportModel(tenantId, definitionId, model, updatedBy) {
  const state = loadState(tenantId);
  const definition = state.reportDefinitions.find((item) => item.id === definitionId);
  if (!definition) throw new Error('definizione report non trovata');
  definition.model = String(model ?? '').trim() || 'anthropic/claude-opus-5';
  definition.updatedAt = nowIso();
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_report_model_updated', detail: { definitionId, model: definition.model } });
  return definition;
}

export function patchProjectExecution(tenantId, projectId, { project: projectPatch = {}, stepId = null, step: stepPatch = {} }, updatedBy = 'v2-executor') {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const now = nowIso();
  const { lifecycleStatus, ...executionPatch } = projectPatch;
  project.execution = { ...project.execution, ...executionPatch, updatedAt: now };
  if (lifecycleStatus) project.status = lifecycleStatus;
  if (stepId) {
    const step = project.steps.find((item) => item.id === stepId);
    if (!step) throw new Error('step non trovato');
    step.execution = { ...step.execution, ...stepPatch, updatedAt: now };
    if (stepPatch.status) step.status = stepPatch.status;
    step.updatedAt = now;
  }
  project.currentStepId = project.steps.find((item) => item.status === 'active')?.id ?? null;
  if (project.steps.length && project.steps.every((item) => item.status === 'completed')) {
    project.status = 'completed';
    project.execution.status = 'completed';
    project.execution.completedAt = now;
  }
  project.updatedAt = now;
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_project_execution', detail: { projectId, stepId, status: project.execution.status } });
  return project;
}

// Ripresa manuale da 'paused' top-level: runProjectSerial esce subito se
// project.status !== 'active', quindi un progetto in pausa (manuale, rifiuto
// approvazione o stato residuo del bug storico con currentStepId null) non
// ripartiva MAI via /resume (bug C, diagnosi 2026-08-15). Qui lo riportiamo
// ad 'active' riattivando UNO step eseguibile, in ordine di preferenza:
// 1. lo step della pausa/rifiuto (execution.pausedStepId, scritto da
//    resolveProjectInput al rifiuto);
// 2. qualsiasi step 'blocked' o 'needs_approval' (stato post-rifiuto senza
//    traccia: ripremendo Riprendi l'utente conferma esplicitamente
//    l'esecuzione, quindi il gate si considera consumato -> approvedAt);
// 3. il prossimo 'pending'/'proposed' (lo attiva il runner all'ingresso).
// Se non c'e' nessuno step eseguibile (tutti completed) il progetto e' di
// fatto finito: errore esplicito invece di un resume a vuoto.
// Se esiste ancora una richiesta aperta il flusso canonico e' /respond:
// errore esplicito (la UI instrada il bottone su /respond in quel caso).
// Idempotente: rifiuta stati diversi da 'paused', nessun doppio rilancio.
export function resumePausedProject(tenantId, projectId, updatedBy = 'v2-executor') {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  if (project.status !== 'paused') throw new Error(`progetto non in stato paused (stato: ${project.status})`);
  const now = nowIso();
  // Le richieste aperte su step 'deferred' NON bloccano il resume: quello step
  // e' stato saltato in avanti apposta (flusso lineare) e la sua richiesta si
  // risolve per conto suo via /respond; il resto del progetto puo' correre.
  const openRequest = (project.requests ?? []).find((request) => {
    if (request.status !== 'open') return false;
    const requestStep = project.steps.find((item) => item.id === request.stepId);
    return requestStep?.status !== 'deferred';
  });
  if (openRequest) throw new Error(`esiste una richiesta aperta (${openRequest.id}): rispondere alla richiesta invece di riprendere`);
  const pausedStepId = project.execution?.pausedStepId ?? null;
  const pausedStep = pausedStepId ? project.steps.find((item) => item.id === pausedStepId) : null;
  const reactivatable = (item) => ['blocked', 'needs_approval'].includes(item.status);
  const target =
    (pausedStep && reactivatable(pausedStep) ? pausedStep : null) ??
    project.steps.find((item) => reactivatable(item)) ??
    (pausedStep && ['pending', 'proposed', 'active'].includes(pausedStep.status) ? pausedStep : null) ??
    project.steps.find((item) => ['pending', 'proposed', 'active'].includes(item.status));
  if (!target) throw new Error('nessuno step eseguibile da riattivare (progetto concluso)');
  if (reactivatable(target)) {
    // Ripresa dopo rifiuto/pausa esplicita dell'utente sullo stesso step:
    // il Riprendi e' un'approvazione esplicita -> il gate si considera
    // consumato (approvedAt) per evitare la riapertura immediata della
    // richiesta (stesso loop del bug A). sessionKey conservato se presente.
    target.status = 'active';
    target.execution = {
      sessionKey: target.execution?.sessionKey ?? null, phase: 'execution',
      userAnswer: 'ripresa manuale da paused', error: null,
      approvedAt: now, approvedBy: updatedBy, updatedAt: now,
    };
    target.updatedAt = now;
  } else if (target.status === 'active' && !target.execution) {
    // Pausa durante una run attiva (E2): lo step resta 'active' ma la pausa
    // puo' aver interrotto il turno a meta'. Se execution manca (es. stato
    // corrotto o persistenza interrotta) ne creiamo uno coerente per la
    // ripresa: nessun lavoro completato viene rifatto (resume dallo stesso
    // step). sessionKey non esiste in questo ramo (execution assente), quindi
    // l'executor ne generera' uno nuovo deterministico da step.id.
    target.execution = {
      sessionKey: null, phase: 'execution',
      resumedFromPause: true, updatedAt: now,
    };
    target.updatedAt = now;
  } else if (target.status === 'active' && target.execution) {
    // Pausa durante una run attiva con execution presente (caso normale E2):
    // lo step resta 'active', sessionKey e gatewayRunId sono conservati sul
    // disco e l'executor li riusa per non rifare il lavoro completato.
    // Resettiamo solo error/phase per ripartire puliti.
    target.execution = { ...target.execution, phase: 'execution', error: null, resumedFromPause: true, updatedAt: now };
    target.updatedAt = now;
  }
  project.status = 'active';
  project.execution = {
    ...project.execution,
    status: 'queued', error: null, nextRetryAt: null,
    pausedAt: null, pausedReason: null, pausedBy: null, pausedStepId: null,
    updatedAt: now,
  };
  project.currentStepId = project.steps.find((item) => item.status === 'active')?.id ?? target.id;
  project.updatedAt = now;
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_project_resumed_from_paused', detail: { projectId, stepId: target.id, stepStatus: target.status } });
  return project;
}

export function activateNextProjectStep(tenantId, projectId) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const next = project.steps.find((item) => ['pending', 'proposed'].includes(item.status));
  if (next) { next.status = 'active'; next.updatedAt = nowIso(); }
  project.currentStepId = next?.id ?? null;
  saveState(state);
  return project;
}

// Invalida gli step successivi a `stepId` quando il quality gate premium boccia
// lo step: gli step a valle erano stati costruiti sull'output (ora rifiutato)
// dello step corrente, quindi tornano 'pending' e verranno rieseguiti con
// l'output corretto. Usato dal batch deferred: il premium boccia lo step N,
// N+1..M vengono azzerati, il runner riparte da N e rifà tutta la coda.
export function invalidateStepsAfter(tenantId, projectId, stepId) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const index = project.steps.findIndex((item) => item.id === stepId);
  if (index < 0) return project;
  const now = nowIso();
  let invalidated = 0;
  for (let i = index + 1; i < project.steps.length; i += 1) {
    const step = project.steps[i];
    if (step.status === 'needs_premium_review') {
      step.status = 'pending';
      step.execution = null;
      step.updatedAt = now;
      invalidated += 1;
    }
  }
  if (invalidated > 0) {
    project.currentStepId = project.steps.find((item) => item.status === 'active')?.id ?? null;
    project.updatedAt = now;
    saveState(state);
    logAudit({ user: 'v2-executor', tenant: tenantId, event: 'v2_project_steps_invalidated', detail: { projectId, afterStepId: stepId, invalidated } });
  }
  return project;
}

// Al boot: nessun turno Architect può essere in corso (le run vivono in-process),
// quindi ogni flag rimasto true è stantio e va azzerato.
export function clearStaleArchitectBusy(tenantIds) {
  for (const tenantId of tenantIds) {
    const state = loadState(tenantId);
    let dirty = false;
    for (const project of state.projects) {
      if (project.architectBusy) { project.architectBusy = false; dirty = true; }
    }
    if (dirty) saveState(state);
  }
}

export function listRecoverableProjects(tenantIds) {
  return tenantIds.flatMap((tenantId) => loadState(tenantId).projects
    .filter((project) => project.status === 'active' && ['queued', 'running', 'error'].includes(project.execution?.status))
    .sort(compareProjectPriority)
    .map((project) => ({ tenantId, projectId: project.id })));
}

// ---- Flusso lineare tra progetti e task rinviate (decisione Owner 2026-08-29) ----
// Regole: i progetti si eseguono in fila (queueOrder, poi createdAt); dentro un
// progetto le task scorrono in ordine; una task ferma su un input di Owner oltre
// la soglia viene RINVIATA ('deferred', richiesta resta aperta) e si prosegue
// con la successiva; alla risposta la task rinviata riprende con priorita'
// (preemption pulita in v2-executor, mai due agent insieme).

export function compareProjectPriority(a, b) {
  const ka = Number.isFinite(Number(a?.queueOrder)) ? Number(a.queueOrder) : Number.MAX_SAFE_INTEGER;
  const kb = Number.isFinite(Number(b?.queueOrder)) ? Number(b.queueOrder) : Number.MAX_SAFE_INTEGER;
  if (ka !== kb) return ka - kb;
  const ca = String(a?.createdAt ?? '');
  const cb = String(b?.createdAt ?? '');
  if (ca !== cb) return ca.localeCompare(cb);
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

export function setProjectQueueOrder(tenantId, projectId, order, updatedBy = 'v2-executor') {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  project.queueOrder = Number.isFinite(Number(order)) ? Number(order) : null;
  project.updatedAt = nowIso();
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_project_queue_order', detail: { projectId, queueOrder: project.queueOrder } });
  return project;
}

// Gruppo di appartenenza (vista raggruppata, richiesta Owner 2026-08-29):
// etichetta libera tipo "Lancio USA". Solo visuale: la fila di esecuzione
// resta globale su queueOrder/createdAt.
export function setProjectGroup(tenantId, projectId, group, updatedBy = 'v2-executor') {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  project.group = String(group ?? '').trim() || null;
  project.updatedAt = nowIso();
  saveState(state);
  logAudit({ user: updatedBy, tenant: tenantId, event: 'v2_project_group', detail: { projectId, group: project.group } });
  return project;
}

const RUNNABLE_STEP_STATUSES = ['active', 'pending', 'proposed'];
export function projectHasRunnableSteps(project) {
  return (project?.steps ?? []).some((step) => RUNNABLE_STEP_STATUSES.includes(step.status));
}

// Un progetto "tiene la fila" (i successivi NON partono) finche' puo' ancora
// avanzare da solo: run viva/in coda, errore con retry programmato, gate
// premium, oppure attesa input DENTRO la finestra di grazia (ha ancora task
// eseguibili: o risponde Owner o scatta il rinvio). NON tiene la fila se e'
// completamente fermo su Owner (tutte le task restanti rinviate/bloccate),
// in pausa (manuale o preemption), failed, completed, discovery o archiviato.
function projectHoldsPipeline(project) {
  if (!project || project.archivedAt) return false;
  if (project.status === 'needs_premium_review') return true;
  if (project.status !== 'active') return false;
  const exec = project.execution?.status ?? 'idle';
  if (['queued', 'running', 'error'].includes(exec)) return true;
  if (['needs_input', 'waiting_approval'].includes(exec)) return projectHasRunnableSteps(project);
  return false;
}

export function findBlockingEarlierProject(tenantId, projectId) {
  const state = loadState(tenantId);
  const target = state.projects.find((item) => item.id === projectId);
  if (!target) return null;
  const blocking = state.projects
    .filter((item) => item.id !== projectId && compareProjectPriority(item, target) < 0 && projectHoldsPipeline(item))
    .sort(compareProjectPriority)[0] ?? null;
  return blocking
    ? { id: blocking.id, title: blocking.title, status: blocking.status, executionStatus: blocking.execution?.status ?? null }
    : null;
}

// Rinvia le task ferme su una richiesta aperta piu' vecchia della soglia: lo
// step passa a 'deferred' (la richiesta RESTA aperta, si risolve via /respond)
// e il progetto torna in coda per proseguire con la task successiva. Se non
// resta nulla di eseguibile il progetto va in attesa piena (needs_input) e
// LIBERA la fila: parte il progetto successivo.
export function deferOverdueInputSteps(tenantId, projectId, { olderThanMs = 0, now = Date.now() } = {}) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  if (project.status !== 'active') return { deferred: [], hasRunnableNext: false, project };
  if (!['needs_input', 'waiting_approval'].includes(project.execution?.status ?? '')) return { deferred: [], hasRunnableNext: false, project };
  const iso = nowIso();
  const deferred = [];
  for (const request of project.requests ?? []) {
    if (request.status !== 'open') continue;
    const createdMs = Date.parse(request.createdAt ?? '');
    if (!Number.isFinite(createdMs) || now - createdMs < Number(olderThanMs)) continue;
    const step = project.steps.find((item) => item.id === request.stepId);
    if (!step || !['blocked', 'needs_approval'].includes(step.status)) continue;
    step.status = 'deferred';
    step.execution = { ...(step.execution ?? {}), deferredAt: iso, deferredReason: 'awaiting_user_input', updatedAt: iso };
    step.updatedAt = iso;
    deferred.push({ id: step.id, label: step.label, requestId: request.id });
  }
  if (!deferred.length) return { deferred, hasRunnableNext: false, project };
  const hasRunnableNext = projectHasRunnableSteps(project);
  if (hasRunnableNext) {
    project.execution = {
      ...project.execution, status: 'queued', error: null, nextRetryAt: null,
      queueReason: 'risposta in attesa: task rinviata, proseguo con la successiva', updatedAt: iso,
    };
  } else {
    project.execution = { ...project.execution, status: 'needs_input', updatedAt: iso };
  }
  project.currentStepId = project.steps.find((item) => item.status === 'active')?.id ?? null;
  project.updatedAt = iso;
  saveState(state);
  logAudit({ user: 'v2-executor', tenant: tenantId, event: 'v2_project_steps_deferred', detail: { projectId, deferred: deferred.map((item) => item.id), hasRunnableNext } });
  return { deferred, hasRunnableNext, project: getProject(tenantId, projectId) };
}

// Riattiva le task rinviate per DIPENDENZA (il worker ha risposto
// blocked_on_dependency): tornano 'pending' solo quando prima di loro non
// restano task ferme in attesa di Owner, altrimenti girerebbero a vuoto
// ributtando fuori lo stesso blocco.
export function reactivateDependencyDeferredSteps(tenantId, projectId) {
  const state = loadState(tenantId);
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('progetto non trovato');
  const iso = nowIso();
  let reactivated = 0;
  project.steps.forEach((step, index) => {
    if (step.status !== 'deferred' || step.execution?.deferredReason !== 'dependency') return;
    const stillWaitingBefore = project.steps.slice(0, index).some((prev) => ['deferred', 'blocked', 'needs_approval'].includes(prev.status));
    if (stillWaitingBefore) return;
    step.status = 'pending';
    step.execution = { ...(step.execution ?? {}), deferredAt: null, deferredReason: null, updatedAt: iso };
    step.updatedAt = iso;
    reactivated += 1;
  });
  if (reactivated) {
    project.updatedAt = iso;
    saveState(state);
    logAudit({ user: 'v2-executor', tenant: tenantId, event: 'v2_project_steps_dependency_reactivated', detail: { projectId, reactivated } });
  }
  return { reactivated, project: getProject(tenantId, projectId) };
}

export function listInputWaitingProjects(tenantIds) {
  return tenantIds.flatMap((tenantId) => loadState(tenantId).projects
    .filter((project) => project.status === 'active'
      && ['needs_input', 'waiting_approval'].includes(project.execution?.status ?? '')
      && (project.requests ?? []).some((request) => request.status === 'open'))
    .map((project) => ({ tenantId, projectId: project.id })));
}

export function listPreemptedProjects(tenantIds) {
  return tenantIds.flatMap((tenantId) => loadState(tenantId).projects
    .filter((project) => ['active', 'needs_premium_review'].includes(project.status)
      && project.execution?.status === 'paused'
      && project.execution?.pausedReason === 'preempted')
    .map((project) => ({ tenantId, projectId: project.id, lifecycle: project.status })));
}

export function listPremiumReviewProjects(tenantIds) {
  return tenantIds.flatMap((tenantId) => loadState(tenantId).projects
    .filter((project) => project.status === 'needs_premium_review')
    .map((project) => ({ tenantId, projectId: project.id })));
}

export function createBrandVersion(tenantId, input, createdBy) {
  const state = loadState(tenantId);
  const version = {
    id: randomUUID(), version: String(input.version ?? `v0.${state.brandVersions.length + 1}-draft`).trim(), status: 'draft',
    name: String(input.name ?? `${tenantId} Brand Canon`).trim(), core: input.core ?? {}, notes: String(input.notes ?? ''),
    createdAt: nowIso(), createdBy,
  };
  state.brandVersions.push(version);
  saveState(state);
  logAudit({ user: createdBy, tenant: tenantId, event: 'v2_brand_version_created', detail: { brandVersionId: version.id, version: version.version } });
  return version;
}

export function activateBrandVersion(tenantId, brandVersionId, activatedBy) {
  const state = loadState(tenantId);
  const target = state.brandVersions.find((version) => version.id === brandVersionId);
  if (!target) throw new Error('versione brand non trovata');
  for (const version of state.brandVersions) if (version.status === 'active') version.status = 'archived';
  target.status = 'active';
  target.activatedAt = nowIso();
  target.activatedBy = activatedBy;
  saveState(state);
  logAudit({ user: activatedBy, tenant: tenantId, event: 'v2_brand_version_activated', detail: { brandVersionId: target.id, version: target.version } });
  return target;
}

export function addDataSignals(tenantId, input, createdBy) {
  const state = loadState(tenantId);
  if (!Array.isArray(input.signals) || !input.signals.length) throw new Error('signals richiesti');
  const createdAt = nowIso();
  const signals = input.signals.map((signal) => {
    const value = Number(signal.value);
    if (!signal.metric || !Number.isFinite(value)) throw new Error('ogni signal richiede metric e value numerico');
    return { id: randomUUID(), metric: String(signal.metric), value, unit: String(signal.unit ?? ''), dimension: String(signal.dimension ?? 'all'), source: String(signal.source ?? 'manual'), observedAt: signal.observedAt ?? createdAt, metadata: signal.metadata ?? {}, createdAt, createdBy };
  });
  state.signals.push(...signals);
  state.signals = state.signals.slice(-5000);
  saveState(state);
  return signals;
}

const metricRule = (metric) => METRIC_RULES.find((rule) => rule.pattern.test(metric)) ?? null;
const fingerprint = (signal) => `${signal.metric}:${signal.dimension}`.toLowerCase();

export function runAutopilot(tenantId, { source = 'manual', user = 'system' } = {}) {
  const state = loadState(tenantId);
  const groups = new Map();
  for (const signal of state.signals) groups.set(fingerprint(signal), [...(groups.get(fingerprint(signal)) ?? []), signal]);
  const created = [];
  for (const values of groups.values()) {
    values.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    const current = values.at(-1);
    const previous = values.at(-2);
    if (!current || !previous || previous.value === 0) continue;
    const rule = metricRule(current.metric);
    if (!rule) continue;
    const deltaPct = ((current.value - previous.value) / Math.abs(previous.value)) * 100;
    const worsening = rule.better === 'higher' ? deltaPct <= -15 : deltaPct >= 15;
    const alreadyAnalyzed = state.opportunities.some((item) => item.fingerprint === fingerprint(current) && item.sourceSignalIds?.includes(current.id));
    if (!worsening || alreadyAnalyzed) continue;
    const direction = deltaPct > 0 ? 'aumentata' : 'diminuita';
    const opportunity = {
      id: randomUUID(), tenantId, fingerprint: fingerprint(current), status: 'open', severity: Math.abs(deltaPct) >= 35 ? 'high' : 'medium',
      title: `${current.metric} ${direction} del ${Math.abs(deltaPct).toFixed(1)}%`, summary: `${current.dimension}: ${previous.value}${current.unit} → ${current.value}${current.unit}`,
      metric: current.metric, dimension: current.dimension, currentValue: current.value, previousValue: previous.value,
      deltaPct: Number(deltaPct.toFixed(2)), confidence: values.length >= 4 ? 'high' : 'medium',
      recommendation: 'Aprire un progetto di diagnosi prima di modificare budget, claim o funnel.',
      suggestedWorkflowType: 'funnel_optimization', sourceSignalIds: [previous.id, current.id], createdAt: nowIso(), source,
    };
    state.opportunities.push(opportunity);
    created.push(opportunity);
  }
  const report = {
    id: randomUUID(), tenantId, type: 'autopilot-sentinel', title: `Autopilot report ${nowIso().slice(0, 10)}`,
    summary: created.length ? `${created.length} nuove opportunità o anomalie rilevate.` : 'Nessuna nuova anomalia oltre soglia sui dati disponibili.',
    opportunityIds: created.map((item) => item.id), signalCount: state.signals.length, createdAt: nowIso(), source,
  };
  state.reports.push(report);
  state.reports = state.reports.slice(-180);
  saveState(state);
  logAudit({ user, tenant: tenantId, event: 'v2_autopilot_run', detail: { source, created: created.length, signalCount: state.signals.length } });
  return { report, opportunities: created };
}

function zonedScheduleParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    day: Number(values.day), hour: Number(values.hour), weekday: weekdayMap[values.weekday],
  };
}

function dueSlotKey(definition, date) {
  const schedule = definition.schedule ?? {};
  const parts = zonedScheduleParts(date, schedule.timezone);
  if (parts.hour !== Number(schedule.hour ?? 8)) return null;
  if (schedule.cadence === 'daily') return `daily:${parts.date}`;
  if (schedule.cadence === 'weekly' && parts.weekday === Number(schedule.weekday ?? 1)) return `weekly:${parts.date}`;
  if (schedule.cadence === 'monthly' && parts.day === Number(schedule.dayOfMonth ?? 1)) return `monthly:${parts.date}`;
  return null;
}

function signalSeriesForKpi(state, kpi) {
  return state.signals
    .filter((signal) => signal.metric.toLocaleLowerCase('en-US') === kpi.metric.toLocaleLowerCase('en-US')
      && (kpi.dimension === 'all' || signal.dimension === kpi.dimension))
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
}

export function generateReportFromDefinition(tenantId, definitionId, { source = 'manual', user = 'system', now = new Date() } = {}) {
  const state = loadState(tenantId);
  const definition = state.reportDefinitions.find((item) => item.id === definitionId);
  if (!definition) throw new Error('definizione report non trovata');
  if (definition.status !== 'active') throw new Error('report non attivo');
  const rows = definition.kpis.map((kpi) => {
    const series = signalSeriesForKpi(state, kpi);
    const current = series.at(-1) ?? null;
    const previous = series.at(-2) ?? null;
    const deltaPct = current && previous && previous.value !== 0
      ? Number((((current.value - previous.value) / Math.abs(previous.value)) * 100).toFixed(1))
      : null;
    return { kpi, current, previous, deltaPct, available: Boolean(current) };
  });
  const available = rows.filter((row) => row.available);
  const missing = rows.filter((row) => !row.available);
  const markdownRows = rows.map((row) => {
    if (!row.current) return `- **${row.kpi.label}**: dato non collegato`;
    const delta = row.deltaPct === null ? 'baseline non disponibile' : `${row.deltaPct > 0 ? '+' : ''}${row.deltaPct}% vs precedente`;
    return `- **${row.kpi.label}**: ${row.current.value}${row.current.unit || row.kpi.unit || ''} (${delta})`;
  }).join('\n');
  const missingSources = definition.dataSources.filter((sourceName) => !state.signals.some((signal) => signal.source === sourceName));
  const createdAt = now.toISOString();
  const content = `# ${definition.layout?.title || definition.title}\n\n## Executive summary\n${available.length}/${rows.length} KPI disponibili. ${missing.length ? `${missing.length} KPI non sono ancora alimentati.` : 'Tutti i KPI richiesti sono disponibili.'}\n\n## KPI\n${markdownRows || '- Nessun KPI definito'}\n\n## Decisioni e alert\n${available.some((row) => Math.abs(row.deltaPct ?? 0) >= 15) ? '- Sono presenti variazioni oltre il 15% da analizzare.' : '- Nessuna variazione oltre soglia sui dati disponibili.'}\n\n## Qualità dati\n${missingSources.length ? `- Fonti non collegate: ${missingSources.join(', ')}` : '- Fonti richieste presenti nei segnali normalizzati.'}`;
  const report = {
    id: randomUUID(), tenantId, definitionId: definition.id, type: 'custom-recurring',
    title: definition.title, summary: `${available.length}/${rows.length} KPI disponibili${missing.length ? `, ${missing.length} mancanti` : ''}.`,
    content, kpiRows: rows, createdAt, source,
  };
  state.reports.push(report);
  state.reports = state.reports.slice(-500);
  definition.lastRunAt = createdAt;
  definition.updatedAt = createdAt;
  saveState(state);
  logAudit({ user, tenant: tenantId, event: 'v2_custom_report_generated', detail: { definitionId, reportId: report.id, available: available.length, missing: missing.length } });
  return report;
}

export function convertReportToProject(tenantId, reportId, input, createdBy) {
  const state = loadState(tenantId);
  const report = state.reports.find((item) => item.id === reportId);
  if (!report) throw new Error('report non trovato');
  const definition = report.definitionId ? state.reportDefinitions.find((item) => item.id === report.definitionId) ?? null : null;
  const sourceSnapshot = {
    type: 'report', id: report.id, title: report.title, summary: report.summary,
    content: report.content ?? '', kpiRows: report.kpiRows ?? [], source: report.source,
    createdAt: report.createdAt,
    definition: definition ? {
      id: definition.id, title: definition.title, purpose: definition.purpose, audience: definition.audience,
      dataSources: definition.dataSources, kpis: definition.kpis, layout: definition.layout, facsimile: definition.facsimile,
    } : null,
  };
  const project = createProject(tenantId, {
    title: String(input.title ?? '').trim() || `Intervento da report: ${report.title}`,
    objective: String(input.objective ?? '').trim() || `Analizzare e migliorare quanto emerso dal report ${report.title}`,
    sourceReportId: report.id, contextSources: [sourceSnapshot],
    skillIds: Array.isArray(input.skillIds) ? input.skillIds : [],
  }, createdBy);
  logAudit({ user: createdBy, tenant: tenantId, event: 'v2_report_converted_to_project', detail: { reportId, projectId: project.id, definitionId: report.definitionId ?? null } });
  return getProject(tenantId, project.id);
}

export function runDueReportDefinitions(tenantId, { now = new Date(), user = 'report-scheduler' } = {}) {
  const state = loadState(tenantId);
  const due = state.reportDefinitions
    .filter((definition) => definition.status === 'active')
    .map((definition) => ({ definition, slotKey: dueSlotKey(definition, now) }))
    .filter(({ definition, slotKey }) => slotKey && definition.lastSlotKey !== slotKey);
  const generated = [];
  for (const { definition, slotKey } of due) {
    const report = generateReportFromDefinition(tenantId, definition.id, { source: 'schedule', user, now });
    const fresh = loadState(tenantId);
    const target = fresh.reportDefinitions.find((item) => item.id === definition.id);
    target.lastSlotKey = slotKey;
    saveState(fresh);
    generated.push(report);
  }
  return generated;
}

export function convertOpportunityToProject(tenantId, opportunityId, input, createdBy) {
  const state = loadState(tenantId);
  const opportunity = state.opportunities.find((item) => item.id === opportunityId);
  if (!opportunity) throw new Error('opportunità non trovata');
  if (opportunity.projectId) return state.projects.find((project) => project.id === opportunity.projectId) ?? getProject(tenantId, opportunity.projectId);
  const project = createProject(tenantId, {
    title: input.title ?? opportunity.title,
    objective: input.objective ?? `Diagnosticare e correggere: ${opportunity.summary}`,
    brief: { opportunity }, sourceOpportunityId: opportunity.id,
  }, createdBy);
  const contextualState = loadState(tenantId);
  const contextualProject = contextualState.projects.find((item) => item.id === project.id);
  contextualProject.messages[0].text = `Ho aperto questo progetto dall’Autopilot. Il segnale è: ${opportunity.summary}\n\nPrima di definire le task: vuoi solo una diagnosi e proposta, oppure anche preparazione ed esecuzione dell’intervento?`;
  contextualProject.updatedAt = nowIso();
  saveState(contextualState);
  const freshState = loadState(tenantId);
  const freshOpportunity = freshState.opportunities.find((item) => item.id === opportunityId);
  freshOpportunity.status = 'converted';
  freshOpportunity.projectId = project.id;
  freshOpportunity.convertedAt = nowIso();
  saveState(freshState);
  return project;
}

export function createOperatingApproval(tenantId, input, createdBy) {
  const state = loadState(tenantId);
  const approval = {
    id: randomUUID(), tenantId, projectId: input.projectId ?? null, actionType: String(input.actionType ?? 'external_action'),
    title: String(input.title ?? '').trim(), reason: String(input.reason ?? '').trim(), impact: String(input.impact ?? ''),
    rollback: String(input.rollback ?? ''), status: 'pending', payload: input.payload ?? {}, createdAt: nowIso(), createdBy,
  };
  if (!approval.title || !approval.reason) throw new Error('titolo e motivo richiesti');
  state.approvals.push(approval);
  saveState(state);
  return approval;
}

export function resolveOperatingApproval(tenantId, approvalId, input, resolvedBy) {
  const state = loadState(tenantId);
  const approval = state.approvals.find((item) => item.id === approvalId);
  if (!approval) throw new Error('approvazione non trovata');
  if (approval.status !== 'pending') throw new Error('approvazione già risolta');
  if (!['approved', 'rejected'].includes(input.status)) throw new Error('status approvazione non valido');
  approval.status = input.status;
  approval.note = String(input.note ?? '');
  approval.resolvedAt = nowIso();
  approval.resolvedBy = resolvedBy;
  saveState(state);
  logAudit({ user: resolvedBy, tenant: tenantId, event: 'v2_approval_resolved', detail: { approvalId, status: approval.status } });
  return approval;
}
