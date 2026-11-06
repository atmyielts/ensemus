// A pretend provider, for the fault tests. It counts effects, which is the thing that matters: a row can
// say anything, and these tests assert how many times the outside world was touched. Each send follows the
// next step in a script. Nothing here opens a socket, and no address in it is real.
import type { ExternalActionGateway, PreparedAttempt } from '@ensemus/application';
import type { AttemptResult, ReconcileResult } from '@ensemus/domain/external-action';

export type SendScript =
  /** Took it and said so. */
  | 'accept'
  /** Refused it, and said so. No effect. */
  | 'refuse'
  /** Could not get there, and trying later could work. No effect. */
  | 'not_sent'
  /** Could not get there, and trying again would not help. No effect. */
  | 'not_sent_final'
  /** Took it, and the reply never came. One effect, and the connector knows only that it timed out. */
  | 'accept_then_silent'
  /** The connector lost the connection before the terminator, then said indeterminate. No effect. */
  | 'indeterminate_without_effect'
  /** Took it, and then the connector threw something nobody thought about. One effect. */
  | 'accept_then_throw'
  /** The worker died after the attempt row, before a byte left. No effect, and no answer ever. */
  | 'die_before_effect'
  /** The worker died after the provider took it. One effect, and no answer ever. */
  | 'accept_then_die';

export type RecordedEffect = {
  attemptId: string;
  externalActionId: string;
  idempotencyKey: string;
  requestHash: string;
  payload: unknown;
};

export type ScriptedGateway = ExternalActionGateway & {
  /** What reached the provider. This is what the fault tests count. */
  effects(): readonly RecordedEffect[];
  /** Everything the provider was asked to send, whether or not it got that far. */
  sendCalls(): number;
  reconcileCalls(): number;
  /** Settles when a send has gone quiet because its worker "died". */
  died(): Promise<void>;
  /** The worker was not dead after all: its Activity gets this answer now, as a zombie would. */
  wakeZombie(result: AttemptResult): void;
};

const NEVER_REPLIED: AttemptResult = { outcome: 'indeterminate', code: 'TIMEOUT_AFTER_COMMIT' };

export function createScriptedGateway(
  sends: readonly SendScript[],
  options: {
    reconciles?: readonly (ReconcileResult | Error)[];
    lookup?: 'none' | 'best_effort' | 'authoritative';
  } = {},
): ScriptedGateway {
  const steps = [...sends];
  const reconciles = [...(options.reconciles ?? [])];
  const effects: RecordedEffect[] = [];
  let sendCalls = 0;
  let reconcileCalls = 0;
  let resolveDied: () => void = () => undefined;
  const dead = new Promise<void>((resolve) => {
    resolveDied = resolve;
  });
  let zombie: ((result: AttemptResult) => void) | undefined;

  const recordEffect = (attempt: PreparedAttempt) => {
    effects.push({
      attemptId: attempt.attemptId,
      externalActionId: attempt.externalActionId,
      idempotencyKey: attempt.idempotencyKey,
      requestHash: attempt.requestHash,
      payload: attempt.payload,
    });
  };
  // Never answers unless woken, which is how a dead worker looks to anything waiting on it.
  const die = () => {
    resolveDied();
    return new Promise<AttemptResult>((resolve) => {
      zombie = resolve;
    });
  };

  return {
    async send(_organizationId, attempt) {
      sendCalls += 1;
      const step = steps.shift();
      if (!step) throw new Error('The provider was contacted and no test expected it');
      switch (step) {
        case 'accept':
          recordEffect(attempt);
          return {
            outcome: 'accepted',
            code: 'ACCEPTED_BY_RELAY',
            providerStatus: 250,
            externalId: `<${attempt.externalActionId}@test.invalid>`,
          };
        case 'refuse':
          return { outcome: 'rejected', code: 'RECIPIENT_REFUSED', providerStatus: 550 };
        case 'not_sent':
          return { outcome: 'not_sent', code: 'RELAY_BUSY', retryable: true };
        case 'not_sent_final':
          return { outcome: 'not_sent', code: 'AUTH_FAILED', retryable: false };
        case 'accept_then_silent':
          recordEffect(attempt);
          return NEVER_REPLIED;
        case 'indeterminate_without_effect':
          return { outcome: 'indeterminate', code: 'CONNECTION_LOST_AFTER_COMMIT' };
        case 'accept_then_throw':
          recordEffect(attempt);
          throw new Error('Some text from a provider that must never be stored');
        case 'die_before_effect':
          return die();
        case 'accept_then_die':
          recordEffect(attempt);
          return die();
      }
    },
    async reconcile() {
      reconcileCalls += 1;
      const answer = reconciles.shift() ?? { answer: 'cannot_answer' as const };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    lookupOf: () => options.lookup ?? 'none',
    effects: () => effects,
    sendCalls: () => sendCalls,
    reconcileCalls: () => reconcileCalls,
    died: () => dead,
    wakeZombie: (result) => zombie?.(result),
  };
}
