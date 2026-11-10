// AGENT-02, QA-012. Every limit stops with its own code, and every outcome leads somewhere.
import {
  AGENT_RUN_STATUSES,
  MODEL_OUTCOMES,
  STOP_CODES,
  TOOL_OUTCOMES,
  type AgentRunStatus,
  type RunCounters,
  type RunLimits,
} from '@ensemus/domain/ai';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decideNext,
  stopForDirective,
  stopForFailure,
  type LastStep,
  type NextStep,
  type ReducerCounters,
  type ReducerLimits,
  type ReducerState,
  type StopStatus,
} from './reducer';

// Compile-time: the reducer imports nothing, so its types are its own, and they may not drift.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const countersMatch: Equal<ReducerCounters, RunCounters> = true;
const limitsMatch: Equal<ReducerLimits, RunLimits> = true;
const statusesExist: StopStatus extends AgentRunStatus ? true : false = true;

const counters: ReducerCounters = {
  modelTurns: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
  activeMs: 0,
};
const limits: ReducerLimits = {
  maxModelTurns: 5,
  maxToolCalls: 5,
  maxTotalTokens: 1_000,
  maxCostMicros: 1_000,
  timeoutSeconds: 60,
  maxDelegationDepth: 1,
};
const state = (
  used: Partial<ReducerCounters> = {},
  caps: Partial<ReducerLimits> = {},
): ReducerState => ({
  counters: { ...counters, ...used },
  limits: { ...limits, ...caps },
});

const model = (outcome: string): LastStep => ({ kind: 'model', outcome });
const tool = (outcome: string): LastStep => ({ kind: 'tool', outcome });
const wait = (waitState: string): LastStep => ({ kind: 'wait', state: waitState });
const child = (status: string): LastStep => ({ kind: 'child', status });

const stopped = (status: StopStatus, stopCode: string): NextStep => ({
  kind: 'stop',
  status,
  stopCode,
});

