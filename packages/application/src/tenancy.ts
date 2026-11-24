// ADR-035 D5. The deployment job owns these records. Request paths only read them.
import {
  deploymentProfile,
  isolationEvidence,
  memberships,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { can } from '@ensemus/domain/policy';
import {
  isolationPosture,
  type IsolationPosture,
  type IsolationRecord,
  type TenancyTier,
} from '@ensemus/domain/tenancy';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AppError } from './errors';

export type DeploymentProfileView = {
  tier: TenancyTier;
  homeRegion: string | null;
  crossOrgEnabled: boolean;
  /** Whether the deployment job has written a profile. */
  profiled: boolean;
};

export async function requireTenancyViewer(tx: Tx, context: TenantContext): Promise<void> {
  if (context.actorType !== 'user') throw new AppError('NOT_FOUND');
  const [member] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, context.organizationId),
        eq(memberships.id, context.membershipId),
        eq(memberships.userId, context.userId),
        eq(memberships.status, 'active'),
      ),
    );
  if (!member || !can(member.role, 'tenancy.view')) throw new AppError('NOT_FOUND');
}

async function readProfile(tx: Tx): Promise<DeploymentProfileView> {
  const [profile] = await tx
    .select({
      tier: deploymentProfile.tier,
      homeRegion: deploymentProfile.homeRegion,
      crossOrgEnabled: deploymentProfile.crossOrgEnabled,
    })
    .from(deploymentProfile);
  return profile
    ? { ...profile, tier: profile.tier as TenancyTier, profiled: true }
    : { tier: 'shared', homeRegion: null, crossOrgEnabled: false, profiled: false };
}

export function getDeploymentProfile(
  database: AppDatabase,
  context: TenantContext,
): Promise<DeploymentProfileView> {
  return withTenantTx(database, context, async (tx) => {
    await requireTenancyViewer(tx, context);
    return readProfile(tx);
  });
}

export function inspectDeployment(
  database: AppDatabase,
  context: TenantContext,
  releaseVersion: string | null,
) {
  return withTenantTx(database, context, async (tx) => {
    await requireTenancyViewer(tx, context);
    const profile = await readProfile(tx);
    const records = await tx
      .selectDistinctOn([isolationEvidence.aspect], {
        aspect: isolationEvidence.aspect,
        result: isolationEvidence.result,
        code: isolationEvidence.code,
        releaseVersion: isolationEvidence.releaseVersion,
        checkedAt: isolationEvidence.checkedAt,
      })
      .from(isolationEvidence)
      .orderBy(
        isolationEvidence.aspect,
        desc(isolationEvidence.checkedAt),
        // Equal-time evidence must not let a less conclusive result hide a failure.
        sql`case ${isolationEvidence.result} when 'failed' then 0 when 'declared' then 1 else 2 end`,
        isolationEvidence.id,
      );
    return {
      profile,
      isolation: isolationPosture(profile.tier, records as IsolationRecord[], releaseVersion),
    };
  });
}

export async function getIsolationPosture(
  database: AppDatabase,
  context: TenantContext,
  input: { releaseVersion: string | null },
): Promise<IsolationPosture> {
  return (await inspectDeployment(database, context, input.releaseVersion)).isolation;
}
