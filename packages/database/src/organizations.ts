import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { appendAudit } from './audit';
import { auditEvents, memberships, organizations, users } from './schema';
import {
  withNewTenantTx,
  withTenantTx,
  withUserTx,
  type AppDatabase,
  type TenantContext,
} from './tenant';

export type CommercialMode = 'cloud' | 'byom' | 'sovereign';

export async function createOrganization(
  database: AppDatabase,
  input: { userId: string; name: string; commercialMode: CommercialMode },
) {
  const organizationId = randomUUID();
  const membershipId = randomUUID();
  await withNewTenantTx(database, organizationId, input.userId, async (tx) => {
    await tx.insert(organizations).values({
      id: organizationId,
      name: input.name,
      commercialMode: input.commercialMode,
    });
    await tx.insert(memberships).values({
      organizationId,
      id: membershipId,
      userId: input.userId,
      role: 'owner',
    });
    await appendAudit(tx, {
      organizationId,
      actorType: 'user',
      actorId: input.userId,
      action: 'organization.created',
      targetRef: `organization:${organizationId}`,
      decision: 'allow',
    });
  });
  return { organizationId, membershipId };
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

export function listMembers(database: AppDatabase, context: TenantContext) {
  return withTenantTx(database, context, (tx) =>
    tx
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        role: memberships.role,
        status: memberships.status,
        name: users.name,
        email: users.email,
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

export function listAuditEvents(database: AppDatabase, context: TenantContext) {
  return withTenantTx(database, context, (tx) => tx.select().from(auditEvents));
}
