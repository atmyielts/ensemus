// Owned by the retention slice (LIFE-03). Held records survive deletion requests, and the hold is audited.
// The refusal itself is below this, in triggers in migration 0501. See ADR-032 D6.
import {
  artifacts,
  clients,
  legalHolds,
  legalHoldScopes,
  offboardings,
  organizations,
  projects,
  workUnits,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { placeLegalHoldSchema, releaseLegalHoldSchema } from '@ensemus/contracts/saas';
import { can } from '@ensemus/domain/policy';
import {
  AGGREGATE_LEGAL_HOLD,
  AGGREGATE_OFFBOARDING,
  LEGAL_HOLD_PLACED,
  LEGAL_HOLD_RELEASED,
  OFFBOARDING_RESUMED,
} from '@ensemus/saas/events';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { AppError, foreignReference } from '../errors';
import { idSchema } from '../ids';
import { auditAction } from '../work';
import { emit } from '../events';
import type { HoldScope } from '@ensemus/saas/lifecycle';

const owner = (context: TenantContext) => {
  if (context.actorType !== 'user' || !can(context.role, 'legal_hold.manage'))
    throw new AppError('NOT_FOUND');
};
async function lockTenant(tx: Tx, context: TenantContext) {
  const [org] = await tx
    .select({ id: organizations.id, lifecycle: organizations.lifecycle })
    .from(organizations)
    .where(eq(organizations.id, context.organizationId))
    .for('no key update');
  if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
}
async function scopeExists(
  tx: Tx,
  context: TenantContext,
  scope: { type: HoldScope; id: string | null },
) {
  if (scope.type === 'organization') return scope.id === null;
  const table =
    scope.type === 'artifact'
      ? artifacts
      : scope.type === 'work_unit'
        ? workUnits
        : scope.type === 'project'
          ? projects
          : clients;
  const [row] = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.organizationId, context.organizationId), eq(table.id, scope.id!)));
  return Boolean(row);
}

export type LegalHoldView = {
  id: string;
  matterRef: string;
  status: 'active' | 'released';
  scopes: readonly { type: HoldScope; id: string | null }[];
  placedByMembershipId: string;
  placedAt: Date;
  releasedAt: Date | null;
  releaseReasonCode: string | null;
  version: number;
};

/** Owner-only choices for a hold; no names are fetched for someone who cannot see the hold itself. */
export async function listLegalHoldTargets(database: AppDatabase, context: TenantContext) {
  owner(context);
  return withAccountTx(database, context, async (tx) => {
    const [clientRows, projectRows, workRows, artifactRows] = await Promise.all([
      tx
        .select({ id: clients.id, label: clients.displayName })
        .from(clients)
        .orderBy(asc(clients.displayName), asc(clients.id))
        .limit(100),
      tx
        .select({ id: projects.id, label: projects.name })
        .from(projects)
        .orderBy(asc(projects.name), asc(projects.id))
        .limit(100),
      tx
        .select({ id: workUnits.id, label: workUnits.title })
        .from(workUnits)
        .orderBy(asc(workUnits.title), asc(workUnits.id))
        .limit(100),
      tx
        .select({ id: artifacts.id, label: artifacts.name })
        .from(artifacts)
        .orderBy(asc(artifacts.name), asc(artifacts.id))
        .limit(100),
    ]);
    return [
      { type: 'client' as const, items: clientRows },
      { type: 'project' as const, items: projectRows },
      { type: 'work_unit' as const, items: workRows },
      { type: 'artifact' as const, items: artifactRows },
    ];
  });
}

