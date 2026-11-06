// Owned by the spine slice (AGENT-02). What a run does next, as one pure function, so a unit test can reach
// every branch and the workflow bundle can load it. It imports nothing at all, by lint, so these types are
// its own. A test holds them equal to @ensemus/domain/ai.

export type ReducerCounters = {
  modelTurns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  activeMs: number;
};

export type ReducerLimits = {
  maxModelTurns: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  maxCostMicros: number;
  timeoutSeconds: number;
  maxDelegationDepth: number;
};

export type ReducerState = {
  counters: ReducerCounters;
  limits: ReducerLimits;
};

export type LastStep =
  | { kind: 'none' }
  | { kind: 'model'; outcome: string }
  /** Any TOOL_OUTCOMES entry, or `delegate` when a tool call asked for a child (FD-16). */
  | { kind: 'tool'; outcome: string }
  | { kind: 'wait'; state: string }
  | { kind: 'child'; status: string };

export type StopStatus =
  | 'failed'
  | 'cancelled'
  | 'budget_exhausted'
  | 'policy_denied'
  | 'timed_out'
  | 'outcome_unverified';

export type RunStop = { kind: 'stop'; status: StopStatus; stopCode: string };

export type NextStep =
  | { kind: 'model_turn' }
  | { kind: 'tool_call' }
  | { kind: 'wait_for_tool' }
  | { kind: 'start_child' }
  | { kind: 'verify' }
  | RunStop;

const stop = (status: StopStatus, stopCode: string): RunStop => ({
  kind: 'stop',
  status,
  stopCode,
});

const internalError = () => stop('failed', 'INTERNAL_ERROR');

const isCount = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A number this cannot trust ends the run. It must never read as "still under the limit". */
const isSound = ({ counters, limits }: ReducerState) =>
  Object.values(counters).every(isCount) &&
  Object.values(limits).every(isCount) &&
  limits.timeoutSeconds > 0;

/**
 * Tokens, money and active time. `reached` asks whether another step may start, so being exactly at a
 * limit stops it. Asked of a finished answer, only going over counts: reaching the limit with the answer
 * in hand is what a limit allows.
 */
function spent({ counters, limits }: ReducerState, reached: boolean): RunStop | null {
  const hit = (used: number, limit: number) => (reached ? used >= limit : used > limit);
  if (hit(counters.costMicros, limits.maxCostMicros)) return stop('budget_exhausted', 'COST_LIMIT');
  const tokens = counters.inputTokens + counters.outputTokens;
  if (hit(tokens, limits.maxTotalTokens)) return stop('budget_exhausted', 'TOKEN_LIMIT');
  if (hit(counters.activeMs, limits.timeoutSeconds * 1000)) return stop('timed_out', 'TIME_LIMIT');
  return null;
}

function modelTurn(state: ReducerState): NextStep {
  if (state.counters.modelTurns >= state.limits.maxModelTurns) {
    return stop('budget_exhausted', 'TURN_LIMIT');
  }
  return spent(state, true) ?? { kind: 'model_turn' };
}

function toolCall(state: ReducerState): NextStep {
  if (state.counters.toolCalls >= state.limits.maxToolCalls) {
    return stop('budget_exhausted', 'TOOL_LIMIT');
  }
  return spent(state, true) ?? { kind: 'tool_call' };
}

function afterModel(state: ReducerState, outcome: string): NextStep {
  switch (outcome) {
    case 'tool_proposed':
      return toolCall(state);
    case 'final_output':
      return spent(state, false) ?? { kind: 'verify' };
    case 'invalid_output':
      return stop('failed', 'INVALID_OUTPUT');
    case 'budget_exhausted':
      return stop('budget_exhausted', 'BUDGET_EXHAUSTED');
    case 'policy_denied':
      return stop('policy_denied', 'POLICY_DENIED');
    case 'model_unavailable':
      return stop('failed', 'MODEL_UNAVAILABLE');
    case 'credential_unavailable':
      return stop('failed', 'CREDENTIAL_UNAVAILABLE');
    case 'stopped':
      return stop('cancelled', 'STOPPED_BY_PERSON');
    default:
      return internalError();
  }
}

