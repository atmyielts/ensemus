import { and, eq, sql } from 'drizzle-orm';
import { openDatabase, type EnsemusDrizzle } from './connection';
import { memberships, organizations } from './schema';
import { webhookEndpoints } from './schema-integrations';
import { billingAccounts } from './schema-saas';

const brand: unique symbol = Symbol('TenantContext');

/**
 * How far this person's tenant is being served (ADR-032 D5). Anything but `full` makes withTenantTx a
 * read-only transaction, so a write is refused by PostgreSQL itself even where a check was forgotten.
 */
export type TenantServing = 'full' | 'read_only' | 'suspended' | 'offboarding';

/** Proof that a user's active membership was checked. Only this module can create one. */
export type TenantContext = Readonly<{
  organizationId: string;
  userId: string;
  membershipId: string;
  role: string;
  actorType: 'user' | 'service';
  /** Missing means `full`, which is what a worker acting for a tenant always is. */
  serving?: TenantServing;
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
    // One spelling, because it ends up in object keys and lock names, where case makes a difference.
    organizationId: organizationId.toLowerCase(),
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
    async (tx) => {
      if (context.serving && context.serving !== 'full') {
        await tx.execute(sql`set transaction read only`);
      }
      return fn(tx);
    },
  );
}

/**
 * The same, for what a person may still do in a tenant that is not being served in full: pay, read their
 * bill, export, ask for support, and leave (ADR-032 D5). Only `@ensemus/application/saas/*` calls this,
 * through `@ensemus/database/account`, and lint keeps it there.
 */
export async function withAccountTx<T>(
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

/**
 * The same person, allowed to write, for one service another milestone wrote with withTenantTx that still has
 * to work in any standing. That is M6's export, today (ADR-032 D5). Lint keeps it where withAccountTx is.
 */
export function accountContextOf(context: TenantContext): TenantContext {
  if (context[brand] !== true) throw new TenantAccessDenied();
  return { ...context, serving: 'full' };
}

/**
 * A processor's event names a customer, and this binds only the hash of that reference, which reveals
 * that one billing account, and from its row binds the tenant, so nothing about the tenant comes from the
 * event (ADR-032 D4). Answers null, without calling `fn`, when nobody has that reference. Worker-only:
 * `@ensemus/database/payment-routing`, and lint blocks the web tier.
 */
export function withPaymentCustomerTx<T>(
  database: AppDatabase,
  customerRefHash: string,
  fn: (
    tx: Tx,
    scope: { account: typeof billingAccounts.$inferSelect; context: TenantContext },
  ) => Promise<T>,
): Promise<T | null> {
  return database.transaction({ 'app.payment_customer_hash': customerRefHash }, async (tx) => {
    const [account] = await tx
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.customerRefHash, customerRefHash));
    if (!account) return null;
    await tx.execute(
      sql`select set_config('app.organization_id', ${account.organizationId}, true)`,
    );
    return fn(tx, { account, context: createServiceContext(account.organizationId) });
  });
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

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;

/**
 * A public callback (ADR-024 D4, ADR-027 D4). Binds only the hash of the token in the URL, which reveals
 * that one endpoint, and from its row binds the tenant, so nothing about the tenant comes from the
 * request. Hands `fn` a context with no person behind it. Answers null, without calling `fn`, when no
 * active endpoint has that hash. This is the only way the web tier gets a context with no session.
 */
export function withWebhookEndpointTx<T>(
  database: AppDatabase,
  tokenHash: string,
  fn: (tx: Tx, scope: { endpoint: WebhookEndpointRow; context: TenantContext }) => Promise<T>,
): Promise<T | null> {
  return database.transaction({ 'app.webhook_token_hash': tokenHash }, async (tx) => {
    const [endpoint] = await tx
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.tokenHash, tokenHash), eq(webhookEndpoints.state, 'active')));
    if (!endpoint) return null;
    await tx.execute(
      sql`select set_config('app.organization_id', ${endpoint.organizationId}, true)`,
    );
    return fn(tx, { endpoint, context: createServiceContext(endpoint.organizationId) });
  });
}

/**
 * Checks an active membership and returns the context needed to reach that tenant's data. The ID in
 * the context is the one the row holds, never the one that was asked for: a UUID column matches any
 * case, but object keys and lock names are text, so a request in capitals would otherwise reach the
 * same data while looking in a different place for what protects it.
 */
export async function resolveTenantContext(
  database: AppDatabase,
  userId: string,
  organizationId: string,
): Promise<TenantContext> {
  assertUuid(organizationId);
  const [membership] = await withUserTx(database, userId, (tx) =>
    tx
      .select({
        id: memberships.id,
        role: memberships.role,
        organizationId: memberships.organizationId,
        lifecycle: organizations.lifecycle,
      })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
        ),
      ),
  );
  // A tenant that has gone is the same as one that never existed.
  if (!membership || membership.lifecycle === 'deleted') throw new TenantAccessDenied();
  return {
    organizationId: membership.organizationId,
    userId,
    membershipId: membership.id,
    role: membership.role,
    actorType: 'user',
    serving: membership.lifecycle === 'active' ? 'full' : (membership.lifecycle as TenantServing),
    [brand]: true,
  };
}

/** Confirms the database answers. Reads no tenant data. */
export async function pingDatabase(database: AppDatabase): Promise<void> {
  await database.run((tx) => tx.execute(sql`select 1`));
}
