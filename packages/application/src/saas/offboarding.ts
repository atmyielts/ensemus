// Owned by the offboarding slice (LIFE-04): export offered, connections revoked, scheduled work ended, deletion
// verified and reported. The last step is an operator's, deliberately. See ADR-032 D7.
import {
  domainEvents,
  connections,
  erasureLog,
  memberships,
  interactiveSessionOf,
  offboardings,
  organizations,
  standingChanges,
  workUnits,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { createServiceContext } from '@ensemus/database/service';
import {
  nextOffboardingStep,
  RETAINED_RECORDS,
  type ErasureReport,
  type OffboardingState,
  type OffboardingStep,
} from '@ensemus/saas/offboarding';
import type { TenantLifecycle } from '@ensemus/saas/entitlements';
import { can } from '@ensemus/domain/policy';
import {
  AGGREGATE_OFFBOARDING,
  NOTIFY_OFFBOARDING,
  OFFBOARDING_CANCELLED,
  OFFBOARDING_REPORTED,
  OFFBOARDING_REQUESTED,
  OFFBOARDING_RESUMED,
  TENANT_SCHEDULES_ENDED,
  offboardingTargetRef,
} from '@ensemus/saas/events';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { emit } from '../events';
import { applyTransition, auditAction, notify } from '../work';
import { TOMBSTONE_RECORDED } from '@ensemus/domain/tombstone-ledger';
import { setTenantStandingInTx } from './standing';
import { assertInteractivePrivilege } from '../product/privileged';
import type { createTenantObjectErasure } from './tenant-object-erasure';
import type { AgentHaltPort, OffboardingAgentHaltPort, OffboardingPorts } from './ports';

const operatorCommandSchema = z.strictObject({
  organizationId: idSchema,
  offboardingId: idSchema,
  operatorRef: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !/[\r\n\0]/.test(value)),
});
export const eraseCommandInputSchemas = {
  run: operatorCommandSchema,
  resume: operatorCommandSchema,
  transition: operatorCommandSchema.extend({ transitionEndsAt: z.iso.datetime({ offset: true }) }),
};
export type EraseCommandInput = z.infer<typeof operatorCommandSchema>;

const manager = (context: TenantContext) => {
  if (context.actorType !== 'user' || !can(context.role, 'offboarding.manage'))
    throw new AppError('NOT_FOUND');
};
const service = (context: TenantContext) => {
  if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
};
const idOf = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
};
const ref = (value: string) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value === value.trim() &&
  value.length <= 200 &&
  !/[\r\n\0]/.test(value);
const count = (value: unknown) => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value)))
    throw new AppError('PREREQUISITES_INCOMPLETE');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new AppError('PREREQUISITES_INCOMPLETE');
  return number;
};
function ownedAgents(
  port: OffboardingAgentHaltPort | undefined,
  offboardingId: string,
): AgentHaltPort {
  if (
    !port ||
    typeof port.haltOffboardingAgents !== 'function' ||
    typeof port.releaseOffboardingAgents !== 'function'
  )
    throw new AppError('PREREQUISITES_INCOMPLETE');
  return {
    haltTenantAgents: (tx, ctx) => port.haltOffboardingAgents(tx, ctx, offboardingId),
    releaseTenantAgents: (tx, ctx) => port.releaseOffboardingAgents(tx, ctx, offboardingId),
  };
}
async function lockTenant(tx: Tx, context: TenantContext, allowDeleted = false) {
  const [org] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, context.organizationId))
    .for('no key update');
  if (!org || (org.lifecycle === 'deleted' && !allowDeleted)) throw new AppError('NOT_FOUND');
  return org;
}
async function locked(tx: Tx, context: TenantContext, id: string, allowDeleted = false) {
  const org = await lockTenant(tx, context, allowDeleted);
  const [row] = await tx
    .select()
    .from(offboardings)
    .where(and(eq(offboardings.organizationId, context.organizationId), eq(offboardings.id, id)))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND');
  return { org, row };
}
async function effects(tx: Tx, context: TenantContext) {
  const result = await tx.execute(
    sql`select (select count(*) from lifecycle.legal_holds where organization_id=${context.organizationId}::uuid and status='active')::text as holds,(select count(*) from integrations.external_actions where organization_id=${context.organizationId}::uuid and status in ('sending','reconciling','unknown'))::text as actions,(select count(*) from billing.payments where organization_id=${context.organizationId}::uuid and status in ('sending','reconciling','unknown'))::text as payments`,
  );
  const row = result.rows[0];
  return {
    activeHolds: count(row?.holds),
    actions: count(row?.actions),
    payments: count(row?.payments),
  };
}
/**
 * Whether erasure has already destroyed something irreversibly: any TENANT_ERASURE tombstone. Only
 * erasure writes that reason (the artifact tombstones of `erasing`, and the delegated input closure just
 * before it), and a tombstone is never removed, so this stays true once it is true. Metadata only.
 */
