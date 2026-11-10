import { describe, expect, it } from 'vitest';
import { reviewWaitOutcome, reviewWaitStep } from './review-wait';

const EXPIRES = 1_000_000;

describe('waiting on a review', () => {
  it('keeps waiting when woken while its approval is pending and not overdue', () => {
    // Another approval's signal, or a stale redelivery: nothing has happened to this approval.
    expect(reviewWaitStep('pending', EXPIRES, EXPIRES - 500)).toEqual({ kind: 'wait', ms: 500 });
  });

  it('asks for expiry only once really overdue', () => {
    expect(reviewWaitStep('pending', EXPIRES, EXPIRES)).toEqual({ kind: 'expire' });
    expect(reviewWaitStep('pending', EXPIRES, EXPIRES + 1)).toEqual({ kind: 'expire' });
  });

  it.each(['approved', 'denied', 'expired', 'cancelled'] as const)(
    'stops waiting once the approval is %s, even if it is overdue',
    (state) => {
      expect(reviewWaitStep(state, EXPIRES, EXPIRES + 1)).toEqual({ kind: 'done' });
    },
  );
});

describe('how a settled review ends the workflow', () => {
  it('carries on only when approved', () => {
    expect(reviewWaitOutcome('approved')).toBeUndefined();
  });

  it('reports each other outcome as what it was', () => {
    expect(reviewWaitOutcome('denied')).toBe('denied');
    expect(reviewWaitOutcome('expired')).toBe('expired');
    expect(reviewWaitOutcome('cancelled')).toBe('cancelled');
  });
});
