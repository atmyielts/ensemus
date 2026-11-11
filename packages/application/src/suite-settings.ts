// Personal connections (ADR-038 D5). An admin decides which capabilities members may connect with their own
// account, and a member then connects through the same consent flow an admin uses, owning what it makes.
// The database holds the same rules (migration 0563): only a person with connection.manage changes the
// setting, and a member's consent may ask only for what it allows.
//
// The pages that use these belong to the personal-connections builder. The signatures here are theirs to
// build on; the two marked NOT_IMPLEMENTED are theirs to write.
import {
  appendAudit,
  connections,
  suiteSettings,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { can } from '@ensemus/domain/policy';
import { CAPABILITY_OWNER, type SuiteCapability } from '@ensemus/domain/workspace-suites';
import { and, eq } from 'drizzle-orm';
import { AppError } from './errors';
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

/** A member's own connections, for their own settings page. Never anyone else's. */
export async function listMyConnections(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly { id: string; connectorType: string; displayName: string; state: string }[]> {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  return withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: connections.id,
        connectorType: connections.connectorType,
        displayName: connections.displayName,
        state: connections.state,
      })
      .from(connections)
      .where(and(eq(connections.ownerMembershipId, context.membershipId))),
  );
}

/**
 * A member revokes their own connection: the personal-connections builder writes this, through the same
 * revoke path an admin's uses, so the credential is revoked and its resources stop being served at once.
 */
export async function revokeMyConnection(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { connectionId: string },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}