async function erasureHasDestroyed(tx: Tx, context: TenantContext) {
  const result = await tx.execute<{ destroyed: boolean }>(
    sql`select exists(select 1 from platform.tombstones where organization_id=${context.organizationId}::uuid and reason_code='TENANT_ERASURE') as destroyed`,
  );
  return result.rows[0]?.destroyed === true;
}
async function tellOwners(tx: Tx, context: TenantContext, offboardingId: string) {
  const owners = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.role, 'owner'), eq(memberships.status, 'active')));
  await notify(
    tx,
    context,
    owners.map((row) => row.id),
    NOTIFY_OFFBOARDING,
    offboardingTargetRef(offboardingId),
  );
}
async function event(
  tx: Tx,
  context: TenantContext,
  row: typeof offboardings.$inferSelect,
  type: string,
) {
  await emit(tx, context, {
    eventType: type,
    aggregateType: AGGREGATE_OFFBOARDING,
    aggregateId: row.id,
    aggregateVersion: row.version,
    classification: 'internal',
    payload: { offboarding_id: row.id },
  });
}
async function stepFor(
  tx: Tx,
  context: TenantContext,
  row: typeof offboardings.$inferSelect,
  now: Date,
) {
  const pending = await effects(tx, context);
  return nextOffboardingStep(
    {
      ...row,
      state: row.state as OffboardingState,
      activeHolds: pending.activeHolds,
      unsettledActions: pending.actions + pending.payments,
    },
    now,
  );
}
async function contentTables(tx: Tx) {
  const result = await tx.execute(
    sql`select n.nspname as schema_name,c.relname as table_name,has_table_privilege('ensemus_eraser',c.oid,'DELETE') as granted from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attname='organization_id' and not a.attisdropped where c.relkind in ('r','p') and not c.relispartition and n.nspname not like 'pg_%' and n.nspname<>'information_schema' and not lifecycle.retained_table(n.nspname::text,c.relname::text) order by n.nspname,c.relname`,
  );
  return result.rows.map((row) => {
    if (
      typeof row.schema_name !== 'string' ||
      typeof row.table_name !== 'string' ||
      !/^[_a-z][_a-z0-9]*$/.test(row.schema_name) ||
      !/^[_a-z][_a-z0-9]*$/.test(row.table_name) ||
      row.granted !== true
    )
      throw new AppError('PREREQUISITES_INCOMPLETE');
    return {
      schema: row.schema_name,
      table: row.table_name,
      tableRef: `${row.schema_name}.${row.table_name}`,
    };
  });
}
async function rowsIn(tx: Tx, offboardingId: string, table: { schema: string; table: string }) {
  // Only begin/finishErasure call this, after service() and the branded withAccountTx check.
  // This metadata capability reads no secret column and lasts only for this transaction.
  const result = await tx.execute(
    sql`select lifecycle.erasure_table_rows(${table.schema + '.' + table.table},${offboardingId}::uuid)::text as n`,
  );
  return count(result.rows[0]?.n);
}

/** Operator-only orchestration facts. A missing ledger receipt is never interpreted as a drained ledger. */
export async function inspectErasure(
  database: AppDatabase,
  context: TenantContext,
  input: { offboardingId: string },
) {
  service(context);
  const id = idOf(input.offboardingId);
  return withAccountTx(database, context, async (tx) => {
    const { row } = await locked(tx, context, id, true),
      pending = await effects(tx, context);
    const result = await tx.execute(
      sql`select (select count(*) from platform.blob_lifecycle where organization_id=${context.organizationId}::uuid and state<>'purged')::text as blobs,(select count(*) from platform.tombstones t where t.organization_id=${context.organizationId}::uuid and t.target_type='artifact' and not exists(select 1 from platform.domain_events e join platform.outbox_events o on o.organization_id=e.organization_id and o.event_id=e.id where e.organization_id=t.organization_id and e.aggregate_type='artifact' and e.aggregate_id=t.target_id and e.event_type='tombstone.recorded' and o.state='published'))::text as ledger`,
    );
    return {
      state: row.state as OffboardingState,
      activeHolds: pending.activeHolds,
      unsettledActions: pending.actions + pending.payments,
      blobsPending: count(result.rows[0]?.blobs),
      ledgerPending: count(result.rows[0]?.ledger),
      report: row.report as ErasureReport | null,
    };
  });
}

