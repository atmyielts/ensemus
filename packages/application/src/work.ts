// Work Unit services. Each one checks permission itself: callers are not trusted to have done so.
import { randomUUID } from 'node:crypto';
import {
  appendAudit,
  artifacts,
  memberships,
  users,
  withTenantTx,
  workArtifacts,
  workAssignments,
  workDependencies,
  workUnits,
  approvals,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { canChangeWork, canReadWork, can, type Classification } from '@ensemus/domain/policy';
import {
  decideTransition,
  type CompletionCriterion,
  type WorkState,
} from '@ensemus/domain/work-unit';
import { and, asc, desc, eq, exists, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, pgCode } from './errors';
import { emit } from './events';

const criteriaSchema = z.array(
  z.strictObject({ kind: z.enum(['artifact_exists', 'reviewer_approved', 'external_receipt']) }),
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

type WorkRow = typeof workUnits.$inferSelect;

async function assignedTo(tx: Tx, context: TenantContext, workUnitId: string) {
  if (context.actorType === 'service') return false;
  const rows = await tx
    .select({ m: workAssignments.membershipId })
    .from(workAssignments)
    .where(
      and(
        eq(workAssignments.workUnitId, workUnitId),
        eq(workAssignments.membershipId, context.membershipId),
      ),
    );
  return rows.length > 0;
}

const accessFacts = (row: WorkRow, isAssigned: boolean) => ({
  classification: row.classification as Classification,
  ownerMembershipId: row.ownerMembershipId,
  createdByMembershipId: row.createdByMembershipId,
  isAssigned,
});

const viewer = (context: TenantContext) => ({
  membershipId: context.membershipId,
  role: context.role,
});

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

/** The visibility rule from the policy, expressed in SQL so that filtering happens in the query. */
function visibleTo(context: TenantContext) {
  const me = context.membershipId;
  const onIt = or(
    eq(workUnits.ownerMembershipId, me),
    eq(workUnits.createdByMembershipId, me),
    exists(
      sql`(select 1 from ${workAssignments} where ${workAssignments.workUnitId} = ${workUnits.id}
           and ${workAssignments.membershipId} = ${me})`,
    ),
  );
  const elevated = context.role === 'owner' || context.role === 'admin';
  return or(
    inArray(workUnits.classification, ['public', 'internal']),
    onIt,
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
      .select()
      .from(workUnits)
      .where(
        and(
          visibleTo(context),
          options.status ? eq(workUnits.status, options.status) : undefined,
          options.projectId ? eq(workUnits.projectId, options.projectId) : undefined,
          cursor
            ? or(
                lt(workUnits.createdAt, cursor.at),
                and(eq(workUnits.createdAt, cursor.at), lt(workUnits.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(workUnits.createdAt), desc(workUnits.id))
      .limit(limit + 1),
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

const encodeCursor = (at: Date, id: string) =>
  Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');

function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const parsed = z
      .tuple([z.iso.datetime(), z.uuid()])
      .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return { at: new Date(parsed[0]), id: parsed[1] };
  } catch {
    throw new AppError('INVALID_INPUT');
  }
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

async function evidenceFor(tx: Tx, id: string) {
  const [artifactCount] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(workArtifacts)
    .where(eq(workArtifacts.workUnitId, id));
  const [approvedReviews] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(approvals)
    .where(and(eq(approvals.workUnitId, id), eq(approvals.status, 'approved')));
  return {
    artifactCount: artifactCount?.n ?? 0,
    approvedReviewCount: approvedReviews?.n ?? 0,
    // Verified external receipts arrive with external actions in M3.
    verifiedReceiptCount: 0,
  };
}

/** The one path by which a status changes, in one transaction with its event. */
export async function applyTransition(
  tx: Tx,
  context: TenantContext,
  current: WorkRow,
  to: WorkState,
  options: { reason?: string; correlationId?: string; causationId?: string } = {},
) {
  const decision = decideTransition({
    from: current.status as WorkState,
    to,
    incompletePrerequisites: to === 'ready' ? await incompletePrerequisites(tx, current.id) : 0,
    criteria: current.completionCriteria as CompletionCriterion[],
    evidence: to === 'completed' ? await evidenceFor(tx, current.id) : emptyEvidence,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
  });
  if (!decision.ok) throw new AppError(decision.reason);

  const nextVersion = current.version + 1;
  const [row] = await tx
    .update(workUnits)
    .set({ status: to, version: nextVersion, updatedAt: new Date() })
    .where(and(eq(workUnits.id, current.id), eq(workUnits.version, current.version)))
    .returning();
  if (!row) throw new AppError('VERSION_CONFLICT');

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

  if (to === 'completed') await promoteDependents(tx, context, current.id);
  return row;
}

const emptyEvidence = { artifactCount: 0, approvedReviewCount: 0, verifiedReceiptCount: 0 };

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
    return applyTransition(tx, context, current, input.to, {
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  });
}

/** Asks for this Work Unit's plan to run. The dispatcher starts the workflow from this event. */
export function requestExecution(database: AppDatabase, context: TenantContext, id: string) {
  return withTenantTx(database, context, async (tx) => {
    const current = await loadChangeable(tx, context, id);
    if (!current.executionPlan) throw new AppError('INVALID_STATE');
    if (current.status !== 'ready') throw new AppError('INVALID_STATE');
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
    await loadChangeable(tx, context, input.dependentId);
    await tx
      .delete(workDependencies)
      .where(
        and(
          eq(workDependencies.dependentId, input.dependentId),
          eq(workDependencies.prerequisiteId, input.prerequisiteId),
        ),
      );
  });
}

/** One accountable owner, always. Ownership moves; it cannot be emptied. */
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
    return row;
  });
}

export function assignContributor(
  database: AppDatabase,
  context: TenantContext,
  input: { id: string; membershipId: string; responsibility?: 'contributor' | 'reviewer' },
) {
  return withTenantTx(database, context, async (tx) => {
    await loadChangeable(tx, context, input.id);
    await assertActiveMember(tx, input.membershipId);
    await tx
      .insert(workAssignments)
      .values({
        organizationId: context.organizationId,
        workUnitId: input.id,
        membershipId: input.membershipId,
        responsibility: input.responsibility ?? 'contributor',
      })
      .onConflictDoNothing();
  });
}

export function unassign(
  database: AppDatabase,
  context: TenantContext,
  input: { id: string; membershipId: string },
) {
  return withTenantTx(database, context, async (tx) => {
    await loadChangeable(tx, context, input.id);
    await tx
      .delete(workAssignments)
      .where(
        and(
          eq(workAssignments.workUnitId, input.id),
          eq(workAssignments.membershipId, input.membershipId),
        ),
      );
  });
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
      .where(eq(workAssignments.workUnitId, id));
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
    const reviews = await tx
      .select({
        id: approvals.id,
        toolName: approvals.toolName,
        status: approvals.status,
        approverMembershipId: approvals.approverMembershipId,
        expiresAt: approvals.expiresAt,
      })
      .from(approvals)
      .where(eq(approvals.workUnitId, id))
      .orderBy(desc(approvals.createdAt));
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
      canChange,
    };
  });
}
