// Only the separately provisioned marketplace operator login uses this module (ADR-034 D6).
import {
  listingObjectKey,
  type DelistCode,
  type DelistMode,
  type ReviewAttestation,
  type ReviewVerdict,
} from '@ensemus/domain/marketplace';
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { openDatabase, type EnsemusDrizzle } from './connection';
import {
  marketplaceListings as listings,
  marketplacePublishers as publishers,
  marketplaceReviews as reviews,
  marketplaceSubmissions as submissions,
  type MarketplaceListingRow,
  type MarketplaceReviewRow,
  type MarketplaceSubmissionRow,
} from './schema-skills';

export function openMarketplaceOperatorDatabase(url: string) {
  return openDatabase(url, { max: 2 });
}

export class MarketplaceOperatorRefusal extends Error {
  constructor(
    readonly code:
      | 'MARKETPLACE_OPERATOR_REQUIRED'
      | 'NOT_FOUND'
      | 'INVALID_STATE'
      | 'INVALID_INPUT'
      | 'VERSION_CONFLICT',
  ) {
    super(code);
    this.name = 'MarketplaceOperatorRefusal';
  }
}

type SubmissionTarget = { organizationId: string; submissionId: string };
const targetOf = (input: SubmissionTarget) =>
  and(eq(submissions.organizationId, input.organizationId), eq(submissions.id, input.submissionId));

async function assertOperator(db: Pick<EnsemusDrizzle, 'execute'>) {
  const result = await db.execute<{ allowed: boolean }>(
    sql`select current_user='ensemus_marketplace' and session_user='ensemus_marketplace' as allowed`,
  );
  if (result.rows[0]?.allowed !== true)
    throw new MarketplaceOperatorRefusal('MARKETPLACE_OPERATOR_REQUIRED');
}

/** Oldest first: open review and delisting requests. */
export async function listOperatorQueue(
  db: EnsemusDrizzle,
): Promise<readonly MarketplaceSubmissionRow[]> {
  return db.transaction(async (tx) => {
    await assertOperator(tx);
    const openDelisting = tx
      .select({ id: listings.id })
      .from(listings)
      .where(
        and(
          eq(listings.publisherOrganizationId, submissions.organizationId),
          eq(listings.submissionId, submissions.id),
          eq(listings.state, 'listed'),
        ),
      );
    return tx
      .select()
      .from(submissions)
      .where(
        or(
          inArray(submissions.state, ['submitted', 'in_review']),
          and(
            eq(submissions.state, 'approved'),
            isNotNull(submissions.delistRequestedAt),
            sql`exists (${openDelisting})`,
          ),
        ),
      )
      .orderBy(asc(submissions.createdAt), asc(submissions.id));
  });
}

export async function getSubmissionForReview(
  db: EnsemusDrizzle,
  input: SubmissionTarget,
): Promise<MarketplaceSubmissionRow | null> {
  return db.transaction(async (tx) => {
    await assertOperator(tx);
    const [row] = await tx.select().from(submissions).where(targetOf(input));
    return row ?? null;
  });
}

export async function getApprovedReview(
  db: EnsemusDrizzle,
  input: SubmissionTarget,
): Promise<MarketplaceReviewRow | null> {
  return db.transaction(async (tx) => {
    await assertOperator(tx);
    const [row] = await tx
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.submissionOrganizationId, input.organizationId),
          eq(reviews.submissionId, input.submissionId),
          eq(reviews.verdict, 'approved'),
        ),
      )
      .orderBy(desc(reviews.recordedAt), desc(reviews.id))
      .limit(1);
    return row ?? null;
  });
}

export async function markSubmissionInReview(
  db: EnsemusDrizzle,
  input: SubmissionTarget & { expectedVersion: number },
): Promise<void> {
  return db.transaction(async (tx) => {
    await assertOperator(tx);
    const target = targetOf(input);
    const [row] = await tx
      .select({ state: submissions.state, version: submissions.version })
      .from(submissions)
      .where(target)
      .for('update');
    if (!row) throw new MarketplaceOperatorRefusal('NOT_FOUND');
    if (row.version !== input.expectedVersion)
      throw new MarketplaceOperatorRefusal('VERSION_CONFLICT');
    if (row.state === 'in_review') return;
    if (row.state !== 'submitted') throw new MarketplaceOperatorRefusal('INVALID_STATE');
    await tx
      .update(submissions)
      .set({ state: 'in_review', version: row.version + 1, updatedAt: new Date() })
      .where(target);
  });
}

