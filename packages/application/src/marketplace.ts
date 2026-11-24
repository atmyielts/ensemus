// The tenant side of publishing (ADR-034 D5). Reviews and listings are written only by the operator.
import { createPublisherSchema, submitToMarketplaceSchema } from '@ensemus/contracts/skills';
import {
  marketplaceListings,
  marketplacePublishers,
  marketplaceReviews,
  marketplaceSubmissions,
  skillPackages,
  skillVersions,
  trustedSigners,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { can } from '@ensemus/domain/policy';
import type { ReviewFindingCode, SubmissionState } from '@ensemus/domain/marketplace';
import {
  AGGREGATE_MARKETPLACE_SUBMISSION,
  MARKETPLACE_DELIST_REQUESTED,
  MARKETPLACE_SUBMITTED,
  MARKETPLACE_WITHDRAWN,
} from '@ensemus/domain/skill-events';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AppError, pgCode } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import { withPrivilegeTx } from './product/privileged';
import { requireSkillMember } from './skill-access';
import { SKILL_SQLSTATE, type SkillFeatureGate } from './skill-ports';
import { auditAction } from './work';

export type PublisherView = {
  id: string;
  displayName: string;
  state: 'active' | 'suspended';
  version: number;
};

export type SubmissionView = {
  id: string;
  skillVersionId: string;
  name: string;
  semver: string;
  digest: string;
  state: SubmissionState;
  delistRequestedAt: Date | null;
  findingCodes: readonly ReviewFindingCode[];
  createdAt: Date;
  decidedAt: Date | null;
  version: number;
};

const publisherFields = {
  id: marketplacePublishers.id,
  displayName: marketplacePublishers.displayName,
  state: marketplacePublishers.state,
  version: marketplacePublishers.version,
};
const publisherView = (row: Omit<PublisherView, 'state'> & { state: string }): PublisherView => ({
  ...row,
  state: row.state as PublisherView['state'],
});

const submissions = marketplaceSubmissions;
const submissionFields = {
  id: submissions.id,
  skillVersionId: submissions.skillVersionId,
  name: submissions.name,
  semver: submissions.semver,
  digest: submissions.digest,
  state: submissions.state,
  delistRequestedAt: submissions.delistRequestedAt,
  createdAt: submissions.createdAt,
  decidedAt: submissions.decidedAt,
  version: submissions.version,
};
const submissionView = (
  row: Omit<SubmissionView, 'state' | 'findingCodes'> & { state: string },
  findingCodes: readonly ReviewFindingCode[],
): SubmissionView => ({ ...row, state: row.state as SubmissionState, findingCodes });

/** Check the current owner role, and hold it through the transaction for a privileged change. */
async function requirePublisher(tx: Tx, context: TenantContext, manage = false) {
  if (context.actorType !== 'user' || !can(context.role, 'marketplace.publish'))
    throw new AppError('FORBIDDEN');
  const role = await requireSkillMember(tx, context, manage);
  if (!can(role, 'marketplace.publish')) throw new AppError('FORBIDDEN');
}

export async function createPublisher(
  database: AppDatabase,
  context: TenantContext,
  gate: SkillFeatureGate,
  input: { displayName: string },
): Promise<PublisherView> {
  const body = createPublisherSchema.safeParse({ display_name: input.displayName });
  if (!body.success) throw new AppError('INVALID_INPUT');
  if (!(await gate.isEnabled(context, 'marketplace'))) throw new AppError('FEATURE_NOT_ENABLED');
  return withPrivilegeTx(database, context, async (tx) => {
    await requirePublisher(tx, context, true);
    const [row] = await tx
      .insert(marketplacePublishers)
      .values({ organizationId: context.organizationId, displayName: body.data.display_name })
      .onConflictDoNothing({ target: marketplacePublishers.organizationId })
      .returning(publisherFields);
    if (!row) throw new AppError('MARKETPLACE_PUBLISHER_EXISTS');
    await auditAction(
      tx,
      context,
      'marketplace_publisher.created',
      `marketplace_publisher:${row.id}`,
    );
    return publisherView(row);
  });
}

export function getPublisher(
  database: AppDatabase,
  context: TenantContext,
): Promise<PublisherView | null> {
  return withTenantTx(database, context, async (tx) => {
    await requirePublisher(tx, context);
    const [row] = await tx
      .select(publisherFields)
      .from(marketplacePublishers)
      .where(eq(marketplacePublishers.organizationId, context.organizationId));
    return row ? publisherView(row) : null;
  });
}

