import { createHash, randomUUID, sign } from 'node:crypto';
import type { InstallationSubject } from '@ensemus/application';
import {
  listingObjectKey,
  REVIEW_CHECKS,
  type ReviewAttestation,
} from '@ensemus/domain/marketplace';
import { parseSkillBundle } from '@ensemus/skills/bundle';
import { attestationPayload } from '@ensemus/skills/review';
import { buildTestBundle, generateTestKey } from '@ensemus/skills/testing';
import { describe, expect, it } from 'vitest';
import {
  hasMarketplaceBundleSignature,
  hasMarketplaceReview,
  matchesMarketplaceBundle,
} from '../../packages/workflows/src/marketplace-install-step';

function fixture() {
  const publisher = generateTestKey();
  const reviewer = generateTestKey();
  const built = buildTestBundle({ key: publisher });
  const result = parseSkillBundle(built.bytes);
  if (!result.ok) throw new Error('INVALID_TEST_BUNDLE');
  const { parsed } = result;
  const { manifest, digest } = parsed;
  const attestation: ReviewAttestation = {
    kind: 'ensemus.skill.review.v1',
    submissionId: randomUUID(),
    publisherId: randomUUID(),
    name: manifest.name,
    semver: manifest.version,
    digest,
    signerKeyId: publisher.keyId,
    verdict: 'approved',
    checks: Object.fromEntries(
      REVIEW_CHECKS.map((check) => [check, 'pass']),
    ) as ReviewAttestation['checks'],
    findingCodes: [],
    reviewerKeyId: reviewer.keyId,
    decidedAt: '2026-11-24T07:25:00Z',
  };
  const reviewSignature = sign(null, attestationPayload(attestation), reviewer.privateKeyPem);
  const subject: InstallationSubject = {
    id: randomUUID(),
    installationId: randomUUID(),
    publisherDisplayName: 'Generated publisher',
    publisherId: attestation.publisherId,
    submissionId: attestation.submissionId,
    name: manifest.name,
    displayName: manifest.display_name,
    summary: manifest.summary,
    semver: manifest.version,
    digest,
    bundleSha256: createHash('sha256').update(built.bytes).digest('hex'),
    objectKey: listingObjectKey(digest),
    sizeBytes: built.bytes.length,
    license: manifest.license,
    executionKind: manifest.execution.kind,
    maxClassification: manifest.max_classification,
    toolBoundaries: manifest.tool_boundaries,
    signerKeyId: publisher.keyId,
    signerPublicKey: publisher.publicKey,
    signature: Buffer.from(parsed.bundle.signature.value_base64, 'base64'),
    reviewerKeyId: reviewer.keyId,
    attestation,
    attestationSignature: reviewSignature,
    reviewSignature,
    state: 'listed',
    delistMode: null,
    listedAt: new Date(attestation.decidedAt),
  };
  return {
    subject,
    attestation,
    parsed,
    reviewKeys: new Map([[reviewer.keyId, reviewer.publicKey]]),
  };
}

describe('marketplace installation trust checks', () => {
  it('requires an independently configured reviewer for exactly the listed release', () => {
    const { subject, attestation, reviewKeys } = fixture();
    expect(hasMarketplaceReview(subject, reviewKeys)).toBe(true);
    expect(hasMarketplaceReview(subject, new Map())).toBe(false);
    expect(hasMarketplaceReview({ ...subject, publisherId: randomUUID() }, reviewKeys)).toBe(false);
    expect(
      hasMarketplaceReview({ ...subject, reviewerKeyId: subject.signerKeyId }, reviewKeys),
    ).toBe(false);
    expect(
      hasMarketplaceReview(
        {
          ...subject,
          attestation: { ...attestation, decidedAt: '2026-11-24T07:26:00Z' },
        },
        reviewKeys,
      ),
    ).toBe(false);
    const forged = Buffer.alloc(64, 23);
    expect(
      hasMarketplaceReview(
        {
          ...subject,
          attestationSignature: forged,
          reviewSignature: forged,
        },
        reviewKeys,
      ),
    ).toBe(false);
  });

  it('binds a parsed bundle and its signer to the precise listing', () => {
    const { subject, parsed } = fixture();
    expect(matchesMarketplaceBundle(parsed, subject)).toBe(true);
    expect(matchesMarketplaceBundle(parsed, { ...subject, digest: 'f'.repeat(64) })).toBe(false);
    expect(matchesMarketplaceBundle(parsed, { ...subject, executionKind: 'sandbox' })).toBe(false);
    expect(hasMarketplaceBundleSignature(parsed, subject)).toBe(true);
    expect(hasMarketplaceBundleSignature(parsed, { ...subject, signature: Buffer.alloc(64) })).toBe(
      false,
    );
    expect(
      hasMarketplaceBundleSignature(parsed, {
        ...subject,
        signerPublicKey: generateTestKey().publicKey,
      }),
    ).toBe(false);
  });
});