/** The CLI verifies the signature before calling this. The trigger checks the bound stored facts. */
export async function recordReview(
  db: EnsemusDrizzle,
  input: {
    organizationId: string;
    attestation: ReviewAttestation;
    attestationSignature: Buffer;
    reviewerLabel: string;
    expectedVersion: number;
  },
): Promise<MarketplaceReviewRow> {
  return db.transaction(async (tx) => {
    await assertOperator(tx);
    const attestation = input.attestation;
    const target = targetOf({
      organizationId: input.organizationId,
      submissionId: attestation.submissionId,
    });
    const [row] = await tx.select().from(submissions).where(target).for('update');
    if (!row) throw new MarketplaceOperatorRefusal('NOT_FOUND');
    if (row.version !== input.expectedVersion)
      throw new MarketplaceOperatorRefusal('VERSION_CONFLICT');
    if (
      row.state !== 'in_review' &&
      !(row.state === 'submitted' && attestation.verdict === 'rejected')
    )
      throw new MarketplaceOperatorRefusal('INVALID_STATE');
    const decidedAt = new Date(attestation.decidedAt);
    if (
      Number.isNaN(decidedAt.getTime()) ||
      decidedAt < row.createdAt ||
      attestation.publisherId !== row.publisherId ||
      attestation.name !== row.name ||
      attestation.semver !== row.semver ||
      attestation.digest !== row.digest ||
      attestation.signerKeyId !== row.signerKeyId
    )
      throw new MarketplaceOperatorRefusal('INVALID_INPUT');
    const [review] = await tx
      .insert(reviews)
      .values({
        submissionOrganizationId: row.organizationId,
        submissionId: row.id,
        digest: row.digest,
        signerKeyId: row.signerKeyId,
        reviewerKeyId: attestation.reviewerKeyId,
        reviewerLabel: input.reviewerLabel,
        verdict: attestation.verdict,
        checks: attestation.checks,
        findingCodes: [...attestation.findingCodes],
        attestation,
        attestationSignature: input.attestationSignature,
        decidedAt,
      })
      .returning();
    if (!review) throw new MarketplaceOperatorRefusal('INVALID_STATE');
    await tx
      .update(submissions)
      .set({
        state: attestation.verdict,
        decidedAt,
        updatedAt: new Date(),
        version: row.version + 1,
      })
      .where(target);
    return review;
  });
}

/** This transaction commits before the caller can send the shared object PUT. */
export async function reserveListingObject(
  db: EnsemusDrizzle,
  input: SubmissionTarget & { digest: string; bundleSha256: string; sizeBytes: number },
): Promise<boolean> {
  if (
    !/^[0-9a-f]{64}$/.test(input.digest) ||
    !/^[0-9a-f]{64}$/.test(input.bundleSha256) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > 8_388_608
  )
    throw new MarketplaceOperatorRefusal('INVALID_INPUT');
  return db.transaction(async (tx) => {
    await assertOperator(tx);
    const [row] = await tx
      .select({ id: submissions.id })
      .from(submissions)
      .where(
        and(
          targetOf(input),
          eq(submissions.state, 'approved'),
          eq(submissions.digest, input.digest),
          eq(submissions.sizeBytes, input.sizeBytes),
        ),
      )
      .for('share');
    if (!row) throw new MarketplaceOperatorRefusal('INVALID_STATE');
    await tx.execute(sql`insert into marketplace.listing_object_reservations (digest,bundle_sha256,size_bytes)
      values(${input.digest}, ${input.bundleSha256}, ${input.sizeBytes}) on conflict (digest) do nothing`);
    const reservation = await tx.execute<{ bundle_sha256: string; size_bytes: number }>(
      sql`select bundle_sha256,size_bytes from marketplace.listing_object_reservations where digest=${input.digest}`,
    );
    const existing = reservation.rows[0];
    return (
      existing?.bundle_sha256 === input.bundleSha256 && existing.size_bytes === input.sizeBytes
    );
  });
}