describe('types', () => {
  it('match the vocabulary', () => {
    expect([countersMatch, limitsMatch, statusesExist]).toEqual([true, true, true]);
    expect(Object.keys(counters).sort()).toEqual(
      ['activeMs', 'costMicros', 'inputTokens', 'modelTurns', 'outputTokens', 'toolCalls'].sort(),
    );
  });

  it('import nothing at all', () => {
    const source = readFileSync(new URL('./reducer.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});

describe('the start of a run', () => {
  it('asks the model', () => {
    expect(decideNext(state(), { kind: 'none' })).toEqual({ kind: 'model_turn' });
  });

  it('never starts with no money allowed', () => {
    expect(decideNext(state({}, { maxCostMicros: 0 }), { kind: 'none' })).toEqual(
      stopped('budget_exhausted', 'COST_LIMIT'),
    );
  });
});

describe('each limit stops with its own code', () => {
  it.each([
    ['turns', model('tool_proposed'), { toolCalls: 5 }, 'budget_exhausted', 'TOOL_LIMIT'],
    ['tools', tool('done'), { modelTurns: 5 }, 'budget_exhausted', 'TURN_LIMIT'],
    [
      'tokens',
      tool('done'),
      { inputTokens: 600, outputTokens: 400 },
      'budget_exhausted',
      'TOKEN_LIMIT',
    ],
    ['cost', tool('done'), { costMicros: 1_000 }, 'budget_exhausted', 'COST_LIMIT'],
    ['time', tool('done'), { activeMs: 60_000 }, 'timed_out', 'TIME_LIMIT'],
    [
      'tokens before a tool',
      model('tool_proposed'),
      { outputTokens: 1_000 },
      'budget_exhausted',
      'TOKEN_LIMIT',
    ],
    [
      'cost before a tool',
      model('tool_proposed'),
      { costMicros: 1_001 },
      'budget_exhausted',
      'COST_LIMIT',
    ],
    ['time before a tool', model('tool_proposed'), { activeMs: 61_000 }, 'timed_out', 'TIME_LIMIT'],
    ['after a child', child('completed'), { modelTurns: 5 }, 'budget_exhausted', 'TURN_LIMIT'],
  ] as const)('%s', (_label, last, used, status, code) => {
    expect(decideNext(state(used), last)).toEqual(stopped(status, code));
  });

  it.each([
    [{ modelTurns: 4 }, tool('done'), 'model_turn'],
    [{ toolCalls: 4 }, model('tool_proposed'), 'tool_call'],
    [{ inputTokens: 999 }, tool('done'), 'model_turn'],
    [{ costMicros: 999 }, tool('done'), 'model_turn'],
    [{ activeMs: 59_999 }, tool('done'), 'model_turn'],
  ] as const)('one short of the limit, %j goes on', (used, last, kind) => {
    expect(decideNext(state(used), last).kind).toBe(kind);
  });
});

describe('a finished answer', () => {
  it('goes to be verified', () => {
    expect(decideNext(state(), model('final_output'))).toEqual({ kind: 'verify' });
  });

  it('is kept when it lands exactly on a limit', () => {
    const atLimit = {
      modelTurns: 5,
      toolCalls: 5,
      inputTokens: 1_000,
      costMicros: 1_000,
      activeMs: 60_000,
    };
    expect(decideNext(state(atLimit), model('final_output'))).toEqual({ kind: 'verify' });
  });

  it.each([
    [{ costMicros: 1_001 }, 'budget_exhausted', 'COST_LIMIT'],
    [{ inputTokens: 1_001 }, 'budget_exhausted', 'TOKEN_LIMIT'],
    [{ activeMs: 60_001 }, 'timed_out', 'TIME_LIMIT'],
  ] as const)('is not when it went over: %j', (used, status, code) => {
    expect(decideNext(state(used), model('final_output'))).toEqual(stopped(status, code));
  });
});

describe('every outcome maps somewhere', () => {
  const allowed = new Set<string>(STOP_CODES);
  const legal = (next: NextStep) => {
    if (next.kind !== 'stop') return true;
    return allowed.has(next.stopCode) && AGENT_RUN_STATUSES.includes(next.status);
  };

  it.each(MODEL_OUTCOMES)('model outcome %s', (outcome) => {
    expect(legal(decideNext(state(), model(outcome)))).toBe(true);
  });

  it.each(TOOL_OUTCOMES)('tool outcome %s', (outcome) => {
    expect(legal(decideNext(state(), tool(outcome)))).toBe(true);
  });

  it('says exactly where', () => {
    const table: Record<(typeof MODEL_OUTCOMES)[number], NextStep> = {
      tool_proposed: { kind: 'tool_call' },
      final_output: { kind: 'verify' },
      invalid_output: stopped('failed', 'INVALID_OUTPUT'),
      budget_exhausted: stopped('budget_exhausted', 'BUDGET_EXHAUSTED'),
      policy_denied: stopped('policy_denied', 'POLICY_DENIED'),
      model_unavailable: stopped('failed', 'MODEL_UNAVAILABLE'),
      credential_unavailable: stopped('failed', 'CREDENTIAL_UNAVAILABLE'),
      stopped: stopped('cancelled', 'STOPPED_BY_PERSON'),
    };
    for (const outcome of MODEL_OUTCOMES) {
      expect(decideNext(state(), model(outcome))).toEqual(table[outcome]);
    }
    const tools: Record<(typeof TOOL_OUTCOMES)[number], NextStep> = {
      done: { kind: 'model_turn' },
      needs_approval: { kind: 'wait_for_tool' },
      denied: stopped('policy_denied', 'POLICY_DENIED'),
      unknown_external_state: stopped('outcome_unverified', 'UNKNOWN_EXTERNAL_STATE'),
      budget_exhausted: stopped('budget_exhausted', 'BUDGET_EXHAUSTED'),
      stopped: stopped('cancelled', 'STOPPED_BY_PERSON'),
    };
    for (const outcome of TOOL_OUTCOMES) {
      expect(decideNext(state(), tool(outcome))).toEqual(tools[outcome]);
    }
  });

  it.each([
    ['waiting', { kind: 'wait_for_tool' }],
    ['done', { kind: 'tool_call' }],
    ['denied', stopped('policy_denied', 'APPROVAL_DENIED')],
    ['expired', stopped('failed', 'APPROVAL_EXPIRED')],
    ['failed', stopped('failed', 'INTERNAL_ERROR')],
    ['unknown_external_state', stopped('outcome_unverified', 'UNKNOWN_EXTERNAL_STATE')],
  ] as const)('wait state %s', (waitState, next) => {
    expect(decideNext(state(), wait(waitState))).toEqual(next);
  });

  it.each([
    ['completed', { kind: 'model_turn' }],
    ['budget_exhausted', stopped('budget_exhausted', 'BUDGET_EXHAUSTED')],
    ['outcome_unverified', stopped('outcome_unverified', 'OUTPUT_UNVERIFIED')],
    ['failed', stopped('failed', 'CHILD_FAILED')],
    ['cancelled', stopped('failed', 'CHILD_FAILED')],
    ['policy_denied', stopped('failed', 'CHILD_FAILED')],
    ['timed_out', stopped('failed', 'CHILD_FAILED')],
    ['nothing_queued', stopped('failed', 'CHILD_FAILED')],
  ] as const)('child status %s', (status, next) => {
    expect(decideNext(state(), child(status))).toEqual(next);
  });

  it.each([
    ['model', model('a model said so')],
    ['tool', tool('a model said so')],
    ['wait', wait('a model said so')],
    ['a kind nobody knows', { kind: 'nonsense' } as unknown as LastStep],
  ])('something unknown from %s ends the run', (_label, last) => {
    expect(decideNext(state(), last)).toEqual(stopped('failed', 'INTERNAL_ERROR'));
  });
});

describe('what a last step says beats a limit', () => {
  const broke = { costMicros: 5_000, modelTurns: 5, toolCalls: 5 };

  it('an unknown send stays unknown on a run out of money', () => {
    expect(decideNext(state(broke), tool('unknown_external_state'))).toEqual(
      stopped('outcome_unverified', 'UNKNOWN_EXTERNAL_STATE'),
    );
    expect(decideNext(state(broke), wait('unknown_external_state'))).toEqual(
      stopped('outcome_unverified', 'UNKNOWN_EXTERNAL_STATE'),
    );
  });

  it('a denial stays a denial', () => {
    expect(decideNext(state(broke), model('policy_denied'))).toEqual(
      stopped('policy_denied', 'POLICY_DENIED'),
    );
  });

  it('a wait is not cut short by a limit, because waiting is not active time (FD-22)', () => {
    expect(decideNext(state({ activeMs: 60_000 }), tool('needs_approval'))).toEqual({
      kind: 'wait_for_tool',
    });
    expect(decideNext(state({ activeMs: 60_000 }), wait('waiting'))).toEqual({
      kind: 'wait_for_tool',
    });
  });

  it('reading a receipt for a send that already happened is not a new call', () => {
    expect(decideNext(state({ toolCalls: 5 }), wait('done'))).toEqual({ kind: 'tool_call' });
  });
});

describe('delegation', () => {
  it('starts a child with depth to spare', () => {
    expect(decideNext(state(), tool('delegate'))).toEqual({ kind: 'start_child' });
  });

  it('refuses at depth 0', () => {
    expect(decideNext(state({}, { maxDelegationDepth: 0 }), tool('delegate'))).toEqual(
      stopped('policy_denied', 'DELEGATION_DENIED'),
    );
  });

  it('refuses with nothing left to carve from', () => {
    expect(decideNext(state({ costMicros: 1_000 }), tool('delegate'))).toEqual(
      stopped('budget_exhausted', 'COST_LIMIT'),
    );
  });
});

describe('a run cannot raise its limits', () => {
  it('reads limits from the state, and nothing in a last step changes them', () => {
    const smuggled = {
      kind: 'tool',
      outcome: 'done',
      limits: { maxModelTurns: 1_000_000 },
      maxModelTurns: 1_000_000,
    } as unknown as LastStep;
    expect(decideNext(state({ modelTurns: 5 }), smuggled)).toEqual(
      stopped('budget_exhausted', 'TURN_LIMIT'),
    );
  });

  it('never writes to what it was given', () => {
    const given = state({ modelTurns: 1 });
    const frozen = Object.freeze({
      counters: Object.freeze({ ...given.counters }),
      limits: Object.freeze({ ...given.limits }),
    });
    expect(() => decideNext(frozen, tool('done'))).not.toThrow();
  });

  it.each([
    ['a negative counter', { costMicros: -1 }, {}],
    ['a fractional counter', { costMicros: 0.5 }, {}],
    ['NaN', { activeMs: Number.NaN }, {}],
    ['Infinity as a limit', {}, { maxCostMicros: Number.POSITIVE_INFINITY }],
    ['a negative limit', {}, { maxModelTurns: -1 }],
    ['a timeout of nothing', {}, { timeoutSeconds: 0 }],
  ] as const)('%s fails closed', (_label, used, caps) => {
    expect(decideNext(state(used, caps), { kind: 'none' })).toEqual(
      stopped('failed', 'INTERNAL_ERROR'),
    );
  });
});

describe('stops that come from outside the loop', () => {
  it('names a stop and a kill switch differently', () => {
    expect(stopForDirective('stop')).toEqual(stopped('cancelled', 'STOPPED_BY_PERSON'));
    expect(stopForDirective('halted')).toEqual(stopped('cancelled', 'HALTED'));
  });

  it.each([
    ['INITIATOR_INACTIVE', 'cancelled', 'INITIATOR_INACTIVE'],
    ['AI_HALTED', 'cancelled', 'HALTED'],
    ['NOT_FOUND', 'policy_denied', 'POLICY_DENIED'],
    ['FORBIDDEN', 'policy_denied', 'POLICY_DENIED'],
    ['WORK_STOPPED', 'cancelled', 'WORK_STOPPED'],
    ['WORKER_UNAVAILABLE', 'failed', 'WORKER_UNAVAILABLE'],
    ['SOMETHING_ELSE', 'failed', 'INTERNAL_ERROR'],
    [null, 'failed', 'INTERNAL_ERROR'],
  ] as const)('failure %s', (code, status, stopCode) => {
    expect(stopForFailure(code)).toEqual(stopped(status, stopCode));
    expect(STOP_CODES).toContain(stopCode);
  });
});
