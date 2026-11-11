// Personal connections (ADR-038 D5). An admin decides which capabilities members may connect with their own
// account, and a member then connects through the same consent flow an admin uses, owning what it makes.
// Only that member sees it, and only that member, or an admin with connection.manage, revokes it. An admin
// sees whose it is and its state, never what it reaches. The database holds the same rules (migration
// 0563): only a person with connection.manage changes the setting, a member's consent may ask only for
// what it allows, and a member may revoke their own connection and do nothing else to it.
import {
  appendAudit,
  connections,
  memberships,
  suiteSettings,
  users,
  webhookEndpoints,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { connectionRef } from '@ensemus/domain/external-action';
import { AGGREGATE_CONNECTION, CONNECTION_REVOKED } from '@ensemus/domain/integration-events';
import { can } from '@ensemus/domain/policy';
import {
  CAPABILITY_OWNER,
  CAPABILITY_SCOPES,
  isSuiteConnectorType,
  MEMBER_CONNECTABLE_CAPABILITIES,
  SUITE_CONNECTOR_TYPES,
  type SuiteCapability,
  type SuiteConnectorType,
} from '@ensemus/domain/workspace-suites';
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { AppError } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import {
  startAuthorization,
  type OAuthWebSide,
  type StartedAuthorization,
} from './oauth-authorizations';
import { assertInteractivePrivilege, withPrivilegeTx } from './product/privileged';
import { listUsableConnections, type UsableConnection } from './suite-connections';

/** What members may connect for themselves when an admin has said nothing. */
export const DEFAULT_MEMBER_CAPABILITIES: readonly SuiteCapability[] = ['mail', 'calendar'];

/** Capabilities a member can own at all: ADR-038 D3's `member` and `either`. */
export const MEMBER_OWNABLE_CAPABILITIES: readonly SuiteCapability[] = (
  Object.keys(CAPABILITY_OWNER) as SuiteCapability[]
).filter((capability) => CAPABILITY_OWNER[capability] !== 'organization');

/** In the caller's transaction, so a consent start reads the setting it is checked against. */
export async function memberCapabilitiesInTx(tx: Tx): Promise<readonly SuiteCapability[]> {
  const [row] = await tx
    .select({ memberCapabilities: suiteSettings.memberCapabilities })
    .from(suiteSettings)
    .limit(1);
  if (!row) return DEFAULT_MEMBER_CAPABILITIES;
  return row.memberCapabilities.filter((capability): capability is SuiteCapability =>
    (MEMBER_OWNABLE_CAPABILITIES as readonly string[]).includes(capability),
  );
}

/** Anyone in the organization may see what they are allowed to connect. */
export function getMemberCapabilities(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly SuiteCapability[]> {
  return withTenantTx(database, context, memberCapabilitiesInTx);
}

/**
 * connection.manage, interactively. Narrowing it stops new consents for what was removed; connections
 * already made stay until revoked, and the admin's connections page lists them.
 */
export async function setMemberCapabilities(
  database: AppDatabase,
  context: TenantContext,
  capabilities: readonly SuiteCapability[],
): Promise<readonly SuiteCapability[]> {
  if (context.actorType !== 'user' || !can(context.role, 'connection.manage')) {
    throw new AppError('FORBIDDEN');
  }
  const chosen = [...new Set(capabilities)].sort();
  if (!chosen.every((capability) => MEMBER_OWNABLE_CAPABILITIES.includes(capability))) {
    throw new AppError('INVALID_INPUT');
  }
  await withPrivilegeTx(database, context, async (tx) => {
    await assertInteractivePrivilege(tx, context, 'connection.manage');
    await tx
      .insert(suiteSettings)
      .values({
        organizationId: context.organizationId,
        memberCapabilities: chosen,
        updatedByMembershipId: context.membershipId,
      })
      .onConflictDoUpdate({
        target: suiteSettings.organizationId,
        set: { memberCapabilities: chosen, updatedByMembershipId: context.membershipId },
      });
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'suite_settings.member_capabilities_changed',
      targetRef: `organization:${context.organizationId}`,
      decision: 'allow',
    });
  });
  return chosen;
}