/** Writes the listing from the existing approved review and signed manifest. */
export async function createListing(
  db: EnsemusDrizzle,
  input: SubmissionTarget & { reviewId: string; objectKey: string; bundleSha256: string },
): Promise<MarketplaceListingRow> {
  return db.transaction(async (tx) => {
    await assertOperator(tx);
    const [subject] = await tx
      .select({
        submission: submissions,
        publisherDisplayName: publishers.displayName,
        publisherState: publishers.state,
      })
      .from(submissions)
      .innerJoin(
        publishers,
        and(
          eq(publishers.id, submissions.publisherId),
          eq(publishers.organizationId, submissions.organizationId),
        ),
      )
      .where(targetOf(input))
      .for('share');
    if (!subject) throw new MarketplaceOperatorRefusal('NOT_FOUND');
    const sub = subject.submission;
    if (sub.state !== 'approved' || subject.publisherState !== 'active')
      throw new MarketplaceOperatorRefusal('INVALID_STATE');
    if (input.objectKey !== listingObjectKey(sub.digest))
      throw new MarketplaceOperatorRefusal('INVALID_INPUT');
    const [review] = await tx
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.id, input.reviewId),
          eq(reviews.submissionOrganizationId, sub.organizationId),
          eq(reviews.submissionId, sub.id),
          eq(reviews.verdict, 'approved'),
        ),
      );
    if (!review) throw new MarketplaceOperatorRefusal('NOT_FOUND');

    const reservation = await tx.execute<{ admitted: boolean }>(
      sql`select exists(select 1 from marketplace.listing_object_reservations
        where digest=${sub.digest} and bundle_sha256=${input.bundleSha256} and size_bytes=${sub.sizeBytes}) as admitted`,
    );
    if (reservation.rows[0]?.admitted !== true)
      throw new MarketplaceOperatorRefusal('INVALID_STATE');
    const [existing] = await tx.select().from(listings).where(eq(listings.reviewId, review.id));
    if (existing?.state === 'delisted') throw new MarketplaceOperatorRefusal('INVALID_STATE');
    if (existing) return existing;
    const manifest = sub.manifest as {
      display_name?: unknown;
      summary?: unknown;
      license?: unknown;
      max_classification?: unknown;
      execution?: { kind?: unknown };
    } | null;
    const executionKind = manifest?.execution?.kind;
    const maxClassification = manifest?.max_classification;
    if (
      !manifest ||
      typeof manifest.display_name !== 'string' ||
      typeof manifest.summary !== 'string' ||
      typeof manifest.license !== 'string' ||
      (executionKind !== 'declarative' && executionKind !== 'sandbox') ||
      (maxClassification !== 'public' &&
        maxClassification !== 'internal' &&
        maxClassification !== 'confidential')
    )
      throw new MarketplaceOperatorRefusal('INVALID_INPUT');
    const [listed] = await tx
      .insert(listings)
      .values({
        publisherId: sub.publisherId,
        publisherOrganizationId: sub.organizationId,
        publisherDisplayName: subject.publisherDisplayName,
        submissionId: sub.id,
        reviewId: review.id,
        name: sub.name,
        semver: sub.semver,
        displayName: manifest.display_name,
        summary: manifest.summary,
        digest: sub.digest,
        manifest: sub.manifest,
        license: manifest.license,
        executionKind,
        maxClassification,
        signerKeyId: sub.signerKeyId,
        signerPublicKey: sub.signerPublicKey,
        signature: sub.signature,
        reviewerKeyId: review.reviewerKeyId,
        attestationSignature: review.attestationSignature,
        objectKey: input.objectKey,
        sizeBytes: sub.sizeBytes,
      })
      .onConflictDoNothing()
      .returning();
    if (listed) return listed;
    const [raced] = await tx.select().from(listings).where(eq(listings.reviewId, review.id));
    if (!raced) throw new MarketplaceOperatorRefusal('VERSION_CONFLICT');
    return raced;
  });
}

export async function delistListing(
  db: EnsemusDrizzle,
  input: { listingId: string; mode: DelistMode; code: DelistCode; expectedVersion: number },
): Promise<MarketplaceListingRow> {
  return db.transaction(async (tx) => {
    await assertOperator(tx);
    const target = eq(listings.id, input.listingId);
    const [row] = await tx.select().from(listings).where(target).for('update');
    if (!row) throw new MarketplaceOperatorRefusal('NOT_FOUND');
    if (row.version !== input.expectedVersion)
      throw new MarketplaceOperatorRefusal('VERSION_CONFLICT');
    if (row.state === 'delisted' && row.delistMode === input.mode && row.delistCode === input.code)
      return row;
    if (row.state === 'delisted' && !(row.delistMode === 'stop_new' && input.mode === 'revoke'))
      throw new MarketplaceOperatorRefusal('INVALID_STATE');
    const [changed] = await tx
      .update(listings)
      .set({
        state: 'delisted',
        delistMode: input.mode,
        delistCode: input.code,
        delistedAt: row.delistedAt ?? new Date(),
        version: row.version + 1,
      })
      .where(target)
      .returning();
    if (!changed) throw new MarketplaceOperatorRefusal('VERSION_CONFLICT');
    return changed;
  });
}

export async function setPublisherState(
  db: EnsemusDrizzle,
  input: { publisherId: string; state: 'active' | 'suspended'; expectedVersion: number },
): Promise<void> {
  return db.transaction(async (tx) => {
    await assertOperator(tx);
    const target = eq(publishers.id, input.publisherId);
    const [row] = await tx
      .select({ state: publishers.state, version: publishers.version })
      .from(publishers)
      .where(target)
      .for('update');
    if (!row) throw new MarketplaceOperatorRefusal('NOT_FOUND');
    if (row.version !== input.expectedVersion)
      throw new MarketplaceOperatorRefusal('VERSION_CONFLICT');
    if (row.state === input.state) return;
    await tx
      .update(publishers)
      .set({ state: input.state, version: row.version + 1, updatedAt: new Date() })
      .where(target);
  });
}

export type { ReviewVerdict };
