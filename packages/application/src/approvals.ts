// Approvals bind to one exact action (WORK-05). The action cannot be edited: no database role can
// update that column, so a changed proposal has to become a new approval.
import { randomUUID } from 'node:crypto';
import {
  appendAudit,
  approvalDecisions,
  approvals,
  memberships,
  notifications,
  users,
  withTenantTx,
  workUnits,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  actionHash,
  checkDecision,
  checkExecution,
  type ProposedAction,
} from '@ensemus/domain/approval';
import { canReadWork, type Classification } from '@ensemus/domain/policy';
import { and, asc, eq, lt } from 'drizzle-orm';
import { AppError, type ErrorCode } from './errors';
import { emit } from './events';
import { applyTransition, loadChangeable, loadReadable } from './work';

const DENIAL_CODES: Record<string, ErrorCode> = {
  NOT_PENDING: 'APPROVAL_NOT_PENDING',
  EXPIRED: 'APPROVAL_EXPIRED',
  WRONG_APPROVER: 'APPROVAL_WRONG_APPROVER',
  HASH_MISMATCH: 'APPROVAL_HASH_MISMATCH',
  SELF_APPROVAL: 'APPROVAL_SELF_APPROVAL',
};

const REMINDER_DELAY_MS = 4 * 60 * 60 * 1000;

export async function createApprovalInTx(
  tx: Tx,
  context: TenantContext,
  input: {
    workUnitId: string;
    action: ProposedAction;
    approverMembershipId: string;
    expiresAt: Date;
  },
) {
  const work = await loadChangeable(tx, context, input.workUnitId);
  const [approver] = await tx
    .select({ id: memberships.id, role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(eq(memberships.id, input.approverMembershipId));
  if (approver?.status !== 'active') throw new AppError('INVALID_INPUT');
  // An approver has to be able to see what they are approving.
  const approverCanRead = canReadWork(
    {
      classification: work.classification as Classification,
      ownerMembershipId: work.ownerMembershipId,
      createdByMembershipId: work.createdByMembershipId,
      isAssigned: false,
    },
    { membershipId: approver.id, role: approver.role },
  );
  if (!approverCanRead) throw new AppError('INVALID_INPUT');

  const id = randomUUID();
  const hash = actionHash(input.action);
  await tx.insert(approvals).values({
    organizationId: context.organizationId,
    id,
    workUnitId: input.workUnitId,
    toolName: input.action.toolName,
    action: input.action,
    actionHash: hash,
    targetRef: input.action.targetRef,
    approverMembershipId: input.approverMembershipId,
    requestedByMembershipId: context.actorType === 'service' ? null : context.membershipId,
    expiresAt: input.expiresAt,
  });
  await tx.insert(notifications).values({
    organizationId: context.organizationId,
    recipientMembershipId: input.approverMembershipId,
    kind: 'approval.requested',
    targetRef: `approval:${id}`,
    remindAt: new Date(Date.now() + REMINDER_DELAY_MS),
  });
  if (work.status === 'running') await applyTransition(tx, context, work, 'awaiting_approval');
  await emit(tx, context, {
    eventType: 'approval.requested',
    aggregateType: 'work_unit',
    aggregateId: input.workUnitId,
    aggregateVersion: work.version,
    classification: work.classification,
    payload: { approval_id: id, work_unit_id: input.workUnitId },
  });
  return { id, actionHash: hash };
}

export function requestApproval(
  database: AppDatabase,
  context: TenantContext,
  input: Parameters<typeof createApprovalInTx>[2],
) {
  return withTenantTx(database, context, (tx) => createApprovalInTx(tx, context, input));
}

export async function decideApproval(
  database: AppDatabase,
  context: TenantContext,
  input: { approvalId: string; decision: 'approve' | 'deny'; shownHash: string; reason?: string },
) {
  if (context.actorType === 'service') throw new AppError('FORBIDDEN');
  return withTenantTx(database, context, async (tx) => {
    const [approval] = await tx
      .select()
      .from(approvals)
      .where(eq(approvals.id, input.approvalId))
      .for('update');
    if (!approval) throw new AppError('NOT_FOUND');
    // Someone who cannot see the work gets not found, not a hint that the approval exists.
    await loadReadable(tx, context, approval.workUnitId);

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
      reason: input.reason ?? null,
    });
    await tx
      .update(notifications)
      .set({ readAt: new Date(), remindAt: null })
      .where(eq(notifications.targetRef, `approval:${approval.id}`));

    const [work] = await tx
      .select()
      .from(workUnits)
      .where(eq(workUnits.id, approval.workUnitId))
      .for('update');
    if (!work) throw new AppError('NOT_FOUND');
    if (work.status === 'awaiting_approval') {
      await applyTransition(tx, context, work, status === 'approved' ? 'running' : 'cancelled');
    }
    await emit(tx, context, {
      eventType: 'approval.resolved',
      aggregateType: 'work_unit',
      aggregateId: approval.workUnitId,
      aggregateVersion: work.version,
      classification: work.classification,
      payload: { approval_id: approval.id, work_unit_id: approval.workUnitId, outcome: status },
    });
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'approval.decided',
      targetRef: `approval:${approval.id}`,
      decision: status === 'approved' ? 'allow' : 'deny',
    });
    return { status };
  });
}

/** Rechecks an approval right before the action runs. A changed action voids it. */
export function verifyApprovalForExecution(
  database: AppDatabase,
  context: TenantContext,
  input: { approvalId: string; action: ProposedAction },
) {
  return withTenantTx(database, context, async (tx) => {
    const [approval] = await tx.select().from(approvals).where(eq(approvals.id, input.approvalId));
    if (!approval) throw new AppError('NOT_FOUND');
    return checkExecution(
      {
        status: approval.status as 'approved',
        expiresAt: approval.expiresAt,
        boundHash: approval.actionHash,
      },
      { action: input.action, now: new Date() },
    );
  });
}

/** Moves one overdue approval to expired. Workflows call this when their timer fires. */
export function expireApproval(
  database: AppDatabase,
  context: TenantContext,
  input: { approvalId: string },
) {
  return withTenantTx(database, context, async (tx) => {
    const [approval] = await tx
      .select()
      .from(approvals)
      .where(eq(approvals.id, input.approvalId))
      .for('update');
    if (approval?.status !== 'pending' || approval.expiresAt > new Date()) return false;
    await tx
      .update(approvals)
      .set({ status: 'expired', decidedAt: new Date() })
      .where(eq(approvals.id, approval.id));
    const [work] = await tx
      .select()
      .from(workUnits)
      .where(eq(workUnits.id, approval.workUnitId))
      .for('update');
    if (work?.status === 'awaiting_approval') {
      await applyTransition(tx, context, work, 'cancelled');
    }
    return true;
  });
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
    return {
      approval,
      work: { id: work.id, title: work.title, classification: work.classification },
      approverName: approver?.name ?? null,
      isMine: approval.approverMembershipId === context.membershipId,
    };
  });
}

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
        ),
      )
      .orderBy(asc(approvals.expiresAt)),
  );
}

/** Finds reminders that are due, up to a limit, for a scheduled workflow to act on. */
export function dueApprovalReminders(database: AppDatabase, context: TenantContext, now: Date) {
  return withTenantTx(database, context, (tx) =>
    tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(lt(notifications.remindAt, now))
      .limit(100),
  );
}
