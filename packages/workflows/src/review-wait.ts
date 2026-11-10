// The decisions in a workflow's wait for a review, kept pure so they can be tested without Temporal.
// This file is imported by workflow code, so it may only import types.
import type { ReviewState, WorkOutcome } from './schemas';

export type ReviewWaitStep = { kind: 'done' } | { kind: 'wait'; ms: number } | { kind: 'expire' };

/**
 * What to do with the approval's state. Waking up for any reason is not an answer: while the approval
 * is pending and not overdue, the only thing to do is keep waiting.
 */
export function reviewWaitStep(
  state: ReviewState,
  expiresAtMs: number,
  nowMs: number,
): ReviewWaitStep {
  if (state !== 'pending') return { kind: 'done' };
  const remaining = expiresAtMs - nowMs;
  return remaining > 0 ? { kind: 'wait', ms: remaining } : { kind: 'expire' };
}

/** How a settled review ends the workflow. Nothing to report means it was approved, so carry on. */
export function reviewWaitOutcome(state: ReviewState): WorkOutcome | undefined {
  switch (state) {
    case 'approved':
      return undefined;
    case 'denied':
      return 'denied';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'expired';
  }
}