/** A configured binding becoming available can explicitly resume a completed waiting workflow. */
export async function resumeOffboarding(
  database: AppDatabase,
  context: TenantContext,
  input: { offboardingId: string; operatorRef: string },
): Promise<void> {
  service(context);
  const id = idOf(input.offboardingId);
  if (!ref(input.operatorRef)) throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    const { row } = await locked(tx, context, id, true);
    if (['reported', 'cancelled'].includes(row.state)) throw new AppError('INVALID_STATE');
    await event(tx, context, row, OFFBOARDING_RESUMED);
    await auditAction(
      tx,
      context,
      'offboarding.resumed',
      offboardingTargetRef(id),
      'OPERATOR_RESUMED',
    );
  });
}

export type OffboardingView = {
  id: string;
  state: OffboardingState;
  exportOfferedAt: Date | null;
  exportRef: string | null;
  transitionEndsAt: Date | null;
  activeHolds: number;
  unsettledActions: number;
  report: ErasureReport | null;
  version: number;
};

/** `offboarding.manage`, which only an owner has. Null when none is under way. */
export async function getOffboarding(
  database: AppDatabase,
  context: TenantContext,
): Promise<OffboardingView | null> {
  manager(context);
  return withAccountTx(database, context, async (tx) => {
    await lockTenant(tx, context);
    const [row] = await tx
      .select()
      .from(offboardings)
      .orderBy(desc(offboardings.createdAt), desc(offboardings.id))
      .limit(1);
    if (!row || row.state === 'cancelled') return null;
    const pending = await effects(tx, context);
    return {
      id: row.id,
      state: row.state as OffboardingState,
      exportOfferedAt: row.exportOfferedAt,
      exportRef: row.exportRef,
      transitionEndsAt: row.transitionEndsAt,
      activeHolds: pending.activeHolds,
      unsettledActions: pending.actions + pending.payments,
      report: row.report as ErasureReport | null,
      version: row.version,
    };
  });
}

/**
 * `offboarding.manage`, and a person. `confirmName` has to be this organization's exact name, or nothing
 * happens. Moves the tenant to `offboarding` through `setTenantStandingInTx`, emits OFFBOARDING_REQUESTED,
 * and tells every owner.
 */
export async function requestOffboarding(
  database: AppDatabase,
  context: TenantContext,
  input: { confirmName: string },
  agents?: OffboardingAgentHaltPort,
): Promise<{ offboardingId: string }> {
  manager(context);
  if (!interactiveSessionOf(context)) throw new AppError('MFA_REQUIRED');
  return withAccountTx(database, context, async (tx) => {
    await assertInteractivePrivilege(tx, context, 'organization.manage');
    const org = await lockTenant(tx, context);
    if (input.confirmName !== org.name) throw new AppError('OFFBOARDING_CONFIRMATION_MISMATCH');
    const [live] = await tx
      .select()
      .from(offboardings)
      .where(
        inArray(offboardings.state, [
          'requested',
          'export_offered',
          'in_transition',
          'winding_down',
          'ready_for_erasure',
          'erasing',
          'verified',
        ]),
      );
    if (live) return { offboardingId: live.id };
    if (org.lifecycle === 'offboarding') throw new AppError('OFFBOARDING_IN_PROGRESS');
    if (!agents) throw new AppError('PREREQUISITES_INCOMPLETE');
    const [row] = await tx
      .insert(offboardings)
      .values({
        organizationId: context.organizationId,
        requestedByMembershipId: context.membershipId,
      })
      .returning();
    const worker = createServiceContext(context.organizationId);
    await setTenantStandingInTx(
      tx,
      worker,
      {
        to: 'offboarding',
        reasonCode: 'OFFBOARDING_REQUESTED',
        actor: { type: 'membership', ref: context.membershipId },
      },
      ownedAgents(agents, row!.id),
    );
    await auditAction(tx, context, 'offboarding.requested', offboardingTargetRef(row!.id));
    await event(tx, context, row!, OFFBOARDING_REQUESTED);
    await tellOwners(tx, context, row!.id);
    return { offboardingId: row!.id };
  });
}

