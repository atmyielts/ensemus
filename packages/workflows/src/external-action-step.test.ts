// The order of steps externalActionWorkflow takes, against scripted answers. The integration tests run the
// same function against real Activities and PostgreSQL. These cover what a server would be needed to reach.
import { describe, expect, it } from 'vitest';
import {
  afterInterrupted,
  MAX_LOST_SENDS,
  retryDelayMs,
  runExternalAction,
  type ExternalActionPorts,
} from './external-action-step';
import type {
  ExternalActionOutcome,
  InterruptedStep,
  ReconcileStepResult,
  SendStep,
} from './schemas';

class TimedOut extends Error {}
class NeverPickedUp extends Error {}

/** Answers each kind of call from a list. A send answered with an Error fails, as an Activity would. */
function script(answers: {
  sends?: (SendStep | Error)[];
  inspects?: InterruptedStep[];
  reconciles?: (ReconcileStepResult | Error)[];
  outcome?: ExternalActionOutcome;
}) {
  const calls: string[] = [];
  const next = <T>(list: T[] | undefined, name: string): T => {
    const answer = list?.shift();
    if (answer === undefined) throw new Error(`Nothing scripted for ${name}`);
    return answer;
  };
  const ports: ExternalActionPorts = {
    send: async () => {
      calls.push('send');
      const answer = next(answers.sends, 'send');
      if (answer instanceof Error) throw answer;
      return answer;
    },
    inspect: async () => {
      calls.push('inspect');
      return next(answers.inspects, 'inspect');
    },
    reconcile: async () => {
      calls.push('reconcile');
      const answer = next(answers.reconciles, 'reconcile');
      if (answer instanceof Error) throw answer;
      return answer;
    },
    concludeWithoutAnswer: async () => {
      calls.push('conclude');
      return 'unknown';
    },
    failUnsent: async (code) => {
      calls.push(`fail:${code}`);
    },
    outcome: async () => {
      calls.push('outcome');
      return answers.outcome ?? 'failed';
    },
    sleep: async (ms) => {
      calls.push(`sleep:${ms}`);
    },
    neverPickedUp: (error) => error instanceof NeverPickedUp,
  };
  return { ports, calls };
}

describe('afterInterrupted', () => {
  it('reconciles when an attempt could have sent, whatever else is true', () => {
    expect(afterInterrupted('attempt_open', { neverPickedUp: true, lostSends: 99 })).toEqual({
      kind: 'reconcile',
    });
  });

  it('only reads what happened when it has already ended', () => {
    expect(afterInterrupted('settled', { neverPickedUp: false, lostSends: 1 })).toEqual({
      kind: 'read_outcome',
    });
  });

  it('fails as unavailable when nothing ever picked the send up', () => {
    expect(afterInterrupted('nothing_sent', { neverPickedUp: true, lostSends: 1 })).toEqual({
      kind: 'fail',
      code: 'CONNECTOR_UNAVAILABLE',
    });
  });

  it('waits and tries again when nothing went, until that has happened too often', () => {
    expect(afterInterrupted('nothing_sent', { neverPickedUp: false, lostSends: 1 })).toEqual({
      kind: 'try_again',
      afterMs: retryDelayMs(1),
    });
    expect(
      afterInterrupted('nothing_sent', { neverPickedUp: false, lostSends: MAX_LOST_SENDS }),
    ).toEqual({ kind: 'fail', code: 'ATTEMPTS_EXHAUSTED' });
  });
});

