// Deterministic workflow code (ADR-027 D2). Only @temporalio/workflow and types may be imported here, plus
// the pure step module and the queue names. The order of steps is in external-action-step.ts, and changing
// it needs a patch: the replay corpus fails the build if that is forgotten.
import {
  ActivityFailure,
  CancellationScope,
  proxyActivities,
  sleep,
  TimeoutFailure,
  workflowInfo,
} from '@temporalio/workflow';
import { CONNECTOR_TASK_QUEUE } from './constants';
import { runExternalAction } from './external-action-step';
import type {
  ExternalActionConnectorActivities,
  ExternalActionPlatformActivities,
} from './external-action-activities';
import type { ExternalActionInput, ExternalActionResult } from './schemas';

// No retries, ever. A lost answer goes through inspectInterruptedAction, never through a blind second send.
const { sendExternalAction } = proxyActivities<ExternalActionConnectorActivities>({
  taskQueue: CONNECTOR_TASK_QUEUE,
  startToCloseTimeout: '2 minutes',
  scheduleToStartTimeout: '1 hour',
  retry: { maximumAttempts: 1 },
});

// Read-only at the provider, so this retries. It gives up eventually, because a connector worker that never
// comes back must not leave someone looking at "sending" for ever.
const { reconcileExternalAction } = proxyActivities<ExternalActionConnectorActivities>({
  taskQueue: CONNECTOR_TASK_QUEUE,
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '1 hour',
  retry: {
    initialInterval: '5 seconds',
    maximumInterval: '1 minute',
    nonRetryableErrorTypes: ['AppError'],
  },
});

// These only touch PostgreSQL, so they ride out a database outage the way the work workflow does.
const platform = proxyActivities<ExternalActionPlatformActivities>({
  startToCloseTimeout: '30 seconds',
  scheduleToCloseTimeout: '24 hours',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '1 minute',
    nonRetryableErrorTypes: ['AppError'],
  },
});

const neverPickedUp = (error: unknown) =>
  error instanceof ActivityFailure &&
  error.cause instanceof TimeoutFailure &&
  error.cause.timeoutType === 'SCHEDULE_TO_START';

/**
 * Takes one approved intent to sent, failed, unknown or cancelled. Nothing can cancel it partway: a send
 * whose answer nobody waits for is exactly the gap this exists to close, so a cancellation is ignored and
 * the steps finish. A stop reaches the send through the recheck in PostgreSQL, not through this.
 */
export async function externalActionWorkflow(
  input: ExternalActionInput,
): Promise<ExternalActionResult> {
  const run = { ...input, runId: workflowInfo().runId };
  const outcome = await CancellationScope.nonCancellable(() =>
    runExternalAction({
      send: () => sendExternalAction(run),
      inspect: () => platform.inspectInterruptedAction(input),
      reconcile: (code) => reconcileExternalAction({ ...input, code }),
      concludeWithoutAnswer: (code) => platform.concludeWithoutAnswer({ ...input, code }),
      failUnsent: (code) => platform.failUnsentAction({ ...input, code }),
      outcome: () => platform.settledActionOutcome(input),
      sleep: (ms) => sleep(ms),
      neverPickedUp,
    }),
  );
  return { externalActionId: input.externalActionId, outcome };
}
