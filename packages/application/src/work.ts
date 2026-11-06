// Work Unit services. Each one checks permission itself: callers are not trusted to have done so.
import { randomUUID } from 'node:crypto';
import {
  appendAudit,
  artifacts,
  memberships,
  notifications,
  users,
  withTenantTx,
  workArtifacts,
  workAssignments,
  workDependencies,
  workTransitions,
  workUnits,
  approvals,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  actionHash,
  reviewCovers,
  WORK_REVIEW_TOOL,
  workReviewAction,
} from '@ensemus/domain/approval';
import { canChangeWork, canReadWork, can, type Classification } from '@ensemus/domain/policy';
import {
  canChangeContent,
  decideTransition,
  isApprovalOnlyTransition,
  isTerminal,
  startOfUtcDay,
  type CompletionCriterion,
  type WorkState,
} from '@ensemus/domain/work-unit';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import { AppError, pgCode } from './errors';
import { emit } from './events';

// An outside system's receipt is not offered yet: nothing can provide one until external actions
// exist, so a criterion asking for it could never be met and the work could never finish.
const criteriaSchema = z.array(
  z.strictObject({ kind: z.enum(['artifact_exists', 'reviewer_approved']) }),
);

export const createWorkInput = z.strictObject({
  title: z.string().trim().min(1).max(300),
  objective: z.string().trim().max(10_000).optional(),
  projectId: z.uuid().optional(),
  ownerMembershipId: z.uuid().optional(),
  classification: z.enum(['public', 'internal', 'confidential', 'restricted']).default('internal'),
  dueAt: z.coerce.date().optional(),
  completionCriteria: criteriaSchema.default([]),
  executionPlan: z.enum(['checklist']).optional(),
});

export const updateWorkInput = z.strictObject({
  title: z.string().trim().min(1).max(300).optional(),
  objective: z.string().trim().max(10_000).optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

export type WorkRow = typeof workUnits.$inferSelect;

async function isOnWork(tx: Tx, workUnitId: string, membershipId: string) {
  const rows = await tx
    .select({ m: workAssignments.membershipId })
    .from(workAssignments)
    .where(
      and(
        eq(workAssignments.workUnitId, workUnitId),
        eq(workAssignments.membershipId, membershipId),
      ),
    );
  return rows.length > 0;
}

async function assignedTo(tx: Tx, context: TenantContext, workUnitId: string) {
  if (context.actorType === 'service') return false;
  return isOnWork(tx, workUnitId, context.membershipId);
}

const accessFacts = (row: WorkRow, isAssigned: boolean) => ({
  classification: row.classification as Classification,
  ownerMembershipId: row.ownerMembershipId,
  isAssigned,
});

const viewer = (context: TenantContext) => ({
  membershipId: context.membershipId,
  role: context.role,
});

/**
 * Whether this member can see this Work Unit. The approval services use it: being asked to approve is
 * not an access grant, so the approver has to have access in their own right.
 */
export async function memberCanRead(
  tx: Tx,
  work: WorkRow,
  member: { membershipId: string; role: string },
) {
  return canReadWork(accessFacts(work, await isOnWork(tx, work.id, member.membershipId)), member);
}

/**
 * Loads a Work Unit for reading. Work someone may not see is reported as not found, so its existence
 * does not leak. Workflow Activities run as a service, and only ever on the unit they were started
 * for; agent runs get real delegation checks in M4.
 */
export async function loadReadable(tx: Tx, context: TenantContext, id: string, lock = false) {
  const query = tx.select().from(workUnits).where(eq(workUnits.id, id));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new AppError('NOT_FOUND');
  if (context.actorType === 'service') return row;
  const isAssigned = await assignedTo(tx, context, id);
  if (!canReadWork(accessFacts(row, isAssigned), viewer(context))) {
    throw new AppError('NOT_FOUND');
  }
  return row;
}

export async function loadChangeable(tx: Tx, context: TenantContext, id: string) {
  const row = await loadReadable(tx, context, id, true);
  if (context.actorType === 'service') return row;
  const isAssigned = await assignedTo(tx, context, id);
  if (!canChangeWork(accessFacts(row, isAssigned), viewer(context))) {
    throw new AppError('FORBIDDEN');
  }
  return row;
}

async function assertActiveMember(tx: Tx, membershipId: string) {
  const [member] = await tx
    .select({ status: memberships.status })
    .from(memberships)
    .where(eq(memberships.id, membershipId));
  if (member?.status !== 'active') throw new AppError('INVALID_INPUT');
}

export async function createWorkUnit(
  database: AppDatabase,
  context: TenantContext,
  raw: z.input<typeof createWorkInput>,
) {
  if (!can(context.role, 'work.create')) throw new AppError('FORBIDDEN');
  const parsed = createWorkInput.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const input = parsed.data;
  const id = randomUUID();
  return withTenantTx(database, context, async (tx) => {
    const owner = input.ownerMembershipId ?? context.membershipId;
    await assertActiveMember(tx, owner);
    const [row] = await tx
      .insert(workUnits)
      .values({
        organizationId: context.organizationId,
        id,
        title: input.title,
        objective: input.objective ?? null,
        projectId: input.projectId ?? null,
        ownerMembershipId: owner,
        createdByMembershipId: context.membershipId,
        classification: input.classification,
        dueAt: input.dueAt ?? null,
        completionCriteria: input.completionCriteria,
        executionPlan: input.executionPlan ?? null,
      })
      .returning();
    // The creator is on the work the way anyone else is: listed, and removable once it has moved.
    await tx.insert(workAssignments).values({
      organizationId: context.organizationId,
      workUnitId: id,
      membershipId: context.membershipId,
      responsibility: 'contributor',
    });
    await emit(tx, context, {
      eventType: 'work.created',
      aggregateType: 'work_unit',
      aggregateId: id,
      aggregateVersion: 1,
      classification: input.classification,
      payload: { work_unit_id: id },
    });
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'work.created',
      targetRef: `work_unit:${id}`,
      decision: 'allow',
    });
    return row as WorkRow;
  });
}

