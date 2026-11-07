// M7's tables and its two public bindings (ADR-031). Its own entry point, so nothing in this milestone
// touches ./index.ts, which the other milestones are changing at the same time.
import { and, eq, sql } from 'drizzle-orm';
import { ssoConnections, scimTokens } from './schema-product';
import { createServiceContext, type AppDatabase, type TenantContext, type Tx } from './tenant';

export * from './schema-product';
export * from './schema-object-authority';

export type ScimScope = {
  token: typeof scimTokens.$inferSelect;
  connection: typeof ssoConnections.$inferSelect;
  context: TenantContext;
};

/**
 * A provider telling us someone left (ADR-031 D9). Binds only the hash of the bearer token, which reveals
 * that one row, and from its row binds the tenant, so nothing about the tenant comes from the request.
 * Answers null, without calling `fn`, when no active token has that hash or its connection is not active.
 * Hands `fn` a context with no person behind it, which only SCIM's own service may use.
 */
export function withScimTokenTx<T>(
  database: AppDatabase,
  tokenHash: string,
  fn: (tx: Tx, scope: ScimScope) => Promise<T>,
): Promise<T | null> {
  return database.transaction({ 'app.scim_token_hash': tokenHash }, async (tx) => {
    const [token] = await tx
      .select()
      .from(scimTokens)
      .where(and(eq(scimTokens.tokenHash, tokenHash), eq(scimTokens.state, 'active')));
    if (!token) return null;
    await tx.execute(sql`select set_config('app.organization_id', ${token.organizationId}, true),
      set_config('app.user_id','',true),set_config('app.membership_id','',true),
      set_config('app.actor_type','service',true),set_config('app.interactive_session_id','',true)`);
    const [connection] = await tx
      .select()
      .from(ssoConnections)
      .where(
        and(
          eq(ssoConnections.organizationId, token.organizationId),
          eq(ssoConnections.id, token.connectionId),
          eq(ssoConnections.state, 'active'),
        ),
      );
    if (!connection) return null;
    return fn(tx, { token, connection, context: createServiceContext(token.organizationId) });
  });
}

export type SsoProviderScope = {
  connection: typeof ssoConnections.$inferSelect;
  context: TenantContext;
};

/**
 * Someone Better Auth just accepted from a provider, who is not in a tenant yet. Binds only the provider's
 * ID, finds its one active, domain-verified connection, and from that row binds the tenant. Answers null,
 * without calling `fn`, for anything else, so a provider nobody verified leads nowhere.
 */
export function withSsoProviderTx<T>(
  database: AppDatabase,
  providerId: string,
  fn: (tx: Tx, scope: SsoProviderScope) => Promise<T>,
): Promise<T | null> {
  return database.transaction({ 'app.sso_provider_id': providerId }, async (tx) => {
    const [connection] = await tx
      .select()
      .from(ssoConnections)
      .where(
        and(
          eq(ssoConnections.providerId, providerId),
          eq(ssoConnections.state, 'active'),
          eq(ssoConnections.domainState, 'verified'),
        ),
      );
    if (!connection) return null;
    await tx.execute(
      sql`select set_config('app.organization_id', ${connection.organizationId}, true),
        set_config('app.user_id','',true),set_config('app.membership_id','',true),
        set_config('app.actor_type','service',true),set_config('app.interactive_session_id','',true)`,
    );
    return fn(tx, { connection, context: createServiceContext(connection.organizationId) });
  });
}