/** `legal_hold.manage`. Even the existence of a hold can be sensitive, so a member gets the usual not found. */
export async function listLegalHolds(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly LegalHoldView[]> {
  owner(context);
  return withAccountTx(database, context, async (tx) => {
    const rows = await tx
      .select()
      .from(legalHolds)
      .orderBy(asc(legalHolds.placedAt), asc(legalHolds.id));
    if (!rows.length) return [];
    const scopes = await tx
      .select()
      .from(legalHoldScopes)
      .where(
        inArray(
          legalHoldScopes.holdId,
          rows.map((row) => row.id),
        ),
      );
    return rows.map((row) => ({
      id: row.id,
      matterRef: row.matterRef,
      status: row.status as 'active' | 'released',
      scopes: scopes
        .filter((scope) => scope.holdId === row.id)
        .map((scope) => ({ type: scope.scopeType as HoldScope, id: scope.scopeId })),
      placedByMembershipId: row.placedByMembershipId,
      placedAt: row.placedAt,
      releasedAt: row.releasedAt,
      releaseReasonCode: row.releaseReasonCode,
      version: row.version,
    }));
  });
}

/**
 * `legal_hold.manage`. Every scope is checked to be in this tenant, as `foreignReference` would answer.
 * Audited, with IDs and no matter text in the log. Emits LEGAL_HOLD_PLACED.
 */
export async function placeLegalHold(
  database: AppDatabase,
  context: TenantContext,
  input: {
    matterRef: string;
    scopes: readonly { type: HoldScope; id: string | null }[];
  },
): Promise<{ holdId: string }> {
  owner(context);
  const parsed = placeLegalHoldSchema.safeParse({
    matter_ref: input.matterRef,
    scopes: input.scopes,
  });
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    await lockTenant(tx, context);
    for (const scope of parsed.data.scopes)
      if (!(await scopeExists(tx, context, scope))) throw foreignReference();
    const [hold] = await tx
      .insert(legalHolds)
      .values({
        organizationId: context.organizationId,
        matterRef: parsed.data.matter_ref,
        placedByMembershipId: context.membershipId,
      })
      .returning();
    const unique = [
      ...new Map(
        parsed.data.scopes.map((scope) => [`${scope.type}:${scope.id ?? ''}`, scope]),
      ).values(),
    ];
    await tx.insert(legalHoldScopes).values(
      unique.map((scope) => ({
        organizationId: context.organizationId,
        holdId: hold!.id,
        scopeType: scope.type,
        scopeId: scope.id,
      })),
    );
    await auditAction(tx, context, 'legal_hold.placed', `legal_hold:${hold!.id}`);
    await emit(tx, context, {
      eventType: LEGAL_HOLD_PLACED,
      aggregateType: AGGREGATE_LEGAL_HOLD,
      aggregateId: hold!.id,
      aggregateVersion: hold!.version,
      classification: 'restricted',
      payload: { legal_hold_id: hold!.id },
    });
    return { holdId: hold!.id };
  });
}

/** `legal_hold.manage`, and a reason code. Stays released. Audited. Wakes an offboarding it was blocking. */
export async function releaseLegalHold(
  database: AppDatabase,
  context: TenantContext,
  input: { holdId: string; reasonCode: string; expectedVersion: number },
): Promise<void> {
  owner(context);
  const id = idSchema.safeParse(input.holdId),
    parsed = releaseLegalHoldSchema.safeParse({ reason_code: input.reasonCode });
  if (
    !id.success ||
    !parsed.success ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  )
    throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    await lockTenant(tx, context);
    const [hold] = await tx
      .select()
      .from(legalHolds)
      .where(and(eq(legalHolds.organizationId, context.organizationId), eq(legalHolds.id, id.data)))
      .for('update');
    if (!hold) throw new AppError('NOT_FOUND');
    if (hold.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (hold.status !== 'active') throw new AppError('INVALID_STATE');
    await tx
      .update(legalHolds)
      .set({
        status: 'released',
        releasedByMembershipId: context.membershipId,
        releasedAt: new Date(),
        releaseReasonCode: parsed.data.reason_code,
        version: hold.version + 1,
      })
      .where(eq(legalHolds.id, hold.id));
    await auditAction(
      tx,
      context,
      'legal_hold.released',
      `legal_hold:${hold.id}`,
      parsed.data.reason_code,
    );
    await emit(tx, context, {
      eventType: LEGAL_HOLD_RELEASED,
      aggregateType: AGGREGATE_LEGAL_HOLD,
      aggregateId: hold.id,
      aggregateVersion: hold.version + 1,
      classification: 'restricted',
      payload: { legal_hold_id: hold.id },
    });
    const [remaining] = await tx
      .select({ id: legalHolds.id })
      .from(legalHolds)
      .where(eq(legalHolds.status, 'active'))
      .limit(1);
    if (!remaining) {
      const live = await tx
        .select({ id: offboardings.id, version: offboardings.version })
        .from(offboardings)
        .where(
          inArray(offboardings.state, [
            'requested',
            'export_offered',
            'in_transition',
            'winding_down',
            'ready_for_erasure',
          ]),
        );
      for (const row of live)
        await emit(tx, context, {
          eventType: OFFBOARDING_RESUMED,
          aggregateType: AGGREGATE_OFFBOARDING,
          aggregateId: row.id,
          aggregateVersion: row.version,
          classification: 'internal',
          payload: { offboarding_id: row.id },
        });
    }
  });
}

/** What an application asks first, so a person hears why. The trigger decides whatever this says. */
export async function isHeldInTx(
  tx: Tx,
  context: TenantContext,
  target: { type: HoldScope; id: string | null },
): Promise<boolean> {
  const scope = placeLegalHoldSchema.shape.scopes.element.safeParse(target);
  if (!scope.success) throw new AppError('INVALID_INPUT');
  const result = await tx.execute(
    sql`select lifecycle.target_is_held(${context.organizationId}::uuid,${scope.data.type},${scope.data.id}::uuid,now()) as held`,
  );
  return result.rows[0]?.held === true;
}
