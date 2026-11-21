// Owned by the skill-format slice (EXP-04). See docs/06-delivery/m11b-slices.md and ADR-034 D2. For a publisher's
// or reviewer's own machine, and for tests. Lint keeps it out of anything that ships, because Ensemus never
// signs for anybody: a server holding a signing key is the exact thing this design avoids.
import { createPrivateKey, sign } from 'node:crypto';
import { signingPayload } from '@ensemus/skills/signature';
import { attestationPayload } from '@ensemus/skills/review';
import type { ReviewAttestation } from '@ensemus/domain/marketplace';

/** Signs a digest with a private key the caller holds in memory. Never reads or stores one itself. */
export function signSkillDigest(input: { digest: string; privateKeyPem: string }): Buffer {
  const key = createPrivateKey(input.privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('SKILL_SIGNER_KEY_INVALID');
  return sign(null, signingPayload(input.digest), key);
}

/** The same, for a review. */
export function signAttestation(input: {
  attestation: ReviewAttestation;
  privateKeyPem: string;
}): Buffer {
  const key = createPrivateKey(input.privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('SKILL_SIGNER_KEY_INVALID');
  return sign(null, attestationPayload(input.attestation), key);
}
