import { AppError, idSchema } from '@ensemus/application';
import {
  approveModelWorkloadSchema,
  requestModelQualificationSchema,
} from '@ensemus/contracts/knowledge-models';
import type {
  ModelQualificationView,
  ModelWorkloadApprovalView,
} from '@ensemus/application/knowledge/model-jobs';

const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
};
const integer = (form: FormData, key: string) => {
  const value = text(form, key);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new AppError('INVALID_INPUT');
  return Number(value);
};
const idOf = (form: FormData, key: string, optional = false) => {
  const raw = text(form, key);
  if (optional && !raw) return null;
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
};
const values = (form: FormData, key: string) =>
  form.getAll(key).map((value) => {
    if (typeof value !== 'string') throw new AppError('INVALID_INPUT');
    return value;
  });
const bounds = (form: FormData) => ({
  maxCalls: integer(form, 'maxCalls'),
  maxInputTokens: integer(form, 'maxInputTokens'),
  maxOutputTokens: integer(form, 'maxOutputTokens'),
  maxTotalTokens: integer(form, 'maxTotalTokens'),
  maxCostMicros: integer(form, 'maxCostMicros'),
  timeoutSeconds: integer(form, 'timeoutSeconds'),
});
export function qualificationFromForm(form: FormData) {
  const parsed = requestModelQualificationSchema.safeParse({
    profileId: idOf(form, 'profileId'),
    expectedProfileVersion: integer(form, 'version'),
    purpose: text(form, 'purpose'),
    dimension: text(form, 'dimension') ? integer(form, 'dimension') : null,
    vectorSpaceVersion: text(form, 'vectorSpaceVersion') || null,
    requestKey: idOf(form, 'requestKey'),
    bounds: bounds(form),
  });
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}
export function workloadFromForm(form: FormData) {
  const parsed = approveModelWorkloadSchema.safeParse({
    kind: text(form, 'kind'),
    scope: text(form, 'scope'),
    sourceId: idOf(form, 'sourceId', true),
    connectionId: idOf(form, 'connectionId', true),
    purposes: values(form, 'purposes'),
    qualificationIds: values(form, 'qualificationIds'),
    maxClassification: text(form, 'maxClassification'),
    bounds: bounds(form),
    expiresAt: text(form, 'expiresAt'),
    requestKey: idOf(form, 'requestKey'),
  });
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}
export const PURPOSE_LABEL = {
  embed: 'Semantic indexing',
  rerank: 'Search ranking',
  answer: 'Grounded answers',
};
export const WORKLOAD_LABEL: Record<string, string> = {
  document_embed: 'Index documents',
  query: 'Semantic search',
  answer: 'Answer a question',
  agent_context: 'Agent evidence',
};
export function qualificationState(
  q: Pick<ModelQualificationView, 'state' | 'current' | 'usable' | 'job'>,
) {
  if (q.job?.unknownOutcome)
    return {
      label: 'Outcome unknown',
      detail: 'A paid attempt has no confirmed outcome. It is not retried automatically.',
      tone: 'unknown',
    };
  if (!q.current)
    return {
      label: 'Earlier profile version',
      detail: 'This evidence cannot authorize the current profile version.',
      tone: '',
    };
  if (q.usable)
    return {
      label: 'Qualified',
      detail: 'The exact capability and current profile version passed.',
      tone: 'done',
    };
  if (q.state === 'passed')
    return {
      label: 'Unavailable',
      detail: 'The evidence passed, but this model is not active.',
      tone: '',
    };
  if (q.job?.state === 'refused' || q.job?.state === 'fenced')
    return {
      label: 'Refused',
      detail:
        'No qualification was granted. Review the recorded refusal before making a new request.',
      tone: 'attention',
    };
  if (q.state === 'failed')
    return {
      label: 'Failed',
      detail: 'The capability did not pass. No workload is authorized by this evidence.',
      tone: 'bad',
    };
  return {
    label: q.job?.state === 'running' ? 'In progress' : 'Queued',
    detail: 'Waiting for a confirmed worker result. Queueing is not qualification.',
    tone: 'active',
  };
}
export function workloadState(
  a: Pick<ModelWorkloadApprovalView, 'revokedAt' | 'expiresAt' | 'qualifications'>,
  now = Date.now(),
) {
  if (a.revokedAt) return 'Revoked';
  if (new Date(a.expiresAt).getTime() <= now) return 'Expired';
  if (!a.qualifications.length || a.qualifications.some((q) => !q.usable))
    return 'Model evidence unavailable';
  return 'Approved within limits';
}
