import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { appendAudit } from './audit';
import { deploymentProfile } from './schema-tenancy';
import {
  auditEvents,
  domainEvents,
  memberships,
  organizations,
  outboxEvents,
  users,
} from './schema';
import {
  TenantAccessDenied,
  withNewTenantTx,
  withTenantTx,
  withUserTx,
  type AppDatabase,
  type TenantContext,
} from './tenant';

export type CommercialMode = 'cloud' | 'byom' | 'sovereign';

export class DedicatedOrganizationClaimRefused extends Error {
  override name = 'DedicatedOrganizationClaimRefused';
}

/** An ID only this person and this form can arrive at, so nobody else can aim at an organization. */
function organizationIdFor(userId: string, requestKey: string, name: string) {
  const hex = createHash('sha256').update(`${userId}:${requestKey}:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Creates an organization and makes this person its owner. A `requestKey` makes this safe to repeat:
 * one rendered form sent again with the same name leads to the same organization, so a double-click or
 * a resubmitted page gets the first one back and creates nothing. The same form sent with another name
 * is someone who went back and typed a new one, so it makes that one and never drops it.
 */
export async function createOrganization(
  database: AppDatabase,
  input: {
    userId: string;
    name: string;
    commercialMode: CommercialMode;
    requestKey?: string;
    pinnedOrganizationId?: string;
  },
) {
  const organizationId =
    input.pinnedOrganizationId ??
    (input.requestKey
      ? organizationIdFor(input.userId, input.requestKey, input.name)
      : randomUUID());
  const membershipId = randomUUID();
  return withNewTenantTx(database, organizationId, input.userId, async (tx) => {
    if (input.pinnedOrganizationId) {
      const [profile] = await tx
        .select({ id: deploymentProfile.pinnedOrganizationId })
        .from(deploymentProfile)
        .where(
          and(
            eq(deploymentProfile.tier, 'dedicated'),
            eq(deploymentProfile.pinnedOrganizationId, organizationId),
          ),
        );
      if (!profile)
        throw new DedicatedOrganizationClaimRefused(
          'The dedicated pin is not configured in the database.',
        );
    }
    const created = await tx
      .insert(organizations)
      .values({
        id: organizationId,
        name: input.name,
        commercialMode: input.commercialMode,
      })
      .onConflictDoNothing()
      .returning({ id: organizations.id });
    if (created.length === 0) {
      const [existing] = await tx
        .select({ id: memberships.id, status: memberships.status })
        .from(memberships)
        .where(
          and(eq(memberships.organizationId, organizationId), eq(memberships.userId, input.userId)),
        );
      if (input.pinnedOrganizationId && existing?.status !== 'active') {
        throw new DedicatedOrganizationClaimRefused('The dedicated organization already exists.');
      }
      return { organizationId, membershipId: existing?.id ?? membershipId };
    }
    await tx.insert(memberships).values({
      organizationId,
      id: membershipId,
      userId: input.userId,
      role: 'owner',
    });
    const eventId = randomUUID();
    await tx.insert(domainEvents).values({
      organizationId,
      id: eventId,
      eventType: 'organization.created',
      aggregateType: 'organization',
      aggregateId: organizationId,
      aggregateVersion: 1,
      actorType: 'membership',
      actorId: membershipId,
      classification: 'internal',
      payload: { organization_id: organizationId },
    });
    await tx.insert(outboxEvents).values({ organizationId, eventId });
    await appendAudit(tx, {
      organizationId,
      actorType: 'user',
      actorId: input.userId,
      action: 'organization.created',
      targetRef: `organization:${organizationId}`,
      decision: 'allow',
    });
    return { organizationId, membershipId };
  });
}

/** Lists the organizations the user belongs to. Needs no tenant, only the user. */
export function listMyOrganizations(database: AppDatabase, userId: string) {
  return withUserTx(database, userId, (tx) =>
    tx
      .select({ id: organizations.id, name: organizations.name, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(eq(memberships.userId, userId))
      .orderBy(asc(organizations.name)),
  );
}

/** The workspace shell only needs to know whether the account has somewhere else to switch. */
export function hasOtherAccessibleOrganization(
  database: AppDatabase,
  userId: string,
  currentOrganizationId: string,
) {
  return withUserTx(database, userId, async (tx) => {
    const [other] = await tx
      .select({ found: sql<number>`1` })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
          ne(memberships.organizationId, currentOrganizationId),
          ne(organizations.lifecycle, 'deleted'),
        ),
      )
      .limit(1);
    return other !== undefined;
  });
}

/** Who is in this tenant, without contact details. People see those through the directory. */
export function listMembers(database: AppDatabase, context: TenantContext) {
  return withTenantTx(database, context, (tx) =>
    tx
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        role: memberships.role,
        status: memberships.status,
        name: users.name,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .orderBy(asc(users.name)),
  );
}

export function getOrganization(database: AppDatabase, context: TenantContext) {
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .select({
        id: organizations.id,
        name: organizations.name,
        commercialMode: organizations.commercialMode,
        lifecycle: organizations.lifecycle,
      })
      .from(organizations);
    return row ?? null;
  });
}

/** The audit log says who did what and who tried what, so it is for this tenant's owners and admins. */
export async function listAuditEvents(database: AppDatabase, context: TenantContext) {
  if (context.role !== 'owner' && context.role !== 'admin') throw new TenantAccessDenied();
  return withTenantTx(database, context, (tx) => tx.select().from(auditEvents));
}
