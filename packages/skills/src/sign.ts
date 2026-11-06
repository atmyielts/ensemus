// Owned by the skill-format slice (EXP-04). See docs/06-delivery/m11b-slices.md and ADR-034 D2. For a publisher's
// or reviewer's own machine, and for tests. Lint keeps it out of anything that ships, because Ensemus never
// signs for anybody: a server holding a signing key is the exact thing this design avoids.
import type { ReviewAttestation } from '@ensemus/domain/marketplace';

/** Signs a digest with a private key the caller holds in memory. Never reads or stores one itself. */
export function signSkillDigest(_input: { digest: string; privateKeyPem: string }): Buffer {
  throw new Error('NOT_IMPLEMENTED');
}

/** The same, for a review. */
export function signAttestation(_input: {
  attestation: ReviewAttestation;
  privateKeyPem: string;
}): Buffer {
  throw new Error('NOT_IMPLEMENTED');
}
