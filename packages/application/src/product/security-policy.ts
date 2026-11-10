// Owned by the mfa slice (ID-05). See docs/06-delivery/m7-slices.md and ADR-031 D8.
import {
  memberships,
  users,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { securityPolicies } from '@ensemus/database/product';
import { can } from '@ensemus/domain/policy';
import {
  canProduct,
  DEFAULT_MFA_MAX_AGE_SECONDS,
  MIN_MFA_MAX_AGE_SECONDS,
  MAX_MFA_MAX_AGE_SECONDS,
} from '@ensemus/domain/product-policy';
import { SECURITY_POLICY_CHANGED, AGGREGATE_ORGANIZATION } from '@ensemus/domain/product-events';
import { and, asc, eq } from 'drizzle-orm';
import { assertRecentMfa, withPrivilegeTx as withTenantTx, type SessionProof } from './privileged';
import { AppError } from '../errors';
import { emit } from '../events';
import { auditAction } from '../work';

const DEFAULT_POLICY: SecurityPolicyView = {
  mfaForAdministration: false,
  mfaMaxAgeSeconds: DEFAULT_MFA_MAX_AGE_SECONDS,
  ssoEnforcement: 'optional',
  version: 1,
};
async function currentPerson(tx: Tx, context: TenantContext) {
  if (context.actorType !== 'user') throw new AppError('NOT_FOUND');
  const [person] = await tx
    .select()
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
const view = (row: typeof securityPolicies.$inferSelect): SecurityPolicyView => ({
  mfaForAdministration: row.mfaForAdministration,
  mfaMaxAgeSeconds: row.mfaMaxAgeSeconds,
  ssoEnforcement: row.ssoEnforcement as 'optional' | 'required',
  version: row.version,
});

export type SecurityPolicyView = {
  mfaForAdministration: boolean;
  mfaMaxAgeSeconds: number;
  ssoEnforcement: 'optional' | 'required';
  version: number;
};

export type MemberSecondFactor = { membershipId: string; name: string; enrolled: boolean };

/** Anyone in the tenant may read it, because it decides what they will be asked for. */
export async function getSecurityPolicy(
  database: AppDatabase,
  context: TenantContext,
): Promise<SecurityPolicyView> {
  return withTenantTx(database, context, async (tx) => {
    await currentPerson(tx, context);
    const [row] = await tx
      .select()
      .from(securityPolicies)
      .where(eq(securityPolicies.organizationId, context.organizationId));
    return row ? view(row) : { ...DEFAULT_POLICY };
  });
}

/** Needs `security_policy.manage` and recent MFA. Tightening and loosening are both audited. */
export async function updateSecurityPolicy(
  database: AppDatabase,
  context: TenantContext,
  proof: SessionProof | null,
  input: {
    expectedVersion: number;
    mfaForAdministration: boolean;
    mfaMaxAgeSeconds: number;
    ssoEnforcement: 'optional' | 'required';
  },
): Promise<SecurityPolicyView> {
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    typeof input.mfaForAdministration !== 'boolean' ||
    !Number.isInteger(input.mfaMaxAgeSeconds) ||
    input.mfaMaxAgeSeconds < MIN_MFA_MAX_AGE_SECONDS ||
    input.mfaMaxAgeSeconds > MAX_MFA_MAX_AGE_SECONDS ||
    !['optional', 'required'].includes(input.ssoEnforcement)
  )
    throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    const fresh = await currentPerson(tx, context);
    if (!canProduct(fresh.role, 'security_policy.manage')) throw new AppError('NOT_FOUND');
    await assertRecentMfa(tx, fresh, 'security_policy.change', proof);
    const update = {
      mfaForAdministration: input.mfaForAdministration,
      mfaMaxAgeSeconds: input.mfaMaxAgeSeconds,
      ssoEnforcement: input.ssoEnforcement,
      version: input.expectedVersion + 1,
      updatedByMembershipId: fresh.membershipId,
      updatedAt: new Date(),
    };
    let [row] = await tx
      .select()
      .from(securityPolicies)
      .where(eq(securityPolicies.organizationId, fresh.organizationId))
      .for('update');
    if (!row) {
      if (input.expectedVersion !== DEFAULT_POLICY.version) throw new AppError('VERSION_CONFLICT');
      const inserted = await tx
        .insert(securityPolicies)
        .values({ organizationId: fresh.organizationId, ...update })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) row = inserted[0];
      else throw new AppError('VERSION_CONFLICT');
    } else {
      if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
      const changed = await tx
        .update(securityPolicies)
        .set(update)
        .where(
          and(
            eq(securityPolicies.organizationId, fresh.organizationId),
            eq(securityPolicies.version, input.expectedVersion),
          ),
        )
        .returning();
      if (!changed[0]) throw new AppError('VERSION_CONFLICT');
      row = changed[0];
    }
    await emit(tx, fresh, {
      eventType: SECURITY_POLICY_CHANGED,
      aggregateType: AGGREGATE_ORGANIZATION,
      aggregateId: fresh.organizationId,
      aggregateVersion: row.version,
      classification: 'internal',
      payload: {
        organization_id: fresh.organizationId,
        mfa_for_administration: row.mfaForAdministration,
        mfa_max_age_seconds: row.mfaMaxAgeSeconds,
        sso_enforcement: row.ssoEnforcement,
      },
    });
    await auditAction(
      tx,
      fresh,
      'security_policy.changed',
      `organization:${fresh.organizationId}`,
      'POLICY_CHANGED',
    );
    return view(row);
  });
}

/** Needs `member.manage`. Whether each person has enrolled, and nothing about their secret. */
export async function listMemberSecondFactors(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly MemberSecondFactor[]> {
  return withTenantTx(database, context, async (tx) => {
    const fresh = await currentPerson(tx, context);
    if (!can(fresh.role, 'member.manage')) throw new AppError('NOT_FOUND');
    return tx
      .select({ membershipId: memberships.id, name: users.name, enrolled: users.twoFactorEnabled })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.status, 'active'))
      .orderBy(asc(users.name), asc(memberships.id))
      .limit(1000);
  });
}
