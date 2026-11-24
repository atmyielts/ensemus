// Signed evaluation reports for tests that need a version published and are not about the gate itself.
// The key is made fresh in this process (see evaluation-attestation.test-support.ts) and never written
// down. The report says a model ran, because a production agent refuses a scripted one: the model, cost
// and latency in it are a test double's, and the figures are the test's own.
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentSpecSha256, getAgentPolicyVersion } from '@ensemus/application/ai-agents';
import { agentSpecV1Schema, type EvaluationReportV2 } from '@ensemus/contracts/ai';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { STUDIO_SUITE_REF } from '@ensemus/domain/agent-draft';
import { evaluationSigner } from '../../../packages/application/src/ai/evaluation-attestation';
import {
  reportV2,
  signedReport,
} from '../../../packages/application/src/ai/evaluation-attestation.test-support';

export { TEST_TRUST } from '../../../packages/application/src/ai/evaluation-attestation.test-support';

export function signedReportFor(
  spec: unknown,
  policyVersion: string,
  overrides: Partial<EvaluationReportV2> = {},
) {
  const parsed = agentSpecV1Schema.parse(spec);
  return signedReport(
    reportV2(agentSpecSha256(parsed), policyVersion, {
      suite_ref: parsed.evaluation.suite_ref,
      ...overrides,
    }),
  );
}

/**
 * The private half of the evaluator key the stack's test overlay trusts, written next to its other generated
 * secrets by generate-test-secrets.mjs. compose.test.yaml mounts only the public half into web. A missing key
 * is a failure and not a skip: a publish that quietly did not happen proves nothing.
 */
export function stackEvaluationSigner() {
  const folder = joinPath(
    fileURLToPath(new URL('../../../', import.meta.url)),
    '.local',
    'evaluation-test',
  );
  return evaluationSigner({
    keyId: readFileSync(joinPath(folder, 'signing-key.id'), 'utf8').trim(),
    privateKeyPem: readFileSync(joinPath(folder, 'signing-key.pem'), 'utf8'),
  });
}

export async function signedStudioStackReport(
  database: AppDatabase,
  context: TenantContext,
  specSha256: string,
) {
  return signedReport(
    reportV2(specSha256, await getAgentPolicyVersion(database, context), {
      suite_ref: STUDIO_SUITE_REF,
    }),
    stackEvaluationSigner(),
  );
}