async function emitSubmission(
  tx: Tx,
  context: TenantContext,
  row: { id: string; version: number; skillVersionId: string },
  eventType: string,
) {
  await emit(tx, context, {
    aggregateType: AGGREGATE_MARKETPLACE_SUBMISSION,
    aggregateId: row.id,
    aggregateVersion: row.version,
    eventType,
    classification: 'internal',
    payload: { skill_version_id: row.skillVersionId },
  });
  await auditAction(tx, context, eventType, `marketplace_submission:${row.id}`);
}

export async function submitToMarketplace(
  database: AppDatabase,
  context: TenantContext,
  gate: SkillFeatureGate,
  input: { skillVersionId: string; confirmShareWithOtherOrganizations: true },
): Promise<SubmissionView> {
  const body = submitToMarketplaceSchema.safeParse({
    skill_version_id: input.skillVersionId,
    confirm_share_with_other_organizations: input.confirmShareWithOtherOrganizations,
  });
  if (!body.success) throw new AppError('INVALID_INPUT');
  if (!(await gate.isEnabled(context, 'marketplace'))) throw new AppError('FEATURE_NOT_ENABLED');
  try {
    return await withPrivilegeTx(database, context, async (tx) => {
      await requirePublisher(tx, context, true);
      if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
      const organizationId = context.organizationId;
      const [publisher] = await tx
        .select({ id: marketplacePublishers.id })
        .from(marketplacePublishers)
        .where(
          and(
            eq(marketplacePublishers.organizationId, organizationId),
            eq(marketplacePublishers.state, 'active'),
          ),
        )
        .for('share');
      if (!publisher) throw new AppError('MARKETPLACE_PUBLISHER_REQUIRED');
      const [subject] = await tx
        .select({
          version: skillVersions,
          name: skillPackages.name,
          classification: skillPackages.contentClassification,
          origin: skillPackages.origin,
          packageState: skillPackages.state,
        })
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
            eq(skillVersions.organizationId, organizationId),
            eq(skillVersions.id, body.data.skill_version_id),
          ),
        )
        .for('share');
      if (!subject) throw new AppError('NOT_FOUND');
      if (subject.classification !== 'public') throw new AppError('MARKETPLACE_NOT_PUBLIC');
      const version = subject.version;
      if (
        subject.origin !== 'tenant' ||
        subject.packageState !== 'active' ||
        !['verified', 'published'].includes(version.state) ||
        !version.license ||
        version.license === 'LicenseRef-Proprietary-Tenant' ||
        !version.semver ||
        !version.digest ||
        !version.manifest ||
        !version.signerKeyId ||
        !version.signature
      ) {
        throw new AppError('MARKETPLACE_VERSION_NOT_SUBMITTABLE');
      }
      const [signer] = await tx
        .select({ publicKey: trustedSigners.publicKey })
        .from(trustedSigners)
        .where(
          and(
            eq(trustedSigners.organizationId, organizationId),
            eq(trustedSigners.keyId, version.signerKeyId),
            eq(trustedSigners.state, 'active'),
          ),
        )
        .for('share');
      if (!signer) throw new AppError('MARKETPLACE_VERSION_NOT_SUBMITTABLE');
      const [row] = await tx
        .insert(submissions)
        .values({
          organizationId,
          publisherId: publisher.id,
          packageId: version.packageId,
          skillVersionId: version.id,
          name: subject.name,
          semver: version.semver,
          digest: version.digest,
          manifest: version.manifest,
          signerKeyId: version.signerKeyId,
          signerPublicKey: signer.publicKey,
          signature: version.signature,
          bundleObjectKey: version.bundleObjectKey,
          sizeBytes: version.sizeBytes,
          submittedByMembershipId: context.membershipId,
          publishConfirmedAt: new Date(),
        })
        .returning(submissionFields);
      if (!row) throw new AppError('VERSION_CONFLICT');
      await emitSubmission(tx, context, row, MARKETPLACE_SUBMITTED);
      return submissionView(row, []);
    });
  } catch (error) {
    const code = pgCode(error);
    if (
      code === SKILL_SQLSTATE.COPY_MISMATCH ||
      code === SKILL_SQLSTATE.REVIEW_GATE ||
      code === '23505'
    )
      throw new AppError('MARKETPLACE_VERSION_NOT_SUBMITTABLE');
    throw error;
  }
}

