// Work Unit services. Each one checks permission itself: callers are not trusted to have done so.
import { createHash, randomUUID } from 'node:crypto';
import {
  actorOf,
  appendAudit,
  artifacts,
  domainEvents,
  externalActions,
  memberships,
  notifications,
  outboxEvents,
  projects,
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
  workReviewActionFromContentHash,
} from '@ensemus/domain/approval';
import { isTerminalWorkControl, type TerminalWorkControl } from './ai/terminal-work-control';
import { workTitleInput } from './work-title';
import {
  can,
  canChangeWork,
  canManageWork,
  canReadWork,
  type Classification,
} from '@ensemus/domain/policy';
import {
  canChangeContent,
  completionBasis,
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
  lt,
  ne,
  not,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { AppError, foreignReference, pgCode } from './errors';
import { emit } from './events';
import { canonicalId, idSchema } from './ids';
import {
  countVerifiedReceipts,
  countVerifiedReceiptsByWork,
  hasActionConnection,
  onApprovalClosedInTx,
} from './external-actions';
import { idFromRequest } from './request-id';
import { heldReviewArtifactIdsInTx } from './work-review-control';
import {
  consumeDelegatedWorkDisposition,
  type DelegatedWorkDisposition,
} from './knowledge/delegated-work-redaction';

// An outside system's receipt is only offered to a tenant with a connection that could produce one, which
// createWorkUnit checks. Otherwise the criterion could never be met and the work could never finish.
const criteriaSchema = z.array(
  z.strictObject({ kind: z.enum(['artifact_exists', 'reviewer_approved', 'external_receipt']) }),
);

export const createWorkInput = z.strictObject({
  title: workTitleInput,
  objective: z.string().trim().max(10_000).optional(),
  projectId: idSchema.optional(),
  ownerMembershipId: idSchema.optional(),
  classification: z.enum(['public', 'internal', 'confidential', 'restricted']).default('internal'),
  dueAt: z.coerce.date().optional(),
  completionCriteria: criteriaSchema.default([]),
  executionPlan: z.enum(['checklist']).optional(),
  requestKey: idSchema.optional(),
});

export const updateWorkInput = z.strictObject({
  title: workTitleInput.optional(),
  objective: z.string().trim().max(10_000).optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

export type WorkRow = typeof workUnits.$inferSelect;
/** Status-only facts. No title, objective, plan text, criteria or fabricated full Work row. */
export type WorkTransitionMetadata = Pick<
  WorkRow,
  | 'id'
  | 'status'
  | 'version'
  | 'classification'
  | 'ownerMembershipId'
  | 'runId'
  | 'runRequestedAt'
  | 'runRequestedByMembershipId'
>;
type WorkTransitionPatch = Pick<WorkRow, 'status' | 'version' | 'updatedAt' | 'runId'> & {
  runRequestedAt?: null;
};

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
  const result = await tx.execute<{ readable: boolean }>(
    sql`select knowledge.can_read_work(${work.id}::uuid,${member.membershipId}::uuid) as readable`,
  );
  return result.rows[0]?.readable === true;
}

/**
 * Loads a Work Unit for reading. Work someone may not see is reported as not found, so its existence
 * does not leak. Workflow Activities run as a service, and only ever on the unit they were started
 * for. An agent is not a service: it falls through here to its initiator's access (ADR-028 FD-3).
 */
export async function loadReadable(tx: Tx, context: TenantContext, id: string, lock = false) {
  const query = tx
    .select()
    .from(workUnits)
    .where(
      and(
        eq(workUnits.id, id),
        context.actorType === 'service'
          ? undefined
          : sql`knowledge.can_read_work(${workUnits.id},${context.membershipId}::uuid)`,
      ),
    );
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

/**
 * For a change only someone who answers for the work may make: its accountable owner, or an
 * organization owner or admin who can see it. Being assigned is not enough (WORK-03).
 */
async function assertCanManage(tx: Tx, context: TenantContext, work: WorkRow) {
  if (context.actorType === 'service') return;
  const isAssigned = await assignedTo(tx, context, work.id);
  if (!canManageWork(accessFacts(work, isAssigned), viewer(context))) {
    throw new AppError('FORBIDDEN');
  }
}

async function loadManageable(tx: Tx, context: TenantContext, id: string) {
  const row = await loadChangeable(tx, context, id);
  await assertCanManage(tx, context, row);
  return row;
}

/**
 * Row-level security limits this to the tenant, so a member it cannot find is one from somewhere else.
 * Someone disabled is an ordinary thing to run into, on a page that was open when it happened.
 */
export async function assertActiveMember(tx: Tx, membershipId: string) {
  if (!idSchema.safeParse(membershipId).success) throw new AppError('INVALID_INPUT');
  const [member] = await tx
    .select({ status: memberships.status })
    .from(memberships)
    .where(eq(memberships.id, membershipId));
  if (!member) throw foreignReference();
  if (member.status !== 'active') throw new AppError('INVALID_INPUT');
}

async function assertProjectInTenant(tx: Tx, projectId: string) {
  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw foreignReference();
}

/**
 * Creates a Work Unit. A `requestKey` makes this safe to repeat: one rendered form sent again with the
 * same content leads to the same Work Unit, so a double-click or a resent page gets the first one back
 * and creates nothing. The same form sent with other content makes its own (see idFromRequest).
 */
export async function createWorkUnit(
  database: AppDatabase,
  context: TenantContext,
  raw: z.input<typeof createWorkInput>,
) {
  return withTenantTx(database, context, (tx) => createWorkUnitInTx(tx, context, raw));
}

/** The same kernel operation, for an atomic company workflow hierarchy. */
export async function createWorkUnitInTx(
  tx: Tx,
  context: TenantContext,
  raw: z.input<typeof createWorkInput>,
  hierarchy: { parentId: string } | undefined = undefined,
) {
  if (!can(context.role, 'work.create')) throw new AppError('FORBIDDEN');
  const parsed = createWorkInput.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const input = parsed.data;
  const { requestKey, ...content } = input;
  const parentId = hierarchy ? idSchema.safeParse(hierarchy.parentId) : undefined;
  if (parentId && !parentId.success) throw new AppError('INVALID_INPUT');
  if (parentId?.success) {
    const parent = await loadChangeable(tx, context, parentId.data);
    if (!canChangeContent(parent.status as WorkState)) throw new AppError('INVALID_STATE');
  }
  const id = requestKey
    ? idFromRequest(
        'work',
        context.membershipId,
        requestKey,
        parentId?.success ? { ...content, parentId: parentId.data } : content,
      )
    : randomUUID();
  const owner = input.ownerMembershipId ?? context.membershipId;
  await assertActiveMember(tx, owner);
  if (input.projectId) await assertProjectInTenant(tx, input.projectId);
  const asksForReceipt = input.completionCriteria.some(
    (criterion) => criterion.kind === 'external_receipt',
  );
  if (asksForReceipt && !(await hasActionConnection(tx))) throw new AppError('INVALID_INPUT');
  const [row] = await tx
    .insert(workUnits)
    .values({
      organizationId: context.organizationId,
      id,
      title: input.title,
      objective: input.objective ?? null,
      projectId: input.projectId ?? null,
      parentId: parentId?.success ? parentId.data : null,
      ownerMembershipId: owner,
      createdByMembershipId: context.membershipId,
      classification: input.classification,
      dueAt: input.dueAt ?? null,
      completionCriteria: input.completionCriteria,
      executionPlan: input.executionPlan ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return loadReadable(tx, context, id);
  await tx.insert(workAssignments).values({
    organizationId: context.organizationId,
    workUnitId: id,
    membershipId: context.membershipId,
    responsibility: 'contributor',
    actorType: 'human',
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
  if (context.actorType !== 'service')
    return sql`knowledge.can_read_work(${workUnits.id},${context.membershipId}::uuid)`;
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

/**
 * The work list for people: each page with who answers for each item and how its evidence stands, by
 * the same rule as the work's own page. The API's list keeps to what its contract states.
 */
export async function listWorkOverview(
  database: AppDatabase,
  context: TenantContext,
  options: Parameters<typeof listWorkUnits>[2] = {},
) {
  const page = await listWorkUnits(database, context, options);
  const ids = page.items.map((work) => work.id);
  if (ids.length === 0) return { ...page, items: [] };
  const now = new Date();
  const { owners, files, approved, receipts } = await withTenantTx(
    database,
    context,
    async (tx) => ({
      owners: await tx
        .select({ membershipId: memberships.id, name: users.name })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          inArray(
            memberships.id,
            page.items.map((work) => work.ownerMembershipId),
          ),
        ),
      files: await tx
        .select({
          workUnitId: workArtifacts.workUnitId,
          id: artifacts.id,
          countsAsEvidence: artifactEvidenceFor(workArtifacts.workUnitId),
        })
        .from(workArtifacts)
        .innerJoin(artifacts, eq(artifacts.id, workArtifacts.artifactId))
        .where(inArray(workArtifacts.workUnitId, ids)),
      approved: await tx
        .select({ workUnitId: approvals.workUnitId, ...APPROVED_REVIEW })
        .from(approvals)
        .where(and(inArray(approvals.workUnitId, ids), eq(approvals.status, 'approved'))),
      receipts: await countVerifiedReceiptsByWork(tx, ids),
    }),
  );
  const ownerName = new Map(owners.map((owner) => [owner.membershipId, owner.name]));
  return {
    ...page,
    items: page.items.map((work) => ({
      ...work,
      ownerName: ownerName.get(work.ownerMembershipId) ?? null,
      evidence: countEvidence(
        work,
        files.filter((file) => file.workUnitId === work.id),
        approved.filter((review) => review.workUnitId === work.id),
        receipts.get(work.id) ?? 0,
        now,
      ),
    })),
  };
}

const encodeCursor = (at: string, id: string) =>
  Buffer.from(JSON.stringify([at, id])).toString('base64url');

// A timestamp exactly as PostgreSQL wrote it, or the ISO form of an older cursor, and nothing else.
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/;

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const parsed = z
      .tuple([z.string().regex(CURSOR_TIME), idSchema])
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
    await recordWorkContentUpdate(
      tx,
      context,
      row,
      async () => actionHash(await currentReviewAction(tx, row)),
      () => failRun(tx, context, row),
    );
    return row;
  });
}

export async function incompletePrerequisites(tx: Tx, id: string) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(workDependencies)
    .innerJoin(workUnits, eq(workUnits.id, workDependencies.prerequisiteId))
    .where(and(eq(workDependencies.dependentId, id), ne(workUnits.status, 'completed')));
  return row?.n ?? 0;
}

async function fileFacts(tx: Tx, id: string) {
  return tx
    .select({ id: artifacts.id, countsAsEvidence: artifactEvidenceFor(sql`${id}::uuid`) })
    .from(workArtifacts)
    .innerJoin(artifacts, eq(artifacts.id, workArtifacts.artifactId))
    .where(eq(workArtifacts.workUnitId, id));
}

/** Generated text proves completion only after fresh exact acceptance, or the pinned onboarding
 * adoption bridge. Neither a model's own output nor a stale/foreign Work acceptance is enough. */
function artifactEvidenceFor(workId: SQL | typeof workArtifacts.workUnitId) {
  return sql<boolean>`case when ${artifacts.provenanceState}='ordinary'
      and ${artifacts.createdByMembershipId} is not null then true
    else knowledge.artifact_is_accepted(${artifacts.id},${workId})
      or knowledge.onboarding_artifact_evidence(${artifacts.id},${workId}) end`;
}

/** The review a Work Unit would need right now: its current text and its current files. */
export async function currentReviewAction(tx: Tx, work: WorkRow) {
  const controlled = await heldReviewArtifactIdsInTx(tx, work);
  if (controlled !== null) return workReviewAction(work, controlled);
  const files = await fileFacts(tx, work.id);
  return workReviewAction(
    work,
    files.map((file) => file.id),
  );
}

/**
 * What the work can show right now. This is the only place evidence is counted, and both completion
 * paths and the page go through it. A generated file requires current exact human acceptance. A
 * review counts only while it covers exactly what the work now holds.
 */
export async function evidenceFor(tx: Tx, work: WorkRow, now = new Date()) {
  const files = await fileFacts(tx, work.id);
  const approved = await tx
    .select(APPROVED_REVIEW)
    .from(approvals)
    .where(and(eq(approvals.workUnitId, work.id), eq(approvals.status, 'approved')));
  return countEvidence(work, files, approved, await countVerifiedReceipts(tx, work.id), now);
}

const APPROVED_REVIEW = {
  toolName: approvals.toolName,
  expiresAt: approvals.expiresAt,
  boundHash: approvals.actionHash,
};

function countEvidence(
  work: WorkRow,
  files: ReadonlyArray<{ id: string; countsAsEvidence: boolean }>,
  approved: ReadonlyArray<{ toolName: string; expiresAt: Date; boundHash: string }>,
  verifiedReceiptCount: number,
  now: Date,
) {
  const current = workReviewAction(
    work,
    files.map((file) => file.id),
  );
  return {
    artifactCount: files.filter((file) => file.countsAsEvidence).length,
    approvedReviewCount: approved.filter((row) =>
      reviewCovers({ ...row, status: 'approved' }, current, now),
    ).length,
    verifiedReceiptCount,
  };
}

/**
 * Marks notifications about approvals as dealt with, so they stop asking for a decision. That includes
 * one its reader has already opened, which would otherwise still have a reminder waiting.
 */
export async function clearApprovalNotifications(tx: Tx, approvalIds: readonly string[]) {
  if (approvalIds.length === 0) return;
  await tx
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, now())`, remindAt: null })
    .where(
      inArray(
        notifications.targetRef,
        approvalIds.map((id) => `approval:${id}`),
      ),
    );
}

/** Tells these people something, by reference only. An agent's human initiator still needs notice. */
export async function notify(
  tx: Tx,
  context: TenantContext,
  recipients: ReadonlyArray<string | null | undefined>,
  kind: string,
  targetRef: string,
) {
  const unique = new Set(recipients.filter((id): id is string => Boolean(id)).map(canonicalId));
  if (context.actorType === 'user') unique.delete(context.membershipId);
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
    ...actorOf(context),
    action,
    targetRef,
    decision: 'allow',
    ...(safeReason ? { safeReason } : {}),
  });
}

/**
 * Everything closing an open approval has to do once it is closed, whatever closed it: nobody is left
 * being asked, the record says why, the event gives it an end, and the people relying on it are told.
 * `kind` has to state the true reason, because it is what the inbox shows them. The work is given as
 * it now stands, so the event's version is not behind a transition in the same transaction.
 */
export async function recordApprovalClosed(
  tx: Tx,
  context: TenantContext,
  work: { id: string; version: number; classification: string },
  approvalId: string,
  closing: {
    reason: string;
    kind: string;
    tell: ReadonlyArray<string | null | undefined>;
  },
) {
  await clearApprovalNotifications(tx, [approvalId]);
  await onApprovalClosedInTx(tx, context, { approvalId, outcome: 'cancelled' });
  await auditAction(tx, context, 'approval.closed', `approval:${approvalId}`, closing.reason);
  await emit(tx, context, {
    eventType: 'approval.resolved',
    aggregateType: 'work_unit',
    aggregateId: work.id,
    aggregateVersion: work.version,
    classification: work.classification,
    payload: { approval_id: approvalId, work_unit_id: work.id, outcome: 'cancelled' },
  });
  await notify(tx, context, closing.tell, closing.kind, `work_unit:${work.id}`);
}

/** The work finished or went round again, which is a different thing to tell someone. */
const CLOSED_WITH_THE_WORK = {
  WORK_FINISHED: 'approval.work_finished',
  WORK_REOPENED: 'approval.work_reopened',
} as const;

/**
 * Closes approvals on a Work Unit that can no longer mean anything. An approved one was resolved when
 * it was decided, so it ends with no second resolution and nobody to tell.
 */
async function closeApprovals(
  tx: Tx,
  context: TenantContext,
  work: Pick<WorkRow, 'id' | 'version' | 'classification'>,
  statuses: readonly string[],
  reason: keyof typeof CLOSED_WITH_THE_WORK,
) {
  const open = new Map(
    (
      await tx
        .select({ id: approvals.id, requestedBy: approvals.requestedByMembershipId })
        .from(approvals)
        .where(and(eq(approvals.workUnitId, work.id), eq(approvals.status, 'pending')))
    ).map((row) => [row.id, row.requestedBy]),
  );
  const closed = await tx
    .update(approvals)
    .set({ status: 'cancelled', decidedAt: new Date() })
    .where(and(eq(approvals.workUnitId, work.id), inArray(approvals.status, [...statuses])))
    .returning({ id: approvals.id });
  for (const { id } of closed) {
    if (open.has(id)) {
      await recordApprovalClosed(tx, context, work, id, {
        reason,
        kind: CLOSED_WITH_THE_WORK[reason],
        tell: [open.get(id)],
      });
    } else {
      await clearApprovalNotifications(tx, [id]);
      await onApprovalClosedInTx(tx, context, { approvalId: id, outcome: 'cancelled' });
      await auditAction(tx, context, 'approval.closed', `approval:${id}`, reason);
    }
  }
}

/**
 * The work changed, so an open review of its old content is no longer the question. Closing it means
 * nobody is asked about something that has gone. Approved reviews need no change here: evidence is
 * worked out from what they bound, so they stop counting by themselves.
 *
 * Content cannot change while a review holds its work, so only re-applying the tombstone ledger can
 * bring that here. It ends the same way as a reviewer losing access: a plan cannot go on without its
 * reviewer, so that run fails, and paused manual work stays paused for someone to ask another person.
 */
export async function closeOutdatedReviews(tx: Tx, context: TenantContext, work: WorkRow) {
  return closeOutdatedReviewsByHash(
    tx,
    context,
    work,
    async () => actionHash(await currentReviewAction(tx, work)),
    () => failRun(tx, context, work),
  );
}

async function closeOutdatedReviewsByHash(
  tx: Tx,
  context: TenantContext,
  work: WorkTransitionMetadata,
  currentHash: () => Promise<string>,
  pause?: () => Promise<WorkTransitionMetadata>,
) {
  const open = await tx
    .select({
      id: approvals.id,
      hash: approvals.actionHash,
      holdsWork: approvals.holdsWork,
      requestedBy: approvals.requestedByMembershipId,
    })
    .from(approvals)
    .where(
      and(
        eq(approvals.workUnitId, work.id),
        eq(approvals.status, 'pending'),
        eq(approvals.toolName, WORK_REVIEW_TOOL),
      ),
    );
  if (open.length === 0) return;
  const hash = await currentHash();
  for (const review of open) {
    if (review.hash === hash) continue;
    await tx
      .update(approvals)
      .set({ status: 'cancelled', decidedAt: new Date() })
      .where(eq(approvals.id, review.id));
    const paused = review.holdsWork && work.status === 'awaiting_approval';
    if (paused && work.runId && !pause) throw new AppError('INVALID_STATE');
    const now = paused && work.runId && pause ? await pause() : work;
    await recordApprovalClosed(tx, context, now, review.id, {
      reason: 'CONTENT_CHANGED',
      kind: 'approval.outdated',
      tell: [review.requestedBy, paused ? work.ownerMembershipId : null],
    });
  }
}

/** Shared content-write effects. The ordinary path supplies its actual updated row; the privacy
 * path below supplies only fixed-SQL metadata with a one-use genuine disposition capability. */
async function recordWorkContentUpdate(
  tx: Tx,
  context: TenantContext,
  work: WorkTransitionMetadata,
  currentHash: () => Promise<string>,
  pause?: () => Promise<WorkTransitionMetadata>,
) {
  await emit(tx, context, {
    eventType: 'work.updated',
    aggregateType: 'work_unit',
    aggregateId: work.id,
    aggregateVersion: work.version,
    classification: work.classification,
    payload: { work_unit_id: work.id },
  });
  await closeOutdatedReviewsByHash(tx, context, work, currentHash, pause);
}

/** No arbitrary metadata/hash callback is exported for privacy writes. Only the fixed native
 * redaction RPC can issue this transaction/context-bound capability, once, after its real effect. */
export async function recordDelegatedWorkRedactionInTx(
  tx: Tx,
  context: TenantContext,
  disposition: DelegatedWorkDisposition,
) {
  if (!consumeDelegatedWorkDisposition(disposition, tx, context)) throw new AppError('FORBIDDEN');
  if (disposition.current.runId !== null) throw new AppError('INVALID_STATE');
  await recordWorkContentUpdate(tx, context, disposition.current, async () =>
    actionHash(
      workReviewActionFromContentHash(disposition.current.id, disposition.contentSha256, []),
    ),
  );
  await appendAudit(tx, {
    organizationId: context.organizationId,
    ...actorOf(context),
    action: 'ai.delegated_work_redacted',
    targetRef: `work_unit:${disposition.current.id}`,
    decision: 'allow',
    safeReason: 'INPUT_PURGED',
  });
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
    const closed = await tx
      .update(approvals)
      .set({ status: 'cancelled', decidedAt: new Date() })
      .where(and(eq(approvals.id, review.id), eq(approvals.status, 'pending')))
      .returning({ id: approvals.id });
    // It was decided while this waited for the lock, so that decision stands and nothing closed.
    if (closed.length === 0) continue;
    const endsRun = review.holdsWork && work.status === 'awaiting_approval' && work.runId;
    const now = endsRun ? await failRun(tx, context, work) : work;
    await recordApprovalClosed(tx, context, now, review.id, {
      reason: 'APPROVER_LOST_ACCESS',
      kind: 'approval.closed',
      tell: [work.ownerMembershipId, review.requestedBy],
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
): Promise<WorkRow> {
  const reason = options.reason?.trim().slice(0, MAX_REASON_LENGTH) || undefined;
  const decision = decideTransition({
    from: current.status as WorkState,
    to,
    incompletePrerequisites: to === 'ready' ? await incompletePrerequisites(tx, current.id) : 0,
    criteria: current.completionCriteria as CompletionCriterion[],
    evidence: to === 'completed' ? await evidenceFor(tx, current) : emptyEvidence,
    actorIsAccountableOwner:
      context.actorType === 'user' && context.membershipId === current.ownerMembershipId,
    ...(reason !== undefined ? { reason } : {}),
  });
  if (!decision.ok) throw new AppError(decision.reason);

  return persistWorkTransition<WorkRow>(
    tx,
    context,
    current,
    to,
    {
      ...options,
      reason,
      hasExecutionPlan: Boolean(current.executionPlan),
      basis:
        to === 'completed'
          ? completionBasis(current.completionCriteria as CompletionCriterion[])
          : null,
    },
    async (patch) => {
      const [row] = await tx
        .update(workUnits)
        .set(patch)
        .where(and(eq(workUnits.id, current.id), eq(workUnits.version, current.version)))
        .returning();
      if (!row) throw new AppError('VERSION_CONFLICT');
      return row;
    },
  );
}

/** One shared set of transition/history/review/notification/event effects for ordinary and fixed
 * terminal control writers. The latter can return only real metadata, never a fake WorkRow. */
async function persistWorkTransition<Row extends WorkTransitionMetadata>(
  tx: Tx,
  context: TenantContext,
  current: WorkTransitionMetadata,
  to: WorkState,
  options: {
    reason?: string | undefined;
    correlationId?: string;
    causationId?: string;
    runId?: string;
    hasExecutionPlan: boolean;
    basis: 'owner_confirmed' | 'evidence' | null;
  },
  write: (patch: WorkTransitionPatch) => Promise<Row>,
): Promise<Row> {
  const reason = options.reason;

  const nextVersion = current.version + 1;
  const row = await write({
    status: to,
    version: nextVersion,
    updatedAt: new Date(),
    // Leaving ready answers any request to run, however it was left. A delayed event then finds
    // nothing to act on.
    ...(current.status === 'ready' ? { runRequestedAt: null } : {}),
    // A run holds the work only while it is running or waiting on its own review.
    runId: to === 'running' || to === 'awaiting_approval' ? (options.runId ?? current.runId) : null,
  });

  // The reason is free text, so it stays here, under the Work Unit's own access rules. It goes into
  // no event, no audit entry and nothing that travels to Temporal.
  await tx.insert(workTransitions).values({
    organizationId: context.organizationId,
    workUnitId: current.id,
    fromVersion: current.version,
    fromStatus: current.status,
    toStatus: to,
    actorMembershipId: context.actorType === 'service' ? null : context.membershipId,
    reason: reason ?? null,
    completionBasis: options.basis,
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
    ...actorOf(context),
    action: 'work.transitioned',
    targetRef: `work_unit:${current.id}`,
    decision: 'allow',
    safeReason: to.toUpperCase(),
  });

  // A person stopping work must also stop any workflow running it. Activities check status too, so
  // nothing further happens even if this signal is delayed.
  if (to === 'cancelled' && context.actorType === 'user' && options.hasExecutionPlan) {
    await emit(tx, context, {
      eventType: 'work.stop_requested',
      aggregateType: 'work_unit',
      aggregateId: current.id,
      aggregateVersion: nextVersion,
      classification: current.classification,
      payload: { work_unit_id: current.id },
    });
  }

  // A person moving work out of ready withdraws any plan run asked for, so whoever asked is told. A
  // run claiming the work acts as a service, and that is the request being answered.
  if (current.status === 'ready' && current.runRequestedAt && context.actorType === 'user') {
    await notify(
      tx,
      context,
      [current.runRequestedByMembershipId],
      'work.run_withdrawn',
      `work_unit:${current.id}`,
    );
  }

  // Finished work has nothing left to decide, so nobody is left being asked.
  if (to === 'cancelled' || to === 'completed' || to === 'failed') {
    await closeApprovals(tx, context, row, ['pending'], 'WORK_FINISHED');
  }
  // Going round again starts afresh: a review from an earlier round is not a review of this one.
  if (to === 'ready' && (current.status === 'completed' || current.status === 'failed')) {
    await closeApprovals(tx, context, row, ['pending', 'approved'], 'WORK_REOPENED');
  }
  if (to === 'cancelled' || to === 'failed') {
    const kind = to === 'cancelled' ? 'work.stopped' : 'work.failed';
    await notify(tx, context, [current.ownerMembershipId], kind, `work_unit:${current.id}`);
  }

  if (to === 'completed') await promoteDependents(tx, context, current.id);
  return row;
}

/** Genuine exact-run capability only. It cannot mark completed or restart arbitrary Work. */
export async function releaseTerminalWorkInTx(
  tx: Tx,
  context: TenantContext,
  control: TerminalWorkControl,
) {
  if (!isTerminalWorkControl(control, tx, context)) throw new AppError('FORBIDDEN');
  const transition = async (to: 'running' | 'failed' | 'verifying') => {
    const current = control.current;
    // These conservative status transitions never consult completion evidence or owner-confirmed
    // criteria. A positive completion still goes through the ordinary human kernel above.
    const decision = decideTransition({
      from: current.status as WorkState,
      to,
      incompletePrerequisites: 0,
      criteria: [],
      evidence: emptyEvidence,
      actorIsAccountableOwner: false,
    });
    if (!decision.ok) throw new AppError(decision.reason);
    return persistWorkTransition(
      tx,
      context,
      current,
      to,
      { hasExecutionPlan: control.hasExecutionPlan, basis: null },
      (patch) => control.write(patch),
    );
  };
  if (control.runStatus === 'completed' || control.runStatus === 'outcome_unverified') {
    if (control.current.status !== 'running') return;
    const checking = await transition('verifying');
    await closeOutdatedReviewsByHash(tx, context, checking, async () =>
      actionHash(
        workReviewActionFromContentHash(
          checking.id,
          control.contentSha256,
          await control.visibleArtifactIds(),
        ),
      ),
    );
    return;
  }
  if (['ready', 'awaiting_approval', 'verifying'].includes(control.current.status))
    await transition('running');
  if (control.current.status === 'running') await transition('failed');
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
    // Stopping is for good, so it belongs to whoever answers for the work, not everyone on it.
    if (input.to === 'cancelled') await assertCanManage(tx, context, current);
    return applyTransition(tx, context, current, input.to, {
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  });
}

/**
 * Refuses someone a review cannot be asked of. Shared, so that disabling or demoting this person at
 * this moment either waits for this request to commit and then closes it, or commits first and is
 * seen here. Plain reads would miss each other. Being asked is not an access grant, and an approver has
 * to be able to see what they are approving.
 */
export async function assertCanBeAskedToReview(tx: Tx, work: WorkRow, membershipId: string) {
  await assertActiveMember(tx, membershipId);
  const [approver] = await tx
    .select({ id: memberships.id, role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(eq(memberships.id, membershipId))
    .for('share');
  if (approver?.status !== 'active') throw new AppError('INVALID_INPUT');
  if (!(await memberCanRead(tx, work, { membershipId: approver.id, role: approver.role }))) {
    throw new AppError('INVALID_INPUT');
  }
}

/**
 * Asks for this Work Unit's plan to run. The dispatcher starts the workflow from this event. When the
 * plan needs a review, it is decided now who gives it, and that can never be the person running it.
 * A request that stands cannot be repeated, or a second person could replace the named reviewer. If
 * nothing picks it up, the periodic sweep asks again, and starting by hand withdraws it. It moves the
 * version like any other change, so a form rendered before it cannot withdraw it without seeing it.
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
    if (current.runRequestedAt) throw new AppError('RUN_ALREADY_REQUESTED');
    const needsReview = (current.completionCriteria as CompletionCriterion[]).some(
      (criterion) => criterion.kind === 'reviewer_approved',
    );
    const reviewer = canonicalId(options.reviewerMembershipId ?? current.ownerMembershipId);
    if (needsReview) {
      if (reviewer === context.membershipId) throw new AppError('APPROVAL_SELF_APPROVAL');
      // Checked here, while a person can still be told. Access lost after this ends in a failed run.
      await assertCanBeAskedToReview(tx, current, reviewer);
    }
    const nextVersion = current.version + 1;
    const [row] = await tx
      .update(workUnits)
      .set({
        runRequestedAt: new Date(),
        runRequestedByMembershipId: context.membershipId,
        planReviewerMembershipId: needsReview ? reviewer : null,
        version: nextVersion,
        updatedAt: new Date(),
      })
      .where(and(eq(workUnits.id, id), eq(workUnits.version, current.version)))
      .returning();
    if (!row) throw new AppError('VERSION_CONFLICT');
    await emit(tx, context, {
      eventType: 'work.execution_requested',
      aggregateType: 'work_unit',
      aggregateId: id,
      aggregateVersion: nextVersion,
      classification: current.classification,
      payload: { work_unit_id: id },
    });
    return row;
  });
}

export async function addDependency(
  database: AppDatabase,
  context: TenantContext,
  input: { dependentId: string; prerequisiteId: string },
) {
  if (canonicalId(input.dependentId) === canonicalId(input.prerequisiteId)) {
    throw new AppError('DEPENDENCY_CYCLE');
  }
  return withTenantTx(database, context, async (tx) => {
    // The cycle trigger takes this same lock. Taken before any row lock, two opposite inserts queue
    // here, and the second gets a clean refusal instead of a deadlock with the first's foreign key.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`work_dependencies:${context.organizationId}`}, 0))`,
    );
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
    // Adding one takes being able to see it, and so does this. A hidden prerequisite that can still
    // finish keeps holding the work, and one that was stopped leaves through the function below.
    await loadReadable(tx, context, input.prerequisiteId);
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
 * Stops waiting on prerequisites this person cannot see, but only ones that were stopped, which can
 * never finish. They name none: being told one exists is all the page says, and this removes them
 * together, so no ID or title comes back. Anything still able to finish keeps holding the work.
 */
export function removeStoppedHiddenPrerequisites(
  database: AppDatabase,
  context: TenantContext,
  input: { dependentId: string },
) {
  if (context.actorType === 'service') throw new AppError('FORBIDDEN');
  return withTenantTx(database, context, async (tx) => {
    const dependent = await loadChangeable(tx, context, input.dependentId);
    if (isTerminal(dependent.status as WorkState)) throw new AppError('INVALID_STATE');
    const stopped = await tx
      .select({ id: workDependencies.prerequisiteId })
      .from(workDependencies)
      .innerJoin(workUnits, eq(workUnits.id, workDependencies.prerequisiteId))
      .where(
        and(
          eq(workDependencies.dependentId, input.dependentId),
          eq(workUnits.status, 'cancelled'),
          not(visibleTo(context) as SQL),
        ),
      );
    for (const { id } of stopped) {
      await tx
        .delete(workDependencies)
        .where(
          and(
            eq(workDependencies.dependentId, input.dependentId),
            eq(workDependencies.prerequisiteId, id),
          ),
        );
      await emit(tx, context, {
        eventType: 'work.dependency_removed',
        aggregateType: 'work_unit',
        aggregateId: input.dependentId,
        aggregateVersion: dependent.version,
        classification: dependent.classification,
        payload: { work_unit_id: input.dependentId, prerequisite_id: id },
      });
      await auditAction(
        tx,
        context,
        'work.dependency_removed',
        `work_unit:${input.dependentId}`,
        'HIDDEN_PREREQUISITE_STOPPED',
      );
    }
    return stopped.length;
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
    const current = await loadManageable(tx, context, input.id);
    return moveOwner(tx, context, current, input);
  });
}

async function moveOwner(
  tx: Tx,
  context: TenantContext,
  current: WorkRow,
  input: { id: string; expectedVersion: number; ownerMembershipId: string },
  auditReason?: string,
) {
  if (current.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
  const owner = canonicalId(input.ownerMembershipId);
  await assertActiveMember(tx, owner);
  const nextVersion = current.version + 1;
  const [row] = await tx
    .update(workUnits)
    .set({
      ownerMembershipId: owner,
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
    payload: { work_unit_id: input.id, owner_membership_id: owner },
  });
  await auditAction(tx, context, 'work.owner_changed', `work_unit:${input.id}`, auditReason);
  await notify(tx, context, [owner], 'work.assigned', `work_unit:${input.id}`);
  // Ownership grants access, so moving it can take access away from a reviewer.
  await closeReviewsForLostAccess(tx, context, { workUnitId: input.id });
  return row;
}

const DISABLED_OWNER_LIST_SIZE = 50;

/**
 * Work whose accountable owner was disabled, for the people page. Nobody else is told, and nothing else
 * would ever bring it up. Anyone managing members sees what they can already read, by title, and moves
 * it on its own page. Restricted work they cannot read goes to organization owners only, with no title
 * and nothing else about what it holds, because it can be moved from here and in no other way.
 */
export async function listWorkWithDisabledOwner(database: AppDatabase, context: TenantContext) {
  if (!can(context.role, 'member.manage')) throw new AppError('FORBIDDEN');
  const ownerDisabled = ne(memberships.status, 'active');
  const newestFirst = desc(workUnits.updatedAt);
  return withTenantTx(database, context, async (tx) => {
    const visible = await tx
      .select({ id: workUnits.id, title: workUnits.title, status: workUnits.status })
      .from(workUnits)
      .innerJoin(memberships, eq(memberships.id, workUnits.ownerMembershipId))
      .where(and(ownerDisabled, visibleTo(context)))
      .orderBy(newestFirst)
      .limit(DISABLED_OWNER_LIST_SIZE);
    const hidden = can(context.role, 'work.recover_owner')
      ? await tx
          .select({ id: workUnits.id, version: workUnits.version, status: workUnits.status })
          .from(workUnits)
          .innerJoin(memberships, eq(memberships.id, workUnits.ownerMembershipId))
          .where(and(ownerDisabled, not(visibleTo(context) as SQL)))
          .orderBy(newestFirst)
          .limit(DISABLED_OWNER_LIST_SIZE)
      : [];
    return { visible, hidden };
  });
}

/**
 * The way back to work nobody can reach (WORK-03). Restricted work is closed to everyone but the people
 * on it, so when its owner is disabled nobody active can read, stop or reassign it, and its files can
 * never be deleted. An organization owner may name a new owner. That is all this does: it shows them
 * nothing, and it grants them nothing unless they name themselves, which goes on the record the same
 * way. Work whose owner is still here gives the same answer as work that does not exist.
 */
export async function recoverWorkOwner(
  database: AppDatabase,
  context: TenantContext,
  input: { id: string; expectedVersion: number; ownerMembershipId: string },
) {
  if (!can(context.role, 'work.recover_owner')) throw new AppError('FORBIDDEN');
  return withTenantTx(database, context, async (tx) => {
    const [current] = await tx
      .select()
      .from(workUnits)
      .where(eq(workUnits.id, input.id))
      .for('update');
    if (!current) throw new AppError('NOT_FOUND');
    const [owner] = await tx
      .select({ status: memberships.status })
      .from(memberships)
      .where(eq(memberships.id, current.ownerMembershipId));
    if (owner?.status === 'active') throw new AppError('NOT_FOUND');
    const row = await moveOwner(tx, context, current, input, 'OWNER_DISABLED');
    const otherOwners = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.role, 'owner'), eq(memberships.status, 'active')));
    // Not a link to the work, which most of them still may not open.
    await notify(
      tx,
      context,
      otherOwners.map(({ id }) => id),
      'work.owner_recovered',
      `membership:${input.ownerMembershipId}`,
    );
    return row;
  });
}

