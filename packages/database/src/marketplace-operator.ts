// For the marketplace operator command only (lint blocks this everywhere else). Its role crosses tenants, and
// reaches the marketplace schema and nothing else: no skills, no work, no secrets. It exists only on a server
// whose operator ran provision-marketplace.sql (ADR-034 D6). Owned by the marketplace-operator slice.
import type {
  DelistCode,
  DelistMode,
  ReviewAttestation,
  ReviewVerdict,
} from '@ensemus/domain/marketplace';
import { openDatabase, type EnsemusDrizzle } from './connection';
import type {
  MarketplaceListingRow,
  MarketplaceReviewRow,
  MarketplaceSubmissionRow,
} from './schema-skills';

export function openMarketplaceOperatorDatabase(url: string) {
  return openDatabase(url, { max: 2 });
}

/** Oldest first: everything `submitted` or `in_review`, and approved ones with a delisting asked for. */
export function listOperatorQueue(
  _db: EnsemusDrizzle,
): Promise<readonly MarketplaceSubmissionRow[]> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getSubmissionForReview(
  _db: EnsemusDrizzle,
  _input: { organizationId: string; submissionId: string },
): Promise<MarketplaceSubmissionRow | null> {
  throw new Error('NOT_IMPLEMENTED');
}

export function markSubmissionInReview(
  _db: EnsemusDrizzle,
  _input: { organizationId: string; submissionId: string; expectedVersion: number },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Appends the review and moves the submission to `approved` or `rejected`, in one transaction. The trigger
 * refuses it if the digest or signer differ from the submission's, or if an approval has any failed check
 * or any finding. The caller has already checked the signature against this deployment's review keys.
 */
export function recordReview(
  _db: EnsemusDrizzle,
  _input: {
    organizationId: string;
    attestation: ReviewAttestation;
    attestationSignature: Buffer;
    reviewerLabel: string;
    expectedVersion: number;
  },
): Promise<MarketplaceReviewRow> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Writes the listing from an approved review. The trigger refuses anything else, whoever asks. */
export function createListing(
  _db: EnsemusDrizzle,
  _input: { organizationId: string; submissionId: string; reviewId: string; objectKey: string },
): Promise<MarketplaceListingRow> {
  throw new Error('NOT_IMPLEMENTED');
}

export function delistListing(
  _db: EnsemusDrizzle,
  _input: { listingId: string; mode: DelistMode; code: DelistCode; expectedVersion: number },
): Promise<MarketplaceListingRow> {
  throw new Error('NOT_IMPLEMENTED');
}

export function setPublisherState(
  _db: EnsemusDrizzle,
  _input: { publisherId: string; state: 'active' | 'suspended'; expectedVersion: number },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export type { ReviewVerdict };
