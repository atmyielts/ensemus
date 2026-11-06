// Approvals bind to one exact action (WORK-05). The action cannot be edited: no database role can
// update that column, so a changed proposal has to become a new approval.
import { randomUUID } from 'node:crypto';
import {
  approvalDecisions,
  approvals,
  artifacts,
  memberships,
  notifications,
  users,
  withTenantTx,
  workArtifacts,
  workUnits,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  actionHash,
  checkDecision,
  WORK_REVIEW_TOOL,
  WORK_REVIEW_VERSION,
  type ProposedAction,
} from '@ensemus/domain/approval';
import { EMAIL_SEND_TOOL } from '@ensemus/domain/external-action';
import { isTerminal, type WorkState } from '@ensemus/domain/work-unit';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { AppError, pgCode, type ErrorCode } from './errors';
import { emit } from './events';
import { assertIntentMatchesApproval, onApprovalClosedInTx } from './external-actions';
import {
  applyTransition,
  assertCanBeAskedToReview,
  auditAction,
  clearApprovalNotifications,
  currentReviewAction,
  loadChangeable,
  loadReadable,
  notify,
  visibleTo,
} from './work';

/** What goes on the record when an approval's time runs out, however that was noticed. */
async function recordExpiry(
  tx: Tx,
  context: TenantContext,
  work: { id: string; version: number; classification: string; ownerMembershipId: string },
  approval: { id: string; requestedByMembershipId: string | null },
  now: Date,
  safeReason?: string,
) {
  await tx
    .update(approvals)
    .set({ status: 'expired', decidedAt: now })
    .where(eq(approvals.id, approval.id));
  await clearApprovalNotifications(tx, [approval.id]);
  await onApprovalClosedInTx(tx, context, { approvalId: approval.id, outcome: 'expired' });
  await emit(tx, context, {
    eventType: 'approval.resolved',
    aggregateType: 'work_unit',
    aggregateId: work.id,
    aggregateVersion: work.version,
    classification: work.classification,
    payload: { approval_id: approval.id, work_unit_id: work.id, outcome: 'expired' },
  });
  await auditAction(tx, context, 'approval.expired', `approval:${approval.id}`, safeReason);
  await notify(
    tx,
    context,
    [work.ownerMembershipId, approval.requestedByMembershipId],
    'approval.expired',
    `work_unit:${work.id}`,
  );
}

const DENIAL_CODES: Record<string, ErrorCode> = {
  NOT_PENDING: 'APPROVAL_NOT_PENDING',
  EXPIRED: 'APPROVAL_EXPIRED',
  WRONG_APPROVER: 'APPROVAL_WRONG_APPROVER',
  HASH_MISMATCH: 'APPROVAL_HASH_MISMATCH',
  SELF_APPROVAL: 'APPROVAL_SELF_APPROVAL',
};

const REMINDER_DELAY_MS = 4 * 60 * 60 * 1000;
const UNIQUE_VIOLATION = '23505';
const MAX_REASON_LENGTH = 2000;

export const REVIEW_HOURS = 72;