describe('retryDelayMs', () => {
  it('backs off and stops growing', () => {
    expect(retryDelayMs(2)).toBeGreaterThan(retryDelayMs(1));
    expect(retryDelayMs(50)).toBe(retryDelayMs(51));
    expect(retryDelayMs(50)).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});

describe('runExternalAction', () => {
  it.each(['sent', 'failed', 'cancelled', 'unknown'] as const)(
    'ends on %s with one send and no other step',
    async (step) => {
      const { ports, calls } = script({ sends: [{ step }] });
      await expect(runExternalAction(ports)).resolves.toBe(step);
      expect(calls).toEqual(['send']);
    },
  );

  it('waits between tries that definitely did not send', async () => {
    const { ports, calls } = script({
      sends: [{ step: 'retry', afterMs: 1000 }, { step: 'retry', afterMs: 2000 }, { step: 'sent' }],
    });
    await expect(runExternalAction(ports)).resolves.toBe('sent');
    expect(calls).toEqual(['send', 'sleep:1000', 'send', 'sleep:2000', 'send']);
  });

  it('never sends again after an answer it did not get, and stops on unknown', async () => {
    const { ports, calls } = script({ sends: [{ step: 'reconcile' }], reconciles: ['unknown'] });
    await expect(runExternalAction(ports)).resolves.toBe('unknown');
    expect(calls).toEqual(['send', 'reconcile']);
  });

  it('asks before anything else when a send Activity fails, and takes no blind second send', async () => {
    const { ports, calls } = script({
      sends: [new TimedOut()],
      inspects: ['attempt_open'],
      reconciles: ['unknown'],
    });
    await expect(runExternalAction(ports)).resolves.toBe('unknown');
    expect(calls).toEqual(['send', 'inspect', 'reconcile']);
  });

  it('sends again after a failed Activity only when PostgreSQL says nothing went', async () => {
    const { ports, calls } = script({
      sends: [new TimedOut(), { step: 'sent' }],
      inspects: ['nothing_sent'],
    });
    await expect(runExternalAction(ports)).resolves.toBe('sent');
    expect(calls).toEqual(['send', 'inspect', `sleep:${retryDelayMs(1)}`, 'send']);
  });

  it('reports what PostgreSQL holds when the Activity did its work and only the answer was lost', async () => {
    const { ports, calls } = script({
      sends: [new TimedOut()],
      inspects: ['settled'],
      outcome: 'sent',
    });
    await expect(runExternalAction(ports)).resolves.toBe('sent');
    expect(calls).toEqual(['send', 'inspect', 'outcome']);
  });

  it('ends a send nothing picked up as unavailable', async () => {
    const { ports, calls } = script({
      sends: [new NeverPickedUp()],
      inspects: ['nothing_sent'],
      outcome: 'failed',
    });
    await expect(runExternalAction(ports)).resolves.toBe('failed');
    expect(calls).toEqual(['send', 'inspect', 'fail:CONNECTOR_UNAVAILABLE', 'outcome']);
  });

  it('does not call a send unavailable when an attempt was recorded', async () => {
    const { ports, calls } = script({
      sends: [new NeverPickedUp()],
      inspects: ['attempt_open'],
      reconciles: ['unknown'],
    });
    await expect(runExternalAction(ports)).resolves.toBe('unknown');
    expect(calls).toEqual(['send', 'inspect', 'reconcile']);
  });

  it('gives up after the send has been lost too many times with nothing recorded', async () => {
    const lost = Array.from({ length: MAX_LOST_SENDS }, () => new TimedOut());
    const { ports, calls } = script({
      sends: lost,
      inspects: lost.map(() => 'nothing_sent' as const),
      outcome: 'failed',
    });
    await expect(runExternalAction(ports)).resolves.toBe('failed');
    expect(calls.filter((call) => call === 'send')).toHaveLength(MAX_LOST_SENDS);
    expect(calls.slice(-2)).toEqual(['fail:ATTEMPTS_EXHAUSTED', 'outcome']);
  });

  it('tries again after a reconcile that found definitely nothing', async () => {
    const { ports, calls } = script({
      sends: [{ step: 'reconcile' }, { step: 'sent' }],
      reconciles: ['retry'],
    });
    await expect(runExternalAction(ports)).resolves.toBe('sent');
    expect(calls).toEqual(['send', 'reconcile', `sleep:${retryDelayMs(1)}`, 'send']);
  });

  it.each(['sent', 'failed', 'unknown'] as const)(
    'ends on %s when that is what reconciling found',
    async (answer) => {
      const { ports } = script({ sends: [{ step: 'reconcile' }], reconciles: [answer] });
      await expect(runExternalAction(ports)).resolves.toBe(answer);
    },
  );

  it('concludes without the provider when the reconcile Activity never ran', async () => {
    const { ports, calls } = script({
      sends: [{ step: 'reconcile' }],
      reconciles: [new NeverPickedUp()],
    });
    await expect(runExternalAction(ports)).resolves.toBe('unknown');
    expect(calls).toEqual(['send', 'reconcile', 'conclude']);
  });
});