export function assignContributor(
  database: AppDatabase,
  context: TenantContext,
  input: { id: string; membershipId: string; responsibility?: 'contributor' | 'reviewer' },
) {
  const membershipId = canonicalId(input.membershipId);
  return withTenantTx(database, context, async (tx) => {
    const work = await loadManageable(tx, context, input.id);
    if (isTerminal(work.status as WorkState)) throw new AppError('INVALID_STATE');
    await assertActiveMember(tx, membershipId);
    const added = await tx
      .insert(workAssignments)
      .values({
        organizationId: context.organizationId,
        workUnitId: input.id,
        membershipId,
        responsibility: input.responsibility ?? 'contributor',
        actorType: 'human',
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
      payload: { work_unit_id: input.id, membership_id: membershipId },
    });
    await appendAssignmentAudit(tx, context, 'work.assigned', work, membershipId);
    await notify(tx, context, [membershipId], 'work.assigned', `work_unit:${input.id}`);
  });
}

/**
 * Taking someone off the work stays possible whatever its status: revoking access must always work.
 * Anyone on the work can take themselves off. Taking off someone else is for whoever answers for it.
 */
export function unassign(
  database: AppDatabase,
  context: TenantContext,
  input: { id: string; membershipId: string },
) {
  const membershipId = canonicalId(input.membershipId);
  return withTenantTx(database, context, async (tx) => {
    const work = await loadChangeable(tx, context, input.id);
    if (membershipId !== context.membershipId) await assertCanManage(tx, context, work);
    const removed = await tx
      .delete(workAssignments)
      .where(
        and(
          eq(workAssignments.workUnitId, input.id),
          eq(workAssignments.membershipId, membershipId),
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
      payload: { work_unit_id: input.id, membership_id: membershipId },
    });
    await appendAssignmentAudit(tx, context, 'work.unassigned', work, membershipId);
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
    // Counts only. They hold the work up, so the person has to be told, but never what they are.
    const [hiddenPrerequisites] = await tx
      .select({
        unfinished: sql<number>`count(*) filter (where ${workUnits.status} <> 'completed')::int`,
        stopped: sql<number>`count(*) filter (where ${workUnits.status} = 'cancelled')::int`,
      })
      .from(workDependencies)
      .innerJoin(workUnits, eq(workUnits.id, workDependencies.prerequisiteId))
      .where(and(eq(workDependencies.dependentId, id), not(visibleTo(context) as SQL)));
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
        completionBasis: workTransitions.completionBasis,
        occurredAt: workTransitions.occurredAt,
        actorName: users.name,
      })
      .from(workTransitions)
      .leftJoin(memberships, eq(memberships.id, workTransitions.actorMembershipId))
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(eq(workTransitions.workUnitId, id))
      // Moves in one transaction share a time, so the version is what puts them in order. Rows from
      // before it was recorded are the oldest, and have only their time to go on.
      .orderBy(
        sql`${workTransitions.fromVersion} desc nulls last`,
        desc(workTransitions.occurredAt),
      );
    const facts = accessFacts(work, await assignedTo(tx, context, id));
    const isService = context.actorType === 'service';
    const canChange = isService || canChangeWork(facts, viewer(context));
    const canManage = isService || canManageWork(facts, viewer(context));
    return {
      work,
      ownerName: owner?.name ?? null,
      prerequisites,
      hiddenPrerequisites: hiddenPrerequisites ?? { unfinished: 0, stopped: 0 },
      dependents,
      people,
      files,
      reviews,
      history,
      evidence: await evidenceFor(tx, work, now),
      evidenceStamp: await evidenceStampFor(tx, id, now),
      canChange,
      canManage,
    };
  });
}

