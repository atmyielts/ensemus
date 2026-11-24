// The reads behind ADR-038 D5 and D6's connection rule, shared by the three places that apply it: the agent
// gateway in its gate transaction, the connector worker's recheck before and after a suite read, and M3's
// intent path. Each takes the caller's transaction, so what it read and what that caller does next commit
// together. The decision itself is `decideConnectionUse` in @ensemus/policy, which is pure.
import {
  connections,
  externalResourceAcl,
  externalResources,
  teamMemberships,
  type Tx,
} from '@ensemus/database';
import {
  isSuiteRule,
  TOOL_MANIFESTS,
  type ToolConnectorType,
  type ToolManifest,
} from '@ensemus/domain/ai-tools';
import type { ConnectionFacts, ResourceFacts, SourceAccess } from '@ensemus/policy';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';

const SOURCE_ACCESS: readonly SourceAccess[] = ['read', 'write', 'owner'];

/**
 * The connection as it stands now, share-locked so revoking it waits for this transaction or commits
 * first and is seen. Null when this tenant has no such connection.
 */
export async function lockConnectionFacts(
  tx: Tx,
  connectionId: string,
): Promise<(ConnectionFacts & { id: string; displayName: string }) | null> {
  const [row] = await tx
    .select({
      id: connections.id,
      state: connections.state,
      connectorType: connections.connectorType,
      ownerMembershipId: connections.ownerMembershipId,
      grantedScopes: connections.grantedScopes,
      displayName: connections.displayName,
    })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .for('share');
  return row ?? null;
}

/** Everything the source's synced ACL grants this member on these resources, directly or by a team. */
async function accessByResource(
  tx: Tx,
  input: { connectionId: string; membershipId: string; externalIds: readonly string[] },
): Promise<Map<string, { synced: boolean; access: SourceAccess[] }>> {
  const found = new Map<string, { synced: boolean; access: SourceAccess[] }>();
  if (input.externalIds.length === 0) return found;
  const resources = await tx
    .select({
      id: externalResources.id,
      externalId: externalResources.externalId,
      aclState: externalResources.aclState,
    })
    .from(externalResources)
    .where(
      and(
        eq(externalResources.connectionId, input.connectionId),
        inArray(externalResources.externalId, [...input.externalIds]),
        isNull(externalResources.deletedAt),
      ),
    );
  if (resources.length === 0) return found;
  const teams = tx
    .select({ teamId: teamMemberships.teamId })
    .from(teamMemberships)
    .where(eq(teamMemberships.membershipId, input.membershipId));
  const grants = await tx
    .select({ resourceId: externalResourceAcl.resourceId, access: externalResourceAcl.access })
    .from(externalResourceAcl)
    .where(
      and(
        inArray(
          externalResourceAcl.resourceId,
          resources.map((resource) => resource.id),
        ),
        or(
          eq(externalResourceAcl.membershipId, input.membershipId),
          inArray(externalResourceAcl.teamId, teams),
        ),
      ),
    );
  for (const resource of resources) {
    // `partial` and `unmapped` mean some source grant found nobody here. Such a resource grants nobody
    // anything until a sync maps all of it, which is the rule every read path already follows.
    const synced = resource.aclState === 'mapped';
    const access = grants
      .filter((grant) => grant.resourceId === resource.id)
      .map((grant) => grant.access as SourceAccess)
      .filter((access) => SOURCE_ACCESS.includes(access));
    found.set(resource.externalId, { synced, access: synced ? access : [] });
  }
  return found;
}

/** The one resource a tool names. Null when it never synced, which the rule then refuses. */
export async function resourceFacts(
  tx: Tx,
  input: { connectionId: string; membershipId: string; externalId: string | null },
): Promise<ResourceFacts | null> {
  if (input.externalId === null) return null;
  const found = await accessByResource(tx, { ...input, externalIds: [input.externalId] });
  return found.get(input.externalId) ?? null;
}

/**
 * Of these resources, the ones this member may have through the organization's connection: synced, mapped,
 * and granted at least `needed` by the source. Anything not synced is left out, never assumed.
 */
export async function permittedResources(
  tx: Tx,
  input: {
    connectionId: string;
    membershipId: string;
    externalIds: readonly string[];
    needed: 'read' | 'write';
  },
): Promise<ReadonlySet<string>> {
  const unique = [...new Set(input.externalIds)].slice(0, 1000);
  const found = await accessByResource(tx, { ...input, externalIds: unique });
  const permitted = new Set<string>();
  for (const [externalId, facts] of found) {
    const ok =
      facts.synced &&
      (facts.access.includes('owner') ||
        facts.access.includes('write') ||
        (input.needed === 'read' && facts.access.includes('read')));
    if (ok) permitted.add(externalId);
  }
  return permitted;
}

/** What a model is told about a connection it may name: never its scopes, settings or credential. */
export type UsableConnection = {
  id: string;
  connectorType: ToolConnectorType;
  owner: 'organization' | 'yours';
  displayName: string;
  /** The suite tools this run could use it for, by the rule's owner and scopes. */
  toolIds: readonly string[];
};

const suiteManifests = (TOOL_MANIFESTS as readonly ToolManifest[]).filter(
  (tool) => tool.connection !== undefined && isSuiteRule(tool.connection),
);

/** The suite tools a connection could serve for this member, by type, owner and granted scopes. */
export function toolsUsableOn(connection: ConnectionFacts, membershipId: string): string[] {
  const owner = connection.ownerMembershipId;
  if (connection.state !== 'active') return [];
  if (owner !== null && owner.toLowerCase() !== membershipId.toLowerCase()) return [];
  const kind = owner === null ? 'organization' : 'member';
  return suiteManifests
    .filter((tool) => {
      const rule = tool.connection!;
      const binding = rule.bindings[connection.connectorType as ToolConnectorType];
      if (!binding) return false;
      if (rule.owner !== 'either' && rule.owner !== kind) return false;
      return binding.scopes.every((scope) => connection.grantedScopes.includes(scope));
    })
    .map((tool) => tool.id);
}

/**
 * The active suite connections this member may name: the organization's, and their own. Another member's
 * is never listed. At most fifty, in a fixed order, so the same run sees the same list.
 */
export async function listUsableConnections(
  tx: Tx,
  membershipId: string,
): Promise<readonly UsableConnection[]> {
  const rows = await tx
    .select({
      id: connections.id,
      state: connections.state,
      connectorType: connections.connectorType,
      ownerMembershipId: connections.ownerMembershipId,
      grantedScopes: connections.grantedScopes,
      displayName: connections.displayName,
    })
    .from(connections)
    .where(
      and(
        eq(connections.state, 'active'),
        inArray(connections.connectorType, ['google_workspace', 'microsoft_365']),
        or(isNull(connections.ownerMembershipId), eq(connections.ownerMembershipId, membershipId)),
      ),
    )
    .orderBy(asc(connections.displayName), asc(connections.id))
    .limit(50);
  return rows
    .map((row) => ({
      id: row.id,
      connectorType: row.connectorType as ToolConnectorType,
      owner: row.ownerMembershipId === null ? ('organization' as const) : ('yours' as const),
      displayName: row.displayName,
      toolIds: toolsUsableOn(row, membershipId),
    }))
    .filter((connection) => connection.toolIds.length > 0);
}
