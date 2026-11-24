import { createHash, randomUUID } from 'node:crypto';
import {
  skillBundleUploads,
  skillPackages,
  skillVersions,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { can } from '@ensemus/domain/policy';
import {
  SKILL_BUNDLE_MAX_BYTES,
  SKILL_BUNDLE_MEDIA_TYPE,
  skillBundleObjectKey,
} from '@ensemus/domain/skill';
import {
  AGGREGATE_SKILL_VERSION,
  SKILL_VERSION_UPLOADED,
  skillVersionTargetRef,
} from '@ensemus/domain/skill-events';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { ObjectStore } from './artifacts';
import { AppError } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import { withPrivilegeTx } from './product/privileged';
import { requireSkillMember } from './skill-access';
import type { SkillFeatureGate } from './skill-ports';
import { getSkillVersion } from './skill-version-reads';
import { auditAction } from './work';

type Bundle = { packageId: string; sha256: string; sizeBytes: number };

async function lockUploadPackage(tx: Tx, context: TenantContext, id: string) {
  await requireSkillMember(tx, context, true);
  const [pkg] = await tx
    .select({ state: skillPackages.state, origin: skillPackages.origin })
    .from(skillPackages)
    .where(and(eq(skillPackages.organizationId, context.organizationId), eq(skillPackages.id, id)))
    .for('update');
  if (!pkg) throw new AppError('NOT_FOUND');
  if (pkg.origin !== 'tenant') throw new AppError('FORBIDDEN');
  if (pkg.state !== 'active') throw new AppError('INVALID_STATE');
}

async function findVersion(tx: Tx, context: TenantContext, bundle: Bundle) {
  const [existing] = await tx
    .select({ id: skillVersions.id })
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.organizationId, context.organizationId),
        eq(skillVersions.packageId, bundle.packageId),
        eq(skillVersions.bundleSha256, bundle.sha256),
      ),
    )
    .orderBy(desc(skillVersions.uploadedAt), desc(skillVersions.id))
    .limit(1);
  return existing?.id;
}

async function reserve(
  database: AppDatabase,
  context: TenantContext,
  bundle: Bundle,
  supersede?: string,
) {
  return withPrivilegeTx(database, context, async (tx) => {
    await lockUploadPackage(tx, context, bundle.packageId);
    const existing = await findVersion(tx, context, bundle);
    if (existing) return { kind: 'existing', id: existing } as const;
    const scope = and(
      eq(skillBundleUploads.organizationId, context.organizationId),
      eq(skillBundleUploads.packageId, bundle.packageId),
      eq(skillBundleUploads.bundleSha256, bundle.sha256),
      eq(skillBundleUploads.state, 'writing'),
    );
    const [pending] = await tx
      .select({
        id: skillBundleUploads.id,
        membershipId: skillBundleUploads.membershipId,
        canReplace: sql<boolean>`clock_timestamp() >= ${skillBundleUploads.createdAt} + interval '2 minutes'`,
      })
      .from(skillBundleUploads)
      .where(scope);
    if (pending) {
      if (pending.id !== supersede || !pending.canReplace)
        return { kind: 'pending', ...pending } as const;
      await tx.update(skillBundleUploads).set({ state: 'superseded' }).where(scope);
    }
    const id = randomUUID();
    // Clock and state are database defaults; the web role cannot name those columns.
    await tx.execute(sql`insert into skills.bundle_uploads
      (organization_id, id, package_id, membership_id, bundle_sha256, size_bytes)
      values (${context.organizationId}, ${id}, ${bundle.packageId},
        ${context.membershipId}, ${bundle.sha256}, ${bundle.sizeBytes})`);
    return { kind: 'reserved', id } as const;
  });
}