export async function createApprovalInTx(
  tx: Tx,
  context: TenantContext,
  input: {
    workUnitId: string;
    action: ProposedAction;
    approverMembershipId: string;
    expiresAt: Date;
    /** The person behind a request a workflow makes, so they cannot approve it themselves. */
    requestedByMembershipId?: string | null;
    /** The workflow run asking, so a retry of the same step finds this approval. */
    runId?: string;
  },
) {
  const work = await loadChangeable(tx, context, input.workUnitId);
  if (isTerminal(work.status as WorkState)) throw new AppError('INVALID_STATE');

  const requestedBy =
    input.requestedByMembershipId !== undefined
      ? input.requestedByMembershipId
      : context.actorType === 'service'
        ? null
        : context.membershipId;
  // They could never decide it, and with one open at a time nobody else could be asked meanwhile.
  if (requestedBy === input.approverMembershipId) throw new AppError('APPROVAL_SELF_APPROVAL');

  // One open decision at a time. A second one could override the first, or be used to replace the
  // person a plan named, so a new request has to wait until the open one is settled.
  const [open] = await tx
    .select({
      id: approvals.id,
      expiresAt: approvals.expiresAt,
      holdsWork: approvals.holdsWork,
      requestedByMembershipId: approvals.requestedByMembershipId,
    })
    .from(approvals)
    .where(and(eq(approvals.workUnitId, input.workUnitId), eq(approvals.status, 'pending')));
  if (open) {
    // A request nobody can decide any more is no reason to refuse a new one, so this settles it here
    // instead of waiting for the sweep. Work it paused stays paused, now under the new request. A
    // plan's own reviewer is the exception: nobody can replace that one, and the sweep ends the run.
    const planReview = open.holdsWork && Boolean(work.runId);
    const now = new Date();
    if (open.expiresAt > now || planReview) throw new AppError('REVIEW_ALREADY_OPEN');
    await recordExpiry(tx, context, work, open, now, 'REPLACED');
  }

  await assertCanBeAskedToReview(tx, work, input.approverMembershipId);

  const id = randomUUID();
  const hash = actionHash(input.action);
  // Work running now pauses on this approval, and work still paused has just lost its reviewer. In
  // either case only this approval's decision can release it. Any other approval is a plain review.
  const holdsWork = work.status === 'running' || work.status === 'awaiting_approval';
  try {
    await tx.insert(approvals).values({
      organizationId: context.organizationId,
      id,
      workUnitId: input.workUnitId,
      toolName: input.action.toolName,
      action: input.action,
      actionHash: hash,
      targetRef: input.action.targetRef,
      approverMembershipId: input.approverMembershipId,
      requestedByMembershipId: requestedBy,
      holdsWork,
      runId: input.runId ?? null,
      expiresAt: input.expiresAt,
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new AppError('REVIEW_ALREADY_OPEN');
    throw error;
  }
  await tx.insert(notifications).values({
    organizationId: context.organizationId,
    recipientMembershipId: input.approverMembershipId,
    kind: 'approval.requested',
    targetRef: `approval:${id}`,
    remindAt: new Date(Date.now() + REMINDER_DELAY_MS),
  });
  const now =
    work.status === 'running'
      ? await applyTransition(tx, context, work, 'awaiting_approval')
      : work;
  await emit(tx, context, {
    eventType: 'approval.requested',
    aggregateType: 'work_unit',
    aggregateId: input.workUnitId,
    aggregateVersion: now.version,
    classification: work.classification,
    payload: { approval_id: id, work_unit_id: input.workUnitId },
  });
  await auditAction(tx, context, 'approval.requested', `approval:${id}`);
  return { id, actionHash: hash };
}

export function requestApproval(
  database: AppDatabase,
  context: TenantContext,
  input: Parameters<typeof createApprovalInTx>[2],
) {
  return withTenantTx(database, context, (tx) => createApprovalInTx(tx, context, input));
}

/**
 * Asks someone to review a Work Unit as it stands. What the review covers is read here, under the
 * lock, so a form cannot name a version or a set of files that does not exist. A plan that holds the
 * work names its own reviewer, and nobody with change rights can add or swap one.
 */
export function requestWorkReview(
  database: AppDatabase,
  context: TenantContext,
  input: { workUnitId: string; expectedVersion: number; approverMembershipId: string },
) {
  return withTenantTx(database, context, async (tx) => {
    const work = await loadChangeable(tx, context, input.workUnitId);
    if (work.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (work.runId) throw new AppError('INVALID_STATE');
    return createApprovalInTx(tx, context, {
      workUnitId: work.id,
      action: await currentReviewAction(tx, work),
      approverMembershipId: input.approverMembershipId,
      expiresAt: new Date(Date.now() + REVIEW_HOURS * 60 * 60 * 1000),
    });
  });
}

export async function decideApproval(
  database: AppDatabase,
  context: TenantContext,
  input: { approvalId: string; decision: 'approve' | 'deny'; shownHash: string; reason?: string },
) {
  if (context.actorType === 'service') throw new AppError('FORBIDDEN');
  return withTenantTx(database, context, async (tx) => {
    const [found] = await tx.select().from(approvals).where(eq(approvals.id, input.approvalId));
    if (!found) throw new AppError('NOT_FOUND');
    // Someone who cannot see the work gets not found, not a hint that the approval exists. The work
    // is locked before the approval, the same order everything that closes approvals uses.
    const work = await loadReadable(tx, context, found.workUnitId, true);
    const [approval] = await tx
      .select()
      .from(approvals)
      .where(eq(approvals.id, input.approvalId))
      .for('update');
    if (!approval) throw new AppError('NOT_FOUND');

    const check = checkDecision(
      {
        status: approval.status as 'pending',
        expiresAt: approval.expiresAt,
        approverMembershipId: approval.approverMembershipId,
        requestedByMembershipId: approval.requestedByMembershipId,
        boundHash: approval.actionHash,
      },
      { actorMembershipId: context.membershipId, shownHash: input.shownHash, now: new Date() },
    );
    if (!check.ok) throw new AppError(DENIAL_CODES[check.reason] as ErrorCode);
    if (isTerminal(work.status as WorkState)) throw new AppError('INVALID_STATE');

    // What the reviewer was shown has to be what the work holds now. Changing the work closes open
    // reviews, so this only catches what that missed. Reviews bound the older way have no content
    // digest to compare, and they can no longer count as evidence anyway.
    const action = approval.action as ProposedAction;
    if (action.toolName === WORK_REVIEW_TOOL && action.toolVersion === WORK_REVIEW_VERSION) {
      const current = await currentReviewAction(tx, work);
      if (actionHash(current) !== approval.actionHash) throw new AppError('APPROVAL_STALE');
    }
    // The same for a send: what was shown has to be what would go, and it is the intent that would go.
    if (action.toolName === EMAIL_SEND_TOOL) await assertIntentMatchesApproval(tx, approval);

    const reason = input.reason?.trim().slice(0, MAX_REASON_LENGTH) || undefined;
    const holdingWork = approval.holdsWork && work.status === 'awaiting_approval';
    // Denying this stops the work for good, so the record says why, however the denial arrived.
    if (input.decision === 'deny' && holdingWork && !reason) {
      throw new AppError('REASON_REQUIRED');
    }
    const status = input.decision === 'approve' ? 'approved' : 'denied';
    await tx
      .update(approvals)
      .set({ status, decidedAt: new Date() })
      .where(and(eq(approvals.id, approval.id), eq(approvals.status, 'pending')));
    await tx.insert(approvalDecisions).values({
      organizationId: context.organizationId,
      approvalId: approval.id,
      actorMembershipId: context.membershipId,
      decision: input.decision,
      actionHash: input.shownHash,
      reason: reason ?? null,
    });
    await clearApprovalNotifications(tx, [approval.id]);
    await onApprovalClosedInTx(tx, context, { approvalId: approval.id, outcome: status });

    // Only the approval that caused the pause can end it. A later review of the same work is just a
    // review: it records an opinion, and overrides nobody.
    const now = holdingWork
      ? await applyTransition(tx, context, work, status === 'approved' ? 'running' : 'cancelled', {
          ...(reason ? { reason } : {}),
        })
      : work;
    await emit(tx, context, {
      eventType: 'approval.resolved',
      aggregateType: 'work_unit',
      aggregateId: approval.workUnitId,
      aggregateVersion: now.version,
      classification: work.classification,
      payload: { approval_id: approval.id, work_unit_id: approval.workUnitId, outcome: status },
    });
    await auditAction(tx, context, 'approval.decided', `approval:${approval.id}`);
    await notifyDecision(tx, context, work.ownerMembershipId, approval);
    return { status };
  });
}

function notifyDecision(
  tx: Tx,
  context: TenantContext,
  ownerMembershipId: string,
  approval: { requestedByMembershipId: string | null; workUnitId: string },
) {
  return notify(
    tx,
    context,
    [ownerMembershipId, approval.requestedByMembershipId],
    'approval.decided',
    `work_unit:${approval.workUnitId}`,
  );
}

/**
 * Settles one approval if it is overdue, and returns its status either way, so nobody has to guess
 * what happened. Work paused on it is stopped, which is the kernel's outcome for an expired approval.
 */
async function settleOverdue(tx: Tx, context: TenantContext, approvalId: string, now: Date) {
  const [found] = await tx
    .select({ workUnitId: approvals.workUnitId })
    .from(approvals)
    .where(eq(approvals.id, approvalId));
  if (!found) return 'cancelled';
  const [work] = await tx
    .select()
    .from(workUnits)
    .where(eq(workUnits.id, found.workUnitId))
    .for('update');
  const [approval] = await tx
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .for('update');
  if (!approval || !work) return 'cancelled';
  if (approval.status !== 'pending' || approval.expiresAt > now) return approval.status;

  // First, or stopping the work would close this approval as something other than expired.
  await recordExpiry(tx, context, work, approval, now);
  if (approval.holdsWork && work.status === 'awaiting_approval') {
    await applyTransition(tx, context, work, 'cancelled');
  }
  return 'expired';
}

/** Expires one approval if it is overdue, and returns the status it now has. */
export function expireApprovalStatus(
  database: AppDatabase,
  context: TenantContext,
  input: { approvalId: string },
  now = new Date(),
) {
  return withTenantTx(database, context, (tx) => settleOverdue(tx, context, input.approvalId, now));
}

/** Moves one overdue approval to expired. Returns whether this call was the one that did it. */
export async function expireApproval(
  database: AppDatabase,
  context: TenantContext,
  input: { approvalId: string },
) {
  const before = await withTenantTx(database, context, (tx) =>
    tx
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, input.approvalId)),
  );
  if (before[0]?.status !== 'pending') return false;
  return (await expireApprovalStatus(database, context, input)) === 'expired';
}

/** Expires everything overdue in one tenant, for approvals no workflow is waiting on. */
export async function expireOverdueApprovals(
  database: AppDatabase,
  context: TenantContext,
  now: Date,
  limit = 100,
) {
  const due = await withTenantTx(database, context, (tx) =>
    tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, now)))
      .limit(limit),
  );
  for (const { id } of due) await expireApprovalStatus(database, context, { approvalId: id }, now);
  return due.length;
}

