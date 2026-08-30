import { join } from 'path';
import { CONFIG_DIR, readJson } from './store.js';

const BASE_POLICY = Object.freeze({
  completed: true,
  failed: true,
  waitingApproval: true,
  needsInput: true,
});

function readBool(obj, key) {
  if (!obj || typeof obj !== 'object' || !(key in obj)) return undefined;
  return Boolean(obj[key]);
}

export function normalizeV2ProjectNotificationPolicy(input, defaults = BASE_POLICY) {
  return {
    completed: readBool(input, 'completed') ?? defaults.completed,
    failed: readBool(input, 'failed') ?? defaults.failed,
    waitingApproval: readBool(input, 'waitingApproval') ?? defaults.waitingApproval,
    needsInput: readBool(input, 'needsInput') ?? defaults.needsInput,
  };
}

const pushCfg = readJson(join(CONFIG_DIR, 'platform.json'), {})?.push ?? {};
export const DEFAULT_V2_PROJECT_NOTIFICATION_POLICY = normalizeV2ProjectNotificationPolicy(pushCfg.v2ProjectDefaults, BASE_POLICY);

export function resolveV2ProjectNotificationPolicy(project) {
  return normalizeV2ProjectNotificationPolicy(project?.notificationPolicy, DEFAULT_V2_PROJECT_NOTIFICATION_POLICY);
}

function currentStep(project) {
  return project?.steps?.find((step) => step.id === project.currentStepId)
    ?? project?.steps?.find((step) => step.status === 'active' || step.status === 'needs_approval')
    ?? null;
}

export function getV2ProjectPushCandidate(project, { tenantName } = {}) {
  if (!project || typeof project !== 'object') return null;
  const policy = resolveV2ProjectNotificationPolicy(project);
  const notificationState = project.execution?.notificationState ?? {};
  const tenantLabel = tenantName ?? project.tenantId ?? 'tenant';
  const step = currentStep(project);

  const completedStamp = String(project.execution?.completedAt ?? project.updatedAt ?? '');
  if ((project.status === 'completed' || project.execution?.status === 'completed') && policy.completed && completedStamp) {
    if (notificationState.completedStamp !== completedStamp) {
      return {
        kind: 'completed',
        stamp: completedStamp,
        payload: {
          title: `✅ Progetto completato — ${tenantLabel}`,
          body: String(project.title ?? 'Progetto').slice(0, 240),
          tag: `v2-project-completed-${project.id}`,
          decision: { kind: 'project', id: project.id, tenantId: project.tenantId },
        },
      };
    }
  }

  const failedStamp = String(project.execution?.failedAt ?? project.updatedAt ?? '');
  if ((project.status === 'failed' || project.execution?.status === 'failed') && policy.failed && failedStamp) {
    if (notificationState.failedStamp !== failedStamp) {
      const reason = String(project.execution?.error ?? project.execution?.failureReason ?? step?.execution?.error ?? '').replace(/\s+/g, ' ').trim();
      return {
        kind: 'failed',
        stamp: failedStamp,
        payload: {
          title: `❌ Progetto fallito — ${tenantLabel}`,
          body: (reason ? `${project.title}\n${reason}` : String(project.title ?? 'Progetto')).slice(0, 240),
          tag: `v2-project-failed-${project.id}`,
          decision: { kind: 'project', id: project.id, tenantId: project.tenantId },
        },
      };
    }
  }

  const waitingApproval = project.execution?.status === 'waiting_approval' || step?.status === 'needs_approval';
  const waitingApprovalStamp = `${step?.id ?? project.currentStepId ?? 'project'}:${step?.updatedAt ?? project.updatedAt ?? ''}`;
  if (waitingApproval && policy.waitingApproval && waitingApprovalStamp) {
    if (notificationState.waitingApprovalStamp !== waitingApprovalStamp) {
      return {
        kind: 'waitingApproval',
        stamp: waitingApprovalStamp,
        payload: {
          title: `❓ Approvazione richiesta — ${tenantLabel}`,
          body: `${String(project.title ?? 'Progetto').slice(0, 120)}\n${String(step?.label ?? 'Step in attesa').slice(0, 120)}`.slice(0, 240),
          tag: `v2-project-approval-${project.id}`,
          decision: { kind: 'project', id: project.id, tenantId: project.tenantId },
        },
      };
    }
  }

  // DOMANDE DI INPUT (fix 2026-08-29): erano l'unico evento SENZA push, cioe'
  // proprio quello che nel flusso lineare richiede Owner (le approvazioni le
  // chiude l'auto-approver, gli input no). Una push per richiesta aperta
  // (dedup sull'id), col testo della domanda e il deep-link al progetto.
  const openInput = (project.requests ?? [])
    .filter((request) => request.status === 'open' && request.type !== 'approval')
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0] ?? null;
  if (openInput && policy.needsInput) {
    const needsInputStamp = String(openInput.id);
    if (notificationState.needsInputStamp !== needsInputStamp) {
      return {
        kind: 'needsInput',
        stamp: needsInputStamp,
        payload: {
          title: `✋ Serve una tua risposta — ${tenantLabel}`,
          body: `${String(project.title ?? 'Progetto').slice(0, 100)}\n${String(openInput.question ?? 'Domanda in attesa').slice(0, 140)}`.slice(0, 240),
          tag: `v2-project-input-${project.id}`,
          decision: { kind: 'project', id: project.id, tenantId: project.tenantId },
        },
      };
    }
  }

  return null;
}