/**
 * `offboarding.manage`. Only before erasure has destroyed anything, then service comes back. `erasing` is
 * the state machine's point of no return, but ADR-028 lifecycle item 8b's delegated input closure
 * (`closeDelegatedRecordInputsInTx`) already tombstones records with TENANT_ERASURE, and starts their
 * purges, while the offboarding is still `ready_for_erasure`. Those tombstones are permanent, so once any
 * exists the tenant could not get its records back: cancelling is refused from then on, and the operator
 * finishes erasure (after any hold placed meanwhile is released). Both this and the closure lock the tenant
 * and the offboarding row first, so neither can pass the other.
 */
export async function cancelOffboarding(
  database: AppDatabase,
  context: TenantContext,
  input: { reasonCode: string; expectedVersion: number },
  agents?: OffboardingAgentHaltPort,
): Promise<void> {
  manager(context);
  if (
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.reasonCode) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  )
    throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    await lockTenant(tx, context);
    const [row] = await tx
      .select()
      .from(offboardings)
      .where(ne(offboardings.state, 'cancelled'))
      .orderBy(desc(offboardings.createdAt), desc(offboardings.id))
      .limit(1)
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (['erasing', 'verified', 'reported'].includes(row.state))
      throw new AppError('OFFBOARDING_NOT_CANCELLABLE');
    if (await erasureHasDestroyed(tx, context)) throw new AppError('OFFBOARDING_NOT_CANCELLABLE');
    const [prior] = await tx
      .select({ from: standingChanges.fromLifecycle })
      .from(standingChanges)
      .innerJoin(
        offboardings,
        and(
          eq(standingChanges.organizationId, offboardings.organizationId),
          eq(standingChanges.occurredAt, offboardings.createdAt),
        ),
      )
      .where(
        and(
          eq(offboardings.id, row.id),
          eq(standingChanges.toLifecycle, 'offboarding'),
          eq(standingChanges.reasonCode, 'OFFBOARDING_REQUESTED'),
        ),
      )
      .limit(1);
    if (!prior || !['active', 'read_only', 'suspended'].includes(prior.from))
      throw new AppError('PREREQUISITES_INCOMPLETE');
    const binding = ownedAgents(agents, row.id);
    const [cancelled] = await tx
      .update(offboardings)
      .set({
        state: 'cancelled',
        cancelledAt: new Date(),
        cancelReasonCode: input.reasonCode,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(offboardings.id, row.id))
      .returning();
    await setTenantStandingInTx(
      tx,
      createServiceContext(context.organizationId),
      {
        to: prior.from as TenantLifecycle,
        reasonCode: 'OFFBOARDING_CANCELLED',
        actor: { type: 'membership', ref: context.membershipId },
        offboardingCancellationId: row.id,
      },
      binding,
    );
    await auditAction(
      tx,
      context,
      'offboarding.cancelled',
      offboardingTargetRef(row.id),
      input.reasonCode,
    );
    await event(tx, context, cancelled!, OFFBOARDING_CANCELLED);
    await tellOwners(tx, context, row.id);
  });
}

/** The operator's command sets this from the contract. It must be set before anything can be erased. */
export async function setTransitionEnd(
  database: AppDatabase,
  context: TenantContext,
  input: { offboardingId: string; transitionEndsAt: Date; operatorRef: string },
): Promise<void> {
  service(context);
  const id = idOf(input.offboardingId);
  if (!ref(input.operatorRef) || !Number.isFinite(input.transitionEndsAt.getTime()))
    throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    const { row } = await locked(tx, context, id);
    if (['erasing', 'verified', 'reported', 'cancelled'].includes(row.state))
      throw new AppError('INVALID_STATE');
    if (
      row.transitionEndsAt?.getTime() === input.transitionEndsAt.getTime() &&
      row.transitionSetByRef === input.operatorRef
    )
      return;
    const [updated] = await tx
      .update(offboardings)
      .set({
        transitionEndsAt: input.transitionEndsAt,
        transitionSetByRef: input.operatorRef,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(offboardings.id, id))
      .returning();
    await auditAction(
      tx,
      context,
      'offboarding.transition_set',
      offboardingTargetRef(id),
      'OPERATOR_CONTRACT_DATE',
    );
    await event(tx, context, updated!, OFFBOARDING_RESUMED);
  });
}

/**
 * Service only. The one step the workflow asks for each time, each idempotent, each recording its own time:
 * tell the owners about their export and record any they have taken, revoke connections with M3's `revokeConnection`, end schedules by emitting
 * TENANT_SCHEDULES_ENDED, halt agents, and wait for unsettled external actions. It stops at
 * `await_operator_erasure`, or `blocked_by_hold`, and tells the owners. Pending M3 actions never just vanish.
 */
