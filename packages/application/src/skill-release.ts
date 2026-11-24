import { yankSkillVersionSchema, type YankSkillVersionBody } from '@ensemus/contracts/skills';
import {
  marketplaceListings,
  skillPackages,
  skillVersions,
  trustedSigners,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { can } from '@ensemus/domain/policy';
import {
  skillBundleObjectKey,
  skillUseDenial,
  type SkillUseDenial,
  type SkillUseFacts,
} from '@ensemus/domain/skill';
import {
  AGGREGATE_SKILL_VERSION,
  NOTIFY_SKILL_VERSION_YANKED,
  SKILL_VERSION_PUBLISHED,
  SKILL_VERSION_YANKED,
  skillVersionTargetRef,
} from '@ensemus/domain/skill-events';
import { and, eq, sql } from 'drizzle-orm';
import { AppError, pgCode } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import { withPrivilegeTx } from './product/privileged';
import { requireSkillMember } from './skill-access';
import { SKILL_SQLSTATE, type SkillFeatureGate } from './skill-ports';
import { readSkillVersionReviewInTx } from './skill-version-reads';
import type { SkillVersionView, UsableSkillVersion } from './skills';
import { auditAction, notify } from './work';

type VersionChange = { skillVersionId: string; expectedVersion: number };

export async function publishSkillVersion(
  database: AppDatabase,
  context: TenantContext,
  gate: SkillFeatureGate,
  input: VersionChange,
): Promise<SkillVersionView> {
  if (context.actorType !== 'user' || !can(context.role, 'skill.publish'))
    throw new AppError('FORBIDDEN');
  if (!(await gate.isEnabled(context, 'skill_catalog'))) throw new AppError('FEATURE_NOT_ENABLED');
  return changeRelease(database, context, input, null);
}

export function yankSkillVersion(
  database: AppDatabase,
  context: TenantContext,
  input: VersionChange & YankSkillVersionBody,
): Promise<SkillVersionView> {
  const body = yankSkillVersionSchema.safeParse({ code: input.code });
  if (!body.success) throw new AppError('INVALID_INPUT');
  return changeRelease(database, context, input, body.data.code);
}

async function changeRelease(
  database: AppDatabase,
  context: TenantContext,
  input: VersionChange,
  yank: YankSkillVersionBody['code'] | null,
) {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  const id = idSchema.safeParse(input.skillVersionId);
  if (!id.success || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new AppError('INVALID_INPUT');
  try {
    return await withPrivilegeTx(database, context, async (tx) => {
      const role = await requireSkillMember(tx, context, true);
      if (yank === null && !can(role, 'skill.publish')) throw new AppError('FORBIDDEN');
      await tx.execute(sql`select skills.lock_trust()`);
      const scope = and(
        eq(skillVersions.organizationId, context.organizationId),
        eq(skillVersions.id, id.data),
      );
      const [row] = await tx
        .select({
          version: skillVersions,
          packageState: skillPackages.state,
          classification: skillPackages.contentClassification,
        })
        .from(skillVersions)
        .innerJoin(
          skillPackages,
          and(
            eq(skillPackages.organizationId, skillVersions.organizationId),
            eq(skillPackages.id, skillVersions.packageId),
          ),
        )
        .where(scope)
        .for('update');
      if (!row) throw new AppError('NOT_FOUND');
      const { version } = row;
      if (version.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
      if (yank === null) {
        if (version.state !== 'verified' || row.packageState !== 'active')
          throw new AppError('SKILL_VERSION_NOT_PUBLISHABLE');
        if (version.uploadedByMembershipId === context.membershipId)
          throw new AppError('SKILL_PUBLISH_SAME_PERSON');
      } else if (version.state !== 'verified' && version.state !== 'published') {
        throw new AppError('INVALID_STATE');
      }
      const next = version.version + 1;
      const [changed] = await tx
        .update(skillVersions)
        .set({
          ...(yank === null
            ? {
                state: 'published',
                publishedByMembershipId: context.membershipId,
                publishedAt: sql`statement_timestamp()`,
              }
            : {
                state: 'yanked',
                yankCode: yank,
                yankedByMembershipId: context.membershipId,
                yankedAt: sql`statement_timestamp()`,
              }),
          version: next,
          updatedAt: sql`statement_timestamp()`,
        })
        .where(scope)
        .returning({ id: skillVersions.id });
      if (!changed) throw new AppError('VERSION_CONFLICT');
      const eventType = yank === null ? SKILL_VERSION_PUBLISHED : SKILL_VERSION_YANKED;
      const target = skillVersionTargetRef(id.data);
      await auditAction(tx, context, eventType, target, yank ?? undefined);
      await emit(tx, context, {
        eventType,
        aggregateType: AGGREGATE_SKILL_VERSION,
        aggregateId: id.data,
        aggregateVersion: next,
        classification: row.classification,
        payload: { skill_version_id: id.data, ...(yank !== null ? { code: yank } : {}) },
      });
      if (yank !== null)
        await notify(
          tx,
          context,
          [version.uploadedByMembershipId],
          NOTIFY_SKILL_VERSION_YANKED,
          target,
        );
      return (await readSkillVersionReviewInTx(tx, context, id.data)).version;
    });
  } catch (error) {
    const code = pgCode(error);
    if (yank === null && (code === SKILL_SQLSTATE.NOT_USABLE || code === '23514'))
      throw new AppError('SKILL_VERSION_NOT_PUBLISHABLE');
    throw error;
  }
}

/** Admission for internal callers. A lookup returns facts, and callers still enforce their own tool policy. */
export async function resolveSkillVersionForUse(
  database: AppDatabase,
  context: TenantContext,
  skillVersionId: string,
): Promise<UsableSkillVersion | { ok: false; denial: SkillUseDenial }> {
  const id = idSchema.safeParse(skillVersionId);
  if (!id.success) return { ok: false, denial: 'NOT_PUBLISHED' };
  return withTenantTx(database, context, async (tx) => {
    if (context.actorType === 'user') await requireSkillMember(tx, context);
    const [row] = await tx
      .select({
        version: skillVersions,
        origin: skillPackages.origin,
        packageName: skillPackages.name,
        packageState: skillPackages.state,
        signerState: trustedSigners.state,
        listingId: marketplaceListings.id,
        delist: marketplaceListings.delistMode,
      })
      .from(skillVersions)
      .innerJoin(
        skillPackages,
        and(
          eq(skillPackages.organizationId, skillVersions.organizationId),
          eq(skillPackages.id, skillVersions.packageId),
        ),
      )
      .leftJoin(
        trustedSigners,
        and(
          eq(trustedSigners.organizationId, skillVersions.organizationId),
          eq(trustedSigners.keyId, skillVersions.signerKeyId),
        ),
      )
      .leftJoin(
        marketplaceListings,
        and(
          eq(marketplaceListings.id, skillPackages.listingId),
          eq(marketplaceListings.digest, skillVersions.digest),
          eq(marketplaceListings.signerKeyId, skillVersions.signerKeyId),
          eq(marketplaceListings.signature, skillVersions.signature),
        ),
      )
      .where(
        and(
          eq(skillVersions.organizationId, context.organizationId),
          eq(skillVersions.id, id.data),
        ),
      );
    if (!row) return { ok: false, denial: 'NOT_PUBLISHED' };
    const { version } = row;
    const denial = skillUseDenial({
      state: version.state as SkillUseFacts['state'],
      origin: row.origin as SkillUseFacts['origin'],
      packageState: row.packageState as SkillUseFacts['packageState'],
      signerState: row.signerState as SkillUseFacts['signerState'],
      listingDelistMode:
        row.origin === 'marketplace' && !row.listingId
          ? 'revoke'
          : (row.delist as SkillUseFacts['listingDelistMode']),
    });
    if (denial) return { ok: false, denial };
    if (
      !version.semver ||
      !version.digest ||
      !version.manifest ||
      !version.signerKeyId ||
      !version.signature ||
      !version.executionKind ||
      !version.maxClassification ||
      version.bundleObjectKey !== skillBundleObjectKey(context.organizationId, version.id)
    ) {
      return { ok: false, denial: 'NOT_PUBLISHED' };
    }
    return {
      ok: true,
      skillVersionId: version.id,
      packageId: version.packageId,
      name: row.packageName,
      semver: version.semver,
      digest: version.digest,
      executionKind: version.executionKind as UsableSkillVersion['executionKind'],
      maxClassification: version.maxClassification as UsableSkillVersion['maxClassification'],
      manifest: version.manifest,
      bundleObjectKey: version.bundleObjectKey,
      bundleSha256: version.bundleSha256,
      signerKeyId: version.signerKeyId,
      signature: version.signature,
    };
  });
}
