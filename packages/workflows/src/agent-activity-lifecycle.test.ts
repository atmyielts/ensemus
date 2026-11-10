// Exercises the Activity with the real halt watcher: each slice's own doubles hid their ownership and
// unknown-provider mismatch. Database effects are doubled here; the real roles have integration tests.
import { randomUUID } from 'node:crypto';
import { AppError } from '@ensemus/application';
import {
  closeRunWithoutContext,
  completeTurn,
  contextForRun,
  createTurnStore,
  raiseClassification,
  readRunFacts,
  storeStepPayload,
  type RunFacts,
} from '@ensemus/application/ai-runs';
import type { LiveSwitch } from '@ensemus/application/ai-halt';
import { TenantAccessDenied, type AgentContext, type AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { currentRunInputClass } from '@ensemus/application/ai-model-admission';
import type { TurnOutcome } from '@ensemus/intelligence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHaltWatcher, type HaltWatcher } from '../../../workers/workflow/src/kill-switch';
import {
  createAgentActivities,
  type AgentActivityDeps,
  type TranscriptPurgePort,
} from './agent-activities';
import type { StepInput } from './agent-schemas';
import type { RunRef as CompileRunRef } from '@ensemus/agent-runtime/context';

vi.mock('@ensemus/application/ai-model-admission', () => ({
  currentRunInputClass: vi.fn(),
  isMainInputDenied: () => false,
}));

vi.mock('@ensemus/application/ai-runs', async (original) => ({
  ...(await original<typeof import('@ensemus/application/ai-runs')>()),
  closeRunWithoutContext: vi.fn(),
  completeTurn: vi.fn(),
  contextForRun: vi.fn(),
  createTurnStore: vi.fn(),
  raiseClassification: vi.fn(),
  readRunFacts: vi.fn(),
  storeStepPayload: vi.fn(),
}));

const input: StepInput = {
  organizationId: randomUUID(),
  workUnitId: randomUUID(),
  agentRunId: randomUUID(),
  temporalRunId: randomUUID(),
  stepNumber: 1,
};
const versionId = randomUUID();
const context: AgentContext = {
  ...createServiceContext(input.organizationId),
  userId: randomUUID(),
  membershipId: randomUUID(),
  role: 'owner',
  actorType: 'agent',
  agentRunId: input.agentRunId,
};
const counters = {
  modelTurns: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
  activeMs: 0,
};
const facts: RunFacts = {
  status: 'running',
  temporalRunId: input.temporalRunId,
  workUnitId: input.workUnitId,
  agentVersionId: versionId,
  classification: 'internal',
  bound: null,
  limits: {
    maxModelTurns: 3,
    maxToolCalls: 3,
    maxTotalTokens: 1000,
    maxCostMicros: 1000,
    timeoutSeconds: 60,
    maxDelegationDepth: 0,
  },
  counters,
};
const outcome = (kind: 'final_output' | 'stopped' = 'final_output'): TurnOutcome => ({
  outcome: kind,
  stopCode: null,
  decisionCode: null,
  usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
  profile: null,
  text: kind === 'final_output' ? 'A synthetic answer.' : null,
  toolCall: null,
});

const watchers: HaltWatcher[] = [];
const calls: Promise<unknown>[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(compileEffect?: () => Promise<void>) {
  let switches: readonly LiveSwitch[] = [];
  const read = vi.fn(async () => switches);
  const watcher = createHaltWatcher({ pollMs: 10, read, log: { warn: vi.fn(), error: vi.fn() } });
  watchers.push(watcher);
  watcher.start();
  const temporal = new AbortController();
  const heartbeat = vi.fn();
  const entered = deferred<AbortSignal>();
  const answer = deferred<TurnOutcome>();
  const compilations: CompileRunRef[] = [];
  const turn = vi.fn<AgentActivityDeps['gateway']['turn']>(
    async (_ctx, _step, _compiled, signal) => {
      entered.resolve(signal);
      if (signal.aborted) return outcome('stopped');
      signal.addEventListener('abort', () => answer.resolve(outcome('stopped')), { once: true });
      return answer.promise;
    },
  );
  const purgeEnded = vi.fn<TranscriptPurgePort['purgeEnded']>(async () => 'purged');
  const reconcileRun = vi.fn(async () => undefined);
  const activities = createAgentActivities({
    database: {} as AppDatabase,
    transcripts: { purgeEnded },
    modelAccounting: { reconcileRun },
    gateway: { turn },
    tools: { handle: vi.fn() },
    context: {
      compile: vi.fn<AgentActivityDeps['context']['compile']>(async (_ctx, run) => {
        compilations.push(run);
        await compileEffect?.();
        return {
          messages: [],
          tools: [],
          responseSchema: null,
          task: {
            runId: input.agentRunId,
            purpose: 'reason',
            quality: 'balanced',
            required: ['text'],
            classification: 'internal',
            requiredRegion: null,
            allowFallback: false,
            pinned: null,
          },
          requestHash: 'a'.repeat(64),
          maxOutputTokens: 100,
          timeoutMs: 1000,
          classification: 'internal',
          sources: [],
        };
      }),
    },
    haltWatcher: watcher,
    pulse: () => ({ heartbeat, signal: temporal.signal }),
  });
  return {
    activities,
    purgeEnded,
    reconcileRun,
    watcher,
    read,
    temporal,
    heartbeat,
    entered: entered.promise,
    answer,
    turn,
    compilations,
    setSwitches: (next: readonly LiveSwitch[]) => {
      switches = next;
    },
    run: () => {
      const call = activities.runModelTurn(input);
      calls.push(call.catch(() => undefined));
      return call;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(contextForRun).mockResolvedValue(context);
  vi.mocked(readRunFacts).mockResolvedValue(facts);
  vi.mocked(createTurnStore).mockReturnValue({
    beginTurn: vi.fn(async () => ({
      kind: 'begin' as const,
      stepId: randomUUID(),
      attempt: 1,
      lostAttempt: null,
    })),
    bindProfile: vi.fn(),
  });
  vi.mocked(raiseClassification).mockResolvedValue('internal');
  vi.mocked(completeTurn).mockResolvedValue(counters);
  vi.mocked(storeStepPayload).mockResolvedValue();
  vi.mocked(currentRunInputClass).mockResolvedValue('internal');
  vi.mocked(closeRunWithoutContext).mockResolvedValue();
});

afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.stop()));
  await Promise.allSettled(calls.splice(0));
  vi.useRealTimers();
});