export async function advanceOffboarding(
  database: AppDatabase,
  context: TenantContext,
  ports: OffboardingPorts,
  input: { offboardingId: string; now: Date },
): Promise<{
  next: OffboardingStep;
  wakeAtMs: number | null;
  progressed: boolean;
  state: OffboardingState;
}> {
  service(context);
  const id = idOf(input.offboardingId);
  if (!Number.isFinite(input.now.getTime())) throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    const { row } = await locked(tx, context, id, true);
    let next = await stepFor(tx, context, row, input.now);
    let change: Partial<typeof offboardings.$inferInsert> | null = null;
    let state = row.state as OffboardingState;
    if (next.kind === 'offer_export') {
      const latest = await ports.exports.latestExport(tx, context);
      if (latest && !ref(latest.exportRef)) throw new AppError('PREREQUISITES_INCOMPLETE');
      await tellOwners(tx, context, id);
      change = {
        state: 'export_offered',
        exportOfferedAt: input.now,
        exportRef: latest?.exportRef ?? null,
      };
    } else if (next.kind === 'wait_for_transition') {
      if (row.state === 'export_offered') change = { state: 'in_transition' };
    } else if (next.kind === 'revoke_connections') {
      if (row.state === 'export_offered') {
        change = { state: 'in_transition' };
      } else {
        const active = await tx
          .select({ id: connections.id })
          .from(connections)
          .where(ne(connections.state, 'revoked'))
          .limit(1);
        if (active.length) {
          if (!ports.connections) throw new AppError('PREREQUISITES_INCOMPLETE');
          await ports.connections.revokeAllInTx(tx, context);
          const [left] = await tx
            .select({ id: connections.id })
            .from(connections)
            .where(ne(connections.state, 'revoked'))
            .limit(1);
          if (left) throw new AppError('PREREQUISITES_INCOMPLETE');
        }
        change = { state: 'winding_down', connectionsRevokedAt: input.now };
      }
    } else if (next.kind === 'end_scheduled_work') {
      await ownedAgents(ports.offboardingAgents, id).haltTenantAgents(
        tx,
        context,
        'OFFBOARDING_REQUESTED',
      );
      for (const windDown of ports.windDowns) await windDown(tx, context);
      const activeRun = and(
        inArray(workUnits.status, [
          'queued',
          'ready',
          'running',
          'blocked',
          'awaiting_approval',
          'verifying',
        ]),
        sql`(${workUnits.runId} is not null or ${workUnits.runRequestedAt} is not null)`,
      );
      const live = await tx
        .select()
        .from(workUnits)
        .where(activeRun)
        .orderBy(asc(workUnits.id))
        .limit(100)
        .for('update');
      for (const work of live) {
        const cancellable =
          work.status === 'verifying'
            ? await applyTransition(tx, context, work, 'running', { reason: 'TENANT_OFFBOARDING' })
            : work;
        await applyTransition(tx, context, cancellable, 'cancelled', {
          reason: 'TENANT_OFFBOARDING',
        });
      }
      const [left] = await tx
        .select({ id: workUnits.id })
        .from(workUnits)
        .where(activeRun)
        .limit(1);
      if (!left) {
        change = { workEndedAt: input.now };
        await emit(tx, context, {
          eventType: TENANT_SCHEDULES_ENDED,
          aggregateType: AGGREGATE_OFFBOARDING,
          aggregateId: id,
          aggregateVersion: row.version + 1,
          classification: 'internal',
          payload: { offboarding_id: id },
        });
      }
    } else if (next.kind === 'settle_pending_actions') {
      const pending = await effects(tx, context);
      if (!pending.actions && !pending.payments) change = { actionsSettledAt: input.now };
      else await tellOwners(tx, context, id);
    } else if (next.kind === 'await_operator_erasure' && row.state === 'winding_down')
      change = { state: 'ready_for_erasure' };
    else if (next.kind === 'blocked_by_hold') await tellOwners(tx, context, id);
    if (change) {
      const [updated] = await tx
        .update(offboardings)
        .set({ ...change, version: row.version + 1, updatedAt: input.now })
        .where(eq(offboardings.id, id))
        .returning();
      state = updated!.state as OffboardingState;
      next = await stepFor(tx, context, updated!, input.now);
      if (next.kind === 'await_operator_erasure' && updated!.state === 'winding_down') {
        await tx
          .update(offboardings)
          .set({ state: 'ready_for_erasure', version: updated!.version + 1, updatedAt: input.now })
          .where(eq(offboardings.id, id));
        state = 'ready_for_erasure';
      }
      await auditAction(tx, context, 'offboarding.advanced', offboardingTargetRef(id));
    }
    return {
      next,
      wakeAtMs: next.kind === 'wait_for_transition' ? (next.until?.getTime() ?? null) : null,
      progressed: change !== null,
      state,
    };
  });
}