/** The connections this member could name in an agent run: the organization's and their own. */
export function listMyUsableConnections(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly UsableConnection[]> {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  return withTenantTx(database, context, (tx) => listUsableConnections(tx, context.membershipId));
}

/**
 * What a connection can do for its owner, in capabilities rather than scopes: each one a member can own
 * whose every scope the provider granted. A capability with no scopes on this provider is never listed.
 */
export function memberCapabilitiesGranted(
  connectorType: SuiteConnectorType,
  grantedScopes: readonly string[],
): SuiteCapability[] {
  return MEMBER_OWNABLE_CAPABILITIES.filter((capability) => {
    const scopes = CAPABILITY_SCOPES[connectorType][capability];
    return scopes.length > 0 && scopes.every((scope) => grantedScopes.includes(scope));
  });
}

/** A member's own connection, as they see it on their own page. Capabilities, never scopes or secrets. */
export type MyConnectionView = {
  id: string;
  connectorType: SuiteConnectorType;
  displayName: string;
  state: string;
  capabilities: readonly SuiteCapability[];
  createdAt: Date;
};

/** A member's own connections, for their own settings page, newest first. Never anyone else's. */
export async function listMyConnections(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly MyConnectionView[]> {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: connections.id,
        connectorType: connections.connectorType,
        displayName: connections.displayName,
        state: connections.state,
        grantedScopes: connections.grantedScopes,
        createdAt: connections.createdAt,
      })
      .from(connections)
      .where(
        and(
          eq(connections.ownerMembershipId, context.membershipId),
          inArray(connections.connectorType, [...SUITE_CONNECTOR_TYPES]),
        ),
      )
      .orderBy(desc(connections.createdAt), asc(connections.id)),
  );
  return rows.flatMap((row) =>
    isSuiteConnectorType(row.connectorType)
      ? [
          {
            id: row.id,
            connectorType: row.connectorType,
            displayName: row.displayName,
            state: row.state,
            capabilities: memberCapabilitiesGranted(row.connectorType, row.grantedScopes),
            createdAt: row.createdAt,
          },
        ]
      : [],
  );
}

/**
 * A member's connection as an admin sees it: whose it is and its state. Not its name, which the member
 * chose, and not its capabilities or scopes, so the list says nothing about what it reaches.
 */
export type MemberConnectionView = {
  id: string;
  connectorType: string;
  ownerMembershipId: string;
  ownerName: string;
  state: string;
  createdAt: Date;
};

/** Every member's own connection, for those who manage connections, so they can revoke one. */
export async function listMemberConnections(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly MemberConnectionView[]> {
  if (context.actorType !== 'user' || !can(context.role, 'connection.manage')) {
    throw new AppError('FORBIDDEN');
  }
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: connections.id,
        connectorType: connections.connectorType,
        ownerMembershipId: memberships.id,
        ownerName: users.name,
        state: connections.state,
        createdAt: connections.createdAt,
      })
      .from(connections)
      .innerJoin(memberships, eq(memberships.id, connections.ownerMembershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(isNotNull(connections.ownerMembershipId))
      .orderBy(asc(users.name), desc(connections.createdAt), asc(connections.id)),
  );
  return rows;
}

/**
 * A member starts connecting their own Google or Microsoft account, through Ensemus's app, for capabilities
 * the organization allows members. Refused in plain words before anything is sealed: a capability no member
 * can own is OAUTH_CAPABILITY_UNAVAILABLE, and one this organization does not allow members is
 * MEMBER_CAPABILITY_NOT_ALLOWED. startAuthorization and 0563's trigger check the same again.
 */
