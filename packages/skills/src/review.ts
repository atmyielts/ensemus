// Owned by the skill-format slice (EXP-04, EXP-06). See docs/06-delivery/m11b-slices.md and ADR-034 D5.
// Checks a review's signature against keys from the deployment's configuration, never from the database.
import type { ReviewAttestation } from '@ensemus/domain/marketplace';

/** The fixed prefix on what a review key signs. */
export const REVIEW_SIGNATURE_DOMAIN = 'ensemus.skill.review.v1\0';

/** Exactly the bytes a reviewer signs: the domain prefix, then the attestation's canonicalJson. */
export function attestationPayload(_attestation: ReviewAttestation): Buffer {
  throw new Error('NOT_IMPLEMENTED');
}

/** Checks a stored attestation's shape, with the verdict `approved`. Null for anything else. */
export function parseApprovedAttestation(_value: unknown): ReviewAttestation | null {
  throw new Error('NOT_IMPLEMENTED');
}

export type AttestationFacts = {
  submissionId: string;
  publisherId: string;
  name: string;
  semver: string;
  digest: string;
  signerKeyId: string;
};

/**
 * True only if the reviewer's key is one this deployment configured, it signed exactly this attestation,
 * the verdict is `approved`, and every fact matches. Answers false for any failure, and never throws.
 */
export function verifyApprovedAttestation(_input: {
  attestation: unknown;
  signature: Buffer;
  reviewKeys: ReadonlyMap<string, Buffer>;
  facts: AttestationFacts;
}): boolean {
  throw new Error('NOT_IMPLEMENTED');
}
