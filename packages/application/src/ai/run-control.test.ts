// The rules for starting and steering a run, in the parts that need no database. The transactions, roles
// and triggers are in tests/integration/ai-timeline.test.ts.
import { AGENT_RUN_STATUSES, isTerminalAgentRun, RUN_CONTROL_KINDS } from '@ensemus/domain/ai';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors';
import {
  controlAgentRun,
  decideControl,
  earlyRefusal,
  listRunnableAgents,
  mayControlRun,
  runTermsFromVersion,
  startAgentRun,
  workStartRefusal,
} from './run-control';

const ID = '7f0c1f6e-3a39-4f5e-9d7a-3f4a0a4f1b11';

const spec = {
  api_version: 'ensemus.ai/v1',
  id: 'work-brief',
  version: 1,
  objective: 'Read the work and draft a short brief for its owner.',
  instructions: 'Use only what the work and its files say.',
  model: {
    required_capabilities: ['text', 'tools'],
    quality_tier: 'balanced',
    fallback: 'disabled',
  },
  context: { allowed_scopes: ['work.read'], memory_write_policy: 'none' },
  tools: { allow: ['work.read', 'artifact.read_text', 'email.send'], deny: ['email.send'] },
  execution: {
    max_model_turns: 5,
    max_tool_calls: 7,
    max_total_tokens: 10_000,
    max_cost_usd: '1',
    timeout_seconds: 60,
    max_delegation_depth: 2,
  },
  output: { schema_ref: 'schemas/work-brief.schema.json', verification: ['schema_check'] },
  evaluation: { suite_ref: 'evaluations/agents/work-brief', min_pass_rate: 0.9 },
};

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  return null;
};

describe('what a run is given', () => {
  it('takes every limit from the version', () => {
    expect(runTermsFromVersion({ spec, maxCostMicros: 1_000_000 })).toEqual({
      maxModelTurns: 5,
      maxToolCalls: 7,
      maxTotalTokens: 10_000,
      maxCostMicros: 1_000_000,
      timeoutSeconds: 60,
      maxDelegationDepth: 2,
      delegatedScopes: { tools: ['work.read', 'artifact.read_text'] },
    });
  });

  it('takes the amount parsed at publish, and never re-reads the decimal text', () => {
    const terms = runTermsFromVersion({
      spec: { ...spec, execution: { ...spec.execution, max_cost_usd: '999' } },
      maxCostMicros: 42,
    });
    expect(terms.maxCostMicros).toBe(42);
  });

  it('lets deny win over allow', () => {
    const { delegatedScopes } = runTermsFromVersion({ spec, maxCostMicros: 1 });
    expect(delegatedScopes.tools).not.toContain('email.send');
  });

  it('refuses a stored spec that no longer parses', () => {
    expect(codeOf(() => runTermsFromVersion({ spec: { id: 'x' }, maxCostMicros: 1 }))).toBe(
      'AGENT_SPEC_INVALID',
    );
  });
});

describe('work a run can start on', () => {
  const plain = { status: 'queued', executionPlan: null, runRequestedAt: null, runId: null };

  it.each(['queued', 'ready', 'running'])('allows %s work', (status) => {
    expect(workStartRefusal({ ...plain, status })).toBeNull();
  });

  it.each(['blocked', 'awaiting_approval', 'verifying', 'completed', 'failed', 'cancelled'])(
    'refuses %s work',
    (status) => {
      expect(workStartRefusal({ ...plain, status })).toBe('INVALID_STATE');
    },
  );

  it('refuses work a plan already holds, since both would use one workflow ID', () => {
    const plan = { ...plain, status: 'ready', executionPlan: 'checklist' };
    expect(workStartRefusal({ ...plan, runRequestedAt: new Date() })).toBe('RUN_ALREADY_REQUESTED');
    expect(workStartRefusal({ ...plan, runId: 'workflow-run' })).toBe('RUN_ALREADY_REQUESTED');
    expect(workStartRefusal(plan)).toBeNull();
  });

  it('allows a retry when an earlier agent run left its run ID on plain work', () => {
    expect(workStartRefusal({ ...plain, status: 'running', runId: 'workflow-run' })).toBeNull();
  });
});

describe('the friendly early check', () => {
  it('says so when no model is ready', () => {
    expect(earlyRefusal({ hasActiveProfile: false, hasBudget: true })).toBe(
      'MODEL_PROFILE_NOT_ACTIVE',
    );
  });

  it('says so when no budget applies', () => {
    expect(earlyRefusal({ hasActiveProfile: true, hasBudget: false })).toBe(
      'BUDGET_NOT_CONFIGURED',
    );
  });

  it('has nothing to say otherwise, and leaves the real decision to the gateway', () => {
    expect(earlyRefusal({ hasActiveProfile: true, hasBudget: true })).toBeNull();
  });
});

describe('who may steer a run', () => {
  const run = { initiatorMembershipId: 'starter' };
  const person = (membershipId: string, role: string) => ({ membershipId, role });

  it.each(RUN_CONTROL_KINDS)('lets an admin with the capability %s anyone’s run', (kind) => {
    expect(mayControlRun(person('other', 'admin'), run, kind)).toBe(true);
    expect(mayControlRun(person('other', 'owner'), run, kind)).toBe(true);
  });

  it.each(RUN_CONTROL_KINDS)('refuses a member who did not start it to %s', (kind) => {
    expect(mayControlRun(person('other', 'member'), run, kind)).toBe(false);
  });

  it('lets the person who started it stop or pause it, whatever they are now', () => {
    expect(mayControlRun(person('starter', 'member'), run, 'stop')).toBe(true);
    expect(mayControlRun(person('starter', 'member'), run, 'pause')).toBe(true);
  });

  it('does not let them restart its spending once they can no longer start runs', () => {
    expect(mayControlRun(person('starter', 'member'), run, 'resume')).toBe(false);
    expect(mayControlRun(person('starter', 'admin'), run, 'resume')).toBe(true);
  });
});

