import { describe, expect, it } from 'vitest';
import {
  mayDispatchModelAttempt,
  MAX_MODEL_JOB_TIMEOUT_SECONDS,
  modelBoundsWithin,
  qualifiedFor,
  validEmbedding,
  validRanking,
  validModelJobBounds,
  type ModelJobBounds,
  type QualifiedModelOperation,
} from './knowledge-models';

const bounds: ModelJobBounds = {
  maxCalls: 7,
  maxInputTokens: 312,
  maxOutputTokens: 61,
  maxTotalTokens: 1900,
  maxCostMicros: 231,
  timeoutSeconds: 123,
};
const q: QualifiedModelOperation = {
  id: 'generated-q',
  profileId: 'generated-profile',
  profileVersion: 3,
  purpose: 'embed',
  protocol: 'native_embedding_v1',
  state: 'passed',
  dimension: 3,
  vectorSpaceVersion: 'generated-space-v4',
};
const p = { id: q.profileId, version: 3, allowedPurposes: ['embed'] as const };

describe('explicit Knowledge model authority', () => {
  it('requires explicit valid bounds within every approved limit', () => {
    expect(modelBoundsWithin(bounds, bounds)).toBe(true);
    for (const key of Object.keys(bounds) as (keyof ModelJobBounds)[])
      expect(modelBoundsWithin({ ...bounds, [key]: bounds[key] + 1 }, bounds), key).toBe(false);
    for (const value of [NaN, Infinity, -1, 1.5])
      expect(modelBoundsWithin({ ...bounds, maxCostMicros: value }, bounds)).toBe(false);
    expect(validModelJobBounds({ ...bounds, timeoutSeconds: MAX_MODEL_JOB_TIMEOUT_SECONDS })).toBe(
      true,
    );
    expect(
      validModelJobBounds({ ...bounds, timeoutSeconds: MAX_MODEL_JOB_TIMEOUT_SECONDS + 1 }),
    ).toBe(false);
  });
  it('pins purpose, protocol, actual profile version and embedding identity', () => {
    expect(qualifiedFor(q, p, 'embed')).toBe(true);
    for (const changed of [
      { state: 'requested' as const },
      { purpose: 'answer' as const },
      { protocol: 'text_answer_v1' as const },
      { profileId: 'another-profile' },
      { profileVersion: 4 },
      { dimension: null },
      { dimension: 0 },
      { vectorSpaceVersion: null },
    ])
      expect(qualifiedFor({ ...q, ...changed }, p, 'embed')).toBe(false);
    expect(qualifiedFor(q, { ...p, allowedPurposes: [] }, 'embed')).toBe(false);
  });
  it('does not resend dispatched, unknown, received or accepted calls', () => {
    expect(mayDispatchModelAttempt('prepared')).toBe(true);
    for (const state of ['dispatched', 'unknown', 'response_received', 'accepted', 'refused', ''])
      expect(mayDispatchModelAttempt(state), state).toBe(false);
  });
  it('rejects malformed vectors and model-selected ranking positions', () => {
    expect(validEmbedding([1, 0, -1], 3)).toBe(true);
    for (const vector of [
      [0, 0, 0],
      [NaN, 1, 2],
      [Infinity, 1, 2],
      [1, 2],
      [1e99, 1, 2],
    ])
      expect(validEmbedding(vector, 3)).toBe(false);
    expect(validRanking([2, 0], 3)).toBe(true);
    for (const order of [[0, 0], [3], [-1], [0.5], ['0'], {}])
      expect(validRanking(order, 3)).toBe(false);
  });
});
