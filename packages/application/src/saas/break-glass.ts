// The customer's and the operator's signatures on a break-glass request. Owned by the support slice (OPS-24).
// Default is no access. A second authorizer, a time limit and an audit trail are required, and even a fully
// authorized request reads nothing in M8: there is no such path. See ADR-032 D8.
import {
  artifacts,
  breakGlassLog,
  breakGlassRequests,
  clients,
  memberships,
  operatorActions,
  projects,
  workUnits,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import type { EnsemusDrizzle } from '@ensemus/database/operator';
import {
  breakGlassInForce,
  signBreakGlass,
  type BreakGlassConfig,
  type BreakGlassState,
} from '@ensemus/saas/support';
import { can } from '@ensemus/domain/policy';
import {
  AGGREGATE_BREAK_GLASS,
  BREAK_GLASS_AUTHORIZED,
  BREAK_GLASS_CLOSED,
  NOTIFY_BREAK_GLASS,
  breakGlassTargetRef,
} from '@ensemus/saas/events';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError, foreignReference } from '../errors';
import { idSchema } from '../ids';
import { auditAction, notify } from '../work';
import { emit } from '../events';

const owner = (context: TenantContext) => {
  if (context.actorType !== 'user' || !can(context.role, 'break_glass.authorize'))
    throw new AppError('NOT_FOUND');
};
const idOf = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data;
};
const version = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new AppError('INVALID_INPUT');
};
const stateAt = (row: typeof breakGlassRequests.$inferSelect, now: Date): BreakGlassState =>
  row.state === 'authorized' && row.expiresAt && row.expiresAt <= now
    ? 'expired'
    : (row.state as BreakGlassState);
async function load(tx: Tx, context: TenantContext, id: string) {
  const [row] = await tx
    .select()
    .from(breakGlassRequests)
    .where(
      and(
        eq(breakGlassRequests.organizationId, context.organizationId),
        eq(breakGlassRequests.id, id),
      ),
    )
    .for('update');
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}
async function validateScope(
  tx: Tx,
  context: TenantContext,
  row: typeof breakGlassRequests.$inferSelect,
) {
  if (!['work_unit', 'artifact', 'client', 'project'].includes(row.scopeType))
    throw foreignReference();
  const table =
    row.scopeType === 'work_unit'
      ? workUnits
      : row.scopeType === 'artifact'
        ? artifacts
        : row.scopeType === 'project'
          ? projects
          : clients;
  const [found] = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.organizationId, context.organizationId), eq(table.id, row.scopeId)));
  if (!found) throw foreignReference();
}
function refusal(code: string): never {
  throw new AppError(
    code === 'BREAK_GLASS_DISABLED' ? 'BREAK_GLASS_DISABLED' : 'BREAK_GLASS_NOT_AUTHORIZABLE',
  );
}
async function customerRecord(
  tx: Tx,
  context: TenantContext,
  row: typeof breakGlassRequests.$inferSelect,
  action: 'customer_authorized' | 'denied' | 'revoked' | 'expired',
  eventType: string | null,
) {
  await tx.insert(breakGlassLog).values({
    organizationId: context.organizationId,
    requestId: row.id,
    action,
    actorRef: context.membershipId,
    targetRef: `${row.scopeType}:${row.scopeId}`,
  });
  await auditAction(tx, context, `support.break_glass_${action}`, breakGlassTargetRef(row.id));
  if (eventType)
    await emit(tx, context, {
      eventType,
      aggregateType: AGGREGATE_BREAK_GLASS,
      aggregateId: row.id,
      aggregateVersion: row.version + 1,
      classification: 'internal',
      payload: { request_id: row.id },
    });
  const owners = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.role, 'owner'), eq(memberships.status, 'active')));
  await notify(
    tx,
    context,
    owners.map((member) => member.id),
    NOTIFY_BREAK_GLASS,
    breakGlassTargetRef(row.id),
  );
}

export type BreakGlassView = {
  id: string;
  ticketId: string;
  reasonCode: string;
  scopeType: string;
  scopeId: string;
  scopeLabel: string | null;
  requestedMinutes: number;
  state: BreakGlassState;
  operatorAuthorized: boolean;
  customerAuthorized: boolean;
  expiresAt: Date | null;
  version: number;
};

