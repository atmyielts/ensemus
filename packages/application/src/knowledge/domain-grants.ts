// Whether a provider's share with a whole email domain reaches anyone here (ADR-029 D2 addendum, question 4).
// Off by default. On, it reaches only active members with a verified email in a domain this organization has
// itself verified, for public and internal sources: knowledge.readable_source_ids holds that in SQL
// (migration 0712), so nothing here decides who reads what. "Anyone with the link" never reaches anyone.
// Changing it widens or narrows access, so it is a security policy change: security_policy.manage, recent
// MFA, audited, and 0404's guard refuses it in SQL without that.
import { memberships, type AppDatabase, type TenantContext, type Tx } from '@ensemus/database';
import { securityPolicies } from '@ensemus/database/product';
import { canProduct, DEFAULT_MFA_MAX_AGE_SECONDS } from '@ensemus/domain/product-policy';
import { and, eq } from 'drizzle-orm';
import { AppError } from '../errors';
import { assertRecentMfa, withPrivilegeTx, type SessionProof } from '../product/privileged';
import { auditAction } from '../work';

export type DomainGrantSetting = { enabled: boolean; version: number };

async function activePerson(tx: Tx, context: TenantContext) {
  if (context.actorType !== 'user') throw new AppError('NOT_FOUND');
  const [person] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.id, context.membershipId),
        eq(memberships.userId, context.userId),
        eq(memberships.status, 'active'),
      ),
    )
    .for('share');
  if (!person) throw new AppError('NOT_FOUND');
  return { ...context, role: person.role };
}

/** Anyone in the organization may see it, since it decides what a provider's share means here. */
export function getDomainGrantSetting(
  database: AppDatabase,
  context: TenantContext,
): Promise<DomainGrantSetting> {
  return withPrivilegeTx(database, context, async (tx) => {
    await activePerson(tx, context);
    const [row] = await tx
      .select({
        enabled: securityPolicies.knowledgeDomainGrants,
        version: securityPolicies.version,
      })
      .from(securityPolicies)
      .where(eq(securityPolicies.organizationId, context.organizationId));
    return row ?? { enabled: false, version: 1 };
  });
}

/**
 * Turns the mapping on or off, against the security policy's version so two admins cannot overwrite
 * each other unseen. Off takes effect in this commit: the next read by anyone evaluates it again.
 */
export function setDomainGrantSetting(
  database: AppDatabase,
  context: TenantContext,
  proof: SessionProof | null,
  input: { enabled: boolean; expectedVersion: number },
): Promise<DomainGrantSetting> {
  if (
    typeof input.enabled !== 'boolean' ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  )
    throw new AppError('INVALID_INPUT');
  return withPrivilegeTx(database, context, async (tx) => {
    const fresh = await activePerson(tx, context);
    if (!canProduct(fresh.role, 'security_policy.manage')) throw new AppError('NOT_FOUND');
    await assertRecentMfa(tx, fresh, 'security_policy.change', proof);
    const [row] = await tx
      .select()
      .from(securityPolicies)
      .where(eq(securityPolicies.organizationId, fresh.organizationId))
      .for('update');
    const update = {
      knowledgeDomainGrants: input.enabled,
      version: input.expectedVersion + 1,
      updatedByMembershipId: fresh.membershipId,
      updatedAt: new Date(),
    };
    let saved: { knowledgeDomainGrants: boolean; version: number } | undefined;
    if (!row) {
      if (input.expectedVersion !== 1) throw new AppError('VERSION_CONFLICT');
      [saved] = await tx
        .insert(securityPolicies)
        .values({
          organizationId: fresh.organizationId,
          mfaMaxAgeSeconds: DEFAULT_MFA_MAX_AGE_SECONDS,
          ...update,
        })
        .onConflictDoNothing()
        .returning();
    } else {
      if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
      [saved] = await tx
        .update(securityPolicies)
        .set(update)
        .where(
          and(
            eq(securityPolicies.organizationId, fresh.organizationId),
            eq(securityPolicies.version, input.expectedVersion),
          ),
        )
        .returning();
    }
    if (!saved) throw new AppError('VERSION_CONFLICT');
    await auditAction(
      tx,
      fresh,
      input.enabled ? 'knowledge.domain_grants_enabled' : 'knowledge.domain_grants_disabled',
      `organization:${fresh.organizationId}`,
      'POLICY_CHANGED',
    );
    return { enabled: saved.knowledgeDomainGrants, version: saved.version };
  });
}
