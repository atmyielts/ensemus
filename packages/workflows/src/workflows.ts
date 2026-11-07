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
  patched,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import type { Activities, PlatformActivities } from './activities';
import { reviewWaitStep, reviewWaitOutcome } from './review-wait';
import type {
  ProbeInput,
  ProbeResult,
  ReviewState,
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

// A database outage must not end work. These retry through any outage shorter than a day, and only
// a deterministic refusal, which can never succeed by retrying, reaches the failure path early. The
// retry policy is not part of history, so changing it needs no patch.
const activities = proxyActivities<Activities>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '24 hours',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '1 minute',
    nonRetryableErrorTypes: ['WORK_STOPPED', 'AppError'],
  },
});

/** Tells a waiting workflow that an approval was decided. It carries nothing: PostgreSQL has it. */
export const approvalResolvedSignal = defineSignal('approvalResolved');

const isStopped = (error: unknown) =>
  error instanceof ActivityFailure &&
  error.cause instanceof ApplicationFailure &&
  error.cause.type === 'WORK_STOPPED';

/** How long to wait before asking again whether an overdue approval has really been settled. */
const SETTLE_RETRY = '5 seconds';

/**
 * The generic interpreter for a Work Unit's plan (ADR-024 D6). Business state stays in PostgreSQL,
 * and this holds only the order of steps, the waits, and IDs. If an Activity finds the work was
 * stopped by a person, the workflow ends without touching it further.
 */
export async function workUnitWorkflow(input: WorkInput): Promise<WorkResult> {
  const { workUnitId } = input;
  const finish = (outcome: WorkOutcome): WorkResult => ({ workUnitId, outcome });
  // Which run this is, so an Activity only acts on work this run actually claimed.
  const run = { ...input, runId: workflowInfo().runId };

  let decided = false;
  setHandler(approvalResolvedSignal, () => {
    decided = true;
  });

  try {
    const prepared = await activities.prepareWork(run);
    if (prepared.status === 'stopped') return finish('cancelled');

    await activities.produceChecklistArtifact(run);

    if (prepared.needsReview) {
      const review = await activities.requestReview(run);
      const approval = { ...run, approvalId: review.approvalId };

      if (patched('review-wait-loop')) {
        // A wake-up says only that some approval moved, so the answer always comes from PostgreSQL.
        // The flag is cleared before reading, so a signal arriving after the read still wakes this.
        let state: ReviewState;
        for (;;) {
          decided = false;
          state = await activities.reviewState(approval);
          const step = reviewWaitStep(state, review.expiresAtMs, Date.now());
          if (step.kind === 'done') break;
          if (step.kind === 'wait') {
            await condition(() => decided, step.ms);
            continue;
          }
          // Overdue by this workflow's clock. The answer is whatever the locked transaction found.
          state = await activities.expireReview(approval);
          if (state !== 'pending') break;
          // The worker's clock is behind, or the transaction lost a race. Nothing has been decided,
          // so nothing is reported yet.
          await sleep(SETTLE_RETRY);
        }
        const outcome = reviewWaitOutcome(state);
        if (outcome) return finish(outcome);
      } else {
        // Histories recorded before the loop above replay through this path, unchanged.
        const remaining = review.expiresAtMs - Date.now();
        await condition(() => decided, remaining > 0 ? remaining : 1);

        let state = await activities.reviewState(approval);
        if (state === 'pending') {
          await activities.expireReview(approval);
          state = 'expired';
        }
        if (state === 'denied') return finish('denied');
        if (state !== 'approved') return finish('expired');
      }
    }

    return finish(await activities.verifyAndComplete(run));
  } catch (error) {
    if (isCancellation(error)) throw error;
    if (isStopped(error)) return finish('cancelled');
    // Report the failure honestly. If even that fails, the workflow fails and stays visible.
    await CancellationScope.nonCancellable(() => activities.markFailed(run));
    return finish('failed');
  }
}

/** Raises one tenant's due reminders. A Temporal Schedule runs it, carrying the organization ID. */
export async function tenantRemindersWorkflow(input: TenantInput): Promise<void> {
  await activities.sendReminders(input);
}

// M3 (ADR-027). Each in its own file, so a change there cannot disturb the histories above.
export { connectorSyncWorkflow } from './connector-sync-workflow';
export { externalActionWorkflow } from './external-action-workflow';
export { webhookDeliveryWorkflow } from './webhook-workflow';

// M4 (ADR-028). The same rule: their own files, their own histories.
export { agentRunWorkflow } from './agent-run';
export { modelProbeWorkflow } from './model-probe';
// M5 (ADR-029). The same.
export { clientOnboardingWorkflow } from './client-onboarding-workflow';
export { knowledgeAnswerWorkflow } from './knowledge-answer-workflow';
export { knowledgeIngestWorkflow } from './knowledge-ingest-workflow';
export { knowledgePurgeWorkflow } from './knowledge-purge-workflow';
export { knowledgeSweepWorkflow } from './knowledge-sweep-workflow';
export { knowledgeModelJobWorkflow } from './knowledge-model-job-workflow';