/** Expose only the latest review's finding codes to this publisher, even when several reviews exist. */
const latestFindingCodes = sql<ReviewFindingCode[]>`coalesce((
  select ${marketplaceReviews.findingCodes} from ${marketplaceReviews}
  where ${marketplaceReviews.submissionOrganizationId} = ${submissions.organizationId}
    and ${marketplaceReviews.submissionId} = ${submissions.id}
  order by ${marketplaceReviews.recordedAt} desc, ${marketplaceReviews.id} desc
  limit 1
), array[]::text[])`;

export function listSubmissions(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly SubmissionView[]> {
  return withTenantTx(database, context, async (tx) => {
    await requirePublisher(tx, context);
    const rows = await tx
      .select({ ...submissionFields, findingCodes: latestFindingCodes })
      .from(submissions)
      .where(eq(submissions.organizationId, context.organizationId))
      .orderBy(desc(submissions.createdAt), desc(submissions.id));
    return rows.map(({ findingCodes, ...row }) => submissionView(row, findingCodes));
  });
}

async function changeSubmission(
  database: AppDatabase,
  context: TenantContext,
  input: { submissionId: string; expectedVersion: number },
  action: 'withdraw' | 'delist',
): Promise<SubmissionView> {
  const submissionId = idSchema.safeParse(input.submissionId);
  if (
    !submissionId.success ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  )
    throw new AppError('INVALID_INPUT');
  try {
    return await withPrivilegeTx(database, context, async (tx) => {
      await requirePublisher(tx, context, true);
      if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
      const target = and(
        eq(submissions.organizationId, context.organizationId),
        eq(submissions.id, submissionId.data),
      );
      const [row] = await tx
        .select({ ...submissionFields, findingCodes: latestFindingCodes })
        .from(submissions)
        .where(target)
        .for('update');
      if (!row) throw new AppError('NOT_FOUND');
      if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
      const { findingCodes, ...current } = row;
      const now = new Date();
      if (action === 'withdraw') {
        if (!['submitted', 'in_review', 'approved'].includes(row.state))
          throw new AppError('MARKETPLACE_SUBMISSION_NOT_WITHDRAWABLE');
      } else {
        if (row.state !== 'approved') throw new AppError('INVALID_STATE');
        if (row.delistRequestedAt) return submissionView(current, findingCodes);
        const [listing] = await tx
          .select({ id: marketplaceListings.id })
          .from(marketplaceListings)
          .where(
            and(
              eq(marketplaceListings.publisherOrganizationId, context.organizationId),
              eq(marketplaceListings.submissionId, row.id),
              eq(marketplaceListings.state, 'listed'),
            ),
          )
          .limit(1);
        if (!listing) throw new AppError('INVALID_STATE');
      }
      const [changed] = await tx
        .update(submissions)
        .set({
          version: row.version + 1,
          updatedAt: now,
          ...(action === 'withdraw'
            ? { state: 'withdrawn', withdrawnByMembershipId: context.membershipId }
            : { delistRequestedAt: now }),
        })
        .where(and(target, eq(submissions.version, row.version)))
        .returning(submissionFields);
      if (!changed) throw new AppError('VERSION_CONFLICT');
      await emitSubmission(
        tx,
        context,
        changed,
        action === 'withdraw' ? MARKETPLACE_WITHDRAWN : MARKETPLACE_DELIST_REQUESTED,
      );
      return submissionView(changed, findingCodes);
    });
  } catch (error) {
    const code = pgCode(error);
    if (
      action === 'withdraw' &&
      (code === SKILL_SQLSTATE.REVIEW_GATE || code === SKILL_SQLSTATE.INVALID_TRANSITION)
    )
      throw new AppError('MARKETPLACE_SUBMISSION_NOT_WITHDRAWABLE');
    if (action === 'delist' && code === SKILL_SQLSTATE.INVALID_TRANSITION)
      throw new AppError('INVALID_STATE');
    throw error;
  }
}

export function withdrawSubmission(
  database: AppDatabase,
  context: TenantContext,
  input: { submissionId: string; expectedVersion: number },
): Promise<SubmissionView> {
  return changeSubmission(database, context, input, 'withdraw');
}

export function requestDelisting(
  database: AppDatabase,
  context: TenantContext,
  input: { submissionId: string; expectedVersion: number },
): Promise<SubmissionView> {
  return changeSubmission(database, context, input, 'delist');
}
