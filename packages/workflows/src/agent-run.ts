// Owned by the spine slice (AGENT-02, AI-13). See docs/06-delivery/m4-slices.md and ADR-028 FD-1, FD-2, FD-7,
// FD-12, FD-16 and FD-22. Deterministic workflow code: only @temporalio/workflow, types, constants.ts and
// @ensemus/agent-runtime/reducer, which imports nothing, may be imported here. Approval waits last days
// across upgrades, so changing the order of steps below needs `patched`, and the corpus fails if it is
// forgotten.
import {
  decideNext,
  stopForDirective,
  stopForFailure,
  type LastStep,
  type RunStop,
} from '@ensemus/agent-runtime/reducer';
import {
  ActivityCancellationType,
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  ChildWorkflowFailure,
  condition,
  ContinueAsNew,
  continueAsNew,
  defineSignal,
  executeChild,
  isCancellation,
  ParentClosePolicy,
  proxyActivities,
  setHandler,
  TimeoutFailure,
  workflowInfo,
} from '@temporalio/workflow';
import type { AgentActivities } from './agent-activities';
import type {
  AgentRunCarry,
  AgentRunInput,
  AgentRunResult,
  ClaimResult,
  FinishRunInput,
  RunDirective,
  RunRef,
} from './agent-schemas';
import {
  AGENT_RUN_CONTROL_SIGNAL,
  AGENT_SCHEDULE_TO_START,
  AGENT_TASK_QUEUE,
  TOOL_WAIT_POLL,
} from './constants';

/** A wake-up to look at `ai.run_controls`. It carries nothing: PostgreSQL has the answer. */
export const agentRunControlSignal = defineSignal(AGENT_RUN_CONTROL_SIGNAL);
/** Sent for any approval on this Work Unit. It carries nothing either. Same name as in workflows.ts. */
export const agentApprovalResolvedSignal = defineSignal('approvalResolved');

// Everything goes to agent-worker's queue (FD-2), and if nothing picks it up within the limit the run says
// so. A schedule-to-start timeout is never retried, so it surfaces here at once. A database outage must
// not end a run, so these retry for a day, and a refusal says it is final by itself.
const onAgentQueue = {
  taskQueue: AGENT_TASK_QUEUE,
  scheduleToStartTimeout: AGENT_SCHEDULE_TO_START,
  // So a cancel never leaves the workflow going on while an Activity is still writing.
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
} as const;
const retryThroughOutage = { initialInterval: '1 second', maximumInterval: '1 minute' } as const;

const database = proxyActivities<AgentActivities>({
  ...onAgentQueue,
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '24 hours',
  retry: retryThroughOutage,
});

// A heartbeat is how a cancel reaches the call, and how a dead worker is noticed. A retry goes through the
// durable step row (FD-12), so it never repeats a finished turn, and an estimate is charged for a lost
// one. Attempts stay few because each lost one may have cost money.
const modelCalls = proxyActivities<AgentActivities>({
  ...onAgentQueue,
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { initialInterval: '2 seconds', maximumInterval: '1 minute', maximumAttempts: 4 },
});

// The gateway finds its own earlier work by run and step, so these may retry. M3 does any sending.
const toolCalls = proxyActivities<AgentActivities>({
  ...onAgentQueue,
  startToCloseTimeout: '5 minutes',
  scheduleToCloseTimeout: '1 hour',
  retry: retryThroughOutage,
});

// Only the agent role can end a run (ADR-028). When no agent-worker is there at all, this waits for one
// to come back, and if none does, the upkeep sweep closes a claimed run as STRANDED.
const closing = proxyActivities<AgentActivities>({
  ...onAgentQueue,
  scheduleToStartTimeout: '24 hours',
  scheduleToCloseTimeout: '48 hours',
  startToCloseTimeout: '2 minutes',
  retry: retryThroughOutage,
});

const isWorkerAbsent = (error: unknown) =>
  error instanceof ActivityFailure &&
  error.cause instanceof TimeoutFailure &&
  error.cause.timeoutType === 'SCHEDULE_TO_START';

/** What an Activity's failure says about itself. Only a type crosses: no message, no provider text. */
function failureCode(error: unknown): string | null {
  if (isWorkerAbsent(error)) return 'WORKER_UNAVAILABLE';
  if (error instanceof ActivityFailure && error.cause instanceof ApplicationFailure) {
    return error.cause.type ?? null;
  }
  return null;
}

/**
 * Standard ID (FD-1), so approval.resolved and work.stop_requested reach a child unchanged, and the upkeep
 * sweep probes the right thing. schemas.ts has the same line, and cannot be imported here: a test holds
 * them equal.
 */
const childWorkflowId = (input: AgentRunInput) =>
  `work-${input.organizationId}-${input.workUnitId}`;

/**
 * The bounded loop. Runs under the Work Unit's standard workflow ID, with Activities on the agent queue.
 * Each pass reads what PostgreSQL says, asks the reducer what comes next, and does that one thing. Time in
 * waits and pauses counts for nothing: `activeMs` only grows inside the Activities (FD-22).
 */