export async function startMyConnection(
  database: AppDatabase,
  context: TenantContext,
  input: {
    connectorType: SuiteConnectorType;
    displayName: string;
    capabilities: readonly SuiteCapability[];
  },
  web: OAuthWebSide,
): Promise<StartedAuthorization> {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  const wanted = input.capabilities;
  if (
    wanted.length === 0 ||
    !wanted.every((capability) =>
      (MEMBER_CONNECTABLE_CAPABILITIES as readonly string[]).includes(capability),
    )
  ) {
    throw new AppError('OAUTH_CAPABILITY_UNAVAILABLE');
  }
  const allowed = await getMemberCapabilities(database, context);
  if (!wanted.every((capability) => allowed.includes(capability))) {
    throw new AppError('MEMBER_CAPABILITY_NOT_ALLOWED');
  }
  try {
    return await startAuthorization(
      database,
      context,
      {
        connectorType: input.connectorType,
        displayName: input.displayName,
        config: {},
        capabilities: wanted,
        owner: 'member',
        client: { kind: 'platform' },
      },
      web,
    );
  } catch (error) {
    // An admin narrowed the setting between the read above and the insert, whose own check refused it.
    if (error instanceof AppError && error.code === 'FORBIDDEN') {
      throw new AppError('MEMBER_CAPABILITY_NOT_ALLOWED');
    }
    throw error;
  }
}

/**
 * Revokes a member's own connection: by that member, or by an admin with connection.manage, interactively.
 * Anyone else, and any connection that is the organization's, hears that it does not exist. It takes
 * effect as an admin's revoke of the organization's does: the row is revoked, so every use rechecks it and
 * stops, its callback addresses close in the same transaction, and connection.revoked lets the worker
 * revoke the sealed secrets. Nothing here reads through the connection, for the admin or anyone.
 */
export async function revokeMyConnection(
  database: AppDatabase,
  context: TenantContext,
  input: { connectionId: string },
): Promise<void> {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  const id = idSchema.safeParse(input.connectionId);
  if (!id.success) throw new AppError('NOT_FOUND');
  const connectionId = id.data;
  const manages = can(context.role, 'connection.manage');
  await withPrivilegeTx(database, context, async (tx) => {
    // Who owns a connection never changes, so it decides, before any lock, whether this is the owner's
    // own revoke or an admin's, which takes the policy lock first as every privileged change does.
    const [owned] = await tx
      .select({ ownerMembershipId: connections.ownerMembershipId })
      .from(connections)
      .where(eq(connections.id, connectionId));
    if (!owned || owned.ownerMembershipId === null) throw new AppError('NOT_FOUND');
    const mine = owned.ownerMembershipId === context.membershipId;
    if (!mine && !manages) throw new AppError('NOT_FOUND');
    if (!mine) await assertInteractivePrivilege(tx, context, 'connection.manage');
    const [row] = await tx
      .select({ state: connections.state, version: connections.version })
      .from(connections)
      .where(eq(connections.id, connectionId))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (row.state === 'revoked') throw new AppError('CONNECTION_NOT_ACTIVE');
    const version = row.version + 1;
    await tx
      .update(connections)
      .set({ state: 'revoked', revokedAt: sql`now()`, updatedAt: sql`now()`, version })
      .where(eq(connections.id, connectionId));
    await tx
      .update(webhookEndpoints)
      .set({ state: 'revoked', updatedAt: sql`now()` })
      .where(
        and(eq(webhookEndpoints.connectionId, connectionId), ne(webhookEndpoints.state, 'revoked')),
      );
    await emit(tx, context, {
      eventType: CONNECTION_REVOKED,
      aggregateType: AGGREGATE_CONNECTION,
      aggregateId: connectionId,
      aggregateVersion: version,
      classification: 'internal',
      payload: { connectionId },
    });
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'connection.revoked',
      targetRef: connectionRef(connectionId),
      decision: 'allow',
    });
  });
}