export function getWorkUnit(database: AppDatabase, context: TenantContext, id: string) {
  return withTenantTx(database, context, (tx) => loadReadable(tx, context, id));
}

const PAGE_SIZE = 50;

/** Work this person is on, as the accountable owner or as someone assigned to it. */
function onTheWork(me: string) {
  return or(
    eq(workUnits.ownerMembershipId, me),
    exists(
      sql`(select 1 from ${workAssignments} where ${workAssignments.workUnitId} = ${workUnits.id}
           and ${workAssignments.membershipId} = ${me})`,
    ),
  );
}

/** The visibility rule from the policy, expressed in SQL so that filtering happens in the query. */
export function visibleTo(context: TenantContext) {
  const elevated = context.role === 'owner' || context.role === 'admin';
  return or(
    inArray(workUnits.classification, ['public', 'internal']),
    onTheWork(context.membershipId),
    elevated ? eq(workUnits.classification, 'confidential') : sql`false`,
  );
}

export async function listWorkUnits(
  database: AppDatabase,
  context: TenantContext,
  options: { status?: WorkState; cursor?: string; limit?: number; projectId?: string } = {},
) {
  const limit = Math.min(options.limit ?? PAGE_SIZE, PAGE_SIZE);
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select({
        ...getTableColumns(workUnits),
        // As text, because a JavaScript date would round microseconds away and skip rows.
        cursorAt: sql<string>`${workUnits.createdAt}::text`,
      })
      .from(workUnits)
      .where(
        and(
          visibleTo(context),
          options.status ? eq(workUnits.status, options.status) : undefined,
          options.projectId ? eq(workUnits.projectId, options.projectId) : undefined,
          cursor
            ? or(
                sql`${workUnits.createdAt} < ${cursor.at}::timestamptz`,
                and(
                  sql`${workUnits.createdAt} = ${cursor.at}::timestamptz`,
                  lt(workUnits.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(workUnits.createdAt), desc(workUnits.id))
      .limit(limit + 1),
  );
  const items = rows.slice(0, limit).map(({ cursorAt: _unused, ...row }) => row);
  const last = rows[limit - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last.cursorAt, last.id) : null,
  };
}

const encodeCursor = (at: string, id: string) =>
  Buffer.from(JSON.stringify([at, id])).toString('base64url');

// A timestamp exactly as PostgreSQL wrote it, or the ISO form of an older cursor, and nothing else.
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/;

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const parsed = z
      .tuple([z.string().regex(CURSOR_TIME), z.uuid()])
      .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return { at: parsed[0], id: parsed[1] };
  } catch {
    throw new AppError('INVALID_INPUT');
  }
}

const HOME_LIST_SIZE = 12;

/**
 * Home's two lists, filtered in SQL, so nothing else this person can see pushes them out. Both hold
 * work this person owns or is assigned to: one what needs attention, the other the most urgent.
 */
