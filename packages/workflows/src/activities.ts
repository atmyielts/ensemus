// Activities do all I/O for workflows. Each one takes IDs, works out its state from PostgreSQL, and
// is safe to retry: a repeated call finds the work already done and does nothing new.
import {
  addArtifact,
  applyTransition,
  closeOutdatedReviews,
  createApprovalInTx,
  currentReviewAction,
  expireApprovalStatus,
  expireOverdueApprovals,
  failRun,
  listHeldRuns,
  loadChangeable,
  purgeDueBlobs,
  purgeExpiredExports,
  purgeExpiredWebhookDeliveries,
  recordApprovalClosed,
  reissueStaleRunRequests,
  REVIEW_HOURS,
  sendDueReminders,
  type SweepCursor,
  type ObjectStore,
} from '@ensemus/application';
import {
  approvals,
  artifacts,
  withTenantTx,
  workArtifacts,
  type AppDatabase,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { isTerminal, type CompletionCriterion, type WorkState } from '@ensemus/domain/work-unit';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { ApplicationFailure } from '@temporalio/common';
import { and, eq } from 'drizzle-orm';
import type {
  PreparedWork,
  ProbeStep,
  ReviewRequest,
  ReviewState,
  RunInput,
  TenantInput,
  WorkOutcome,
} from './schemas';

const log = createLogger('worker');
const CHECKLIST_NAME = 'completion-checklist.md';
/** Work a run holds is only checked once nothing has happened on it for this long. */
const QUIET_RUN_MS = 15 * 60 * 1000;
/** A request nothing has claimed after this long has probably met a run that cannot claim it. */
const UNCLAIMED_REQUEST_MS = 5 * 60 * 1000;
/** How long one sweep keeps asking Temporal, well inside the Activity's 2 minutes. */
const RECONCILE_BUDGET_MS = 45 * 1000;

const CRITERION_WORDS: Record<CompletionCriterion['kind'], string> = {
  artifact_exists: 'Someone attaches the file that shows the result.',
  reviewer_approved: 'A reviewer approves this work as it stands.',
  external_receipt: 'The outside system confirms it happened.',
};

export async function recordProbeStep(probeId: string, step: ProbeStep): Promise<void> {
  log.info('probe.step', { probeId, step });
}

export type PlatformActivities = { recordProbeStep: typeof recordProbeStep };

const stopped = () =>
  ApplicationFailure.create({ type: 'WORK_STOPPED', message: 'Work stopped', nonRetryable: true });

export type WorkflowProbe = (input: {
  organizationId: string;
  workUnitId: string;
  runId: string;
}) => Promise<'open' | 'closed'>;

export function createActivities(deps: {
  database: AppDatabase;
  store: ObjectStore;
  /** Asks Temporal whether a run is still open. Without one, stranded work is left for later. */
  probeWorkflow?: WorkflowProbe;
}) {
  const { database, store, probeWorkflow } = deps;
  const context = (input: { organizationId: string }) => createServiceContext(input.organizationId);

  const load = (input: RunInput) =>
    withTenantTx(database, context(input), (tx) =>
      loadChangeable(tx, context(input), input.workUnitId),
    );

  /**
   * Ends the hold of runs Temporal says are over, so no work sits in progress with nothing behind it.
   * It goes through every held run, since most are reviews waiting properly and could otherwise fill
   * the batch for ever, and stops when its time is up. The next sweep starts again.
   */
  async function reconcileStrandedRuns(input: TenantInput, now: Date) {
    if (!probeWorkflow) return 0;
    const ctx = context(input);
    const stopAt = Date.now() + RECONCILE_BUDGET_MS;
    const quietSince = new Date(now.getTime() - QUIET_RUN_MS);
    let failed = 0;
    let after: SweepCursor | undefined;
    do {
      const page: Awaited<ReturnType<typeof listHeldRuns>> = await listHeldRuns(
        database,
        ctx,
        quietSince,
        { after },
      );
      for (const { id, runId } of page.items) {
        if (Date.now() > stopAt) return failed;
        if (!runId) continue;
        const state = await probeWorkflow({ ...input, workUnitId: id, runId });
        if (state === 'open') continue;
        await withTenantTx(database, ctx, async (tx) => {
          const work = await loadChangeable(tx, ctx, id);
          // Rechecked under the lock: it may have moved on since the list was read.
          if (work.runId !== runId) return;
          await failRun(tx, ctx, work);
          failed += 1;
          log.warn('work.run_stranded', { workUnitId: id, status: work.status });
        });
      }
      after = page.next ?? undefined;
    } while (after);
    return failed;
  }

  return {
    recordProbeStep,

    /**
     * Claims ready work for this run, but only if someone asked for a run and that request still
     * stands. Finding it running under this same run means a retry, so carry on. Anything else, such
     * as a person having started it by hand, is not this run's to touch.
     */
    async prepareWork(input: RunInput): Promise<PreparedWork> {
      const ctx = context(input);
      return withTenantTx(database, ctx, async (tx) => {
        const work = await loadChangeable(tx, ctx, input.workUnitId);
        const needsReview = (work.completionCriteria as CompletionCriterion[]).some(
          (criterion) => criterion.kind === 'reviewer_approved',
        );
        if (work.status === 'ready' && work.runRequestedAt) {
          await applyTransition(tx, ctx, work, 'running', { runId: input.runId });
          return { status: 'running', needsReview };
        }
        if (work.status === 'running' && work.runId === input.runId) {
          return { status: 'running', needsReview };
        }
        return { status: 'stopped', needsReview };
      });
    },

    /**
     * Produces the plan's deterministic artifact, on work this run holds. A retry finds it and adds
     * nothing, and an attempt still in flight after a timeout loses to whichever attached it first.
     */
    async produceChecklistArtifact(input: RunInput): Promise<{ artifactId: string }> {
      const work = await load(input);
      const held = (row: { status: string; runId: string | null }) =>
        row.status === 'running' && row.runId === input.runId;
      if (!held(work)) throw stopped();
      const ctx = context(input);
      const [existing] = await withTenantTx(database, ctx, (tx) =>
        tx
          .select({ id: artifacts.id })
          .from(workArtifacts)
          .innerJoin(artifacts, eq(artifacts.id, workArtifacts.artifactId))
          .where(and(eq(workArtifacts.workUnitId, work.id), eq(artifacts.name, CHECKLIST_NAME))),
      );
      if (existing) return { artifactId: existing.id };
      const criteria = work.completionCriteria as CompletionCriterion[];
      const body = [
        `# Completion checklist`,
        '',
        'Ensemus wrote this list. It has not checked any of this, and this file is not evidence.',
        'A person decides when this work is done.',
        '',
        `Work: ${work.id}`,
        '',
        ...(criteria.length
          ? criteria.map((criterion) => `- [ ] ${CRITERION_WORDS[criterion.kind]}`)
          : ['- [ ] The accountable owner confirms the outcome. No evidence was asked for.']),
        '',
      ].join('\n');
      const { id } = await addArtifact(database, store, ctx, {
        workUnitId: work.id,
        name: CHECKLIST_NAME,
        mimeType: 'text/markdown',
        body: Buffer.from(body),
        onlyOnce: true,
        stillAllowed: (row) => {
          if (!held(row)) throw stopped();
        },
      });
      return { artifactId: id };
    },

    /**
     * Asks the reviewer chosen when the plan was run. A retry finds this run's own request by run ID,
     * whatever has happened to the files since. Nothing from an earlier run is ever reused.
     */
    async requestReview(input: RunInput): Promise<ReviewRequest> {
      const ctx = context(input);
      return withTenantTx(database, ctx, async (tx) => {
        const work = await loadChangeable(tx, ctx, input.workUnitId);
        const [own] = await tx
          .select({ id: approvals.id, expiresAt: approvals.expiresAt })
          .from(approvals)
          .where(and(eq(approvals.workUnitId, work.id), eq(approvals.runId, input.runId)));
        if (own) return { approvalId: own.id, expiresAtMs: own.expiresAt.getTime() };
        if (work.status !== 'running' || work.runId !== input.runId) throw stopped();

        // A review someone asked for by hand before the plan started does not replace this one.
        const superseded = await tx
          .update(approvals)
          .set({ status: 'cancelled', decidedAt: new Date() })
          .where(and(eq(approvals.workUnitId, work.id), eq(approvals.status, 'pending')))
          .returning({ id: approvals.id, requestedBy: approvals.requestedByMembershipId });
        for (const { id, requestedBy } of superseded) {
          await recordApprovalClosed(tx, ctx, work, id, {
            reason: 'PLAN_STARTED',
            kind: 'approval.superseded',
            tell: [requestedBy],
          });
        }
        const expiresAt = new Date(Date.now() + REVIEW_HOURS * 60 * 60 * 1000);
        const created = await createApprovalInTx(tx, ctx, {
          workUnitId: work.id,
          action: await currentReviewAction(tx, work),
          approverMembershipId: work.planReviewerMembershipId ?? work.ownerMembershipId,
          requestedByMembershipId: work.runRequestedByMembershipId,
          runId: input.runId,
          expiresAt,
        });
        return { approvalId: created.id, expiresAtMs: expiresAt.getTime() };
      });
    },

    async reviewState(input: RunInput & { approvalId: string }): Promise<ReviewState> {
      const ctx = context(input);
      const [row] = await withTenantTx(database, ctx, (tx) =>
        tx
          .select({ status: approvals.status })
          .from(approvals)
          .where(eq(approvals.id, input.approvalId)),
      );
      return (row?.status ?? 'cancelled') as ReviewState;
    },

    /** Expires the approval if it really is overdue, and reports the status it ended up with. */
    async expireReview(input: RunInput & { approvalId: string }): Promise<ReviewState> {
      const status = await expireApprovalStatus(database, context(input), {
        approvalId: input.approvalId,
      });
      return status as ReviewState;
    },

    /**
     * Sends the work for checking, and stops there. Despite the name, which workflow histories have
     * recorded and which therefore stays, this never completes anything. A person does that: a plan
     * that generated a checklist has not shown that anything was done. Evidence is worked out when
     * they press Mark done, so a review that no longer covers the work is refused at that point.
     */
    async verifyAndComplete(input: RunInput): Promise<WorkOutcome> {
      const ctx = context(input);
      return withTenantTx(database, ctx, async (tx) => {
        const work = await loadChangeable(tx, ctx, input.workUnitId);
        if (work.status === 'completed') return 'completed';
        if (work.status === 'verifying') return 'verifying';
        if (work.status !== 'running' || work.runId !== input.runId) return 'cancelled';
        const checking = await applyTransition(tx, ctx, work, 'verifying');
        await closeOutdatedReviews(tx, ctx, checking);
        return 'verifying';
      });
    },

    /** Reports failure truthfully, on work this run was responsible for. Anything else is left be. */
    async markFailed(input: RunInput): Promise<void> {
      const ctx = context(input);
      await withTenantTx(database, ctx, async (tx) => {
        const work = await loadChangeable(tx, ctx, input.workUnitId);
        const status = work.status as WorkState;
        const isOurs = work.runId === input.runId || (status === 'ready' && work.runRequestedAt);
        if (isOurs) await failRun(tx, ctx, work);
        log.warn('work.failed', {
          workUnitId: work.id,
          status: isTerminal(status) ? 'final' : status,
        });
      });
    },

    /**
     * One tenant's periodic upkeep, which is why this one Activity does several jobs. Adding Activities
     * to a scheduled workflow would need a patch for no gain: nothing here depends on their order. One
     * job failing does not stop the others. It is logged, and fails the Activity so that it is retried.
     */
    async sendReminders(input: TenantInput): Promise<number> {
      const ctx = context(input);
      const now = new Date();
      const failures: unknown[] = [];
      const attempt = async <T>(job: () => Promise<T>, otherwise: T) => {
        try {
          return await job();
        } catch (error) {
          failures.push(error);
          log.error('reminders.failed', { errorCode: errorCode(error) });
          return otherwise;
        }
      };
      await attempt(() => expireOverdueApprovals(database, ctx, now), 0);
      await attempt(() => reconcileStrandedRuns(input, now), 0);
      await attempt(
        () =>
          reissueStaleRunRequests(database, ctx, new Date(now.getTime() - UNCLAIMED_REQUEST_MS)),
        0,
      );
      const reminders = await attempt(() => sendDueReminders(database, ctx, now), 0);
      // Last, because a store that hangs is the slowest way any of this can fail.
      const blobs = await attempt(() => purgeDueBlobs(database, store, ctx, now), {
        purged: 0,
        failed: 0,
      });
      if (blobs.failed > 0) log.warn('blobs.purge_failed', { count: blobs.failed });
      await attempt(() => purgeExpiredWebhookDeliveries(database, ctx, now), 0);
      await attempt(() => purgeExpiredExports(database, store, ctx, now), 0);
      if (failures.length > 0) throw failures[0];
      return reminders;
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
