// Deterministic workflow code. Only @temporalio/workflow and types may be imported here, because
// this runs in a sandboxed VM and is replayed from history. Changing the order of steps below needs
// a patch, and the replay corpus in tests/replay fails the build if that is forgotten.
import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { Activities, PlatformActivities } from './activities';
import type {
  ProbeInput,
  ProbeResult,
  TenantInput,
  WorkInput,
  WorkOutcome,
  WorkResult,
} from './schemas';

const { recordProbeStep } = proxyActivities<PlatformActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export const releaseProbeSignal = defineSignal('releaseProbe');

/**
 * The deployment smoke test: proves workers poll, survive restarts, wait durably, take signals and
 * honor cancellation, with no business data involved.
 */
export async function platformProbeWorkflow(input: ProbeInput): Promise<ProbeResult> {
  let released = false;
  setHandler(releaseProbeSignal, () => {
    released = true;
  });
  await recordProbeStep(input.probeId, 'started');
  await condition(() => released);
  await recordProbeStep(input.probeId, 'finished');
  return { probeId: input.probeId, outcome: 'completed', steps: 2 };
}

const activities = proxyActivities<Activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
    nonRetryableErrorTypes: ['WORK_STOPPED'],
  },
});

/** Tells a waiting workflow that an approval was decided. It carries nothing: PostgreSQL has it. */
export const approvalResolvedSignal = defineSignal('approvalResolved');

const isStopped = (error: unknown) =>
  error instanceof ActivityFailure &&
  error.cause instanceof ApplicationFailure &&
  error.cause.type === 'WORK_STOPPED';

/**
 * The generic interpreter for a Work Unit's plan (ADR-024 D6). Business state stays in PostgreSQL,
 * and this holds only the order of steps, the waits, and IDs. If an Activity finds the work was
 * stopped by a person, the workflow ends without touching it further.
 */
export async function workUnitWorkflow(input: WorkInput): Promise<WorkResult> {
  const { workUnitId } = input;
  const finish = (outcome: WorkOutcome): WorkResult => ({ workUnitId, outcome });

  let decided = false;
  setHandler(approvalResolvedSignal, () => {
    decided = true;
  });

  try {
    const prepared = await activities.prepareWork(input);
    if (prepared.status === 'stopped') return finish('cancelled');

    await activities.produceChecklistArtifact(input);

    if (prepared.needsReview) {
      const review = await activities.requestReview(input);
      const remaining = review.expiresAtMs - Date.now();
      await condition(() => decided, remaining > 0 ? remaining : 1);

      let state = await activities.reviewState({ ...input, approvalId: review.approvalId });
      if (state === 'pending') {
        await activities.expireReview({ ...input, approvalId: review.approvalId });
        state = 'expired';
      }
      if (state === 'denied') return finish('denied');
      if (state !== 'approved') return finish('expired');
    }

    return finish(await activities.verifyAndComplete(input));
  } catch (error) {
    if (isCancellation(error)) throw error;
    if (isStopped(error)) return finish('cancelled');
    // Report the failure honestly. If even that fails, the workflow fails and stays visible.
    await CancellationScope.nonCancellable(() => activities.markFailed(input));
    return finish('failed');
  }
}

/** Raises one tenant's due reminders. A Temporal Schedule runs it, carrying the organization ID. */
export async function tenantRemindersWorkflow(input: TenantInput): Promise<void> {
  await activities.sendReminders(input);
}