/** `break_glass.authorize`, which only an owner has. */
export async function listBreakGlassRequests(
  database: AppDatabase,
  context: TenantContext,
  input?: { requestId: string },
): Promise<readonly BreakGlassView[]> {
  owner(context);
  return withAccountTx(database, context, async (tx) => {
    const rows = await tx
        .select()
        .from(breakGlassRequests)
        .where(input ? eq(breakGlassRequests.id, idOf(input.requestId)) : undefined)
        .orderBy(desc(breakGlassRequests.createdAt), desc(breakGlassRequests.id)),
      ids = (type: string) =>
        rows.filter((row) => row.scopeType === type).map((row) => row.scopeId);
    // These are the owner's ordinary names, independent of the request's authorization state.
    const [works, files, clientRows, projectRows] = await Promise.all([
      ids('work_unit').length
        ? tx
            .select({ id: workUnits.id, label: workUnits.title })
            .from(workUnits)
            .where(
              and(
                eq(workUnits.organizationId, context.organizationId),
                inArray(workUnits.id, ids('work_unit')),
              ),
            )
        : Promise.resolve([]),
      ids('artifact').length
        ? tx
            .select({ id: artifacts.id, label: artifacts.name })
            .from(artifacts)
            .where(
              and(
                eq(artifacts.organizationId, context.organizationId),
                inArray(artifacts.id, ids('artifact')),
              ),
            )
        : Promise.resolve([]),
      ids('client').length
        ? tx
            .select({ id: clients.id, label: clients.displayName })
            .from(clients)
            .where(
              and(
                eq(clients.organizationId, context.organizationId),
                inArray(clients.id, ids('client')),
              ),
            )
        : Promise.resolve([]),
      ids('project').length
        ? tx
            .select({ id: projects.id, label: projects.name })
            .from(projects)
            .where(
              and(
                eq(projects.organizationId, context.organizationId),
                inArray(projects.id, ids('project')),
              ),
            )
        : Promise.resolve([]),
    ]);
    const labels = new Map<string, string>([
      ...works.map((row) => [`work_unit:${row.id}`, row.label] as const),
      ...files.map((row) => [`artifact:${row.id}`, row.label] as const),
      ...clientRows.map((row) => [`client:${row.id}`, row.label] as const),
      ...projectRows.map((row) => [`project:${row.id}`, row.label] as const),
    ]);
    return rows.map((row) => ({
      id: row.id,
      ticketId: row.ticketId,
      reasonCode: row.reasonCode,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      scopeLabel: labels.get(`${row.scopeType}:${row.scopeId}`) ?? null,
      requestedMinutes: row.requestedMinutes,
      state: stateAt(row, new Date()),
      operatorAuthorized: row.operatorAuthorizer !== null,
      customerAuthorized: row.customerAuthorizerMembershipId !== null,
      expiresAt: row.expiresAt,
      version: row.version,
    }));
  });
}

/**
 * `break_glass.authorize`, and a person. The customer's side: agree or refuse. Applies `signBreakGlass`, logs
 * it, audits it, and tells the other owners. Refusing is final. An approval needs the scope to be in this tenant.
 */
export async function decideBreakGlass(
  database: AppDatabase,
  context: TenantContext,
  input: {
    requestId: string;
    decision: 'authorize' | 'deny';
    expectedVersion: number;
  },
  config: BreakGlassConfig,
): Promise<{ state: BreakGlassState; expiresAt: Date | null }> {
  owner(context);
  const id = idOf(input.requestId);
  version(input.expectedVersion);
  if (input.decision !== 'authorize' && input.decision !== 'deny')
    throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    const row = await load(tx, context, id);
    if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    const now = new Date();
    if (input.decision === 'deny') {
      if (row.state !== 'requested') throw new AppError('BREAK_GLASS_NOT_AUTHORIZABLE');
      await tx
        .update(breakGlassRequests)
        .set({
          state: 'denied',
          closedAt: now,
          closedBy: context.membershipId,
          version: row.version + 1,
        })
        .where(eq(breakGlassRequests.id, id));
      await customerRecord(tx, context, row, 'denied', BREAK_GLASS_CLOSED);
      return { state: 'denied', expiresAt: row.expiresAt };
    }
    if (!config.enabled) throw new AppError('BREAK_GLASS_DISABLED');
    await validateScope(tx, context, row);
    if (
      row.customerAuthorizerMembershipId === context.membershipId &&
      (row.state === 'requested' ||
        breakGlassInForce({ ...row, state: row.state as BreakGlassState }, now))
    )
      return { state: row.state as BreakGlassState, expiresAt: row.expiresAt };
    const signedAt = new Date(Math.max(now.getTime(), row.operatorAuthorizedAt?.getTime() ?? 0));
    const decision = signBreakGlass(
      { ...row, state: row.state as BreakGlassState },
      { side: 'customer', membershipId: context.membershipId },
      config,
      signedAt,
    );
    if (!decision.ok) refusal(decision.code);
    await tx
      .update(breakGlassRequests)
      .set({
        customerAuthorizerMembershipId: context.membershipId,
        customerAuthorizedAt: signedAt,
        state: decision.state,
        authorizedFrom: decision.state === 'authorized' ? signedAt : null,
        expiresAt: decision.expiresAt,
        version: row.version + 1,
      })
      .where(eq(breakGlassRequests.id, id));
    await customerRecord(
      tx,
      context,
      row,
      'customer_authorized',
      decision.state === 'authorized' ? BREAK_GLASS_AUTHORIZED : null,
    );
    return { state: decision.state, expiresAt: decision.expiresAt };
  });
}