async function attach(
  database: AppDatabase,
  context: TenantContext,
  bundle: Bundle,
  id: string,
  gate: SkillFeatureGate,
) {
  if (!(await gate.isEnabled(context, 'skill_catalog'))) throw new AppError('FEATURE_NOT_ENABLED');
  return withPrivilegeTx(database, context, async (tx) => {
    await lockUploadPackage(tx, context, bundle.packageId);
    const existing = await findVersion(tx, context, bundle);
    if (existing) return existing;
    const scope = and(
      eq(skillBundleUploads.organizationId, context.organizationId),
      eq(skillBundleUploads.packageId, bundle.packageId),
      eq(skillBundleUploads.id, id),
      eq(skillBundleUploads.membershipId, context.membershipId),
      eq(skillBundleUploads.bundleSha256, bundle.sha256),
      eq(skillBundleUploads.sizeBytes, bundle.sizeBytes),
      eq(skillBundleUploads.state, 'writing'),
    );
    const [current] = await tx
      .select({ id: skillBundleUploads.id })
      .from(skillBundleUploads)
      .where(scope);
    if (!current) throw new AppError('SKILL_UPLOAD_PENDING');
    await tx.insert(skillVersions).values({
      organizationId: context.organizationId,
      packageId: bundle.packageId,
      id,
      bundleObjectKey: skillBundleObjectKey(context.organizationId, id),
      bundleSha256: bundle.sha256,
      sizeBytes: bundle.sizeBytes,
      uploadedByMembershipId: context.membershipId,
    });
    await tx.update(skillBundleUploads).set({ state: 'attached' }).where(scope);
    await auditAction(tx, context, SKILL_VERSION_UPLOADED, skillVersionTargetRef(id));
    await emit(tx, context, {
      eventType: SKILL_VERSION_UPLOADED,
      aggregateType: AGGREGATE_SKILL_VERSION,
      aggregateId: id,
      aggregateVersion: 1,
      classification: 'internal',
      payload: { skill_version_id: id },
    });
    return id;
  });
}

/** An unresolved write may be recovered by matching bytes, but the key is never PUT twice. */
export async function uploadSkillBundle(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  gate: SkillFeatureGate,
  input: { packageId: string; bytes: Buffer },
) {
  if (context.actorType !== 'user' || !can(context.role, 'skill.manage'))
    throw new AppError('FORBIDDEN');
  const id = idSchema.safeParse(input.packageId);
  if (!id.success || !input.bytes.length) throw new AppError('INVALID_INPUT');
  if (input.bytes.length > SKILL_BUNDLE_MAX_BYTES) throw new AppError('SKILL_BUNDLE_TOO_LARGE');
  if (!(await gate.isEnabled(context, 'skill_catalog'))) throw new AppError('FEATURE_NOT_ENABLED');
  if (!store.putSingleAttempt) throw new AppError('CAPABILITY_UNAVAILABLE');
  const bytes = Buffer.from(input.bytes);
  const bundle = {
    packageId: id.data,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
  const key = (versionId: string) => skillBundleObjectKey(context.organizationId, versionId);
  const finish = async (versionId: string) =>
    getSkillVersion(database, context, await attach(database, context, bundle, versionId, gate));
  let write = await reserve(database, context, bundle);
  if (write.kind === 'pending') {
    if (write.membershipId === context.membershipId) {
      const stored = await store.get(key(write.id), bundle.sizeBytes).catch(() => null);
      if (stored?.equals(bytes)) return finish(write.id);
    }
    if (!write.canReplace) throw new AppError('SKILL_UPLOAD_PENDING');
    write = await reserve(database, context, bundle, write.id);
  }
  if (write.kind === 'existing') return getSkillVersion(database, context, write.id);
  if (write.kind !== 'reserved') throw new AppError('SKILL_UPLOAD_PENDING');
  const result = await store
    .putSingleAttempt(key(write.id), bytes, SKILL_BUNDLE_MEDIA_TYPE)
    .catch(() => null);
  if (result?.transport !== 'written') throw new AppError('SKILL_UPLOAD_PENDING');
  try {
    await withTenantTx(database, context, (tx) =>
      tx
        .update(skillBundleUploads)
        .set({ putFinishedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(skillBundleUploads.organizationId, context.organizationId),
            eq(skillBundleUploads.id, write.id),
            eq(skillBundleUploads.membershipId, context.membershipId),
            isNull(skillBundleUploads.putFinishedAt),
          ),
        ),
    );
  } catch {
    // The single PUT may have landed. A repeat can try a read-back without writing this key again.
    throw new AppError('SKILL_UPLOAD_PENDING');
  }
  return finish(write.id);
}