/**
 * The admission beginErasure checks before it moves to `erasing`, shared with the delegated input closure
 * that must run just before it (ADR-028 lifecycle item 8b). Locks the tenant and the offboarding row.
 * `finished` means erasure already ended (verified or reported) and nothing may be written. Otherwise
 * the offboarding is `ready_for_erasure` or `erasing` (so its transition is over), no legal hold is
 * active (LEGAL_HOLD_ACTIVE), and no external action or payment is unsettled (PREREQUISITES_INCOMPLETE).
 */
export async function assertErasureAdmittedInTx(
  tx: Tx,
  context: TenantContext,
  offboardingId: string,
): Promise<{ row: typeof offboardings.$inferSelect; finished: boolean }> {
  service(context);
  const id = idOf(offboardingId);
  const { row } = await locked(tx, context, id, true);
  if (row.state === 'reported' || row.state === 'verified') return { row, finished: true };
  if (!['ready_for_erasure', 'erasing'].includes(row.state))
    throw new AppError('PREREQUISITES_INCOMPLETE');
  const pending = await effects(tx, context);
  if (pending.activeHolds) throw new AppError('LEGAL_HOLD_ACTIVE');
  if (pending.actions || pending.payments) throw new AppError('PREREQUISITES_INCOMPLETE');
  return { row, finished: false };
}

/**
 * The operator's erase command, as the application role: moves to `erasing`, which the database refuses while
 * any hold is active, a step is unfinished or the transition is not over. It tombstones every artifact first,
 * so a restore cannot bring the bytes back (ADR-026). Answers the IDs of what it tombstoned.
 */
export async function beginErasure(
  database: AppDatabase,
  context: TenantContext,
  input: { offboardingId: string; operatorRef: string },
): Promise<{ tombstoned: number; more: boolean }> {
  service(context);
  const id = idOf(input.offboardingId);
  if (!ref(input.operatorRef)) throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    const { row, finished } = await assertErasureAdmittedInTx(tx, context, id);
    if (finished) return { tombstoned: 0, more: false };
    const tables = await contentTables(tx),
      logs = await tx
        .select()
        .from(erasureLog)
        .where(
          and(eq(erasureLog.offboardingId, id), eq(erasureLog.reasonCode, 'ERASURE_BASELINE')),
        );
    for (const table of tables)
      if (!logs.some((log) => log.tableRef === table.tableRef))
        await tx.insert(erasureLog).values({
          organizationId: context.organizationId,
          offboardingId: id,
          tableRef: table.tableRef,
          rowsLeft: await rowsIn(tx, id, table),
          outcome: 'left_over',
          reasonCode: 'ERASURE_BASELINE',
        });
    const [blobBaseline] = await tx
      .select({ id: erasureLog.id })
      .from(erasureLog)
      .where(
        and(eq(erasureLog.offboardingId, id), eq(erasureLog.reasonCode, 'ERASURE_BLOB_BASELINE')),
      )
      .limit(1);
    if (!blobBaseline) {
      const result = await tx.execute(
        sql`select count(*)::text as n from platform.blob_lifecycle where organization_id=${context.organizationId}::uuid and state='purged'`,
      );
      await tx.insert(erasureLog).values({
        organizationId: context.organizationId,
        offboardingId: id,
        tableRef: 'platform.blob_lifecycle',
        rowsLeft: count(result.rows[0]?.n),
        outcome: 'left_over',
        reasonCode: 'ERASURE_BLOB_BASELINE',
      });
    }
    if (row.state === 'ready_for_erasure')
      await tx
        .update(offboardings)
        .set({
          state: 'erasing',
          erasureStartedAt: new Date(),
          erasureStartedByRef: input.operatorRef,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(offboardings.id, id));
    else if (!row.erasureStartedByRef)
      await tx
        .update(offboardings)
        .set({ erasureStartedByRef: input.operatorRef })
        .where(eq(offboardings.id, id));
    let tombstoned = 0;
    const files = (
      await tx.execute<{ artifact_id: string; classification: string; added: boolean }>(
        sql`select * from lifecycle.prepare_erasure_artifacts(${id}::uuid,100)`,
      )
    ).rows;
    for (const file of files) {
      if (file.added) tombstoned += 1;
      const [event] = await tx
        .select({ id: domainEvents.id })
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.organizationId, context.organizationId),
            eq(domainEvents.aggregateType, 'artifact'),
            eq(domainEvents.aggregateId, file.artifact_id),
            eq(domainEvents.eventType, TOMBSTONE_RECORDED),
          ),
        )
        .limit(1);
      if (!event)
        await emit(tx, context, {
          eventType: TOMBSTONE_RECORDED,
          aggregateType: 'artifact',
          aggregateId: file.artifact_id,
          aggregateVersion: 1,
          classification: file.classification as
            'public' | 'internal' | 'confidential' | 'restricted',
          payload: { artifact_id: file.artifact_id },
        });
    }
    await auditAction(
      tx,
      context,
      'offboarding.erasure_started',
      offboardingTargetRef(id),
      'OPERATOR_ERASURE',
    );
    return { tombstoned, more: files.length === 100 };
  });
}

