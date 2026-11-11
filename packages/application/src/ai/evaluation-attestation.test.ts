// AGENT-16, threat SEC-007. The keys and the signing side. What publish refuses is in agents.test.ts.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  evaluationReportProblems,
  evaluationSigner,
  evaluationTrust,
  publicKeyOf,
  signEvaluationReport,
  verifyEvaluationAttestation,
} from './evaluation-attestation';
import { reportV2, TEST_SIGNER, TEST_TRUST } from './evaluation-attestation.test-support';

const SPEC = 'a'.repeat(64);

describe('evaluationSigner', () => {
  it('takes only an Ed25519 key, so a signature can only mean one thing', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => evaluationSigner({ keyId: 'ci', privateKeyPem: pem })).toThrow(
      'EVALUATION_SIGNER_NOT_ED25519',
    );
  });

  it('refuses a key id that publish could never look up', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => evaluationSigner({ keyId: 'Not An Id', privateKeyPem: pem })).toThrow(
      'EVALUATION_SIGNER_INVALID_KEY_ID',
    );
  });
});

describe('evaluationTrust', () => {
  it('turns the public key an operator copies from a signer into one that verifies it', () => {
    const trust = evaluationTrust({
      publicKeys: [{ keyId: TEST_SIGNER.keyId, publicKey: publicKeyOf(TEST_SIGNER) }],
      maxAgeHours: 1,
    });
    const signed = signEvaluationReport(reportV2(SPEC, 'p'), TEST_SIGNER);
    expect(verifyEvaluationAttestation(signed, trust, new Date())).toEqual(signed.report);
  });

  it.each([
    ['a duplicated id', [TEST_SIGNER.keyId, TEST_SIGNER.keyId]],
    ['a malformed id', ['Bad Id']],
  ])('refuses %s', (_label, ids) => {
    const publicKeys = ids.map((keyId) => ({ keyId, publicKey: publicKeyOf(TEST_SIGNER) }));
    expect(() => evaluationTrust({ publicKeys, maxAgeHours: 1 })).toThrow(
      'EVALUATION_TRUST_INVALID_KEY',
    );
  });

  it('refuses a max age that would accept nothing or anything', () => {
    for (const maxAgeHours of [0, -1, 1.5, Number.NaN]) {
      expect(() => evaluationTrust({ publicKeys: [], maxAgeHours })).toThrow(
        'EVALUATION_TRUST_INVALID_MAX_AGE',
      );
    }
  });
});

describe('signEvaluationReport', () => {
  it('will not sign a report that does not agree with itself', () => {
    const inconsistent = reportV2(SPEC, 'p', { cost_micros: 999 });
    expect(evaluationReportProblems(inconsistent)).toEqual(['COST_MISMATCH']);
    expect(() => signEvaluationReport(inconsistent, TEST_SIGNER)).toThrow(
      'EVALUATION_REPORT_INCONSISTENT:COST_MISMATCH',
    );
  });

  it('gives the same signature for the same report, so evidence can be regenerated and compared', () => {
    const report = reportV2(SPEC, 'p');
    expect(signEvaluationReport(report, TEST_SIGNER)).toEqual(
      signEvaluationReport(structuredClone(report), TEST_SIGNER),
    );
  });

  it('verifies whatever order the report keys arrive in', () => {
    const signed = signEvaluationReport(reportV2(SPEC, 'p'), TEST_SIGNER);
    const reordered = {
      signature: signed.signature,
      report: Object.fromEntries(Object.entries(signed.report).reverse()),
    };
    expect(verifyEvaluationAttestation(reordered, TEST_TRUST, new Date()).spec_sha256).toBe(SPEC);
  });
});