export function listMyWork(database: AppDatabase, context: TenantContext, now = new Date()) {
  const isMine = and(
    onTheWork(context.membershipId),
    notInArray(workUnits.status, ['completed', 'cancelled']),
  );
  const dueFirst = sql`${workUnits.dueAt} asc nulls last`;
  return withTenantTx(database, context, async (tx) => {
    const attention = await tx
      .select()
      .from(workUnits)
      .where(
        and(
          isMine,
          or(
            inArray(workUnits.status, ['blocked', 'failed']),
            and(isNotNull(workUnits.dueAt), lt(workUnits.dueAt, startOfUtcDay(now))),
          ),
        ),
      )
      .orderBy(dueFirst, desc(workUnits.createdAt))
      .limit(HOME_LIST_SIZE + 1);
    const work = await tx
      .select()
      .from(workUnits)
      .where(isMine)
      .orderBy(dueFirst, desc(workUnits.createdAt))
      .limit(HOME_LIST_SIZE + 1);
    return {
      attention: attention.slice(0, HOME_LIST_SIZE),
      attentionHasMore: attention.length > HOME_LIST_SIZE,
      work: work.slice(0, HOME_LIST_SIZE),
      workHasMore: work.length > HOME_LIST_SIZE,
    };
  });
}

/** Compare-and-swap: a stale version never overwrites someone else's change. */
export async function updateWorkUnit(
  database: AppDatabase,
  context: TenantContext,
  id: string,
  expectedVersion: number,
  raw: z.input<typeof updateWorkInput>,
) {
  const parsed = updateWorkInput.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const input = parsed.data;
  return withTenantTx(database, context, async (tx) => {
    const current = await loadChangeable(tx, context, id);
    if (current.version !== expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (!canChangeContent(current.status as WorkState)) throw new AppError('INVALID_STATE');
    const nextVersion = current.version + 1;
    const [row] = await tx
      .update(workUnits)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.objective !== undefined ? { objective: input.objective } : {}),
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
        version: nextVersion,
        updatedAt: new Date(),
      })
      .where(and(eq(workUnits.id, id), eq(workUnits.version, expectedVersion)))
      .returning();
    if (!row) throw new AppError('VERSION_CONFLICT');
    await emit(tx, context, {
      eventType: 'work.updated',
      aggregateType: 'work_unit',
      aggregateId: id,
      aggregateVersion: nextVersion,
      classification: row.classification,
      payload: { work_unit_id: id },
    });
    await closeOutdatedReviews(tx, context, row);
    return row;
  });
}

async function incompletePrerequisites(tx: Tx, id: string) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(workDependencies)
    .innerJoin(workUnits, eq(workUnits.id, workDependencies.prerequisiteId))
    .where(and(eq(workDependencies.dependentId, id), ne(workUnits.status, 'completed')));
  return row?.n ?? 0;
}

async function fileFacts(tx: Tx, id: string) {
  return tx
    .select({ id: artifacts.id, createdBy: artifacts.createdByMembershipId })
    .from(workArtifacts)
    .innerJoin(artifacts, eq(artifacts.id, workArtifacts.artifactId))
    .where(eq(workArtifacts.workUnitId, id));
}

/** The review a Work Unit would need right now: its current text and its current files. */
export async function currentReviewAction(tx: Tx, work: WorkRow) {
  const files = await fileFacts(tx, work.id);
  return workReviewAction(
    work,
    files.map((file) => file.id),
  );
}

/**
 * What the work can show right now. This is the only place evidence is counted, and both completion
 * paths and the page go through it. A file a plan generated itself proves nothing, so only files a
 * person added count. A review counts only while it covers exactly what the work now holds.
 */
export async function evidenceFor(tx: Tx, work: WorkRow, now = new Date()) {
  const files = await fileFacts(tx, work.id);
  const current = workReviewAction(
    work,
    files.map((file) => file.id),
  );
  const approved = await tx
    .select({
      toolName: approvals.toolName,
      expiresAt: approvals.expiresAt,
      boundHash: approvals.actionHash,
    })
    .from(approvals)
    .where(and(eq(approvals.workUnitId, work.id), eq(approvals.status, 'approved')));
  return {
    artifactCount: files.filter((file) => file.createdBy !== null).length,
    approvedReviewCount: approved.filter((row) =>
      reviewCovers({ ...row, status: 'approved' }, current, now),
    ).length,
    // Verified external receipts arrive with external actions in M3.
    verifiedReceiptCount: 0,
  };
}

/** Marks notifications about approvals as dealt with, so they stop asking for a decision. */
export async function clearApprovalNotifications(tx: Tx, approvalIds: readonly string[]) {
  if (approvalIds.length === 0) return;
  await tx
    .update(notifications)
    .set({ readAt: new Date(), remindAt: null })
    .where(
      and(
        inArray(
          notifications.targetRef,
          approvalIds.map((id) => `approval:${id}`),
        ),
        isNull(notifications.readAt),
      ),
    );
}

/** Tells these people something, by reference only. The person acting already knows. */
export async function notify(
  tx: Tx,
  context: TenantContext,
  recipients: ReadonlyArray<string | null | undefined>,
  kind: string,
  targetRef: string,
) {
  const unique = new Set(recipients.filter((id): id is string => Boolean(id)));
  unique.delete(context.membershipId);
  if (unique.size === 0) return;
  await tx.insert(notifications).values(
    [...unique].map((recipientMembershipId) => ({
      organizationId: context.organizationId,
      recipientMembershipId,
      kind,
      targetRef,
    })),
  );
}