/**
 * After the eraser role has finished. Writes the log and the report from what was counted, moves to `verified`
 * only if nothing is left over, then to `reported`, and marks the tenant `deleted`. Anything left over stops at
 * `erasing` with the list, so "verified" always means verified (LIFE-04).
 */
export async function finishErasure(
  database: AppDatabase,
  context: TenantContext,
  input: {
    offboardingId: string;
    tables: readonly { tableRef: string; rowsRemoved: number; rowsLeft: number }[];
    blobsRemoved: number;
    operatorRef: string;
  },
  agents?: OffboardingAgentHaltPort,
  objects?: Pick<ReturnType<typeof createTenantObjectErasure>, 'confirm'>,
): Promise<{ state: OffboardingState; report: ErasureReport | null }> {
  service(context);
  const id = idOf(input.offboardingId);
  if (
    !ref(input.operatorRef) ||
    !Number.isSafeInteger(input.blobsRemoved) ||
    input.blobsRemoved < 0 ||
    new Set(input.tables.map((table) => table.tableRef)).size !== input.tables.length ||
    input.tables.some(
      (table) =>
        !Number.isSafeInteger(table.rowsRemoved) ||
        table.rowsRemoved < 0 ||
        !Number.isSafeInteger(table.rowsLeft) ||
        table.rowsLeft < 0,
    )
  )
    throw new AppError('INVALID_INPUT');
  // Provider/prefix I/O finishes before the final SQL transaction. Missing composition never means
  // zero bytes. The final transaction rechecks exact retained receipts under the tenant barrier.
  if (!objects || !(await objects.confirm(context, { offboardingId: id })).confirmed)
    throw new AppError('PREREQUISITES_INCOMPLETE');
  return withAccountTx(database, context, async (tx) => {
    const { row } = await locked(tx, context, id, true);
    const physical = await tx.execute<{ ready: boolean }>(
      sql`select lifecycle.erasure_object_proofs(${id}::uuid) as ready`,
    );
    if (physical.rows[0]?.ready !== true) throw new AppError('PREREQUISITES_INCOMPLETE');
    if (row.state === 'reported') {
      for (const table of await contentTables(tx)) {
        if ((await rowsIn(tx, id, table)) !== 0) throw new AppError('PREREQUISITES_INCOMPLETE');
      }
      return { state: 'reported', report: row.report as ErasureReport };
    }
    if (row.state !== 'erasing') throw new AppError('INVALID_STATE');
    const pending = await effects(tx, context);
    if (pending.activeHolds) throw new AppError('LEGAL_HOLD_ACTIVE');
    const tables = await contentTables(tx);
    if (
      tables.length !== input.tables.length ||
      tables.some((table) => !input.tables.some((actual) => actual.tableRef === table.tableRef))
    )
      throw new AppError('PREREQUISITES_INCOMPLETE');
    const baseline = await tx
      .select()
      .from(erasureLog)
      .where(and(eq(erasureLog.offboardingId, id), eq(erasureLog.reasonCode, 'ERASURE_BASELINE')));
    const leftOver: { tableRef: string; rows: number; reasonCode: string }[] = [];
    let rowsRemoved = 0,
      erasedTables = 0;
    for (const table of tables) {
      const original = baseline.find((log) => log.tableRef === table.tableRef);
      if (!original) throw new AppError('PREREQUISITES_INCOMPLETE');
      const left = await rowsIn(tx, id, table);
      if (input.tables.find((actual) => actual.tableRef === table.tableRef)!.rowsLeft !== left)
        throw new AppError('VERSION_CONFLICT');
      const removed = Math.max(0, original.rowsLeft - left);
      rowsRemoved += removed;
      if (left) leftOver.push({ tableRef: table.tableRef, rows: left, reasonCode: 'ROWS_REMAIN' });
      else erasedTables += 1;
      await tx.insert(erasureLog).values({
        organizationId: context.organizationId,
        offboardingId: id,
        tableRef: table.tableRef,
        rowsRemoved: removed,
        rowsLeft: left,
        outcome: left ? 'left_over' : 'erased',
        reasonCode: left ? 'ROWS_REMAIN' : 'POST_DELETE_COUNT_ZERO',
      });
    }
    const proof = await tx.execute(
      sql`select (select count(*) from platform.blob_lifecycle where organization_id=${context.organizationId}::uuid and state<>'purged')::text as blobs_pending,(select count(*) from platform.blob_lifecycle where organization_id=${context.organizationId}::uuid and state='purged')::text as blobs_purged,(select count(*) from platform.tombstones t where t.organization_id=${context.organizationId}::uuid and t.target_type='artifact' and not exists(select 1 from platform.domain_events e join platform.outbox_events o on o.organization_id=e.organization_id and o.event_id=e.id where e.organization_id=t.organization_id and e.aggregate_type='artifact' and e.aggregate_id=t.target_id and e.event_type='tombstone.recorded' and o.state='published'))::text as ledger_pending`,
    );
    const evidence = proof.rows[0]!;
    for (const [tableRef, rows, reasonCode] of [
      ['platform.blob_lifecycle', count(evidence.blobs_pending), 'BLOB_PURGE_PENDING'],
      ['platform.outbox_events', count(evidence.ledger_pending), 'TOMBSTONE_LEDGER_PENDING'],
      ['integrations.external_actions', pending.actions, 'UNSETTLED_EXTERNAL_ACTIONS'],
      ['billing.payments', pending.payments, 'UNSETTLED_PAYMENTS'],
    ] as const)
      if (rows) leftOver.push({ tableRef, rows, reasonCode });
    const [blobBaseline] = await tx
      .select()
      .from(erasureLog)
      .where(
        and(eq(erasureLog.offboardingId, id), eq(erasureLog.reasonCode, 'ERASURE_BLOB_BASELINE')),
      )
      .limit(1);
    if (!blobBaseline || !row.erasureStartedAt) throw new AppError('PREREQUISITES_INCOMPLETE');
    const report: ErasureReport = {
      schemaVersion: 1,
      offboardingId: id,
      organizationId: context.organizationId,
      erasedTables,
      rowsRemoved,
      leftOver,
      retained: RETAINED_RECORDS.map((what) => ({
        what,
        reasonCode:
          what === 'backups_until_expiry'
            ? 'BACKUP_EXPIRY_REQUIRES_OPERATOR_VERIFICATION'
            : 'RETAINED_BY_RULE',
      })),
      blobsRemoved: Math.max(0, count(evidence.blobs_purged) - blobBaseline.rowsLeft),
      backups: 'expire_on_schedule',
      startedAt: row.erasureStartedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
    if (leftOver.length) {
      await tx
        .update(offboardings)
        .set({ report, version: row.version + 1, updatedAt: new Date() })
        .where(eq(offboardings.id, id));
      return { state: 'erasing', report };
    }
    const binding = ownedAgents(agents, id);
    await tx
      .update(offboardings)
      .set({
        state: 'verified',
        report,
        erasureFinishedAt: new Date(),
        erasureVerifiedByRef: input.operatorRef,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(offboardings.id, id));
    // The standing change keeps the offboarding-owned agent stop engaged, and 0508's
    // lifecycle.offboarding_agent_stop refuses that halt once the intent is reported (or cancelled).
    // 0501's check_lifecycle_change already admits `deleted` from `verified`, so the tenant is
    // deleted while the intent is verified, and reporting is the last step.
    await setTenantStandingInTx(
      tx,
      context,
      {
        to: 'deleted',
        reasonCode: 'OFFBOARDING_ERASURE_VERIFIED',
        actor: { type: 'operator', ref: input.operatorRef },
      },
      binding,
    );
    const [reported] = await tx
      .update(offboardings)
      .set({
        state: 'reported',
        reportedAt: new Date(),
        version: row.version + 2,
        updatedAt: new Date(),
      })
      .where(eq(offboardings.id, id))
      .returning();
    await event(tx, context, reported!, OFFBOARDING_REPORTED);
    await tellOwners(tx, context, id);
    await auditAction(
      tx,
      context,
      'offboarding.erasure_verified',
      offboardingTargetRef(id),
      'POST_DELETE_COUNTS_VERIFIED',
    );
    return { state: 'reported', report };
  });
}
