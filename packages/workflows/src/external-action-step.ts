// The order of steps for one external action, kept pure so that a test can run it against real Activities
// and faults without a server (ADR-027 D2). The workflow hands this its Activities and nothing else. This
// file is imported by workflow code, so it may only import types.
import type {
  ExternalActionOutcome,
  InterruptedStep,
  ReconcileStepResult,
  SendStep,
} from './schemas';

export type LostSendCode = 'ATTEMPTS_EXHAUSTED' | 'CONNECTOR_UNAVAILABLE';

/**
 * How many times a send Activity may fail with nothing recorded before giving up. Each of those is safe
 * to repeat, but something is wrong by then, and a person is better told than kept waiting.
 */
export const MAX_LOST_SENDS = 5;

const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 5 * 60 * 1000;

/** How long to wait after a try that definitely did not send, doubling up to five minutes. */
export function retryDelayMs(tries: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, Math.min(tries, 16) - 1), RETRY_CAP_MS);
}

export type AfterInterrupted =
  | { kind: 'reconcile' }
  | { kind: 'read_outcome' }
  | { kind: 'try_again'; afterMs: number }
  | { kind: 'fail'; code: LostSendCode };

/**
 * A send Activity failed or timed out, and PostgreSQL has said what it found. Only `nothing_sent` leads
 * back to a send, and an attempt that could have gone always wins over any other reason.
 */
export function afterInterrupted(
  state: InterruptedStep,
  facts: { neverPickedUp: boolean; lostSends: number },
): AfterInterrupted {
  switch (state) {
    case 'attempt_open':
      return { kind: 'reconcile' };
    case 'settled':
      return { kind: 'read_outcome' };
    case 'nothing_sent':
      if (facts.neverPickedUp) return { kind: 'fail', code: 'CONNECTOR_UNAVAILABLE' };
      if (facts.lostSends >= MAX_LOST_SENDS) return { kind: 'fail', code: 'ATTEMPTS_EXHAUSTED' };
      return { kind: 'try_again', afterMs: retryDelayMs(facts.lostSends) };
  }
}

/** What the steps need. The workflow gives these Activities, and tests give them whatever they like. */
export type ExternalActionPorts = {
  send(): Promise<SendStep>;
  inspect(): Promise<InterruptedStep>;
  reconcile(code: 'WORKER_INTERRUPTED'): Promise<ReconcileStepResult>;
  /** Reads and writes only PostgreSQL, for when no connector worker ever came to reconcile. */
  concludeWithoutAnswer(code: 'WORKER_INTERRUPTED'): Promise<ReconcileStepResult>;
  failUnsent(code: LostSendCode): Promise<void>;
  outcome(): Promise<ExternalActionOutcome>;
  sleep(ms: number): Promise<void>;
  /** The send timed out waiting for a worker, so it never ran at all. */
  neverPickedUp(error: unknown): boolean;
};

/**
 * Takes one approved intent as far as anything automated may. Sends are the only step with an effect, and
 * one follows another only after the row, or a provider's authoritative word, says the last one did not
 * go. It ends on `unknown` with no further step: a person's answer does not need this to be running.
 *
 * The code given to reconcile only ever applies to an attempt nobody has marked yet, and an attempt nobody
 * has marked means a worker stopped partway through it. A timeout the connector noticed was marked already.
 */
export async function runExternalAction(
  ports: ExternalActionPorts,
): Promise<ExternalActionOutcome> {
  const reconcile = async () => {
    try {
      return await ports.reconcile('WORKER_INTERRUPTED');
    } catch {
      return ports.concludeWithoutAnswer('WORKER_INTERRUPTED');
    }
  };

  let lostSends = 0;
  let reconciledRetries = 0;
  for (;;) {
    let step: SendStep;
    try {
      step = await ports.send();
    } catch (error) {
      lostSends += 1;
      const next = afterInterrupted(await ports.inspect(), {
        neverPickedUp: ports.neverPickedUp(error),
        lostSends,
      });
      if (next.kind === 'read_outcome') return ports.outcome();
      if (next.kind === 'fail') {
        await ports.failUnsent(next.code);
        return ports.outcome();
      }
      if (next.kind === 'try_again') {
        await ports.sleep(next.afterMs);
        continue;
      }
      step = { step: 'reconcile' };
    }

    if (step.step === 'retry') {
      await ports.sleep(step.afterMs);
      continue;
    }
    if (step.step !== 'reconcile') return step.step;

    const answer = await reconcile();
    if (answer !== 'retry') return answer;
    reconciledRetries += 1;
    await ports.sleep(retryDelayMs(reconciledRetries));
  }
}
