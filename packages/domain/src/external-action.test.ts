// ADR-027 D1 and D2's pure rules. The database holds the same rules in triggers, and
// tests/integration covers those. These say what the application asks for before the trigger is reached.
import { describe, expect, it } from 'vitest';
import {
  checkBeforeSend,
  decideAfterAttempt,
  decideAfterReconcile,
  EXTERNAL_ACTION_STATUSES,
  MAX_SEND_ATTEMPTS,
  type ExternalActionStatus,
  type SendFacts,
} from './external-action';

const NOW = new Date('2026-11-06T12:00:00Z');
const LATER = new Date('2026-11-06T13:00:00Z');
const HASH = 'a'.repeat(64);

const ready = (overrides: Partial<SendFacts> = {}): SendFacts => ({
  status: 'ready',
  requiresApproval: true,
  requestHash: HASH,
  recomputedHash: HASH,
  approval: { status: 'approved', actionHash: HASH, expiresAt: LATER },
  workStatus: 'running',
  connectionState: 'active',
  attemptsSoFar: 0,
  ...overrides,
});

describe('checkBeforeSend', () => {
  it('lets through an intent where everything holds', () => {
    expect(checkBeforeSend(ready(), NOW)).toEqual({ ok: true });
  });

  it.each(EXTERNAL_ACTION_STATUSES.filter((status) => status !== 'ready'))(
    'has nothing to do for an intent that is %s, and changes nothing',
    (status: ExternalActionStatus) => {
      expect(checkBeforeSend(ready({ status }), NOW)).toEqual({ ok: false, to: null, code: null });
    },
  );

  it('stops a payload that no longer matches the hash on the intent', () => {
    expect(checkBeforeSend(ready({ recomputedHash: 'b'.repeat(64) }), NOW)).toEqual({
      ok: false,
      to: 'cancelled',
      code: 'PAYLOAD_CHANGED',
    });
  });

  it('stops an approval for a different hash', () => {
    const approval = { status: 'approved', actionHash: 'b'.repeat(64), expiresAt: LATER };
    expect(checkBeforeSend(ready({ approval }), NOW)).toEqual({
      ok: false,
      to: 'cancelled',
      code: 'PAYLOAD_CHANGED',
    });
  });

  it.each(['pending', 'denied', 'expired', 'cancelled'])(
    'stops an approval that is %s, even one that was approved a moment ago',
    (status) => {
      const approval = { status, actionHash: HASH, expiresAt: LATER };
      expect(checkBeforeSend(ready({ approval }), NOW)).toEqual({
        ok: false,
        to: 'cancelled',
        code: 'APPROVAL_NOT_VALID',
      });
    },
  );

  it('stops an intent that needs an approval and has none', () => {
    expect(checkBeforeSend(ready({ approval: null }), NOW)).toEqual({
      ok: false,
      to: 'cancelled',
      code: 'APPROVAL_NOT_VALID',
    });
  });

  it('needs no approval from an intent that does not require one', () => {
    expect(checkBeforeSend(ready({ requiresApproval: false, approval: null }), NOW)).toEqual({
      ok: true,
    });
  });

  it('stops at the moment the approval expires, not after', () => {
    const approval = { status: 'approved', actionHash: HASH, expiresAt: NOW };
    expect(checkBeforeSend(ready({ approval }), NOW)).toEqual({
      ok: false,
      to: 'cancelled',
      code: 'APPROVAL_EXPIRED',
    });
  });

  it.each(['cancelled', 'completed', 'failed'])('stops work that is %s', (workStatus) => {
    expect(checkBeforeSend(ready({ workStatus }), NOW)).toEqual({
      ok: false,
      to: 'cancelled',
      code: 'WORK_STOPPED',
    });
  });

  it.each(['queued', 'ready', 'running', 'blocked', 'awaiting_approval', 'verifying'])(
    'lets through work that is %s',
    (workStatus) => {
      expect(checkBeforeSend(ready({ workStatus }), NOW)).toEqual({ ok: true });
    },
  );

  it.each(['disabled', 'revoked'])('stops a connection that is %s', (connectionState) => {
    expect(checkBeforeSend(ready({ connectionState }), NOW)).toEqual({
      ok: false,
      to: 'cancelled',
      code: 'CONNECTION_NOT_ACTIVE',
    });
  });

  it('ends an intent that has used all its tries as failed', () => {
    expect(checkBeforeSend(ready({ attemptsSoFar: MAX_SEND_ATTEMPTS }), NOW)).toEqual({
      ok: false,
      to: 'failed',
      code: 'ATTEMPTS_EXHAUSTED',
    });
    expect(checkBeforeSend(ready({ attemptsSoFar: MAX_SEND_ATTEMPTS - 1 }), NOW)).toEqual({
      ok: true,
    });
  });

  it('reports a changed payload ahead of anything else, because that is what someone must see', () => {
    const facts = ready({
      recomputedHash: 'b'.repeat(64),
      workStatus: 'cancelled',
      connectionState: 'revoked',
    });
    expect(checkBeforeSend(facts, NOW)).toMatchObject({ code: 'PAYLOAD_CHANGED' });
  });
});