function afterTool(state: ReducerState, outcome: string): NextStep {
  switch (outcome) {
    case 'done':
      return modelTurn(state);
    case 'needs_approval':
      return { kind: 'wait_for_tool' };
    case 'delegate':
      // The application refuses this as well. A run with no depth left never gets as far as asking.
      if (state.limits.maxDelegationDepth < 1) return stop('policy_denied', 'DELEGATION_DENIED');
      return spent(state, true) ?? { kind: 'start_child' };
    case 'denied':
      return stop('policy_denied', 'POLICY_DENIED');
    case 'unknown_external_state':
      return stop('outcome_unverified', 'UNKNOWN_EXTERNAL_STATE');
    case 'budget_exhausted':
      return stop('budget_exhausted', 'BUDGET_EXHAUSTED');
    case 'stopped':
      return stop('cancelled', 'STOPPED_BY_PERSON');
    default:
      return internalError();
  }
}

function afterWait(state: string): NextStep {
  switch (state) {
    case 'waiting':
      return { kind: 'wait_for_tool' };
    case 'done':
      // Back through the same tool step, which finds the send by its key and records the receipt the next
      // turn needs. It is not a new call and spends nothing, so no limit applies here. The next turn is
      // checked as usual.
      return { kind: 'tool_call' };
    case 'denied':
      return stop('policy_denied', 'APPROVAL_DENIED');
    case 'expired':
      return stop('failed', 'APPROVAL_EXPIRED');
    case 'failed':
      return stop('failed', 'INTERNAL_ERROR');
    case 'unknown_external_state':
      return stop('outcome_unverified', 'UNKNOWN_EXTERNAL_STATE');
    default:
      return internalError();
  }
}

function afterChild(state: ReducerState, status: string): NextStep {
  switch (status) {
    case 'completed':
      return modelTurn(state);
    case 'budget_exhausted':
      return stop('budget_exhausted', 'BUDGET_EXHAUSTED');
    case 'outcome_unverified':
      return stop('outcome_unverified', 'OUTPUT_UNVERIFIED');
    default:
      // Failed, cancelled, denied, timed out or never claimed. Whatever it was, the parent does not guess.
      return stop('failed', 'CHILD_FAILED');
  }
}

/**
 * What a run does next, from its counters, its limits and how the last step ended. A last step that ends
 * the run wins over a limit, because it says what really happened: an unknown send stays unknown, even on
 * a run that has also run out of money. No input can raise a limit: they are read here and written nowhere.
 */
export function decideNext(state: ReducerState, last: LastStep): NextStep {
  if (!isSound(state)) return internalError();
  switch (last.kind) {
    case 'none':
      return modelTurn(state);
    case 'model':
      return afterModel(state, last.outcome);
    case 'tool':
      return afterTool(state, last.outcome);
    case 'wait':
      return afterWait(last.state);
    case 'child':
      return afterChild(state, last.status);
    default:
      return internalError();
  }
}

/** A stop or a kill switch found in PostgreSQL. */
export function stopForDirective(directive: 'stop' | 'halted'): RunStop {
  return directive === 'halted'
    ? stop('cancelled', 'HALTED')
    : stop('cancelled', 'STOPPED_BY_PERSON');
}

/**
 * An Activity's failure, by its type. Only the type crosses Temporal, and these are what it can say on
 * purpose. Anything else is a fault, stated as one, and never read as a policy decision.
 */
export function stopForFailure(code: string | null): RunStop {
  switch (code) {
    case 'INITIATOR_INACTIVE':
      return stop('cancelled', 'INITIATOR_INACTIVE');
    case 'AI_HALTED':
      return stop('cancelled', 'HALTED');
    case 'NOT_FOUND':
    case 'FORBIDDEN':
      return stop('policy_denied', 'POLICY_DENIED');
    case 'WORK_STOPPED':
      return stop('cancelled', 'WORK_STOPPED');
    case 'WORKER_UNAVAILABLE':
      return stop('failed', 'WORKER_UNAVAILABLE');
    default:
      return internalError();
  }
}