/** Records an action in the audit log, by whoever is acting. Reasons are codes, never free text. */
export async function auditAction(
  tx: Tx,
  context: TenantContext,
  action: string,
  targetRef: string,
  safeReason?: string,
) {
  await appendAudit(tx, {
    organizationId: context.organizationId,
    actorType: context.actorType === 'service' ? 'service' : 'user',
    ...(context.actorType === 'service' ? {} : { actorId: context.membershipId }),
    action,
    targetRef,
    decision: 'allow',
    ...(safeReason ? { safeReason } : {}),
  });
}

/** Closes approvals on a Work Unit that can no longer mean anything. */
async function closeApprovals(
  tx: Tx,
  context: TenantContext,
  workUnitId: string,
  statuses: readonly string[],
  reason: string,
) {
  const closed = await tx
    .update(approvals)
    .set({ status: 'cancelled', decidedAt: new Date() })
    .where(and(eq(approvals.workUnitId, workUnitId), inArray(approvals.status, [...statuses])))
    .returning({ id: approvals.id });
  await clearApprovalNotifications(
    tx,
    closed.map((row) => row.id),
  );
  for (const { id } of closed) {
    await auditAction(tx, context, 'approval.closed', `approval:${id}`, reason);
  }
}

/**
 * The work changed, so an open review of its old content is no longer the question. Closing it means
 * nobody is asked about something that has gone. Approved reviews need no change here: evidence is
 * worked out from what they bound, so they stop counting by themselves.
 */
export async function closeOutdatedReviews(tx: Tx, context: TenantContext, work: WorkRow) {
  const open = await tx
    .select({ id: approvals.id, hash: approvals.actionHash })
    .from(approvals)
    .where(
      and(
        eq(approvals.workUnitId, work.id),
        eq(approvals.status, 'pending'),
        eq(approvals.toolName, WORK_REVIEW_TOOL),
      ),
    );
  if (open.length === 0) return;
  const hash = actionHash(await currentReviewAction(tx, work));
  for (const review of open) {
    if (review.hash === hash) continue;
    await tx
      .update(approvals)
      .set({ status: 'cancelled', decidedAt: new Date() })
      .where(eq(approvals.id, review.id));
    await clearApprovalNotifications(tx, [review.id]);
    await auditAction(tx, context, 'approval.closed', `approval:${review.id}`, 'CONTENT_CHANGED');
  }
}

/**
 * Closes open approvals whose approver can no longer see the work. Being asked to approve is not an
 * access grant. Paused manual work stays paused, since only a decision can release it, and someone
 * can ask another person. A plan cannot go on without its reviewer, so that run ends as failed.
 */
export async function closeReviewsForLostAccess(
  tx: Tx,
  context: TenantContext,
  scope: { workUnitId: string } | { approverMembershipId: string },
) {
  const open = await tx
    .select({
      id: approvals.id,
      workUnitId: approvals.workUnitId,
      approver: approvals.approverMembershipId,
      requestedBy: approvals.requestedByMembershipId,
      holdsWork: approvals.holdsWork,
      role: memberships.role,
      memberStatus: memberships.status,
    })
    .from(approvals)
    .innerJoin(memberships, eq(memberships.id, approvals.approverMembershipId))
    .where(
      and(
        eq(approvals.status, 'pending'),
        'workUnitId' in scope
          ? eq(approvals.workUnitId, scope.workUnitId)
          : eq(approvals.approverMembershipId, scope.approverMembershipId),
      ),
    );
  for (const review of open) {
    const [work] = await tx
      .select()
      .from(workUnits)
      .where(eq(workUnits.id, review.workUnitId))
      .for('update');
    if (!work) continue;
    const canStillRead =
      review.memberStatus === 'active' &&
      (await memberCanRead(tx, work, { membershipId: review.approver, role: review.role }));
    if (canStillRead) continue;
    await tx
      .update(approvals)
      .set({ status: 'cancelled', decidedAt: new Date() })
      .where(and(eq(approvals.id, review.id), eq(approvals.status, 'pending')));
    await clearApprovalNotifications(tx, [review.id]);
    await auditAction(
      tx,
      context,
      'approval.closed',
      `approval:${review.id}`,
      'APPROVER_LOST_ACCESS',
    );
    await notify(
      tx,
      context,
      [work.ownerMembershipId, review.requestedBy],
      'approval.closed',
      `work_unit:${work.id}`,
    );
    if (review.holdsWork && work.status === 'awaiting_approval' && work.runId) {
      await failRun(tx, context, work);
    }
    await emit(tx, context, {
      eventType: 'approval.resolved',
      aggregateType: 'work_unit',
      aggregateId: work.id,
      aggregateVersion: work.version,
      classification: work.classification,
      payload: { approval_id: review.id, work_unit_id: work.id, outcome: 'cancelled' },
    });
  }
}

