// What the operator's live suite check reads from PostgreSQL (workers/workflow/src/live-suite-check.ts).
// Both read only, under the connector worker's service context, and hand back settings, IDs and sets of
// provider IDs: never a person's name or address. Nothing in the product path calls them.
import {
  connections,
  externalResources,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { AppError } from './errors';
import { idSchema } from './ids';

/** The connection as the check needs it. Its display name is read only to hold it to the TEST rule. */
export type LiveCheckConnection = {
  id: string;
  displayName: string;
  state: string;
  connectorType: string;
  config: unknown;
  credentialSecretId: string | null;
  grantedScopes: readonly string[];
  ownerKind: 'organization' | 'member';
};

const requireWorker = (context: TenantContext) => {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
};

/** One connection of this tenant, or null. RLS keeps it to the context's own organization. */
export async function loadLiveCheckConnection(
  database: AppDatabase,
  context: TenantContext,
  connectionId: string,
): Promise<LiveCheckConnection | null> {
  requireWorker(context);
  if (!idSchema.safeParse(connectionId).success) throw new AppError('INVALID_INPUT');
  const [row] = await withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: connections.id,
        displayName: connections.displayName,
        state: connections.state,
        connectorType: connections.connectorType,
        config: connections.config,
        credentialSecretId: connections.credentialSecretId,
        grantedScopes: connections.grantedScopes,
        ownerMembershipId: connections.ownerMembershipId,
      })
      .from(connections)
      .where(eq(connections.id, connectionId)),
  );
  if (!row) return null;
  const { ownerMembershipId, ...rest } = row;
  return { ...rest, ownerKind: ownerMembershipId ? 'member' : 'organization' };
}

/**
 * Of these provider IDs, the ones this connection has synced and not seen deleted, whatever their ACL:
 * what an administrator who may read everything synced would be shown. The check's stand-in for the
 * initiator's source ACL, so a search filters as it does in the product and the count says so.
 */
export async function syncedResourceIds(
  database: AppDatabase,
  context: TenantContext,
  input: { connectionId: string; externalIds: readonly string[] },
): Promise<ReadonlySet<string>> {
  requireWorker(context);
  if (!idSchema.safeParse(input.connectionId).success) throw new AppError('INVALID_INPUT');
  const unique = [...new Set(input.externalIds)].slice(0, 1000);
  if (unique.length === 0) return new Set();
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select({ externalId: externalResources.externalId })
      .from(externalResources)
      .where(
        and(
          eq(externalResources.connectionId, input.connectionId),
          inArray(externalResources.externalId, unique),
          isNull(externalResources.deletedAt),
        ),
      ),
  );
  return new Set(rows.map((row) => row.externalId));
}
