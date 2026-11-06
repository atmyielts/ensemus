import { describe, expect, it } from 'vitest';
import {
  approvalStepOutcome,
  agentStepOutcome,
  ancestorsOf,
  externalStepOutcome,
  nextProcessSteps,
  recheckRun,
  simulateProcess,
  stopStatusFor,
  sumMeasuredCost,
  workStepOutcome,
  type StepStatus,
} from './process-run';
import type { ProcessSpec, ProcessStep } from './process-spec';
import type { SimulationScenario } from './simulation';

const STATUSES: readonly StepStatus[] = ['pending', 'ready', 'waiting', 'done', 'failed', 'skipped'];

const step = (key: string, after: readonly string[] = [], extra: Partial<ProcessStep> = {}) =>
  ({ key, kind: 'work_item', after, labelCode: null, label: key, ...extra }) as ProcessStep;

const spec = (steps: readonly ProcessStep[], classification = 'internal'): ProcessSpec => ({
  schemaVersion: 1,
  classification: classification as ProcessSpec['classification'],
  steps,
});

const scenario = (extra: Partial<SimulationScenario> = {}): SimulationScenario => ({
  key: 'standard',
  turns: [],
  ...extra,
});

describe('nextProcessSteps', () => {
  it('finishes a spec with no steps', () => {
    expect(nextProcessSteps(spec([]), {})).toEqual({ next: 'completed' });
  });

  describe('one step, every status', () => {
    const single = spec([step('a')]);
    it.each([
      ['pending', { next: 'start_steps', stepKeys: ['a'] }],
      // Decided on and not yet made, as after a worker died. Asking again is how a retry finds it.
      ['ready', { next: 'start_steps', stepKeys: ['a'] }],
      ['waiting', { next: 'wait' }],
      ['done', { next: 'completed' }],
      ['failed', { next: 'failed', stepKey: 'a' }],
      // Nothing can finish it now, and calling that completed would mark undone work as done.
      ['skipped', { next: 'failed', stepKey: 'a' }],
    ] as const)('%s', (status, expected) => {
      expect(nextProcessSteps(single, { a: status })).toEqual(expected);
    });
  });

  describe('a chain of two, every status combination', () => {
    const chain = spec([step('a'), step('b', ['a'])]);
    const table: Record<string, Record<string, unknown>> = {
      pending: {
        pending: { next: 'start_steps', stepKeys: ['a'] },
        ready: { next: 'start_steps', stepKeys: ['a'] },
        waiting: { next: 'start_steps', stepKeys: ['a'] },
        done: { next: 'start_steps', stepKeys: ['a'] },
        failed: { next: 'failed', stepKey: 'b' },
        skipped: { next: 'start_steps', stepKeys: ['a'] },
      },
      ready: {
        pending: { next: 'start_steps', stepKeys: ['a'] },
        ready: { next: 'start_steps', stepKeys: ['a'] },
        waiting: { next: 'start_steps', stepKeys: ['a'] },
        done: { next: 'start_steps', stepKeys: ['a'] },
        failed: { next: 'failed', stepKey: 'b' },
        skipped: { next: 'start_steps', stepKeys: ['a'] },
      },
      waiting: {
        pending: { next: 'wait' },
        ready: { next: 'wait' },
        waiting: { next: 'wait' },
        done: { next: 'wait' },
        failed: { next: 'failed', stepKey: 'b' },
        skipped: { next: 'wait' },
      },
      done: {
        pending: { next: 'start_steps', stepKeys: ['b'] },
        ready: { next: 'start_steps', stepKeys: ['b'] },
        waiting: { next: 'wait' },
        done: { next: 'completed' },
        failed: { next: 'failed', stepKey: 'b' },
        skipped: { next: 'failed', stepKey: 'b' },
      },
      failed: Object.fromEntries(STATUSES.map((s) => [s, { next: 'failed', stepKey: 'a' }])),
      skipped: {
        pending: { next: 'failed', stepKey: 'a' },
        ready: { next: 'failed', stepKey: 'a' },
        waiting: { next: 'wait' },
        done: { next: 'failed', stepKey: 'a' },
        failed: { next: 'failed', stepKey: 'b' },
        skipped: { next: 'failed', stepKey: 'a' },
      },
    };
    for (const a of STATUSES) {
      for (const b of STATUSES) {
        it(`a ${a}, b ${b}`, () => {
          expect(nextProcessSteps(chain, { a, b })).toEqual(table[a]?.[b]);
        });
      }
    }
  });

  describe('a join needs everything before it', () => {
    const join = spec([step('a'), step('b'), step('c', ['a', 'b'])]);
    it('starts both sides together', () => {
      expect(nextProcessSteps(join, { a: 'pending', b: 'pending', c: 'pending' })).toEqual({
        next: 'start_steps',
        stepKeys: ['a', 'b'],
      });
    });
    it('holds the join while one side is out', () => {
      expect(nextProcessSteps(join, { a: 'done', b: 'waiting', c: 'pending' })).toEqual({
        next: 'wait',
      });
    });
    it('starts the join once both are done', () => {
      expect(nextProcessSteps(join, { a: 'done', b: 'done', c: 'pending' })).toEqual({
        next: 'start_steps',
        stepKeys: ['c'],
      });
    });
    it('a failed side stops the join, and the other side does not count it done', () => {
      expect(nextProcessSteps(join, { a: 'failed', b: 'done', c: 'pending' })).toEqual({
        next: 'failed',
        stepKey: 'a',
      });
    });
  });

  it('treats a step with no row as not started', () => {
    expect(nextProcessSteps(spec([step('a')]), {})).toEqual({ next: 'start_steps', stepKeys: ['a'] });
  });

  it('does not wait for ever on an `after` naming nothing', () => {
    expect(nextProcessSteps(spec([step('a', ['ghost'])]), { a: 'pending' })).toEqual({
      next: 'failed',
      stepKey: 'a',
    });
  });

  it('names the first failure in spec order, whichever order the statuses came in', () => {
    const three = spec([step('a'), step('b'), step('c')]);
    expect(nextProcessSteps(three, { c: 'failed', b: 'failed', a: 'done' })).toEqual({
      next: 'failed',
      stepKey: 'b',
    });
  });

  it('never starts a step before its after set, over random specs and statuses', () => {
    // A small seeded generator, so a failure here is the same failure next time.
    let seed = 20261106;
    const random = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return Math.floor((seed / 4294967296) * n);
    };
    for (let round = 0; round < 2000; round += 1) {
      const size = 1 + random(7);
      const steps: ProcessStep[] = [];
      for (let i = 0; i < size; i += 1) {
        const after = steps.map((s) => s.key).filter(() => random(3) === 0);
        steps.push(step(`s${i}`, after));
      }
      const statuses = Object.fromEntries(
        steps.map((s) => [s.key, STATUSES[random(STATUSES.length)] as StepStatus]),
      );
      const decision = nextProcessSteps(spec(steps), statuses);
      if (decision.next === 'start_steps') {
        expect(decision.stepKeys.length).toBeGreaterThan(0);
        for (const key of decision.stepKeys) {
          const started = steps.find((s) => s.key === key);
          expect(started).toBeDefined();
          for (const before of started?.after ?? []) expect(statuses[before]).toBe('done');
          expect(['pending', 'ready']).toContain(statuses[key]);
        }
      }
      if (decision.next === 'completed') {
        for (const s of steps) expect(statuses[s.key]).toBe('done');
      }
      if (decision.next !== 'failed' && decision.next !== 'completed') {
        for (const s of steps) expect(statuses[s.key]).not.toBe('failed');
      }
    }
  });
});