/**
 * Stands for what a Work Unit's page shows about its files and reviews. A file, or a decision on a
 * review that does not hold the work, leaves the version alone, so a page following the version alone
 * would never hear of it. Only ever compared: it says nothing about the work.
 */
async function evidenceStampFor(tx: Tx, workUnitId: string, now: Date) {
  // One round trip, because a page following its work asks this every second.
  const rows = await tx
    .select({ fact: sql<string>`${workArtifacts.artifactId}::text` })
    .from(workArtifacts)
    .where(eq(workArtifacts.workUnitId, workUnitId))
    .unionAll(
      tx
        .select({
          fact: sql<string>`${approvals.id}::text || ':' || ${approvals.status} || ':' || (${approvals.expiresAt} <= ${now.toISOString()}::timestamptz)::text`,
        })
        .from(approvals)
        .where(eq(approvals.workUnitId, workUnitId)),
    )
    .unionAll(
      tx
        .select({
          fact: sql<string>`${externalActions.id}::text || ':' || ${externalActions.status}`,
        })
        .from(externalActions)
        .where(eq(externalActions.workUnitId, workUnitId)),
    );
  const facts = rows.map((row) => row.fact).sort();
  return createHash('sha256').update(facts.join(',')).digest('hex').slice(0, 32);
}

