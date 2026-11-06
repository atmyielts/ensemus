import { and, eq, sql } from 'drizzle-orm';
import { openDatabase, type EnsemusDrizzle } from './connection';
import { memberships } from './schema';
import { webhookEndpoints } from './schema-integrations';

const brand: unique symbol = Symbol('TenantContext');

/** Proof that a user's active membership was checked. Only this module can create one. */
export type TenantContext = Readonly<{
  organizationId: string;
  userId: string;
  membershipId: string;
  role: string;
  /** `delegated` is a worker acting for one named person, with exactly that person's reach (ADR-029 D5). */
  actorType: 'user' | 'service' | 'delegated';
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
      // set_config because SET LOCAL cannot take a bind parameter (ADR-024 D4). One statement however
      // many there are, so binding a tenant costs one round trip.
      const settings = Object.entries(bindings).map(
        ([name, value]) => sql`set_config(${name}, ${value}, true)`,
      );
      if (settings.length > 0) await tx.execute(sql`select ${sql.join(settings, sql`, `)}`);
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
    {
      'app.organization_id': context.organizationId,
      'app.user_id': context.userId,
      // Knowledge's row-level security reads these, so a source's ACL holds whatever a query forgets:
      // a person sees what they may, and only a service context skips it (ADR-029 D2).
      'app.membership_id': context.membershipId,
      'app.actor_type': context.actorType,
    },
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
      })
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
    organizationId: membership.organizationId,
    userId,
    membershipId: membership.id,
    role: membership.role,
    actorType: 'user',
    [brand]: true,
  };
}

/**
 * A worker doing something for a person who asked, such as answering their question. The membership is
 * re-read and has to be active, so someone disabled since asking gets nothing. It can read what that person
 * can and no more, because knowledge's row-level security looks at the membership. A trigger refuses it
 * anything that has to be a person acting as themselves, such as verifying a fact. Worker-only, by lint.
 */
export async function createDelegatedContext(
  database: AppDatabase,
  organizationId: string,
  membershipId: string,
): Promise<TenantContext> {
  assertUuid(membershipId);
  const service = createServiceContext(organizationId);
  const [membership] = await withTenantTx(database, service, (tx) =>
    tx
      .select({
        id: memberships.id,
        role: memberships.role,
        userId: memberships.userId,
        organizationId: memberships.organizationId,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, service.organizationId),
          eq(memberships.id, membershipId),
          eq(memberships.status, 'active'),
        ),
      ),
  );
  if (!membership) throw new TenantAccessDenied();
  return {
    organizationId: membership.organizationId,
    userId: membership.userId,
    membershipId: membership.id,
    role: membership.role,
    actorType: 'delegated',
    [brand]: true,
  };
}

/** Confirms the database answers. Reads no tenant data. */
export async function pingDatabase(database: AppDatabase): Promise<void> {
  await database.run((tx) => tx.execute(sql`select 1`));
}
