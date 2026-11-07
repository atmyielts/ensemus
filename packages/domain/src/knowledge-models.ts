// Knowledge operations are distinct from a general generation call. These are approved wire
// protocols, not aliases for another purpose and not claims about an untested provider.
import type { ModelPurpose } from './ai';
export const MODEL_JOB_REQUESTED = 'knowledge.model_job_requested';
export const AGGREGATE_MODEL_JOB = 'model_job';
/** Transport ceiling, not a job default or provider spending authority. */
export const MAX_MODEL_JOB_TIMEOUT_SECONDS = 86400;

export const KNOWLEDGE_MODEL_PURPOSES = ['embed', 'rerank', 'answer'] as const;
export type KnowledgeModelPurpose = (typeof KNOWLEDGE_MODEL_PURPOSES)[number];
export const KNOWLEDGE_MODEL_PROTOCOLS = [
  'native_embedding_v1',
  'structured_ranking_v1',
  'text_answer_v1',
] as const;
export type KnowledgeModelProtocol = (typeof KNOWLEDGE_MODEL_PROTOCOLS)[number];
export const protocolForPurpose = (purpose: KnowledgeModelPurpose): KnowledgeModelProtocol =>
  ({ embed: 'native_embedding_v1', rerank: 'structured_ranking_v1', answer: 'text_answer_v1' })[
    purpose
  ] as KnowledgeModelProtocol;

export type ModelJobBounds = {
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxCostMicros: number;
  timeoutSeconds: number;
};

/** Technical bounds only. No commercial price, allowance or default is supplied here. */
export function validModelJobBounds(value: ModelJobBounds): boolean {
  return (
    [
      value.maxCalls,
      value.maxInputTokens,
      value.maxOutputTokens,
      value.maxTotalTokens,
      value.timeoutSeconds,
    ].every((amount) => Number.isSafeInteger(amount) && amount > 0) &&
    Number.isSafeInteger(value.maxCostMicros) &&
    value.maxCostMicros >= 0 &&
    value.maxCalls <= 1000 &&
    value.maxInputTokens <= value.maxTotalTokens &&
    value.maxInputTokens <= 2147483647 &&
    value.maxOutputTokens <= 2147483647 &&
    value.maxOutputTokens <= value.maxTotalTokens &&
    value.timeoutSeconds <= MAX_MODEL_JOB_TIMEOUT_SECONDS
  );
}

export function modelBoundsWithin(request: ModelJobBounds, approval: ModelJobBounds): boolean {
  return (
    validModelJobBounds(request) &&
    validModelJobBounds(approval) &&
    (Object.keys(request) as (keyof ModelJobBounds)[]).every((key) => request[key] <= approval[key])
  );
}

export type QualifiedModelOperation = {
  id: string;
  profileId: string;
  profileVersion: number;
  purpose: KnowledgeModelPurpose;
  protocol: KnowledgeModelProtocol;
  state: 'requested' | 'passed' | 'failed';
  dimension: number | null;
  vectorSpaceVersion: string | null;
};

export function qualifiedFor(
  qualification: QualifiedModelOperation,
  profile: { id: string; version: number; allowedPurposes: readonly ModelPurpose[] },
  purpose: KnowledgeModelPurpose,
): boolean {
  return (
    qualification.state === 'passed' &&
    qualification.profileId === profile.id &&
    qualification.profileVersion === profile.version &&
    qualification.purpose === purpose &&
    qualification.protocol === protocolForPurpose(purpose) &&
    profile.allowedPurposes.includes(purpose) &&
    (purpose === 'embed'
      ? Number.isInteger(qualification.dimension) &&
        qualification.dimension! >= 1 &&
        qualification.dimension! <= 8192 &&
        !!qualification.vectorSpaceVersion &&
        qualification.vectorSpaceVersion.length <= 256
      : qualification.dimension === null && qualification.vectorSpaceVersion === null)
  );
}

/** One paid attempt is never automatically resent, even when its process died before the response. */
export function mayDispatchModelAttempt(state: string): boolean {
  return state === 'prepared';
}

export function validRanking(order: unknown, count: number): order is readonly number[] {
  return (
    Array.isArray(order) &&
    order.length <= count &&
    new Set(order).size === order.length &&
    order.every((value) => Number.isSafeInteger(value) && value >= 0 && value < count)
  );
}

export function validEmbedding(vector: unknown, dimension: number): vector is readonly number[] {
  return (
    Array.isArray(vector) &&
    vector.length === dimension &&
    vector.every(
      (value) =>
        typeof value === 'number' &&
        Number.isFinite(value) &&
        Math.abs(value) <= 3.4028234663852886e38,
    ) &&
    vector.some((value) => Math.fround(value) !== 0)
  );
}