const FILE_ID = /^[0-9a-f-]{36}$/;

/** The file IDs an approval's action bound, if any. The action is stored, so its shape is checked. */
function boundFileIds(action: unknown): string[] {
  const payload = (action as { payload?: { artifact_ids?: unknown } } | null)?.payload;
  const ids = payload?.artifact_ids;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string' && FILE_ID.test(id));
}

export function getApproval(database: AppDatabase, context: TenantContext, approvalId: string) {
  return withTenantTx(database, context, async (tx) => {
    const [approval] = await tx.select().from(approvals).where(eq(approvals.id, approvalId));
    if (!approval) throw new AppError('NOT_FOUND');
    const work = await loadReadable(tx, context, approval.workUnitId);
    const [approver] = await tx
      .select({ name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.id, approval.approverMembershipId));
    const boundIds = boundFileIds(approval.action);
    // Names of the files it covers, through this work only. A deleted file simply has no name.
    const files =
      boundIds.length === 0
        ? []
        : await tx
            .select({ id: artifacts.id, name: artifacts.name, sizeBytes: artifacts.sizeBytes })
            .from(workArtifacts)
            .innerJoin(artifacts, eq(artifacts.id, workArtifacts.artifactId))
            .where(and(eq(workArtifacts.workUnitId, work.id), inArray(artifacts.id, boundIds)));
    const decisions = await tx
      .select({
        decision: approvalDecisions.decision,
        reason: approvalDecisions.reason,
        decidedAt: approvalDecisions.decidedAt,
        actorName: users.name,
      })
      .from(approvalDecisions)
      .innerJoin(memberships, eq(memberships.id, approvalDecisions.actorMembershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(approvalDecisions.approvalId, approval.id))
      .orderBy(asc(approvalDecisions.decidedAt));
    return {
      approval,
      work: {
        id: work.id,
        title: work.title,
        classification: work.classification,
        status: work.status,
        updatedAt: work.updatedAt,
      },
      approverName: approver?.name ?? null,
      isMine: approval.approverMembershipId === context.membershipId,
      files,
      /** Files it covers that are gone now, so nobody is told a list is complete when it is not. */
      missingFileCount: boundIds.length - files.length,
      decisions,
    };
  });
}

/**
 * What is waiting on this person. Read access is checked here as everywhere else: being named as an
 * approver grants none, and it can have been lost since. Overdue approvals cannot be decided any
 * more, so they are not listed as waiting.
 */
export function listMyPendingApprovals(database: AppDatabase, context: TenantContext) {
  return withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: approvals.id,
        toolName: approvals.toolName,
        expiresAt: approvals.expiresAt,
        workUnitId: approvals.workUnitId,
        workTitle: workUnits.title,
      })
      .from(approvals)
      .innerJoin(workUnits, eq(workUnits.id, approvals.workUnitId))
      .where(
        and(
          eq(approvals.approverMembershipId, context.membershipId),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, sql`now()`),
          visibleTo(context),
        ),
      )
      .orderBy(asc(approvals.expiresAt)),
  );
}
