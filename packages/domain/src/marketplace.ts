// Marketplace rules (ADR-034 D5 to D7). Pure. Each state table is repeated in migration 0651, and a test
// holds the copies together. No price, plan or payment appears here or anywhere in M11B.

export const SUBMISSION_STATES = [
  'submitted',
  'in_review',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

export const SUBMISSION_TRANSITIONS: Record<SubmissionState, readonly SubmissionState[]> = {
  submitted: ['in_review', 'rejected', 'withdrawn'],
  in_review: ['approved', 'rejected', 'withdrawn'],
  approved: ['withdrawn'],
  rejected: [],
  withdrawn: [],
};

export const LISTING_STATES = ['listed', 'delisted'] as const;
export type ListingState = (typeof LISTING_STATES)[number];

export const DELIST_MODES = ['stop_new', 'revoke'] as const;
export type DelistMode = (typeof DELIST_MODES)[number];

export const DELIST_CODES = [
  'PUBLISHER_REQUEST',
  'SECURITY_ISSUE',
  'LICENSE_ISSUE',
  'POLICY_VIOLATION',
] as const;
export type DelistCode = (typeof DELIST_CODES)[number];

export const INSTALLATION_STATES = [
  'requested',
  'installing',
  'installed',
  'failed',
  'removed',
] as const;
export type InstallationState = (typeof INSTALLATION_STATES)[number];

export const INSTALLATION_TRANSITIONS: Record<InstallationState, readonly InstallationState[]> = {
  requested: ['installing', 'failed'],
  installing: ['installed', 'failed'],
  installed: ['removed'],
  failed: [],
  removed: [],
};

export const INSTALLATION_FAILURE_CODES = [
  'LISTING_NOT_AVAILABLE',
  'ATTESTATION_INVALID',
  'SIGNATURE_INVALID',
  'BUNDLE_HASH_MISMATCH',
  'BUNDLE_UNAVAILABLE',
  'NAME_TAKEN',
  'VERIFICATION_REJECTED',
  'INSTALL_ERROR',
] as const;
export type InstallationFailureCode = (typeof INSTALLATION_FAILURE_CODES)[number];

/**
 * What a reviewer has to answer, one by one. A fixed list, because "reviewed" should mean the same thing
 * every time, and non-code skills get reviewed too: instructions can induce harmful permitted behaviour
 * (threat model section 5). Approving means the reviewer looked, and is not a certification.
 */
export const REVIEW_CHECKS = [
  'signature_and_digest_checked',
  'license_and_dependencies_checked',
  'tool_boundaries_match_purpose',
  'data_classes_match_purpose',
  'instructions_read_for_abuse',
  'code_read_for_abuse',
  'tests_inspected',
] as const;
export type ReviewCheck = (typeof REVIEW_CHECKS)[number];

export const REVIEW_CHECK_RESULTS = ['pass', 'fail', 'not_applicable'] as const;
export type ReviewCheckResult = (typeof REVIEW_CHECK_RESULTS)[number];

export const REVIEW_VERDICTS = ['approved', 'rejected'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_FINDING_CODES = [
  'SIGNATURE_PROBLEM',
  'LICENSE_PROBLEM',
  'DEPENDENCY_PROBLEM',
  'EXCESSIVE_TOOLS',
  'EXCESSIVE_DATA_ACCESS',
  'HARMFUL_INSTRUCTIONS',
  'HARMFUL_CODE',
  'INADEQUATE_TESTS',
  'MISLEADING_DESCRIPTION',
] as const;
export type ReviewFindingCode = (typeof REVIEW_FINDING_CODES)[number];

export type ReviewChecks = Readonly<Record<ReviewCheck, ReviewCheckResult>>;

/**
 * An approval needs every check answered, none failed, and no findings. Only the code and signature
 * checks may be not_applicable, and code only for a package with no code. Everything else always applies.
 * Migration 0651 holds the first three halves of this, and the operator command the last.
 */
export function reviewCanApprove(
  checks: ReviewChecks,
  findings: readonly ReviewFindingCode[],
  executionKind: 'declarative' | 'sandbox',
): boolean {
  if (findings.length > 0) return false;
  return REVIEW_CHECKS.every((check) => {
    const result = checks[check];
    if (result === 'pass') return true;
    return (
      result === 'not_applicable' &&
      check === 'code_read_for_abuse' &&
      executionKind === 'declarative'
    );
  });
}

/**
 * Exactly what a review key signs. Everything an installer relies on is in here, so changing a listing's
 * publisher, signer or bytes breaks the signature wherever the row came from.
 */
export type ReviewAttestation = {
  kind: 'ensemus.skill.review.v1';
  submissionId: string;
  publisherId: string;
  name: string;
  semver: string;
  digest: string;
  signerKeyId: string;
  verdict: ReviewVerdict;
  checks: ReviewChecks;
  findingCodes: readonly ReviewFindingCode[];
  reviewerKeyId: string;
  decidedAt: string;
};

/** A listing's copy of the bytes, outside any tenant's prefix. Named by what it holds. */
export const listingObjectKey = (digest: string) => `marketplace/${digest}`;