const MAX_REASON_LENGTH = 2000;

/** The one path by which a status changes, in one transaction with its event. */
export async function applyTransition(
  tx: Tx,
  context: TenantContext,
  current: WorkRow,
  to: WorkState,
  options: { reason?: string; correlationId?: string; causationId?: string; runId?: string } = {},
) {
  const reason = options.reason?.trim().slice(0, MAX_REASON_LENGTH) || undefined;
  const decision = decideTransition({
    from: current.status as WorkState,
    to,
    incompletePrerequisites: to === 'ready' ? await incompletePrerequisites(tx, current.id) : 0,
    criteria: current.completionCriteria as CompletionCriterion[],
    evidence: to === 'completed' ? await evidenceFor(tx, current) : emptyEvidence,
    ...(reason !== undefined ? { reason } : {}),
  });
  if (!decision.ok) throw new AppError(decision.reason);

  const nextVersion = current.version + 1;
  const [row] = await tx
    .update(workUnits)
    .set({
      status: to,
      version: nextVersion,
      updatedAt: new Date(),
      // Leaving ready answers any request to run, however it was left. A delayed event then finds
      // nothing to act on.
      ...(current.status === 'ready' ? { runRequestedAt: null } : {}),
      // A run holds the work only while it is running or waiting on its own review.
      runId:
        to === 'running' || to === 'awaiting_approval' ? (options.runId ?? current.runId) : null,
    })
    .where(and(eq(workUnits.id, current.id), eq(workUnits.version, current.version)))
    .returning();
  if (!row) throw new AppError('VERSION_CONFLICT');

  // The reason is free text, so it stays here, under the Work Unit's own access rules. It goes into
  // no event, no audit entry and nothing that travels to Temporal.
  await tx.insert(workTransitions).values({
    organizationId: context.organizationId,
    workUnitId: current.id,
    fromStatus: current.status,
    toStatus: to,
    actorMembershipId: context.actorType === 'service' ? null : context.membershipId,
    reason: reason ?? null,
  });

  await emit(tx, context, {
    eventType: 'work.transitioned',
    aggregateType: 'work_unit',
    aggregateId: current.id,
    aggregateVersion: nextVersion,
    classification: current.classification,
    payload: { work_unit_id: current.id, from: current.status, to },
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    ...(options.causationId ? { causationId: options.causationId } : {}),
  });
  await appendAudit(tx, {
    organizationId: context.organizationId,
    actorType: context.actorType === 'service' ? 'service' : 'user',
    ...(context.actorType === 'service' ? {} : { actorId: context.membershipId }),
    action: 'work.transitioned',
    targetRef: `work_unit:${current.id}`,
    decision: 'allow',
    safeReason: to.toUpperCase(),
  });

  // A person stopping work must also stop any workflow running it. Activities check status too, so
  // nothing further happens even if this signal is delayed.
  if (to === 'cancelled' && context.actorType === 'user' && current.executionPlan) {
    await emit(tx, context, {
      eventType: 'work.stop_requested',
      aggregateType: 'work_unit',
      aggregateId: current.id,
      aggregateVersion: nextVersion,
      classification: current.classification,
      payload: { work_unit_id: current.id },
    });
  }

  // Finished work has nothing left to decide, so nobody is left being asked.
  if (to === 'cancelled' || to === 'completed' || to === 'failed') {
    await closeApprovals(tx, context, current.id, ['pending'], 'WORK_FINISHED');
  }
  // Going round again starts afresh: a review from an earlier round is not a review of this one.
  if (to === 'ready' && (current.status === 'completed' || current.status === 'failed')) {
    await closeApprovals(tx, context, current.id, ['pending', 'approved'], 'WORK_REOPENED');
  }
  if (to === 'cancelled' || to === 'failed') {
    const kind = to === 'cancelled' ? 'work.stopped' : 'work.failed';
    await notify(tx, context, [current.ownerMembershipId], kind, `work_unit:${current.id}`);
  }

  if (to === 'completed') await promoteDependents(tx, context, current.id);
  return row;
}

const emptyEvidence = { artifactCount: 0, approvedReviewCount: 0, verifiedReceiptCount: 0 };

/**
 * Ends a workflow run's hold on its work honestly, whichever step it had reached. Going again takes a
 * person, who can see that it failed and press Try again.
 */
export async function failRun(tx: Tx, context: TenantContext, work: WorkRow) {
  switch (work.status as WorkState) {
    case 'running':
      return applyTransition(tx, context, work, 'failed');
    case 'verifying':
    case 'awaiting_approval':
    case 'ready':
      return applyTransition(
        tx,
        context,
        await applyTransition(tx, context, work, 'running'),
        'failed',
      );
    default:
      return work;
  }
}

