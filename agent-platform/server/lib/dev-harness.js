const MAX_TEXT = 2_400;

function compactText(value, maxChars = MAX_TEXT) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function compactValue(value, maxChars = MAX_TEXT) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return compactText(value, maxChars);
  try {
    return compactText(JSON.stringify(value), maxChars);
  } catch {
    return compactText(String(value), maxChars);
  }
}

function compactList(values, map, maxItems = 6) {
  return (Array.isArray(values) ? values : []).slice(-maxItems).map(map).filter(Boolean);
}

export function buildDevelopmentTaskPack(context, step) {
  const project = context?.project ?? {};
  const task = {
    id: String(step?.id ?? ''),
    title: compactText(step?.label, 240),
    description: compactText(step?.description, 2_000),
    approvalRequired: Boolean(step?.approvalRequired),
    acceptanceCriteria: compactList(project.successCriteria, (item) => compactText(item, 360), 12),
  };
  return {
    version: 1,
    project: {
      id: String(project.id ?? ''),
      title: compactText(project.title, 240),
      objective: compactText(project.objective, 900),
      brief: compactValue(project.brief, 1_600),
    },
    task,
    constraints: {
      noInventedClaims: context?.platformRules?.noInventedClaims !== false,
      finalEvidenceRequired: context?.platformRules?.doneRequiresFinalEnvironmentEvidence !== false,
      externalHighImpactActionsRequireApproval: context?.platformRules?.externalHighImpactActionsRequireApproval !== false,
    },
    taskContext: {
      sharedContext: compactText(context?.sharedContext, 3_000),
      relevantArtifacts: compactList(context?.relevantArtifacts, (artifact) => ({
        id: String(artifact?.id ?? ''),
        title: compactText(artifact?.title ?? artifact?.name ?? artifact?.type, 180),
        status: compactText(artifact?.status, 80),
        content: compactValue(artifact?.content ?? artifact?.summary ?? artifact?.metadata, 700),
      })),
      contextSources: compactList(context?.contextSources, (source) => ({
        id: String(source?.id ?? ''),
        title: compactText(source?.title ?? source?.name ?? source?.type, 180),
        type: compactText(source?.type, 80),
        content: compactValue(source?.content ?? source?.summary ?? source?.definition, 900),
      }), 4),
      recentDecisions: compactList(context?.recentDecisions, (decision) => compactValue(decision, 700), 5),
      recentMessages: compactList(context?.recentMessages, (message) => ({
        role: compactText(message?.role, 30),
        text: compactText(message?.text, 600),
      }), 2),
    },
    executionContract: {
      exploreBeforeEditing: true,
      maximumImplementationTurns: 5,
      requiredEvidence: ['file o output prodotto', 'verifica realmente eseguita'],
      handoffRequired: true,
    },
  };
}

export function summarizeTaskPack(pack) {
  return {
    version: pack.version,
    chars: JSON.stringify(pack).length,
    acceptanceCriteria: pack.task.acceptanceCriteria.length,
    artifacts: pack.taskContext.relevantArtifacts.length,
    sources: pack.taskContext.contextSources.length,
    decisions: pack.taskContext.recentDecisions.length,
    messages: pack.taskContext.recentMessages.length,
  };
}

export function normalizeUsage(usage, model) {
  if (!usage || typeof usage !== 'object') return { model: model ?? null, available: false };
  const readNumber = (...keys) => {
    for (const key of keys) {
      const value = Number(usage[key]);
      if (Number.isFinite(value) && value >= 0) return value;
    }
    return 0;
  };
  const inputTokens = readNumber('prompt_tokens', 'input_tokens');
  const outputTokens = readNumber('completion_tokens', 'output_tokens');
  const totalTokens = readNumber('total_tokens') || inputTokens + outputTokens;
  return {
    model: model ?? null,
    available: inputTokens > 0 || outputTokens > 0 || totalTokens > 0,
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens: readNumber('cache_read_input_tokens', 'cached_tokens'),
    cacheCreationTokens: readNumber('cache_creation_input_tokens'),
  };
}

export function buildTaskHandoff({ pack, taskResult, worker, quality, qualityOutput, workerUsage, qualityUsage, economicPreReview = null }) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    task: pack.task,
    taskPack: summarizeTaskPack(pack),
    worker: {
      model: worker?.modelUsed ?? null,
      status: compactText(taskResult?.status, 80),
      summary: compactText(taskResult?.summary, 1_200),
      evidence: compactList(taskResult?.evidence, (item) => compactText(item, 500), 12),
      artifacts: compactList(taskResult?.artifacts, (item) => compactText(item, 500), 12),
    },
    quality: quality ? {
      approved: quality?.approved === true,
      score: Number.isFinite(Number(quality?.score)) ? Number(quality.score) : 0,
      feedback: compactText(quality?.feedback, 1_500),
      checks: compactList(quality?.checks, (item) => compactText(item, 500), 12),
      output: compactText(qualityOutput, 1_500),
    } : null,
    economicPreReview: economicPreReview ? {
      model: compactText(economicPreReview.model, 160),
      maxCycles: Number(economicPreReview.maxCycles) || 0,
      reviewCount: Number(economicPreReview.reviewCount) || 0,
      revisionCount: Number(economicPreReview.revisionCount) || 0,
      approved: economicPreReview.approved === true,
      limitReached: economicPreReview.limitReached === true,
      feedback: compactText(economicPreReview.feedback, 1_500),
      reviews: compactList(economicPreReview.reviews, (review) => ({
        index: Number(review?.index) || 0,
        approved: review?.approved === true,
        score: Number(review?.score) || 0,
        feedback: compactText(review?.feedback, 700),
        checks: compactList(review?.checks, (item) => compactText(item, 300), 6),
      }), 4),
    } : null,
    usage: { worker: workerUsage, quality: qualityUsage },
  };
}