describe('an Activity owns its halt watch for one call', () => {
  it('owns heartbeat, cancellation and exact model-step identity before auxiliary compilation starts', async () => {
    const entered = deferred<void>(),
      release = deferred<void>();
    const world = fixture(async () => {
        entered.resolve();
        await release.promise;
      }),
      result = world.run();
    await entered.promise;
    expect(world.heartbeat).toHaveBeenCalled();
    expect(world.compilations[0]).toMatchObject({
      runId: input.agentRunId,
      modelStep: { stepNumber: input.stepNumber, attempt: 1, stepId: expect.any(String) },
      signal: expect.any(AbortSignal),
    });
    world.setSwitches([{ organizationId: null, scope: 'provider', targetRef: 'openai_hosted' }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(world.compilations[0]?.signal?.aborted).toBe(true);
    release.resolve();
    await expect(result).resolves.toMatchObject({ outcome: 'stopped', stopCode: 'HALTED' });
    expect(world.turn).not.toHaveBeenCalled();
  });
  it.each([
    ['costMicros', 'maxCostMicros', 'COST_LIMIT'],
    ['inputTokens', 'maxTotalTokens', 'TOKEN_LIMIT'],
    ['modelTurns', 'maxModelTurns', 'TURN_LIMIT'],
  ] as const)(
    'does not dispatch the main call after auxiliary spending exhausts %s',
    async (counter, limit, stopCode) => {
      vi.mocked(readRunFacts)
        .mockResolvedValueOnce(facts)
        .mockResolvedValue({
          ...facts,
          counters: { ...facts.counters, [counter]: facts.limits[limit] },
        });
      const world = fixture();
      await expect(world.run()).resolves.toMatchObject({ outcome: 'budget_exhausted', stopCode });
      expect(world.turn).not.toHaveBeenCalled();
      expect(completeTurn).toHaveBeenCalledWith(
        expect.anything(),
        context,
        expect.objectContaining({
          delta: expect.objectContaining({
            modelTurns: 0,
            costMicros: 0,
            inputTokens: 0,
            outputTokens: 0,
          }),
        }),
      );
    },
  );
  it('does not begin auxiliary compilation when the actual active-time budget is already spent', async () => {
    vi.mocked(readRunFacts).mockResolvedValue({
      ...facts,
      limits: { ...facts.limits, timeoutSeconds: 1 },
      counters: { ...facts.counters, activeMs: 1000 },
    });
    const world = fixture();
    await expect(world.run()).resolves.toMatchObject({
      outcome: 'stopped',
      stopCode: 'TIME_LIMIT',
    });
    expect(world.compilations).toEqual([]);
    expect(world.turn).not.toHaveBeenCalled();
  });
  it('aborts the first, unpinned call when a provider switch engages', async () => {
    const world = fixture();
    const result = world.run();
    const signal = await world.entered;
    world.setSwitches([{ organizationId: null, scope: 'provider', targetRef: 'openai_hosted' }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(signal.aborted).toBe(true);
    await expect(result).resolves.toMatchObject({ outcome: 'stopped', stopCode: 'HALTED' });
  });

  it('does not abort a call pinned to a different provider', async () => {
    vi.mocked(readRunFacts).mockResolvedValue({
      ...facts,
      bound: {
        profileId: randomUUID(),
        profileVersion: 1,
        providerKind: 'local_openai_compatible',
      },
    });
    const world = fixture();
    const result = world.run();
    const signal = await world.entered;
    world.setSwitches([{ organizationId: null, scope: 'provider', targetRef: 'openai_hosted' }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(signal.aborted).toBe(false);
    world.answer.resolve(outcome());
    await expect(result).resolves.toMatchObject({ outcome: 'final_output' });
  });

  it('releases a successful call instead of polling its tenant forever', async () => {
    const world = fixture();
    const result = world.run();
    await world.entered;
    world.answer.resolve(outcome());
    await result;
    await vi.advanceTimersByTimeAsync(30);
    expect(world.read).not.toHaveBeenCalled();
  });

  it('releases a failed call and does not expose the thrown content', async () => {
    const world = fixture();
    const result = world.run();
    await world.entered;
    world.answer.reject(new Error('PRIVATE_PROVIDER_ERROR_CANARY'));
    await expect(result).rejects.toMatchObject({ message: 'Agent activity failed' });
    await vi.advanceTimersByTimeAsync(30);
    expect(world.read).not.toHaveBeenCalled();
  });

  it('releases the watch if the first heartbeat fails before the call starts', async () => {
    const world = fixture();
    world.heartbeat.mockImplementation(() => {
      throw new Error('PRIVATE_HEARTBEAT_ERROR_CANARY');
    });
    await expect(world.run()).rejects.toMatchObject({ message: 'Agent activity failed' });
    expect(world.turn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30);
    expect(world.read).not.toHaveBeenCalled();
  });

  it.each(['CANCELLED', 'WORKER_SHUTDOWN'])('releases a call cancelled by %s', async (reason) => {
    const world = fixture();
    const result = world.run();
    const signal = await world.entered;
    world.temporal.abort(new Error(reason));
    expect(signal.aborted).toBe(true);
    if (reason === 'CANCELLED') await expect(result).resolves.toMatchObject({ outcome: 'stopped' });
    else await expect(result).rejects.toMatchObject({ type: 'WORKER_INTERRUPTED' });
    await vi.advanceTimersByTimeAsync(30);
    expect(world.read).not.toHaveBeenCalled();
  });

  it('never opens a watch or a model call for a revoked initiator', async () => {
    vi.mocked(contextForRun).mockRejectedValue(new TenantAccessDenied());
    const world = fixture();
    const watch = vi.spyOn(world.watcher, 'signalFor');
    await expect(world.run()).rejects.toMatchObject({ type: 'INITIATOR_INACTIVE' });
    expect(watch).not.toHaveBeenCalled();
    expect(world.turn).not.toHaveBeenCalled();
  });
  it('discards a late fenced completion while preserving already settled usage and turn counters', async () => {
    vi.mocked(storeStepPayload).mockRejectedValueOnce({ code: 'EN119' });
    const world = fixture(),
      result = world.run();
    await world.entered;
    world.answer.resolve(outcome());
    await expect(result).resolves.toMatchObject({ outcome: 'stopped', stopCode: 'POLICY_DENIED' });
    expect(completeTurn).toHaveBeenCalledWith(
      expect.anything(),
      context,
      expect.objectContaining({
        outcome: 'stopped',
        code: 'POLICY_DENIED',
        delta: expect.objectContaining({
          modelTurns: 1,
          inputTokens: 1,
          outputTokens: 1,
          costMicros: 1,
        }),
      }),
    );
  });
  it('discards a late class-raised response while preserving its already settled money/tokens', async () => {
    vi.mocked(currentRunInputClass)
      .mockResolvedValueOnce('internal')
      .mockResolvedValue('restricted');
    const world = fixture(),
      result = world.run();
    await world.entered;
    world.answer.resolve(outcome());
    await expect(result).resolves.toMatchObject({ outcome: 'stopped', stopCode: 'POLICY_DENIED' });
    expect(storeStepPayload).not.toHaveBeenCalled();
    expect(completeTurn).toHaveBeenCalledWith(
      expect.anything(),
      context,
      expect.objectContaining({
        delta: expect.objectContaining({
          modelTurns: 1,
          costMicros: 1,
          inputTokens: 1,
          outputTokens: 1,
        }),
      }),
    );
  });
});

describe('an ended run hands its transcript to the required service purge (FD-5)', () => {
  const ref = {
    organizationId: input.organizationId,
    workUnitId: input.workUnitId,
    agentRunId: input.agentRunId,
    temporalRunId: input.temporalRunId,
  };
  // The two INITIATOR_INACTIVE call sites: no agent context can be made, so the run is closed by
  // lookup and its transcript can only go through the service purge the composition binds.
  const inactive = {
    reclaimAgentRun: (world: ReturnType<typeof fixture>) => world.activities.reclaimAgentRun(ref),
    finishAgentRun: (world: ReturnType<typeof fixture>) =>
      world.activities.finishAgentRun({ ...ref, status: 'completed', stopCode: null }),
  } as const;
  const paths = Object.keys(inactive) as (keyof typeof inactive)[];

  it('refuses to compose agent Activities without the transcript purge', () => {
    const { transcripts: _unbound, ...unbound } = {
      database: {} as AppDatabase,
      transcripts: { purgeEnded: vi.fn() },
      gateway: { turn: vi.fn() },
      tools: { handle: vi.fn() },
      context: { compile: vi.fn() },
    };
    expect(() => createAgentActivities(unbound as unknown as AgentActivityDeps)).toThrow(
      'AGENT_TRANSCRIPT_PURGE_REQUIRED',
    );
  });

  it.each(paths)(
    '%s: an inactive initiator closes the run, then reconciles and purges it',
    async (path) => {
      vi.mocked(contextForRun).mockRejectedValue(new TenantAccessDenied());
      const world = fixture();
      const result = await inactive[path](world);
      if (path === 'reclaimAgentRun') expect(result).toEqual({ kind: 'nothing_queued' });
      expect(closeRunWithoutContext).toHaveBeenCalledWith(expect.anything(), {
        organizationId: ref.organizationId,
        agentRunId: ref.agentRunId,
        status: 'cancelled',
        stopCode: 'INITIATOR_INACTIVE',
      });
      expect(world.purgeEnded).toHaveBeenCalledExactlyOnceWith(ref.organizationId, ref.agentRunId);
      // Only after the run's end has committed: the purge refuses a live run.
      const closed = vi.mocked(closeRunWithoutContext).mock.invocationCallOrder[0]!;
      expect(world.purgeEnded.mock.invocationCallOrder[0]).toBeGreaterThan(closed);
      expect(world.reconcileRun.mock.invocationCallOrder[0]).toBeGreaterThan(closed);
    },
  );

  it.each(paths)('%s: a held transcript still lets the run close', async (path) => {
    vi.mocked(contextForRun).mockRejectedValue(new TenantAccessDenied());
    const world = fixture();
    world.purgeEnded.mockResolvedValue('held');
    await inactive[path](world);
    expect(closeRunWithoutContext).toHaveBeenCalledOnce();
    expect(world.purgeEnded).toHaveBeenCalledOnce();
  });

  it.each(
    paths.flatMap((path) =>
      (['NOT_FOUND', 'INVALID_STATE'] as const).map((code) => [path, code] as const),
    ),
  )(
    '%s: the purge refusing %s is a terminal answer, not a retried or failed close',
    async (path, code) => {
      vi.mocked(contextForRun).mockRejectedValue(new TenantAccessDenied());
      const world = fixture();
      world.purgeEnded.mockRejectedValue(new AppError(code));
      // Thrown on, this would end the closing Activity after the run had already ended. No retry
      // changes the answer, so it resolves, once, and the unpurged checkpoint stays as debt.
      await inactive[path](world);
      expect(closeRunWithoutContext).toHaveBeenCalledOnce();
      expect(world.purgeEnded).toHaveBeenCalledOnce();
    },
  );

  it.each(paths)('%s: an outage in the purge is retried, never answered', async (path) => {
    vi.mocked(contextForRun).mockRejectedValue(new TenantAccessDenied());
    const world = fixture();
    world.purgeEnded.mockRejectedValue(
      Object.assign(new Error('PRIVATE_LOCK_ERROR_CANARY'), { code: '55P03' }),
    );
    await expect(inactive[path](world)).rejects.toMatchObject({
      type: '55P03',
      nonRetryable: false,
      message: 'Agent activity failed',
    });
  });

  it.each(paths)('%s: any other refusal from the purge still ends the Activity', async (path) => {
    vi.mocked(contextForRun).mockRejectedValue(new TenantAccessDenied());
    const world = fixture();
    // A composition that bound a non-service context: a decision, visible, not an 'unconfirmed'.
    world.purgeEnded.mockRejectedValue(new AppError('FORBIDDEN'));
    await expect(inactive[path](world)).rejects.toMatchObject({
      type: 'FORBIDDEN',
      nonRetryable: true,
    });
  });
});
