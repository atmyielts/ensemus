// AGENT-02 / ADR-028: records real Temporal command histories with synthetic Activity ports. No DB,
// provider credential, prompt or tool payload is involved. Parent must stop its isolated agent-worker while
// these workers exclusively poll ensemus-agent with the public corpus key. No container control here.
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Context } from '@temporalio/activity';
import { Client, Connection, type WorkflowHandle } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import type { AgentActivities } from '@ensemus/workflows/agent-activities';
import type {
  AgentRunCarry,
  AgentRunResult,
  RunDirective,
  ToolWaitState,
} from '@ensemus/workflows/agent-schemas';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { AGENT_RUN_CONTROL_SIGNAL, AGENT_TASK_QUEUE } from '@ensemus/workflows/constants';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';
import {
  AGENT_CONTINUE_HISTORY,
  AGENT_INPUT,
  AGENT_RUN_HISTORIES,
  AGENT_RUN_ID,
  CHILD_RUN_ID,
  CHILD_WORK_ID,
} from './agent-run-paths';
import { capturing, withCaptureWorkers } from './capture-support';
import { CORPUS_DIR, FAILURE_CONVERTER, REPLAY_KEY } from './corpus';

type Path = (typeof AGENT_RUN_HISTORIES)[number];
type Name = Path['name'];
type Counters = Awaited<ReturnType<AgentActivities['runModelTurn']>>['counters'];
const counters = (): Counters => ({
  modelTurns: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
  activeMs: 0,
});
const limits = {
  maxModelTurns: 10,
  maxToolCalls: 10,
  maxTotalTokens: 10000,
  maxCostMicros: 1000,
  timeoutSeconds: 60,
  maxDelegationDepth: 1,
};
const pathFile = (name: string) => join(repoRoot, CORPUS_DIR, `${name}.json`);
const fault = (type = 'CAPTURE_FAULT') =>
  ApplicationFailure.create({ type, message: 'Synthetic capture fault', nonRetryable: true });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function waitForEvent(handle: WorkflowHandle, eventType: string) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (historyToJSON(await handle.fetchHistory()).includes(eventType)) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Capture barrier not reached: ${eventType}`);
}

function harness(name: Name) {
  const parent = counters();
  const child = counters();
  const modelStarted = deferred();
  const modelCalls: { workUnitId: string; stepNumber: number }[] = [];
  const toolCalls: number[] = [];
  const moves: string[] = [];
  const finishes: Parameters<AgentActivities['finishAgentRun']>[0][] = [];
  const settlements: string[] = [];
  const toolSteps = new Set<number>();
  let directive: RunDirective =
    name === 'agent-run-pause-resume' || name === 'agent-run-continued-resume'
      ? 'pause'
      : name === 'agent-run-stop-before-model'
        ? 'stop'
        : name === 'agent-run-halt-before-model'
          ? 'halted'
          : 'continue';
  let wait: ToolWaitState = name === 'agent-run-resumed-tool-wait' ? 'done' : 'waiting';
  let reclaims = 0;
  let claims = 0;
  let resumed = 0;
  let cancelled = false;
  if (name.startsWith('agent-run-resumed-')) {
    Object.assign(parent, {
      modelTurns: 1,
      inputTokens: 10,
      outputTokens: 5,
      costMicros: 1,
      activeMs: 1,
    });
    if (name !== 'agent-run-resumed-final-output') {
      parent.toolCalls = 1;
      toolSteps.add(8);
    }
  }
  if (name === 'agent-run-budget-exhausted') parent.costMicros = limits.maxCostMicros;

  const claim = async (workUnitId: string) => {
    if (workUnitId === CHILD_WORK_ID && name === 'agent-run-delegation-child-execution-failed')
      throw fault();
    if (name === 'agent-run-nothing-queued') return { kind: 'nothing_queued' as const };
    return {
      kind: 'claimed' as const,
      agentRunId: workUnitId === CHILD_WORK_ID ? CHILD_RUN_ID : AGENT_RUN_ID,
      limits: { ...limits, maxDelegationDepth: workUnitId === CHILD_WORK_ID ? 0 : 1 },
      counters: { ...(workUnitId === CHILD_WORK_ID ? child : parent) },
      nextStepNumber: name.startsWith('agent-run-resumed-') ? 3 : 0,
    };
  };
  const activities: AgentActivities = {
    async claimAgentRun(input) {
      claims += 1;
      return claim(input.workUnitId);
    },
    async reclaimAgentRun(input) {
      reclaims += 1;
      if (name === 'agent-run-reclaim-denied') throw fault('INITIATOR_INACTIVE');
      if (name === 'agent-run-continued-resume') directive = 'continue';
      return claim(input.workUnitId);
    },
    async readResumePoint() {
      resumed += 1;
      if (name === 'agent-run-resumed-final-output')
        return { kind: 'model', outcome: 'final_output' };
      if (name === 'agent-run-resumed-tool-wait')
        return { kind: 'tool', outcome: 'needs_approval' };
      if (name === 'agent-run-resumed-next-step') return { kind: 'tool', outcome: 'done' };
      return { kind: 'none' };
    },
    readRunDirective: async (input) =>
      input.workUnitId === CHILD_WORK_ID ? 'continue' : directive,
    async runModelTurn(input) {
      modelCalls.push({ workUnitId: input.workUnitId, stepNumber: input.stepNumber });
      const isChild = input.workUnitId === CHILD_WORK_ID;
      if (
        !isChild &&
        (name === 'agent-run-stop-in-flight' ||
          name === 'agent-run-halt-in-flight' ||
          name === 'agent-run-workflow-cancelled')
      ) {
        const context = Context.current();
        const heartbeat = setInterval(() => context.heartbeat(), 50);
        modelStarted.resolve();
        try {
          return await context.cancelled;
        } finally {
          clearInterval(heartbeat);
          cancelled = true;
        }
      }
      if (name === 'agent-run-model-activity-failed') throw fault();
      const used = isChild ? child : parent;
      used.modelTurns += 1;
      used.inputTokens += 10;
      used.outputTokens += 5;
      used.costMicros += 1;
      used.activeMs += 1;
      let outcome: Awaited<ReturnType<AgentActivities['runModelTurn']>>['outcome'] = 'final_output';
      if (
        name === 'agent-run-model-unavailable' ||
        (isChild && name === 'agent-run-delegation-failure')
      )
        outcome = 'model_unavailable';
      else if (name === 'agent-run-invalid-output') outcome = 'invalid_output';
      else if (name === 'agent-run-policy-denied') outcome = 'policy_denied';
      else if (
        !isChild &&
        (name.startsWith('agent-run-tool-') || name.startsWith('agent-run-delegation-')) &&
        used.modelTurns === 1
      )
        outcome = 'tool_proposed';
      return { outcome, stopCode: null, counters: { ...used } };
    },
    async runToolCall(input) {
      toolCalls.push(input.stepNumber);
      toolSteps.add(input.stepNumber);
      parent.toolCalls = toolSteps.size;
      const delegation = name.startsWith('agent-run-delegation-')
        ? { ...AGENT_INPUT, workUnitId: CHILD_WORK_ID }
        : null;
      if (name === 'agent-run-tool-denied')
        return { outcome: 'denied', stopCode: null, counters: { ...parent }, delegation: null };
      // Reaching the budget during an approval must not turn unknown delivery into a budget outcome.
      if (name === 'agent-run-tool-approval-unknown') parent.costMicros = limits.maxCostMicros;
      return {
        outcome:
          name.startsWith('agent-run-tool-approval-') && toolCalls.length === 1
            ? 'needs_approval'
            : 'done',
        stopCode: null,
        counters: { ...parent },
        delegation,
      };
    },
    readToolWait: async () => wait,
    async setRunStatus(input) {
      if (input.workUnitId === AGENT_INPUT.workUnitId) moves.push(input.status);
    },
    async createChildRun() {
      const refused = name === 'agent-run-delegation-refused';
      return {
        outcome: refused ? 'denied' : 'done',
        stopCode: refused ? 'DELEGATION_DENIED' : null,
        counters: { ...parent },
        delegation: refused ? null : { ...AGENT_INPUT, workUnitId: CHILD_WORK_ID },
      };
    },
    async settleChildRun(input) {
      settlements.push(input.childRunId);
    },
    verifyRunOutput: async () =>
      name === 'agent-run-outcome-unverified' ? 'outcome_unverified' : 'completed',
    async finishAgentRun(input) {
      finishes.push(input);
    },
    closeQueuedRun: async () => {
      throw new Error('Unexpected queued-run closure');
    },
  };
  return {
    activities,
    parent,
    modelCalls,
    toolCalls,
    moves,
    finishes,
    settlements,
    modelStarted,
    reclaims: () => reclaims,
    claims: () => claims,
    resumed: () => resumed,
    cancelled: () => cancelled,
    setDirective: (value: RunDirective) => {
      directive = value;
    },
    setWait: (value: ToolWaitState) => {
      wait = value;
    },
  };
}

async function assertPath(path: Path, state: ReturnType<typeof harness>, handle: WorkflowHandle) {
  const { name } = path;
  if (name.endsWith('-in-flight') || name === 'agent-run-workflow-cancelled') {
    await state.modelStarted.promise;
    if (name === 'agent-run-workflow-cancelled') await handle.cancel();
    else {
      state.setDirective(name === 'agent-run-halt-in-flight' ? 'halted' : 'stop');
      await handle.signal(AGENT_RUN_CONTROL_SIGNAL);
    }
  } else if (name === 'agent-run-pause-resume' || name.startsWith('agent-run-tool-approval-')) {
    // Observe the real durable wait before signaling; an early signal cannot accidentally skip it.
    await waitForEvent(handle, 'EVENT_TYPE_TIMER_STARTED');
    if (name === 'agent-run-pause-resume') {
      state.setDirective('continue');
      await handle.signal(AGENT_RUN_CONTROL_SIGNAL);
    } else {
      state.setWait(
        name.endsWith('-done')
          ? 'done'
          : name.endsWith('-denied')
            ? 'denied'
            : 'unknown_external_state',
      );
      await handle.signal('approvalResolved');
    }
  }
  await expect(handle.result()).resolves.toEqual({
    workUnitId: AGENT_INPUT.workUnitId,
    agentRunId: path.status === 'nothing_queued' ? null : AGENT_RUN_ID,
    status: path.status,
  } satisfies AgentRunResult);
  const finish = state.finishes.find((call) => call.workUnitId === AGENT_INPUT.workUnitId);
  if (path.status === 'nothing_queued') expect(finish).toBeUndefined();
  else expect(finish).toMatchObject({ status: path.status, stopCode: path.stop });
  if (name.endsWith('-in-flight') || name === 'agent-run-workflow-cancelled')
    expect(state.cancelled()).toBe(true);
  if (name === 'agent-run-pause-resume')
    expect(state.moves).toEqual(['paused', 'running', 'verifying']);
  if (name === 'agent-run-tool-approval-done') {
    expect(state.toolCalls).toEqual([1, 1]);
    expect(state.parent.toolCalls).toBe(1);
  }
  if (name.startsWith('agent-run-delegation-') && name !== 'agent-run-delegation-refused') {
    expect(state.settlements).toEqual(
      name === 'agent-run-delegation-child-execution-failed' ? [] : [CHILD_RUN_ID],
    );
  }
  if (name.startsWith('agent-run-resumed-')) {
    expect(state.claims()).toBe(0);
    expect(state.reclaims()).toBe(1);
    expect(state.resumed()).toBe(1);
  }
  if (name === 'agent-run-resumed-next-step') expect(state.modelCalls[0]?.stepNumber).toBe(9);
  if (name === 'agent-run-resumed-tool-wait') {
    expect(state.toolCalls).toEqual([8]);
    expect(state.parent.toolCalls).toBe(1);
  }
  if (name.endsWith('-before-model') || name === 'agent-run-budget-exhausted')
    expect(state.modelCalls).toEqual([]);
}

describe.skipIf(!capturing)('capture the bounded agent workflow on real Temporal', () => {
  it('records terminal, wait, cancellation, delegation and resume paths with explicit controls', async () => {
    let state = harness('agent-run-completed');
    const activities = Object.fromEntries(
      Object.keys(state.activities).map((name) => [
        name,
        (...args: unknown[]) =>
          Reflect.apply(state.activities[name as keyof AgentActivities], state.activities, args),
      ]),
    );
    await withCaptureWorkers(
      {
        activities,
        queues: [`replay-agent-${randomUUID()}`, AGENT_TASK_QUEUE],
        heartbeatThrottleMs: 50,
      },
      async (run) => {
        for (const path of AGENT_RUN_HISTORIES) {
          if (
            path.name === 'agent-run-missing-model-activity' ||
            path.name === 'agent-run-continued-resume'
          )
            continue;
          state = harness(path.name);
          const carry: AgentRunCarry | undefined =
            path.name.startsWith('agent-run-resumed-') || path.name === 'agent-run-reclaim-denied'
              ? { agentRunId: AGENT_RUN_ID, nextStepNumber: 9 }
              : undefined;
          await run.record(path.name, {
            workflowType: 'agentRunWorkflow',
            args: carry ? [AGENT_INPUT, carry] : [AGENT_INPUT],
            afterStart: (handle) => assertPath(path, state, handle),
          });
        }
      },
    );
  }, 300000);

  it('records a genuinely unregistered model Activity and its bounded retry exhaustion', async () => {
    const path = AGENT_RUN_HISTORIES.find(
      (item) => item.name === 'agent-run-missing-model-activity',
    )!;
    const state = harness(path.name);
    const { runModelTurn: _missing, ...activities } = state.activities;
    await withCaptureWorkers(
      { activities, queues: [`replay-agent-missing-${randomUUID()}`, AGENT_TASK_QUEUE] },
      async (run) =>
        run.record(path.name, {
          workflowType: 'agentRunWorkflow',
          args: [AGENT_INPUT],
          afterStart: (handle) => assertPath(path, state, handle),
        }),
    );
  }, 120000);

  it('records genuine server-suggested continue-as-new and the resumed execution without production hooks', async () => {
    const firstFile = pathFile(AGENT_CONTINUE_HISTORY);
    const resumedFile = pathFile('agent-run-continued-resume');
    if (existsSync(firstFile) && existsSync(resumedFile)) return;
    if (existsSync(firstFile) || existsSync(resumedFile)) {
      throw new Error(
        'Incomplete continuation pair: preserve the existing history and recover its actual linked execution; never replace it with an unrelated capture',
      );
    }
    const state = harness('agent-run-continued-resume');
    await withCaptureWorkers(
      {
        activities: state.activities,
        queues: [`replay-agent-rollover-${randomUUID()}`, AGENT_TASK_QUEUE],
      },
      async (run) => {
        const connection = await Connection.connect({
          address: `127.0.0.1:${process.env.ENSEMUS_TEST_TEMPORAL_PORT ?? '57233'}`,
        });
        const client = new Client({
          connection,
          namespace: 'default',
          dataConverter: {
            payloadCodecs: [new AesGcmPayloadCodec(REPLAY_KEY)],
            failureConverterPath: FAILURE_CONVERTER,
          },
        });
        const workflowId = `replay-agent-rollover-${randomUUID()}`;
        const handle = await client.workflow.start('agentRunWorkflow', {
          args: [AGENT_INPUT],
          taskQueue: run.taskQueue,
          workflowId,
        });
        let completed = false;
        try {
          const firstRunId = (await handle.describe()).runId;
          await waitForEvent(handle, 'EVENT_TYPE_TIMER_STARTED');
          // Empty wake-ups obey the real signal contract: the scripted directive stays paused.
          // Bounded batches build genuine server history until its own suggestion triggers rollover.
          let signals = 0;
          const latest = client.workflow.getHandle(workflowId);
          while (state.reclaims() === 0 && signals < 20000) {
            const results = await Promise.allSettled(
              Array.from({ length: 32 }, () => latest.signal(AGENT_RUN_CONTROL_SIGNAL)),
            );
            signals += results.length;
            for (const result of results)
              if (result.status === 'rejected' && state.reclaims() === 0) throw result.reason;
          }
          await expect.poll(state.reclaims, { timeout: 30000, interval: 100 }).toBe(1);
          await expect(handle.result()).resolves.toMatchObject({
            status: 'completed',
            agentRunId: AGENT_RUN_ID,
          });
          const firstHistory = historyToJSON(
            await client.workflow.getHandle(workflowId, firstRunId).fetchHistory(),
          );
          expect(firstHistory).toContain('EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW');
          expect(firstHistory).toMatch(/"suggestContinueAsNew"\s*:\s*true/);
          const lastRunId = (await latest.describe()).runId;
          expect(lastRunId).not.toBe(firstRunId);
          const resumedHistory = historyToJSON(
            await client.workflow.getHandle(workflowId, lastRunId).fetchHistory(),
          );
          expect(resumedHistory).toContain('reclaimAgentRun');
          expect(resumedHistory).toContain('readResumePoint');
          if (!existsSync(firstFile)) writeFileSync(firstFile, firstHistory, { flag: 'wx' });
          if (!existsSync(resumedFile)) writeFileSync(resumedFile, resumedHistory, { flag: 'wx' });
          completed = true;
        } finally {
          if (!completed) {
            await handle.cancel().catch(() => undefined);
            await handle.result().catch(() => undefined);
          }
          await connection.close();
        }
      },
    );
  }, 600000);
});