describe('decideAfterAttempt', () => {
  it('believes the provider when it accepts', () => {
    expect(decideAfterAttempt({ outcome: 'accepted', code: 'ACCEPTED_BY_RELAY' }, 1)).toEqual({
      status: 'sent',
      receipt: 'sent',
    });
  });

  it('believes the provider when it refuses', () => {
    expect(decideAfterAttempt({ outcome: 'rejected', code: 'RECIPIENT_REFUSED' }, 1)).toEqual({
      status: 'failed',
      receipt: 'failed',
    });
  });

  it.each([1, 2, MAX_SEND_ATTEMPTS])(
    'never goes back to ready from an answer it did not get, on attempt %i',
    (attemptNo) => {
      expect(
        decideAfterAttempt({ outcome: 'indeterminate', code: 'TIMEOUT_AFTER_COMMIT' }, attemptNo),
      ).toEqual({ status: 'reconciling', receipt: null });
    },
  );

  it('tries again only when nothing was sent and trying later could work', () => {
    const busy = { outcome: 'not_sent', code: 'RELAY_BUSY', retryable: true } as const;
    expect(decideAfterAttempt(busy, 1)).toEqual({ status: 'ready', receipt: null });
    expect(decideAfterAttempt(busy, MAX_SEND_ATTEMPTS - 1)).toEqual({
      status: 'ready',
      receipt: null,
    });
  });

  it('stops trying on the last attempt', () => {
    expect(
      decideAfterAttempt(
        { outcome: 'not_sent', code: 'RELAY_BUSY', retryable: true },
        MAX_SEND_ATTEMPTS,
      ),
    ).toEqual({ status: 'failed', receipt: 'failed' });
  });

  it('does not treat a missing retryable flag as permission to try again', () => {
    expect(decideAfterAttempt({ outcome: 'not_sent', code: 'AUTH_FAILED' }, 1)).toEqual({
      status: 'failed',
      receipt: 'failed',
    });
    expect(
      decideAfterAttempt({ outcome: 'not_sent', code: 'AUTH_FAILED', retryable: false }, 1),
    ).toEqual({ status: 'failed', receipt: 'failed' });
  });
});

describe('decideAfterReconcile', () => {
  it.each(['best_effort', 'authoritative'] as const)(
    'takes the word of a %s lookup that found it',
    (lookup) => {
      expect(decideAfterReconcile({ answer: 'found' }, lookup)).toEqual({
        status: 'sent',
        attemptOutcome: 'accepted',
        code: 'PROVIDER_FOUND_IT',
      });
    },
  );

  it.each(['best_effort', 'authoritative'] as const)(
    'takes the word of a %s lookup that says it was refused',
    (lookup) => {
      expect(decideAfterReconcile({ answer: 'refused' }, lookup)).toEqual({
        status: 'failed',
        attemptOutcome: 'rejected',
        code: 'REFUSED_BY_PROVIDER',
      });
    },
  );

  it('tries again after not finding it only when the lookup is authoritative', () => {
    expect(decideAfterReconcile({ answer: 'not_found' }, 'authoritative')).toEqual({
      status: 'ready',
      attemptOutcome: 'not_sent',
      code: 'PROVIDER_DID_NOT_FIND_IT',
    });
    expect(decideAfterReconcile({ answer: 'not_found' }, 'best_effort')).toEqual({
      status: 'unknown',
      attemptOutcome: 'indeterminate',
      code: 'PROVIDER_CANNOT_ANSWER',
    });
  });

  it.each(['none', 'best_effort', 'authoritative'] as const)(
    'stays unknown when a %s lookup cannot answer',
    (lookup) => {
      expect(decideAfterReconcile({ answer: 'cannot_answer' }, lookup)).toEqual({
        status: 'unknown',
        attemptOutcome: 'indeterminate',
        code: 'PROVIDER_CANNOT_ANSWER',
      });
    },
  );

  it.each([{ answer: 'found' }, { answer: 'refused' }, { answer: 'not_found' }] as const)(
    'does not believe a connector that declares no lookup and then answers $answer',
    (result) => {
      expect(decideAfterReconcile(result, 'none')).toEqual({
        status: 'unknown',
        attemptOutcome: 'indeterminate',
        code: 'PROVIDER_CANNOT_ANSWER',
      });
    },
  );
});