describe('what a control does to a run in each state', () => {
  const finished = AGENT_RUN_STATUSES.filter(isTerminalAgentRun);
  const live = AGENT_RUN_STATUSES.filter((status) => !isTerminalAgentRun(status));

  it.each(finished)('refuses every control once a run is %s', (status) => {
    for (const kind of RUN_CONTROL_KINDS) {
      expect(decideControl(status, null, kind)).toBe('AGENT_RUN_NOT_CONTROLLABLE');
    }
  });

  it.each(live)('always records a stop while a run is %s', (status) => {
    expect(decideControl(status, null, 'stop')).toBe('record');
    expect(decideControl(status, 'pause', 'stop')).toBe('record');
  });

  it.each(live)('treats a second stop as the first, while %s', (status) => {
    expect(decideControl(status, 'stop', 'stop')).toBe('already');
  });

  it.each(live)('does not let a pause or a resume overtake a stop, while %s', (status) => {
    expect(decideControl(status, 'stop', 'pause')).toBe('INVALID_STATE');
    expect(decideControl(status, 'stop', 'resume')).toBe('INVALID_STATE');
  });

  it.each(['running', 'waiting_for_approval', 'waiting_for_child'] as const)(
    'pauses a run that is %s, which the state machine allows',
    (status) => {
      expect(decideControl(status, null, 'pause')).toBe('record');
    },
  );

  it.each(['queued', 'preparing', 'verifying'] as const)(
    'refuses to pause a run that is %s, which the state machine does not allow',
    (status) => {
      expect(decideControl(status, null, 'pause')).toBe('INVALID_STATE');
    },
  );

  it('treats a repeated pause as one, before and after the worker acts on it', () => {
    expect(decideControl('running', 'pause', 'pause')).toBe('already');
    expect(decideControl('paused', 'pause', 'pause')).toBe('already');
  });

  it('resumes a paused run, and one whose pause the worker has not reached', () => {
    expect(decideControl('paused', 'pause', 'resume')).toBe('record');
    expect(decideControl('paused', null, 'resume')).toBe('record');
    expect(decideControl('running', 'pause', 'resume')).toBe('record');
  });

  it('treats a repeated resume as one', () => {
    expect(decideControl('paused', 'resume', 'resume')).toBe('already');
    expect(decideControl('running', 'resume', 'resume')).toBe('already');
  });

  it('refuses to resume something that was never paused', () => {
    expect(decideControl('running', null, 'resume')).toBe('INVALID_STATE');
    expect(decideControl('queued', null, 'resume')).toBe('INVALID_STATE');
  });

  it('lets someone pause again while their resume is on its way', () => {
    expect(decideControl('paused', 'resume', 'pause')).toBe('record');
  });
});

describe('refusals that need no database', () => {
  /** A database nothing should reach. A refusal below fails if a query is tried first. */
  const unreachable = {
    transaction() {
      throw new Error('This should have been refused before reaching the database');
    },
  } as unknown as AppDatabase;

  const contextOf = (actorType: string) =>
    ({
      organizationId: ID,
      membershipId: ID,
      role: 'owner',
      actorType,
    }) as unknown as TenantContext;
  const start = { work_unit_id: ID, agent_version_id: ID };
  const stop = { agentRunId: ID, kind: 'stop' } as const;

  const refusedWith = (code: string, promise: Promise<unknown>) =>
    expect(promise).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === code,
    );

  it.each(['agent', 'service'])('never lets an %s start or steer a run', async (actorType) => {
    // An agent carries its initiator's role, so without this the capability check would pass.
    const context = contextOf(actorType);
    await refusedWith('FORBIDDEN', startAgentRun(unreachable, context, start));
    await refusedWith('FORBIDDEN', controlAgentRun(unreachable, context, stop));
    await refusedWith('FORBIDDEN', listRunnableAgents(unreachable, context));
  });

  it('refuses a request that does not have the contract’s shape', async () => {
    const context = contextOf('user');
    await refusedWith(
      'INVALID_INPUT',
      startAgentRun(unreachable, context, { ...start, work_unit_id: 'nope' }),
    );
    await refusedWith(
      'INVALID_INPUT',
      startAgentRun(unreachable, context, {
        ...start,
        // A limit or a tool in the request is refused outright, not ignored.
        max_cost_micros: 999,
      } as typeof start),
    );
    await refusedWith(
      'INVALID_INPUT',
      controlAgentRun(unreachable, context, { agentRunId: ID, kind: 'explode' } as never),
    );
  });

  it('calls a run ID that is not an ID not found', async () => {
    await refusedWith(
      'NOT_FOUND',
      controlAgentRun(unreachable, contextOf('user'), { agentRunId: 'nope', kind: 'stop' }),
    );
  });

  it('refuses a member the list of agents to start', async () => {
    await refusedWith(
      'FORBIDDEN',
      listRunnableAgents(unreachable, {
        ...contextOf('user'),
        role: 'member',
      } as unknown as TenantContext),
    );
  });
});
