// Test-only. A signing key made fresh in this process, so no test key is ever written down, and reports
// signed with it for whatever a test needs to publish. Never imported by shipped code.
import { generateKeyPairSync } from 'node:crypto';
import type { EvaluationReportV2, SignedEvaluationReport } from '@ensemus/contracts/ai';
import {
  evaluationSigner,
  evaluationTrust,
  publicKeyOf,
  signEvaluationReport,
  type EvaluationSigner,
  type EvaluationTrust,
} from './evaluation-attestation';

export function generatedSigner(keyId = 'test-evaluator'): EvaluationSigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  return evaluationSigner({
    keyId,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  });
}

/** The default signer of this test process, and the trust that accepts it. */
export const TEST_SIGNER = generatedSigner();
export const trustFor = (
  signers: readonly EvaluationSigner[],
  maxAgeHours = 168,
): EvaluationTrust =>
  evaluationTrust({
    publicKeys: signers.map((signer) => ({ keyId: signer.keyId, publicKey: publicKeyOf(signer) })),
    maxAgeHours,
  });
export const TEST_TRUST = trustFor([TEST_SIGNER]);

/**
 * A consistent report for a spec hash: two cases, both passed, with made-up but self-consistent cost and
 * latency. The model named is a test double's, never a real provider's, and the cost is the test's own.
 */
export function reportV2(
  specSha256: string,
  policyVersion: string,
  overrides: Partial<EvaluationReportV2> = {},
): EvaluationReportV2 {
  const model = {
    profile_id: 'test-profile',
    profile_version: 1,
    provider_kind: 'local_openai_compatible',
    model_id: 'test-model',
  };
  return {
    report_version: 2,
    spec_sha256: specSha256,
    policy_version: policyVersion,
    suite_ref: 'evaluations/agents/work-brief',
    dataset_version: 'synthetic-1',
    model_label: 'test-model',
    pass_rate: 1,
    cases: 2,
    passed: true,
    scripted_model: false,
    issued_at: new Date().toISOString(),
    cost_micros: 30,
    latency_ms: 12,
    case_results: [
      { id: 'a', critical: true, passed: true, cost_micros: 10, latency_ms: 5, model },
      { id: 'b', critical: false, passed: true, cost_micros: 20, latency_ms: 7, model },
    ],
    ...overrides,
  };
}

export const signedReport = (
  report: EvaluationReportV2,
  signer: EvaluationSigner = TEST_SIGNER,
): SignedEvaluationReport => signEvaluationReport(report, signer);
