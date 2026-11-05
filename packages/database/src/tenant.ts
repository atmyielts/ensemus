import { and, eq, sql } from 'drizzle-orm';
import { openDatabase, type EnsemusDrizzle } from './connection';
import { memberships } from './schema';

const brand: unique symbol = Symbol('TenantContext');

/** Proof that a user's active membership was checked. Only this module can create one. */
export type TenantContext = Readonly<{
  organizationId: string;
  userId: string;
  membershipId: string;
  role: string;
  actorType: 'user' | 'service';
  [brand]: true;
}>;

/**
 * A worker acting for a tenant, with no person behind the transaction. Only workers may import
 * this (`@ensemus/database/service`, enforced by lint). The organization ID comes from the outbox
 * event, not from any model or request, and RLS still confines every query to that tenant.
 */
export function createServiceContext(organizationId: string): TenantContext {
  if (!UUID.test(organizationId)) throw new TenantAccessDenied();
  return {
    organizationId,
    userId: '',
    membershipId: '',
    role: 'service',
    actorType: 'service',
    [brand]: true,
  };
}

export type Tx = Parameters<Parameters<EnsemusDrizzle['transaction']>[0]>[0];

/** The application handle. Queries only run through the helpers below, which bind context first. */
export class AppDatabase {
  readonly #db: EnsemusDrizzle;
  constructor(db: EnsemusDrizzle) {
    this.#db = db;
  }
  /** Runs with nothing bound, so RLS returns no tenant rows. Exists to test exactly that. */
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#db.transaction(fn);
  }
  transaction<T>(bindings: Record<string, string>, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#db.transaction(async (tx) => {
      // set_config because SET LOCAL cannot take a bind parameter (ADR-024 D4).
      for (const [name, value] of Object.entries(bindings)) {
        await tx.execute(sql`select set_config(${name}, ${value}, true)`);
      }
      return fn(tx);
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TenantAccessDenied extends Error {
  override name = 'TenantAccessDenied';
  constructor() {
    // Same message whether the organization is missing or forbidden, so IDs cannot be probed.
    super('Not found or not permitted');
  }
}

function assertUuid(value: string) {
  if (!UUID.test(value)) throw new TenantAccessDenied();
}

export function openAppDatabase(url: string, options: { max?: number } = {}) {
  const { db, close } = openDatabase(url, options);
  return { db: new AppDatabase(db), close };
}

/** Binds only the user: their own memberships and organizations are visible, tenant data is not. */
export function withUserTx<T>(
  database: AppDatabase,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(userId);
  return database.transaction({ 'app.user_id': userId }, fn);
}

/** Binds one tenant. Keep it short: never span rendering or a model call. */
export async function withTenantTx<T>(
  database: AppDatabase,
  context: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (context[brand] !== true) throw new TenantAccessDenied();
  return database.transaction(
    { 'app.organization_id': context.organizationId, 'app.user_id': context.userId },
    fn,
  );
}

/** Binds a brand-new tenant, so row-level policies apply to its first inserts like any other. */
export function withNewTenantTx<T>(
  database: AppDatabase,
  organizationId: string,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(organizationId);
  assertUuid(userId);
  return database.transaction({ 'app.organization_id': organizationId, 'app.user_id': userId }, fn);
}

/** Binds only the hash of an invitation token, which reveals that one invitation and nothing else. */
export function withInvitationTx<T>(
  database: AppDatabase,
  tokenHash: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return database.transaction({ 'app.invitation_token_hash': tokenHash }, fn);
}

/** Checks an active membership and returns the context needed to reach that tenant's data. */
export async function resolveTenantContext(
  database: AppDatabase,
  userId: string,
  organizationId: string,
): Promise<TenantContext> {
  assertUuid(organizationId);
  const [membership] = await withUserTx(database, userId, (tx) =>
    tx
      .select({ id: memberships.id, role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
        ),
      ),
  );
  if (!membership) throw new TenantAccessDenied();
  return {
    organizationId,
    userId,
    membershipId: membership.id,
    role: membership.role,
    actorType: 'user',
    [brand]: true,
  };
}

/** Confirms the database answers. Reads no tenant data. */
export async function pingDatabase(database: AppDatabase): Promise<void> {
  await database.run((tx) => tx.execute(sql`select 1`));
}
