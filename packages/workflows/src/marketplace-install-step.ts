import type { InstallationSubject, MarketplaceReviewKeys } from '@ensemus/application';
import type { parseSkillBundle } from '@ensemus/skills/bundle';
import { parseApprovedAttestation, verifyApprovedAttestation } from '@ensemus/skills/review';
import { isValidPublicKey, keyIdOf, verifySkillSignature } from '@ensemus/skills/signature';

type ParsedBundle = Extract<ReturnType<typeof parseSkillBundle>, { ok: true }>['parsed'];

export function hasMarketplaceReview(
  subject: InstallationSubject,
  reviewKeys: MarketplaceReviewKeys,
) {
  const attestation = parseApprovedAttestation(subject.attestation);
  if (
    !attestation ||
    attestation.reviewerKeyId !== subject.reviewerKeyId ||
    !subject.attestationSignature?.equals(subject.reviewSignature) ||
    (subject.executionKind !== 'declarative' && subject.executionKind !== 'sandbox')
  )
    return false;
  return verifyApprovedAttestation({
    attestation,
    signature: subject.attestationSignature,
    reviewKeys,
    facts: { ...subject, executionKind: subject.executionKind },
  });
}

export function matchesMarketplaceBundle(parsed: ParsedBundle, subject: InstallationSubject) {
  return (
    parsed.digest === subject.digest &&
    parsed.manifest.name === subject.name &&
    parsed.manifest.version === subject.semver &&
    parsed.manifest.execution.kind === subject.executionKind &&
    parsed.manifest.license === subject.license &&
    parsed.manifest.max_classification === subject.maxClassification
  );
}

export function hasMarketplaceBundleSignature(parsed: ParsedBundle, subject: InstallationSubject) {
  const signature = Buffer.from(parsed.bundle.signature.value_base64, 'base64');
  return (
    parsed.bundle.signature.key_id === subject.signerKeyId &&
    signature.equals(subject.signature) &&
    isValidPublicKey(subject.signerPublicKey) &&
    keyIdOf(subject.signerPublicKey) === subject.signerKeyId &&
    verifySkillSignature({ digest: parsed.digest, signature, publicKey: subject.signerPublicKey })
  );
}
