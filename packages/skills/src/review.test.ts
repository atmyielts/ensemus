import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@ensemus/domain/approval';
import { REVIEW_CHECKS, type ReviewAttestation } from '@ensemus/domain/marketplace';
import { keyIdOf } from './signature';
import { attestationPayload, parseApprovedAttestation, verifyApprovedAttestation } from './review';
import { signAttestation } from './sign';

function scene() {
  const keys = generateKeyPairSync('ed25519');
  const raw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const attestation: ReviewAttestation = {
    kind: 'ensemus.skill.review.v1',
    submissionId: '00000000-0000-4000-8000-000000000001',
    publisherId: '00000000-0000-4000-8000-000000000002',
    name: 'sample-skill',
    semver: '1.0.0',
    digest: 'a'.repeat(64),
    signerKeyId: 'b'.repeat(64),
    verdict: 'approved',
    checks: Object.fromEntries(
      REVIEW_CHECKS.map((key) => [key, 'pass']),
    ) as ReviewAttestation['checks'],
    findingCodes: [],
    reviewerKeyId: keyIdOf(raw),
    decidedAt: '2026-11-21T00:00:00.000Z',
  };
  const facts = {
    submissionId: attestation.submissionId,
    publisherId: attestation.publisherId,
    name: attestation.name,
    semver: attestation.semver,
    digest: attestation.digest,
    signerKeyId: attestation.signerKeyId,
    executionKind: 'sandbox' as const,
  };
  const payload = Buffer.from('ensemus.skill.review.v1\0' + canonicalJson(attestation));
  return {
    keys,
    raw,
    attestation,
    facts,
    payload,
    signature: sign(null, payload, keys.privateKey),
    reviewKeys: new Map([[keyIdOf(raw), raw]]),
  };
}
describe('deployment review attestations', () => {
  it('checks a separately signed canonical review against configured trust and exact package facts', () => {
    const s = scene();
    expect(attestationPayload(s.attestation)).toEqual(s.payload);
    expect(parseApprovedAttestation(s.attestation)).toEqual(s.attestation);
    expect(verifyApprovedAttestation(s)).toBe(true);
    expect(
      signAttestation({
        attestation: s.attestation,
        privateKeyPem: s.keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      }),
    ).toEqual(s.signature);
  });
  it('rejects every substituted fact, unknown or mislabeled trust, invalid shapes and altered signatures', () => {
    const s = scene();
    for (const key of [
      'submissionId',
      'publisherId',
      'name',
      'semver',
      'digest',
      'signerKeyId',
    ] as const) {
      expect(verifyApprovedAttestation({ ...s, facts: { ...s.facts, [key]: 'changed' } })).toBe(
        false,
      );
    }
    expect(verifyApprovedAttestation({ ...s, reviewKeys: new Map() })).toBe(false);
    expect(
      verifyApprovedAttestation({
        ...s,
        reviewKeys: new Map([[s.attestation.reviewerKeyId, Buffer.alloc(32)]]),
      }),
    ).toBe(false);
    expect(verifyApprovedAttestation({ ...s, signature: Buffer.alloc(64) })).toBe(false);
    for (const attestation of [
      null,
      [],
      { ...s.attestation, verdict: 'rejected' },
      { ...s.attestation, extra: true },
      { ...s.attestation, checks: {} },
      { ...s.attestation, decidedAt: 'tomorrow' },
    ]) {
      expect(parseApprovedAttestation(attestation)).toBeNull();
      expect(verifyApprovedAttestation({ ...s, attestation })).toBe(false);
    }
  });
  it('refuses signed failed checks, findings, code-review skips for executable packages and self-review', () => {
    const s = scene();
    for (const attestation of [
      {
        ...s.attestation,
        checks: { ...s.attestation.checks, instructions_read_for_abuse: 'fail' as const },
      },
      { ...s.attestation, findingCodes: ['HARMFUL_CODE' as const] },
      {
        ...s.attestation,
        checks: { ...s.attestation.checks, code_read_for_abuse: 'not_applicable' as const },
      },
      { ...s.attestation, signerKeyId: s.attestation.reviewerKeyId },
    ]) {
      const signature = sign(null, attestationPayload(attestation), s.keys.privateKey);
      expect(
        verifyApprovedAttestation({
          ...s,
          attestation,
          signature,
          facts: { ...s.facts, signerKeyId: attestation.signerKeyId },
        }),
      ).toBe(false);
    }
  });
});
