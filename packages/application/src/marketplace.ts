// Owned by the marketplace-submissions slice (EXP-06). See docs/06-delivery/m11b-slices.md and ADR-034 D5.
// A tenant's side of publishing. A publisher can ask, withdraw and ask for a delisting, and that is all:
// reviews and listings are written only by the operator role, which this code does not have.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { ReviewFindingCode, SubmissionState } from '@ensemus/domain/marketplace';
import type { SkillFeatureGate } from './skill-ports';

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
  /** Codes from the review, from a fixed list. A reviewer's words never come through here. */
  findingCodes: readonly ReviewFindingCode[];
  createdAt: Date;
  decidedAt: Date | null;
  version: number;
};

/** Needs marketplace.publish, which only an owner has. One per organization. */
export function createPublisher(
  _database: AppDatabase,
  _context: TenantContext,
  _gate: SkillFeatureGate,
  _input: { displayName: string },
): Promise<PublisherView> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Null for an organization that has not asked to publish. */
export function getPublisher(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<PublisherView | null> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Needs marketplace.publish and a person, because it says other organizations may see this. The version
 * must be `verified` or `published`, of a tenant-origin package marked `public`, signed by a key still
 * active. Copies everything a reviewer needs on to the row, and the trigger holds the copy equal.
 */
export function submitToMarketplace(
  _database: AppDatabase,
  _context: TenantContext,
  _gate: SkillFeatureGate,
  _input: { skillVersionId: string; confirmShareWithOtherOrganizations: true },
): Promise<SubmissionView> {
  throw new Error('NOT_IMPLEMENTED');
}

export function listSubmissions(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly SubmissionView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Refused for anything already listed: MARKETPLACE_SUBMISSION_NOT_WITHDRAWABLE. Use requestDelisting. */
export function withdrawSubmission(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { submissionId: string; expectedVersion: number },
): Promise<SubmissionView> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Only for an approved submission. Writes the request and an event. The operator takes it from there. */
export function requestDelisting(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { submissionId: string; expectedVersion: number },
): Promise<SubmissionView> {
  throw new Error('NOT_IMPLEMENTED');
}