/** `break_glass.authorize`. A customer can end it at any moment, whoever agreed to it. */
export async function revokeBreakGlass(
  database: AppDatabase,
  context: TenantContext,
  input: { requestId: string; expectedVersion: number },
): Promise<void> {
  owner(context);
  const id = idOf(input.requestId);
  version(input.expectedVersion);
  return withAccountTx(database, context, async (tx) => {
    const row = await load(tx, context, id);
    if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (['denied', 'revoked', 'expired'].includes(row.state)) return;
    const now = new Date(),
      state =
        row.state === 'requested'
          ? 'denied'
          : row.expiresAt && row.expiresAt <= now
            ? 'expired'
            : 'revoked';
    await tx
      .update(breakGlassRequests)
      .set({ state, closedAt: now, closedBy: context.membershipId, version: row.version + 1 })
      .where(eq(breakGlassRequests.id, id));
    await customerRecord(tx, context, row, state, BREAK_GLASS_CLOSED);
  });
}

/** The operator's side, from the command line, as `ensemus_operator`. Never the person who asked. */
export async function authorizeBreakGlassAsOperator(
  db: EnsemusDrizzle,
  input: { organizationId: string; requestId: string; operatorRef: string },
  config: BreakGlassConfig,
  now: Date,
): Promise<{ state: BreakGlassState; expiresAt: Date | null }> {
  const organizationId = idOf(input.organizationId),
    id = idOf(input.requestId);
  if (
    !input.operatorRef ||
    input.operatorRef !== input.operatorRef.trim() ||
    input.operatorRef.length > 200 ||
    /[\r\n\0]/.test(input.operatorRef) ||
    !Number.isFinite(now.getTime())
  )
    throw new AppError('INVALID_INPUT');
  return db.transaction(async (tx) => {
    const role = await tx.execute(sql`select current_user as role`);
    if (role.rows[0]?.role !== 'ensemus_operator') throw new AppError('NOT_FOUND');
    if (!config.enabled) throw new AppError('BREAK_GLASS_DISABLED');
    const [row] = await tx
      .select()
      .from(breakGlassRequests)
      .where(
        and(eq(breakGlassRequests.organizationId, organizationId), eq(breakGlassRequests.id, id)),
      )
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (
      row.operatorAuthorizer === input.operatorRef &&
      (row.state === 'requested' ||
        breakGlassInForce({ ...row, state: row.state as BreakGlassState }, now))
    )
      return { state: row.state as BreakGlassState, expiresAt: row.expiresAt };
    // The second signature cannot predate the first if the two trusted callers' clocks differ.
    const signedAt = new Date(Math.max(now.getTime(), row.customerAuthorizedAt?.getTime() ?? 0));
    const decision = signBreakGlass(
      { ...row, state: row.state as BreakGlassState },
      { side: 'operator', operatorRef: input.operatorRef },
      config,
      signedAt,
    );
    if (!decision.ok) refusal(decision.code);
    await tx
      .update(breakGlassRequests)
      .set({
        operatorAuthorizer: input.operatorRef,
        operatorAuthorizedAt: signedAt,
        state: decision.state,
        authorizedFrom: decision.state === 'authorized' ? signedAt : null,
        expiresAt: decision.expiresAt,
        version: row.version + 1,
      })
      .where(
        and(eq(breakGlassRequests.organizationId, organizationId), eq(breakGlassRequests.id, id)),
      );
    await tx.insert(breakGlassLog).values({
      organizationId,
      requestId: id,
      action: 'operator_authorized',
      actorRef: input.operatorRef,
      targetRef: `${row.scopeType}:${row.scopeId}`,
    });
    await tx.insert(operatorActions).values({
      operatorRef: input.operatorRef,
      action: 'support.break_glass_operator_authorized',
      targetRef: breakGlassTargetRef(id),
    });
    return { state: decision.state, expiresAt: decision.expiresAt };
  });
}