describe('simulateProcess', () => {
  const approved = spec([
    step('draft'),
    step('review', ['draft'], { kind: 'human_approval', approverRole: 'process_owner' }),
    step('send', ['review'], { kind: 'external_action', toolId: 'email.send' }),
    step('check', ['send'], { kind: 'evidence_check', evidence: 'external_receipt' }),
  ]);

  it('reports each step as what it would do, and that nothing else happened', () => {
    const report = simulateProcess(approved, 'hash', scenario());
    expect(report).toMatchObject({
      schemaVersion: 1,
      scenarioKey: 'standard',
      subjectSha256: 'hash',
      outcome: 'passed',
      failureCodes: [],
      wouldWriteOutside: ['email.send'],
      // The drawn approval, and M3's own on the effect: two independent stops.
      approvalsNeeded: 2,
    });
    expect(report.steps.map((s) => [s.subject, s.decision])).toEqual([
      ['draft', 'allowed'],
      ['review', 'needs_approval'],
      ['send', 'would_write_outside'],
      ['check', 'allowed'],
    ]);
  });

  it('fails a report whose effect has a way round the approval', () => {
    const roundabout = spec([
      step('review', [], { kind: 'human_approval' }),
      step('other'),
      step('send', ['review', 'other'], { kind: 'external_action', toolId: 'email.send' }),
    ]);
    // Joined, so both are before it, and it cannot start without the approval.
    expect(simulateProcess(roundabout, 'hash', scenario()).outcome).toBe('passed');

    const bare = spec([step('send', [], { kind: 'external_action', toolId: 'email.send' })]);
    const report = simulateProcess(bare, 'hash', scenario());
    expect(report.outcome).toBe('failed');
    expect(report.failureCodes).toEqual(['EFFECT_WITHOUT_APPROVAL']);
  });

  it('an effect from restricted work is denied, and writes nothing', () => {
    const restricted = spec(approved.steps, 'restricted');
    const report = simulateProcess(restricted, 'hash', scenario());
    expect(report.outcome).toBe('failed');
    expect(report.failureCodes).toContain('RESTRICTED_EFFECT');
    expect(report.wouldWriteOutside).toEqual([]);
    expect(report.steps.find((s) => s.subject === 'send')?.decision).toBe('denied');
  });

  it('a step the scenario does not reach is shown as not reached, and writes nothing', () => {
    const report = simulateProcess(approved, 'hash', scenario({ processPath: ['draft', 'review'] }));
    expect(report.outcome).toBe('passed');
    expect(report.wouldWriteOutside).toEqual([]);
    expect(report.approvalsNeeded).toBe(1);
    expect(report.steps.find((s) => s.subject === 'send')).toMatchObject({
      decision: 'denied',
      reasonCode: 'NOT_REACHED',
    });
  });

  it('a scenario walking a step before its after set fails', () => {
    const report = simulateProcess(approved, 'hash', scenario({ processPath: ['review', 'draft'] }));
    expect(report.outcome).toBe('failed');
    expect(report.failureCodes).toContain('PATH_OUT_OF_ORDER');
  });

  it('a scenario naming a step the spec does not have fails', () => {
    const report = simulateProcess(approved, 'hash', scenario({ processPath: ['ghost'] }));
    expect(report.failureCodes).toContain('PATH_UNKNOWN_STEP');
  });

  it('holds no label: a report has codes and keys, so it can go anywhere a code can', () => {
    const canary = spec([step('a', [], { label: 'CANARY text a person wrote' })]);
    expect(JSON.stringify(simulateProcess(canary, 'hash', scenario()))).not.toContain('CANARY');
  });

  it('is deterministic, and walks steps in the order they can run', () => {
    const shuffled = spec([step('c', ['b']), step('b', ['a']), step('a')]);
    const first = simulateProcess(shuffled, 'hash', scenario());
    expect(first.steps.map((s) => s.subject)).toEqual(['a', 'b', 'c']);
    expect(simulateProcess(shuffled, 'hash', scenario())).toEqual(first);
    expect(first.steps.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('holds its step count against the limit', () => {
    const report = simulateProcess(approved, 'hash', scenario());
    expect(report.limits.turnsUsed).toBe(4);
    expect(report.limits.toolCallsUsed).toBe(1);
    expect(report.limits.turnsAllowed).toBeGreaterThanOrEqual(4);
  });
});

describe('recheckRun, before each effect', () => {
  const clear = {
    stopRequested: false,
    rootStatus: 'running',
    specHashStored: 'h',
    specHashNow: 'h',
    starterActive: true,
  };
  it('lets a clear run go on', () => {
    expect(recheckRun(clear)).toBeNull();
  });
  it.each([
    [{ stopRequested: true }, 'STOP_REQUESTED'],
    [{ rootStatus: 'cancelled' }, 'ROOT_STOPPED'],
    [{ specHashNow: 'other' }, 'SPEC_HASH_MISMATCH'],
    [{ starterActive: false }, 'STARTER_INACTIVE'],
  ])('%j stops it', (change, code) => {
    expect(recheckRun({ ...clear, ...change })).toBe(code);
  });
  it('a stale spec outranks everything, because nothing it says can be trusted', () => {
    expect(
      recheckRun({
        stopRequested: true,
        rootStatus: 'cancelled',
        specHashStored: 'h',
        specHashNow: 'x',
        starterActive: false,
      }),
    ).toBe('SPEC_HASH_MISMATCH');
  });
});

describe('what a step made says about the step', () => {
  it.each([
    ['queued', 'waiting', null],
    ['running', 'waiting', null],
    ['completed', 'done', null],
    ['failed', 'failed', 'WORK_FAILED'],
    ['cancelled', 'failed', 'WORK_STOPPED'],
  ])('work %s', (work, status, stopCode) => {
    expect(workStepOutcome(work)).toEqual({ status, stopCode });
  });
  it.each([
    ['pending', 'waiting', null],
    ['approved', 'done', null],
    ['denied', 'failed', 'APPROVAL_DENIED'],
    ['expired', 'failed', 'APPROVAL_EXPIRED'],
    ['cancelled', 'failed', 'APPROVAL_CANCELLED'],
  ])('approval %s', (approval, status, stopCode) => {
    expect(approvalStepOutcome(approval)).toEqual({ status, stopCode });
  });
  it.each([
    ['awaiting_approval', 'waiting', null],
    ['ready', 'waiting', null],
    ['sending', 'waiting', null],
    ['reconciling', 'waiting', null],
    ['sent', 'done', null],
    ['failed', 'failed', 'EXTERNAL_ACTION_FAILED'],
    ['cancelled', 'failed', 'EXTERNAL_ACTION_CANCELLED'],
    // It may have gone. Only a person can say, so it waits, and nothing here tries again.
    ['unknown', 'waiting', 'EXTERNAL_ACTION_UNKNOWN'],
  ])('external action %s', (action, status, stopCode) => {
    expect(externalStepOutcome(action)).toEqual({ status, stopCode });
  });
  it.each([
    ['running', 'waiting', null],
    ['completed', 'done', null],
    ['failed', 'failed', 'AGENT_RUN_FAILED'],
    ['stopped', 'failed', 'AGENT_RUN_STOPPED'],
    ['unknown', 'waiting', 'AGENT_RUN_UNKNOWN'],
  ] as const)('agent run %s', (outcome, status, stopCode) => {
    expect(agentStepOutcome(outcome)).toEqual({ status, stopCode });
  });
  it('anything it does not recognise waits, and is never counted as done', () => {
    expect(workStepOutcome('new_state').status).toBe('waiting');
    expect(approvalStepOutcome('new_state').status).toBe('waiting');
    expect(externalStepOutcome('new_state').status).toBe('waiting');
  });
});

describe('stopStatusFor', () => {
  it.each(['STOP_REQUESTED', 'ROOT_STOPPED', 'STARTER_INACTIVE'])('%s is a stop', (code) => {
    expect(stopStatusFor(code)).toBe('cancelled');
  });
  it.each(['SPEC_HASH_MISMATCH', 'ADVANCE_FAILED', 'WORK_FAILED', 'anything'])(
    '%s is a failure',
    (code) => {
      expect(stopStatusFor(code)).toBe('failed');
    },
  );
});

describe('ancestorsOf', () => {
  it('finds everything before a step, and not the step', () => {
    const shape = spec([step('a'), step('b', ['a']), step('c', ['b']), step('d')]);
    expect([...ancestorsOf(shape, 'c')].sort()).toEqual(['a', 'b']);
    expect([...ancestorsOf(shape, 'a')]).toEqual([]);
    expect([...ancestorsOf(shape, 'ghost')]).toEqual([]);
  });
});

describe('sumMeasuredCost', () => {
  it('nothing measured is null, never zero', () => {
    expect(sumMeasuredCost([])).toBeNull();
    expect(sumMeasuredCost([null, null])).toBeNull();
  });
  it('adds what was measured', () => {
    expect(
      sumMeasuredCost([
        { costMicros: 10, isEstimate: false },
        { costMicros: 5, isEstimate: false },
      ]),
    ).toEqual({ costMicros: 15, isEstimate: false });
  });
  it('one estimate makes the total an estimate', () => {
    expect(
      sumMeasuredCost([
        { costMicros: 10, isEstimate: true },
        { costMicros: 5, isEstimate: false },
      ]),
    ).toEqual({ costMicros: 15, isEstimate: true });
  });
  it('a part with no measure makes the total an estimate, so it does not read as complete', () => {
    expect(sumMeasuredCost([{ costMicros: 10, isEstimate: false }, null])).toEqual({
      costMicros: 10,
      isEstimate: true,
    });
  });
  it('a real zero stays a zero', () => {
    expect(sumMeasuredCost([{ costMicros: 0, isEstimate: false }])).toEqual({
      costMicros: 0,
      isEstimate: false,
    });
  });
});
