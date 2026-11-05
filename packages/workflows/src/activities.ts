// Activities do all I/O for workflows. Each one takes IDs, works out its state from PostgreSQL, and
// is safe to retry: a repeated call finds the work already done and does nothing new.
import {
  addArtifact,
  applyTransition,
  createApprovalInTx,
  expireApproval,
  loadChangeable,
  sendDueReminders,
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
import { actionHash, type ProposedAction } from '@ensemus/domain/approval';
import { isTerminal, type CompletionCriterion, type WorkState } from '@ensemus/domain/work-unit';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { ApplicationFailure } from '@temporalio/common';
import { and, eq } from 'drizzle-orm';
import type {
  PreparedWork,
  ProbeStep,
  ReviewRequest,
  ReviewState,
  TenantInput,
  WorkInput,
  WorkOutcome,
} from './schemas';

const log = createLogger('worker');
const CHECKLIST_NAME = 'completion-checklist.md';
const REVIEW_HOURS = 72;

export async function recordProbeStep(probeId: string, step: ProbeStep): Promise<void> {
  log.info('probe.step', { probeId, step });
}

export type PlatformActivities = { recordProbeStep: typeof recordProbeStep };

const stopped = () =>
  ApplicationFailure.create({ type: 'WORK_STOPPED', message: 'Work stopped', nonRetryable: true });

const reviewAction = (workUnitId: string, artifactIds: string[]): ProposedAction => ({
  toolName: 'work.review',
  toolVersion: '1',
  targetRef: `work_unit:${workUnitId}`,
  payload: { artifact_ids: [...artifactIds].sort() },
});

export function createActivities(deps: { database: AppDatabase; store: ObjectStore }) {
  const { database, store } = deps;
  const context = (input: { organizationId: string }) => createServiceContext(input.organizationId);

  const load = (input: WorkInput) =>
    withTenantTx(database, context(input), (tx) =>
      loadChangeable(tx, context(input), input.workUnitId),
    );

  return {
    recordProbeStep,

    /** Moves ready work to running. Finding it running already means a retry, so carry on. */
    async prepareWork(input: WorkInput): Promise<PreparedWork> {
      const ctx = context(input);
      return withTenantTx(database, ctx, async (tx) => {
        const work = await loadChangeable(tx, ctx, input.workUnitId);
        const status = work.status as WorkState;
        const needsReview = (work.completionCriteria as CompletionCriterion[]).some(
          (criterion) => criterion.kind === 'reviewer_approved',
        );
        if (status === 'ready') await applyTransition(tx, ctx, work, 'running');
        else if (status !== 'running') return { status: 'stopped', needsReview };
        return { status: 'running', needsReview };
      });
    },

    /** Produces the plan's deterministic artifact. A retry finds it and adds nothing. */
    async produceChecklistArtifact(input: WorkInput): Promise<{ artifactId: string }> {
      const work = await load(input);
      if (work.status !== 'running') throw stopped();
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
        `Work Unit: ${work.id}`,
        `Version at generation: ${work.version}`,
        '',
        ...(criteria.length
          ? criteria.map((criterion) => `- [ ] ${criterion.kind}`)
          : ['- No completion criteria were set.']),
        '',
      ].join('\n');
      const { id } = await addArtifact(database, store, ctx, {
        workUnitId: work.id,
        name: CHECKLIST_NAME,
        mimeType: 'text/markdown',
        body: Buffer.from(body),
      });
      return { artifactId: id };
    },

    /** Asks the accountable owner to review. A retry returns the same approval. */
    async requestReview(input: WorkInput): Promise<ReviewRequest> {
      const ctx = context(input);
      return withTenantTx(database, ctx, async (tx) => {
        const work = await loadChangeable(tx, ctx, input.workUnitId);
        const files = await tx
          .select({ id: workArtifacts.artifactId })
          .from(workArtifacts)
          .where(eq(workArtifacts.workUnitId, work.id));
        const action = reviewAction(
          work.id,
          files.map((file) => file.id),
        );
        const [existing] = await tx
          .select({ id: approvals.id, expiresAt: approvals.expiresAt })
          .from(approvals)
          .where(
            and(eq(approvals.workUnitId, work.id), eq(approvals.actionHash, actionHash(action))),
          );
        if (existing) {
          return { approvalId: existing.id, expiresAtMs: existing.expiresAt.getTime() };
        }
        if (work.status !== 'running') throw stopped();
        const expiresAt = new Date(Date.now() + REVIEW_HOURS * 60 * 60 * 1000);
        const created = await createApprovalInTx(tx, ctx, {
          workUnitId: work.id,
          action,
          approverMembershipId: work.ownerMembershipId,
          expiresAt,
        });
        return { approvalId: created.id, expiresAtMs: expiresAt.getTime() };
      });
    },

    async reviewState(input: WorkInput & { approvalId: string }): Promise<ReviewState> {
      const ctx = context(input);
      const [row] = await withTenantTx(database, ctx, (tx) =>
        tx
          .select({ status: approvals.status })
          .from(approvals)
          .where(eq(approvals.id, input.approvalId)),
      );
      return (row?.status ?? 'cancelled') as ReviewState;
    },

    async expireReview(input: WorkInput & { approvalId: string }): Promise<void> {
      await expireApproval(database, context(input), { approvalId: input.approvalId });
    },

    /** Runs the domain's evidence check. If it fails, the work goes back for remediation. */
    async verifyAndComplete(input: WorkInput): Promise<WorkOutcome> {
      const ctx = context(input);
      return withTenantTx(database, ctx, async (tx) => {
        let work = await loadChangeable(tx, ctx, input.workUnitId);
        if (work.status === 'completed') return 'completed';
        if (work.status === 'running') work = await applyTransition(tx, ctx, work, 'verifying');
        if (work.status !== 'verifying') return 'cancelled';
        await applyTransition(tx, ctx, work, 'completed');
        return 'completed';
      });
    },

    /** Reports failure truthfully. Finished work is left as it is. */
    async markFailed(input: WorkInput): Promise<void> {
      const ctx = context(input);
      await withTenantTx(database, ctx, async (tx) => {
        const work = await loadChangeable(tx, ctx, input.workUnitId);
        const status = work.status as WorkState;
        if (status === 'running') await applyTransition(tx, ctx, work, 'failed');
        else if (status === 'verifying') {
          const back = await applyTransition(tx, ctx, work, 'running');
          await applyTransition(tx, ctx, back, 'failed');
        }
        log.warn('work.failed', {
          workUnitId: work.id,
          status: isTerminal(status) ? 'final' : status,
        });
      });
    },

    async sendReminders(input: TenantInput): Promise<number> {
      try {
        return await sendDueReminders(database, context(input), new Date());
      } catch (error) {
        log.error('reminders.failed', { errorCode: errorCode(error) });
        throw error;
      }
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
