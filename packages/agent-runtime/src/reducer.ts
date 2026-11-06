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
  | { kind: 'tool'; outcome: string }
  | { kind: 'wait'; state: string }
  | { kind: 'child'; status: string };

export type NextStep =
  | { kind: 'model_turn' }
  | { kind: 'tool_call' }
  | { kind: 'wait_for_tool' }
  | { kind: 'start_child' }
  | { kind: 'verify' }
  | {
      kind: 'stop';
      status: 'failed' | 'cancelled' | 'budget_exhausted' | 'policy_denied' | 'timed_out';
      stopCode: string;
    };

/** Fails closed until the spine slice fills it in. Any input ends the run. */
export function decideNext(_state: ReducerState, _last: LastStep): NextStep {
  return { kind: 'stop', status: 'failed', stopCode: 'INTERNAL_ERROR' };
}