/** Completing a prerequisite moves any queued dependent with nothing else outstanding to ready. */
async function promoteDependents(tx: Tx, context: TenantContext, id: string) {
  const dependents = await tx
    .select({ id: workDependencies.dependentId })
    .from(workDependencies)
    .where(eq(workDependencies.prerequisiteId, id));
  for (const dependent of dependents) {
    const [row] = await tx
      .select()
      .from(workUnits)
      .where(and(eq(workUnits.id, dependent.id), eq(workUnits.status, 'queued')))
      .for('update');
    if (row && (await incompletePrerequisites(tx, row.id)) === 0) {
      await applyTransition(tx, context, row, 'ready', { causationId: id });
    }
  }
}

export function transitionWorkUnit(
  database: AppDatabase,
  context: TenantContext,
  input: { id: string; expectedVersion: number; to: WorkState; reason?: string },
) {
  return withTenantTx(database, context, async (tx) => {
    const current = await loadChangeable(tx, context, input.id);
    if (current.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    // A pause starts when a review is requested and ends when it is decided. The state machine allows
    // those moves because the approval path needs them. Nobody else may make them.
    if (isApprovalOnlyTransition(current.status as WorkState, input.to)) {
      throw new AppError('INVALID_TRANSITION');
    }
    return applyTransition(tx, context, current, input.to, {
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  });
}

/**
 * Asks for this Work Unit's plan to run. The dispatcher starts the workflow from this event. When the
 * plan needs a review, it is decided now who gives it, and that can never be the person running it.
 */
export function requestExecution(
  database: AppDatabase,
  context: TenantContext,
  id: string,
  options: { reviewerMembershipId?: string } = {},
) {
  return withTenantTx(database, context, async (tx) => {
    const current = await loadChangeable(tx, context, id);
    if (!current.executionPlan) throw new AppError('INVALID_STATE');
    if (current.status !== 'ready') throw new AppError('INVALID_STATE');
    const needsReview = (current.completionCriteria as CompletionCriterion[]).some(
      (criterion) => criterion.kind === 'reviewer_approved',
    );
    const reviewer = options.reviewerMembershipId ?? current.ownerMembershipId;
    if (needsReview) {
      if (reviewer === context.membershipId) throw new AppError('APPROVAL_SELF_APPROVAL');
      await assertActiveMember(tx, reviewer);
    }
    await tx
      .update(workUnits)
      .set({
        runRequestedAt: new Date(),
        runRequestedByMembershipId: context.membershipId,
        planReviewerMembershipId: needsReview ? reviewer : null,
      })
      .where(eq(workUnits.id, id));
    await emit(tx, context, {
      eventType: 'work.execution_requested',
      aggregateType: 'work_unit',
      aggregateId: id,
      aggregateVersion: current.version,
      classification: current.classification,
      payload: { work_unit_id: id },
    });
    return current;
  });
}

export async function addDependency(
  database: AppDatabase,
  context: TenantContext,
  input: { dependentId: string; prerequisiteId: string },
) {
  if (input.dependentId === input.prerequisiteId) throw new AppError('DEPENDENCY_CYCLE');
  return withTenantTx(database, context, async (tx) => {
    const dependent = await loadChangeable(tx, context, input.dependentId);
    await loadReadable(tx, context, input.prerequisiteId);
    if (dependent.status !== 'queued' && dependent.status !== 'blocked') {
      throw new AppError('INVALID_STATE');
    }
    try {
      await tx.insert(workDependencies).values({
        organizationId: context.organizationId,
        dependentId: input.dependentId,
        prerequisiteId: input.prerequisiteId,
      });
    } catch (error) {
      if (pgCode(error) === 'EN001') throw new AppError('DEPENDENCY_CYCLE');
      if (pgCode(error) === '23505') return; // Already there, so nothing to do.
      throw error;
    }
    await emit(tx, context, {
      eventType: 'work.dependency_added',
      aggregateType: 'work_unit',
      aggregateId: input.dependentId,
      aggregateVersion: dependent.version,
      classification: dependent.classification,
      payload: { work_unit_id: input.dependentId, prerequisite_id: input.prerequisiteId },
    });
  });
}

export function removeDependency(
  database: AppDatabase,
  context: TenantContext,
  input: { dependentId: string; prerequisiteId: string },
) {
  return withTenantTx(database, context, async (tx) => {
    const dependent = await loadChangeable(tx, context, input.dependentId);
    if (isTerminal(dependent.status as WorkState)) throw new AppError('INVALID_STATE');
    const removed = await tx
      .delete(workDependencies)
      .where(
        and(
          eq(workDependencies.dependentId, input.dependentId),
          eq(workDependencies.prerequisiteId, input.prerequisiteId),
        ),
      )
      .returning({ id: workDependencies.prerequisiteId });
    if (removed.length === 0) return;
    await emit(tx, context, {
      eventType: 'work.dependency_removed',
      aggregateType: 'work_unit',
      aggregateId: input.dependentId,
      aggregateVersion: dependent.version,
      classification: dependent.classification,
      payload: { work_unit_id: input.dependentId, prerequisite_id: input.prerequisiteId },
    });
    await auditAction(tx, context, 'work.dependency_removed', `work_unit:${input.dependentId}`);
  });
}

/**
 * One accountable owner, always. Ownership moves; it cannot be emptied. It can still move on finished
 * work, because someone leaving must not stay the only person with access to it.
 */
export function setOwner(
  database: AppDatabase,
  context: TenantContext,
  input: { id: string; expectedVersion: number; ownerMembershipId: string },
) {
  return withTenantTx(database, context, async (tx) => {
    const current = await loadChangeable(tx, context, input.id);
    if (current.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    await assertActiveMember(tx, input.ownerMembershipId);
    const nextVersion = current.version + 1;
    const [row] = await tx
      .update(workUnits)
      .set({
        ownerMembershipId: input.ownerMembershipId,
        version: nextVersion,
        updatedAt: new Date(),
      })
      .where(and(eq(workUnits.id, input.id), eq(workUnits.version, input.expectedVersion)))
      .returning();
    if (!row) throw new AppError('VERSION_CONFLICT');
    await emit(tx, context, {
      eventType: 'work.owner_changed',
      aggregateType: 'work_unit',
      aggregateId: input.id,
      aggregateVersion: nextVersion,
      classification: current.classification,
      payload: { work_unit_id: input.id, owner_membership_id: input.ownerMembershipId },
    });
    await auditAction(tx, context, 'work.owner_changed', `work_unit:${input.id}`);
    await notify(tx, context, [input.ownerMembershipId], 'work.assigned', `work_unit:${input.id}`);
    // Ownership grants access, so moving it can take access away from a reviewer.
    await closeReviewsForLostAccess(tx, context, { workUnitId: input.id });
    return row;
  });
}

export function assignContributor(
  database: AppDatabase,
  context: TenantContext,
  input: { id: string; membershipId: string; responsibility?: 'contributor' | 'reviewer' },
) {
  return withTenantTx(database, context, async (tx) => {
    const work = await loadChangeable(tx, context, input.id);
    if (isTerminal(work.status as WorkState)) throw new AppError('INVALID_STATE');
    await assertActiveMember(tx, input.membershipId);
    const added = await tx
      .insert(workAssignments)
      .values({
        organizationId: context.organizationId,
        workUnitId: input.id,
        membershipId: input.membershipId,
        responsibility: input.responsibility ?? 'contributor',
      })
      .onConflictDoNothing()
      .returning({ id: workAssignments.membershipId });
    if (added.length === 0) return;
    // This grants access, so it is recorded as firmly as anything else that does.
    await emit(tx, context, {
      eventType: 'work.assigned',
      aggregateType: 'work_unit',
      aggregateId: input.id,
      aggregateVersion: work.version,
      classification: work.classification,
      payload: { work_unit_id: input.id, membership_id: input.membershipId },
    });
    await appendAssignmentAudit(tx, context, 'work.assigned', work, input.membershipId);
    await notify(tx, context, [input.membershipId], 'work.assigned', `work_unit:${input.id}`);
  });
}

/** Taking someone off the work stays possible whatever its status: revoking access must always work. */
export function unassign(
  database: AppDatabase,
  context: TenantContext,
  input: { id: string; membershipId: string },
) {
  return withTenantTx(database, context, async (tx) => {
    const work = await loadChangeable(tx, context, input.id);
    const removed = await tx
      .delete(workAssignments)
      .where(
        and(
          eq(workAssignments.workUnitId, input.id),
          eq(workAssignments.membershipId, input.membershipId),
        ),
      )
      .returning({ id: workAssignments.membershipId });
    if (removed.length === 0) return;
    await emit(tx, context, {
      eventType: 'work.unassigned',
      aggregateType: 'work_unit',
      aggregateId: input.id,
      aggregateVersion: work.version,
      classification: work.classification,
      payload: { work_unit_id: input.id, membership_id: input.membershipId },
    });
    await appendAssignmentAudit(tx, context, 'work.unassigned', work, input.membershipId);
    await closeReviewsForLostAccess(tx, context, { workUnitId: input.id });
  });
}

/** Names both the work, in the target, and the person whose access moved, in the event beside it. */
async function appendAssignmentAudit(
  tx: Tx,
  context: TenantContext,
  action: string,
  work: WorkRow,
  membershipId: string,
) {
  await auditAction(
    tx,
    context,
    action,
    `membership:${membershipId}`,
    work.classification.toUpperCase(),
  );
  await auditAction(tx, context, action, `work_unit:${work.id}`, work.classification.toUpperCase());
}

/** Everything a Work Unit page needs, with permission checked first. */
export function getWorkDetail(database: AppDatabase, context: TenantContext, id: string) {
  return withTenantTx(database, context, async (tx) => {
    const work = await loadReadable(tx, context, id);
    const prerequisites = await tx
      .select({ id: workUnits.id, title: workUnits.title, status: workUnits.status })
      .from(workDependencies)
      .innerJoin(workUnits, eq(workUnits.id, workDependencies.prerequisiteId))
      .where(and(eq(workDependencies.dependentId, id), visibleTo(context)))
      .orderBy(asc(workUnits.createdAt));
    const dependents = await tx
      .select({ id: workUnits.id, title: workUnits.title, status: workUnits.status })
      .from(workDependencies)
      .innerJoin(workUnits, eq(workUnits.id, workDependencies.dependentId))
      .where(and(eq(workDependencies.prerequisiteId, id), visibleTo(context)))
      .orderBy(asc(workUnits.createdAt));
    const people = await tx
      .select({
        membershipId: workAssignments.membershipId,
        responsibility: workAssignments.responsibility,
        name: users.name,
      })
      .from(workAssignments)
      .innerJoin(memberships, eq(memberships.id, workAssignments.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(workAssignments.workUnitId, id),
          // The owner is shown as the owner. An assignment they also hold grants nothing more.
          ne(workAssignments.membershipId, work.ownerMembershipId),
        ),
      );
    const [owner] = await tx
      .select({ name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.id, work.ownerMembershipId));
    const files = await tx
      .select({
        id: artifacts.id,
        name: artifacts.name,
        mimeType: artifacts.mimeType,
        sizeBytes: artifacts.sizeBytes,
        createdAt: artifacts.createdAt,
      })
      .from(workArtifacts)
      .innerJoin(artifacts, eq(artifacts.id, workArtifacts.artifactId))
      .where(eq(workArtifacts.workUnitId, id))
      .orderBy(asc(artifacts.createdAt));
    const reviewRows = await tx
      .select({
        id: approvals.id,
        toolName: approvals.toolName,
        status: approvals.status,
        approverMembershipId: approvals.approverMembershipId,
        requestedByMembershipId: approvals.requestedByMembershipId,
        holdsWork: approvals.holdsWork,
        expiresAt: approvals.expiresAt,
        boundHash: approvals.actionHash,
      })
      .from(approvals)
      .where(eq(approvals.workUnitId, id))
      .orderBy(desc(approvals.createdAt));
    const now = new Date();
    const action = await currentReviewAction(tx, work);
    const reviews = reviewRows.map(({ boundHash, ...review }) => ({
      ...review,
      // Approved, but for something other than what the work holds now.
      outdated:
        review.status === 'approved' &&
        !reviewCovers(
          { toolName: review.toolName, status: 'approved', expiresAt: review.expiresAt, boundHash },
          action,
          now,
        ),
    }));
    const history = await tx
      .select({
        id: workTransitions.id,
        fromStatus: workTransitions.fromStatus,
        toStatus: workTransitions.toStatus,
        reason: workTransitions.reason,
        occurredAt: workTransitions.occurredAt,
        actorName: users.name,
      })
      .from(workTransitions)
      .leftJoin(memberships, eq(memberships.id, workTransitions.actorMembershipId))
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(eq(workTransitions.workUnitId, id))
      .orderBy(desc(workTransitions.occurredAt));
    const canChange =
      context.actorType === 'service' ||
      canChangeWork(accessFacts(work, await assignedTo(tx, context, id)), viewer(context));
    return {
      work,
      ownerName: owner?.name ?? null,
      prerequisites,
      dependents,
      people,
      files,
      reviews,
      history,
      evidence: await evidenceFor(tx, work, now),
      canChange,
    };
  });
}

/** A short title for a browser tab, or nothing if this person may not see the work. */
export function getWorkTitle(database: AppDatabase, context: TenantContext, id: string) {
  return withTenantTx(database, context, async (tx) => (await loadReadable(tx, context, id)).title);
}

/** Running work whose workflow run has gone quiet, for a sweep to check with Temporal. */
export function listHeldRuns(database: AppDatabase, context: TenantContext, olderThan: Date) {
  return withTenantTx(database, context, (tx) =>
    tx
      .select({ id: workUnits.id, runId: workUnits.runId })
      .from(workUnits)
      .where(
        and(
          inArray(workUnits.status, ['running', 'awaiting_approval']),
          isNotNull(workUnits.runId),
          lt(workUnits.updatedAt, olderThan),
        ),
      )
      .limit(50),
  );
}