export async function agentRunWorkflow(
  input: AgentRunInput,
  carry?: AgentRunCarry,
): Promise<AgentRunResult> {
  const { organizationId, workUnitId } = input;
  const temporalRunId = workflowInfo().runId;

  let woken = false;
  const wake = () => {
    woken = true;
  };
  setHandler(agentRunControlSignal, wake);
  setHandler(agentApprovalResolvedSignal, wake);

  // --- Claim. A continued run takes its own hold over first, so the upkeep sweep never finds it closed.
  let claim: ClaimResult;
  try {
    claim = carry
      ? await database.reclaimAgentRun({
          organizationId,
          workUnitId,
          agentRunId: carry.agentRunId,
          temporalRunId,
        })
      : await database.claimAgentRun({ organizationId, workUnitId, temporalRunId });
  } catch (error) {
    const stopCode = isCancellation(error)
      ? ('WORK_STOPPED' as const)
      : ('WORKER_UNAVAILABLE' as const);
    if (carry) {
      // A claimed run has a row to end, so it goes through the ordinary path.
      const stop = isCancellation(error)
        ? stopForFailure('WORK_STOPPED')
        : stopForFailure(failureCode(error));
      const status = await finish(
        { organizationId, workUnitId, agentRunId: carry.agentRunId, temporalRunId },
        stop,
      );
      return { workUnitId, agentRunId: carry.agentRunId, status };
    }
    if (!isCancellation(error) && !isWorkerAbsent(error)) throw error;
    try {
      await CancellationScope.nonCancellable(() =>
        closing.closeQueuedRun({ organizationId, workUnitId, temporalRunId, stopCode }),
      );
    } catch (closeError) {
      if (!isWorkerAbsent(closeError)) throw closeError;
    }
    return { workUnitId, agentRunId: null, status: isCancellation(error) ? 'cancelled' : 'failed' };
  }
  if (claim.kind === 'nothing_queued') {
    return { workUnitId, agentRunId: carry?.agentRunId ?? null, status: 'nothing_queued' };
  }

  const { agentRunId, limits } = claim;
  const ref: RunRef = { organizationId, workUnitId, agentRunId, temporalRunId };
  const result = (status: AgentRunResult['status']): AgentRunResult => ({
    workUnitId,
    agentRunId,
    status,
  });

  let counters = claim.counters;
  let nextStep = Math.max(claim.nextStepNumber, carry?.nextStepNumber ?? 0);
  // The step a wait belongs to. After continue-as-new, that is the last one written.
  let toolStep = nextStep - 1;
  let last: LastStep = { kind: 'none' };
  /** A code the last step gave, which says more than the reducer's general one for that outcome. */
  let lastStopCode: string | null = null;
  /** While waiting, an absent worker only means nobody can look yet. It holds nothing, so wait on. */
  let waiting = false;
  /** A stop found while a call was out, which is why that call was cancelled. */
  let stopFound: 'stop' | 'halted' | null = null;
  /** Unknown after continue-as-new, and setting it twice does nothing. */
  let status: FinishRunInput['status'] | RunStatusMove | 'preparing' | null = carry
    ? null
    : 'preparing';

  const moveTo = async (to: RunStatusMove) => {
    if (status === to) return;
    await database.setRunStatus({ ...ref, status: to });
    status = to;
  };

  const readDirective = async (): Promise<RunDirective> => {
    try {
      return await database.readRunDirective(ref);
    } catch (error) {
      if (waiting && isWorkerAbsent(error)) return status === 'paused' ? 'pause' : 'continue';
      throw error;
    }
  };

  const carryOn = (): Promise<never> =>
    continueAsNew<typeof agentRunWorkflow>(input, { agentRunId, nextStepNumber: nextStep });

  /**
   * Runs a call that can be aborted. A signal only says to look, so this looks, and only what PostgreSQL
   * says cancels the call. The Activity's cancellation signal then reaches the adapter (ADR-024 D3).
   */
  const abortable = async <T>(call: () => Promise<T>): Promise<T> => {
    const scope = new CancellationScope();
    let settled = false;
    const watcher = (async () => {
      try {
        for (;;) {
          await condition(() => woken || settled);
          if (settled) return;
          woken = false;
          const directive = await database.readRunDirective(ref);
          if (directive === 'stop' || directive === 'halted') {
            stopFound = directive;
            scope.cancel();
            return;
          }
        }
      } catch {
        // The loop reads this again itself as soon as the call is over. Nothing is lost by not knowing yet.
      }
    })();
    try {
      return await scope.run(call);
    } finally {
      settled = true;
      await watcher;
    }
  };

  try {
    if (carry) last = await database.readResumePoint(ref);

    for (;;) {
      if (stopFound) return result(await finish(ref, stopForDirective(stopFound)));

      // Cleared before reading, so a signal arriving after the read still wakes the wait below.
      woken = false;
      const directive = await readDirective();
      if (directive === 'stop' || directive === 'halted') {
        return result(await finish(ref, stopForDirective(directive)));
      }
      if (directive === 'pause') {
        await moveTo('paused');
        waiting = true;
        // A child not started yet is the one thing the step rows cannot show, so that waits to continue.
        const asksForChild = last.kind === 'tool' && last.outcome === 'delegate';
        if (workflowInfo().continueAsNewSuggested && !asksForChild) await carryOn();
        await condition(() => woken, TOOL_WAIT_POLL);
        continue;
      }

      const next = decideNext({ counters, limits }, last);
      switch (next.kind) {
        case 'stop':
          return result(await finish(ref, { ...next, stopCode: lastStopCode ?? next.stopCode }));

        case 'verify': {
          await moveTo('verifying');
          const verdict = await database.verifyRunOutput(ref);
          return result(
            await finish(
              ref,
              verdict === 'completed'
                ? { status: 'completed', stopCode: '' }
                : { status: 'outcome_unverified', stopCode: 'OUTPUT_UNVERIFIED' },
            ),
          );
        }

        case 'wait_for_tool': {
          await moveTo('waiting_for_approval');
          waiting = true;
          if (workflowInfo().continueAsNewSuggested) await carryOn();
          let state: Awaited<ReturnType<AgentActivities['readToolWait']>> = 'waiting';
          try {
            state = await database.readToolWait({ ...ref, stepNumber: toolStep });
          } catch (error) {
            if (!isWorkerAbsent(error)) throw error;
          }
          if (state === 'waiting') {
            await condition(() => woken, TOOL_WAIT_POLL);
          } else {
            waiting = false;
            last = { kind: 'wait', state };
          }
          continue;
        }

        case 'model_turn': {
          waiting = false;
          if (workflowInfo().continueAsNewSuggested) await carryOn();
          await moveTo('running');
          const stepNumber = nextStep++;
          const turn = await abortable(() => modelCalls.runModelTurn({ ...ref, stepNumber }));
          counters = turn.counters;
          lastStopCode = turn.stopCode;
          last = { kind: 'model', outcome: turn.outcome };
          continue;
        }

        case 'tool_call': {
          waiting = false;
          if (workflowInfo().continueAsNewSuggested) await carryOn();
          await moveTo('running');
          // After a wait this is the same step going back for its receipt, which is not a new call.
          if (last.kind !== 'wait') toolStep = nextStep++;
          const stepNumber = toolStep;
          const call = await abortable(() => toolCalls.runToolCall({ ...ref, stepNumber }));
          counters = call.counters;
          lastStopCode = call.stopCode;
          last = { kind: 'tool', outcome: call.delegation ? 'delegate' : call.outcome };
          continue;
        }

        case 'start_child': {
          waiting = false;
          const created = await toolCalls.createChildRun({ ...ref, stepNumber: toolStep });
          counters = created.counters;
          lastStopCode = created.stopCode;
          if (!created.delegation) {
            last = { kind: 'tool', outcome: created.outcome };
            continue;
          }
          await moveTo('waiting_for_child');
          const childInput = created.delegation;
          lastStopCode = null;
          // Native, so cancelling this cancels that, and closing this asks it to stop (FD-16). This never
          // continues as new while a child runs: the wait uses no timers, so history barely grows.
          let childStatus: string;
          let childRunId: string | null = null;
          try {
            const finished = await abortable(() =>
              executeChild<typeof agentRunWorkflow>('agentRunWorkflow', {
                args: [childInput],
                workflowId: childWorkflowId(childInput),
                parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
              }),
            );
            childStatus = finished.status;
            childRunId = finished.agentRunId;
          } catch (error) {
            const parentStopped =
              stopFound !== null || CancellationScope.current().consideredCancelled;
            if (parentStopped || !(error instanceof ChildWorkflowFailure)) throw error;
            childStatus = 'failed';
          }
          if (childRunId) {
            await database.settleChildRun({ ...ref, stepNumber: toolStep, childRunId });
          }
          last = { kind: 'child', status: childStatus };
          continue;
        }
      }
    }
  } catch (error) {
    if (error instanceof ContinueAsNew) throw error;
    if (stopFound) return result(await finish(ref, stopForDirective(stopFound)));
    // A cancel comes from work.stop_requested, so the work itself was stopped.
    if (isCancellation(error)) return result(await finish(ref, stopForFailure('WORK_STOPPED')));
    return result(await finish(ref, stopForFailure(failureCode(error))));
  }
}

type RunStatusMove =
  'running' | 'paused' | 'waiting_for_approval' | 'waiting_for_child' | 'verifying';

/**
 * Writes the end, whatever is happening to this workflow, so a stop can never leave a run saying it is
 * running. If no worker comes back to write it, this still reports what happened, and the upkeep sweep
 * closes the row once this workflow has closed. Any other failure fails the workflow, where it stays visible.
 */
async function finish(
  ref: RunRef,
  stop: Pick<RunStop, 'status' | 'stopCode'> | { status: 'completed'; stopCode: '' },
): Promise<FinishRunInput['status']> {
  const status = stop.status as FinishRunInput['status'];
  try {
    await CancellationScope.nonCancellable(() =>
      closing.finishAgentRun({
        ...ref,
        status,
        stopCode: stop.stopCode === '' ? null : stop.stopCode,
      }),
    );
  } catch (error) {
    if (!isWorkerAbsent(error)) throw error;
  }
  return status;
}