/**
 * What someone following this work needs to know whether it has fallen behind. Access is decided each
 * time. Only a page asks about the evidence, which takes a further query on every poll.
 */
export function getWorkFollowState(
  database: AppDatabase,
  context: TenantContext,
  id: string,
  options: { evidence?: boolean } = {},
) {
  return withTenantTx(database, context, async (tx) => {
    const work = await loadReadable(tx, context, id);
    const evidence = options.evidence === false ? null : await evidenceStampFor(tx, id, new Date());
    return { version: work.version, evidence };
  });
}

/** A short title for a browser tab, or nothing if this person may not see the work. */
export function getWorkTitle(database: AppDatabase, context: TenantContext, id: string) {
  return withTenantTx(database, context, async (tx) => (await loadReadable(tx, context, id)).title);
}

/**
 * A Work Unit, and for finished work what its completion rests on and who gave it. Work finished
 * before this was recorded says so, instead of guessing.
 */
export function getWorkWithCompletion(database: AppDatabase, context: TenantContext, id: string) {
  return withTenantTx(database, context, async (tx) => {
    const work = await loadReadable(tx, context, id);
    if (work.status !== 'completed') return { work, completion: null };
    const [last] = await tx
      .select({
        basis: workTransitions.completionBasis,
        confirmedBy: workTransitions.actorMembershipId,
        confirmedAt: workTransitions.occurredAt,
      })
      .from(workTransitions)
      .where(and(eq(workTransitions.workUnitId, id), eq(workTransitions.toStatus, 'completed')))
      .orderBy(desc(workTransitions.occurredAt))
      .limit(1);
    return { work, completion: last ?? null };
  });
}

