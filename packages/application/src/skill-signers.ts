// Trusted publisher administration (EXP-04, ADR-034 D2/D4). Keys are public; authorization is live.
import { createHash, createPublicKey } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  trustedSigners,
  skillVersions,
  skillPackages,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import {
  AGGREGATE_SKILL_SIGNER,
  AGGREGATE_SKILL_VERSION,
  SKILL_SIGNER_ADDED,
  SKILL_SIGNER_REVOKED,
  SKILL_VERSION_YANKED,
  NOTIFY_SKILL_VERSION_YANKED,
  skillVersionTargetRef,
} from '@ensemus/domain/skill-events';
import { AppError, pgCode } from './errors';
import { idSchema } from './ids';
import { auditAction, notify } from './work';
import { emit } from './events';
import { withPrivilegeTx } from './product/privileged';
import { requireSkillMember } from './skill-access';
import type { SkillSignerView } from './skills';
import type { SkillFeatureGate } from './skill-ports';

function keyFingerprint(publicKey: Buffer): string {
  try {
    if (!Buffer.isBuffer(publicKey) || publicKey.length !== 32) throw new Error('INVALID_KEY');
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
      format: 'der',
      type: 'spki',
    });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('INVALID_KEY');
    return createHash('sha256').update(publicKey).digest('hex');
  } catch {
    throw new AppError('SKILL_SIGNER_KEY_INVALID');
  }
}
function signerView(row: typeof trustedSigners.$inferSelect): SkillSignerView {
  return {
    id: row.id,
    displayName: row.displayName,
    keyId: row.keyId,
    state: row.state as SkillSignerView['state'],
    version: row.version,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}
export async function addTrustedSigner(
  database: AppDatabase,
  context: TenantContext,
  gate: SkillFeatureGate,
  input: { displayName: string; publicKey: Buffer },
): Promise<SkillSignerView> {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 120) throw new AppError('INVALID_INPUT');
  const publicKey = Buffer.from(input.publicKey);
  const keyId = keyFingerprint(publicKey);
  if (!(await gate.isEnabled(context, 'skill_catalog'))) throw new AppError('FEATURE_NOT_ENABLED');
  try {
    return await withPrivilegeTx(database, context, async (tx) => {
      await requireSkillMember(tx, context, true);
      await tx.execute(sql`select skills.lock_trust()`);
      const [row] = await tx
        .insert(trustedSigners)
        .values({
          organizationId: context.organizationId,
          displayName,
          keyId,
          publicKey,
          addedByMembershipId: context.membershipId,
        })
        .returning();
      if (!row) throw new AppError('VERSION_CONFLICT');
      await auditAction(tx, context, SKILL_SIGNER_ADDED, `skill_signer:${row.id}`);
      await emit(tx, context, {
        eventType: SKILL_SIGNER_ADDED,
        aggregateType: AGGREGATE_SKILL_SIGNER,
        aggregateId: row.id,
        aggregateVersion: row.version,
        classification: 'internal',
        payload: { signer_id: row.id },
      });
      return signerView(row);
    });
  } catch (error) {
    if (pgCode(error) === '23505') throw new AppError('SKILL_SIGNER_EXISTS');
    throw error;
  }
}
export async function listTrustedSigners(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly SkillSignerView[]> {
  return withTenantTx(database, context, async (tx) => {
    await requireSkillMember(tx, context);
    return (
      await tx
        .select()
        .from(trustedSigners)
        .where(eq(trustedSigners.organizationId, context.organizationId))
        .orderBy(desc(trustedSigners.createdAt), desc(trustedSigners.id))
        .limit(1000)
    ).map(signerView);
  });
}
export async function revokeTrustedSigner(
  database: AppDatabase,
  context: TenantContext,
  input: { signerId: string; expectedVersion: number },
): Promise<void> {
  const id = idSchema.safeParse(input.signerId);
  if (!id.success || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new AppError('INVALID_INPUT');
  return withPrivilegeTx(database, context, async (tx) => {
    await requireSkillMember(tx, context, true);
    await tx.execute(sql`select skills.lock_trust()`);
    const [signer] = await tx
      .select()
      .from(trustedSigners)
      .where(
        and(
          eq(trustedSigners.organizationId, context.organizationId),
          eq(trustedSigners.id, id.data),
        ),
      )
      .for('update');
    if (!signer) throw new AppError('NOT_FOUND');
    if (signer.state === 'revoked') return;
    if (signer.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    await tx
      .update(trustedSigners)
      .set({
        state: 'revoked',
        revokedAt: sql`now()`,
        revokedByMembershipId: context.membershipId,
        version: signer.version + 1,
      })
      .where(
        and(
          eq(trustedSigners.organizationId, context.organizationId),
          eq(trustedSigners.id, id.data),
        ),
      );
    const versions = await tx
      .select({ version: skillVersions, classification: skillPackages.contentClassification })
      .from(skillVersions)
      .innerJoin(
        skillPackages,
        and(
          eq(skillPackages.organizationId, skillVersions.organizationId),
          eq(skillPackages.id, skillVersions.packageId),
        ),
      )
      .where(
        and(
          eq(skillVersions.organizationId, context.organizationId),
          eq(skillVersions.signerKeyId, signer.keyId),
          eq(skillPackages.origin, 'tenant'),
          inArray(skillVersions.state, ['verified', 'published']),
        ),
      )
      .orderBy(skillVersions.id)
      .for('update');
    for (const { version, classification } of versions) {
      await tx
        .update(skillVersions)
        .set({
          state: 'yanked',
          yankCode: 'SIGNER_REVOKED',
          yankedAt: sql`now()`,
          yankedByMembershipId: context.membershipId,
          version: version.version + 1,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(skillVersions.organizationId, context.organizationId),
            eq(skillVersions.id, version.id),
          ),
        );
      await emit(tx, context, {
        eventType: SKILL_VERSION_YANKED,
        aggregateType: AGGREGATE_SKILL_VERSION,
        aggregateId: version.id,
        aggregateVersion: version.version + 1,
        classification,
        payload: { skill_version_id: version.id, code: 'SIGNER_REVOKED' },
      });
      await notify(
        tx,
        context,
        [version.uploadedByMembershipId],
        NOTIFY_SKILL_VERSION_YANKED,
        skillVersionTargetRef(version.id),
      );
    }
    await auditAction(tx, context, SKILL_SIGNER_REVOKED, `skill_signer:${signer.id}`);
    await emit(tx, context, {
      eventType: SKILL_SIGNER_REVOKED,
      aggregateType: AGGREGATE_SKILL_SIGNER,
      aggregateId: signer.id,
      aggregateVersion: signer.version + 1,
      classification: 'internal',
      payload: { signer_id: signer.id },
    });
  });
}