/** Where a sweep got to: the exact timestamp as PostgreSQL wrote it, and the ID that breaks a tie. */
export type SweepCursor = { at: string; id: string };

const SWEEP_PAGE = 50;

/**
 * Running work whose workflow run has gone quiet, for a sweep to check with Temporal, a page at a time
 * in a stable order, because most of these are reviews legitimately waiting for days.
 */
export async function listHeldRuns(
  database: AppDatabase,
  context: TenantContext,
  olderThan: Date,
  options: { after?: SweepCursor | undefined; limit?: number } = {},
) {
  const limit = options.limit ?? SWEEP_PAGE;
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: workUnits.id,
        runId: workUnits.runId,
        at: sql<string>`${workUnits.updatedAt}::text`,
      })
      .from(workUnits)
      .where(
        and(
          inArray(workUnits.status, ['running', 'awaiting_approval']),
          isNotNull(workUnits.runId),
          lt(workUnits.updatedAt, olderThan),
          options.after
            ? sql`(${workUnits.updatedAt}, ${workUnits.id}) > (${options.after.at}::timestamptz, ${options.after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(workUnits.updatedAt), asc(workUnits.id))
      .limit(limit),
  );
  const last = rows.at(-1);
  return {
    items: rows.map(({ id, runId }) => ({ id, runId })),
    next: rows.length === limit && last ? { at: last.at, id: last.id } : null,
  };
}

/**
 * Asks again for plans nobody has picked up. A request can meet a run that is still open and that can
 * never claim it, and then nothing would ever answer it. Asking again is safe: a workflow that finds
 * nothing to claim does nothing. A request already waiting in the outbox is left to be delivered.
 */
export async function reissueStaleRunRequests(
  database: AppDatabase,
  context: TenantContext,
  olderThan: Date,
) {
  let reissued = 0;
  let after: SweepCursor | undefined;
  for (;;) {
    const cursor: SweepCursor | undefined = after;
    const rows = await withTenantTx(database, context, (tx) =>
      tx
        .select({ id: workUnits.id, at: sql<string>`${workUnits.runRequestedAt}::text` })
        .from(workUnits)
        .where(
          and(
            eq(workUnits.status, 'ready'),
            lt(workUnits.runRequestedAt, olderThan),
            not(
              exists(
                tx
                  .select({ id: domainEvents.id })
                  .from(domainEvents)
                  .innerJoin(outboxEvents, eq(outboxEvents.eventId, domainEvents.id))
                  .where(
                    and(
                      eq(domainEvents.aggregateId, workUnits.id),
                      eq(domainEvents.eventType, 'work.execution_requested'),
                      eq(outboxEvents.state, 'queued'),
                    ),
                  ),
              ),
            ),
            cursor
              ? sql`(${workUnits.runRequestedAt}, ${workUnits.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(workUnits.runRequestedAt), asc(workUnits.id))
        .limit(SWEEP_PAGE),
    );
    for (const { id } of rows) {
      await withTenantTx(database, context, async (tx) => {
        const work = await loadChangeable(tx, context, id);
        // Rechecked under the lock: it may have started, or been withdrawn, since the list was read.
        if (work.status !== 'ready' || !work.runRequestedAt || work.runRequestedAt >= olderThan) {
          return;
        }
        await emit(tx, context, {
          eventType: 'work.execution_requested',
          aggregateType: 'work_unit',
          aggregateId: id,
          aggregateVersion: work.version,
          classification: work.classification,
          payload: { work_unit_id: id },
        });
        await auditAction(
          tx,
          context,
          'work.run_requested_again',
          `work_unit:${id}`,
          'NOT_CLAIMED',
        );
        reissued += 1;
      });
    }
    const last = rows.at(-1);
    if (!last || rows.length < SWEEP_PAGE) return reissued;
    after = { at: last.at, id: last.id };
  }
}
