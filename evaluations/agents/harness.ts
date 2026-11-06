// Scripted reports prove the runner, publication gate and controls. They do not measure model quality.
import { createHash } from 'node:crypto';
import { agentSpecSha256 } from '../../packages/application/src/ai/agents';
import {
  agentSpecV1Schema,
  evaluationReportSchema,
  type AgentSpecV1,
  type EvaluationReport,
} from '../../packages/contracts/src/ai';
import { canonicalJson } from '../../packages/domain/src/approval';
import { usdToMicros } from '../../packages/domain/src/ai';
import { EGRESS_MATRIX_SOURCE } from '../../packages/policy/src/egress';
import {
  compiled,
  message,
  task,
} from '../../packages/intelligence/src/router/doubles.test-support';
import { scriptedGateway } from '../routing/scripted-gateway';
import {
  briefSchema,
  DATASET_VERSION,
  PROMPT,
  SOURCE_ID,
  SOURCE_SHA256,
  SOURCE_TEXT,
  SUITE_REF,
  type EvaluationCase,
} from './fixtures';

export const LIMITATION =
  'Scripted model: validates harness, gates and policy behavior only; real model quality is unverified.';
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

export type ExperimentIdentity = {
  task_fixture_version: string;
  fixture_sha256: string;
  agent_version: string;
  skill_version: 'none-m4';
  prompt_sha256: string;
  model_deployment: 'ScriptedModelAdapter/v1';
  scripted_responses_sha256: string;
  policy_version: string;
  policy_matrix_sha256: string;
  spend_budget_micros: number;
  baseline_report_sha256: string | null;
  context_compiler_version: 'explicit-fixture-assembly-v1';
  source_corpus_revision: string;
  test_runner_version: 'ensemus-scripted-eval-1';
  scorer_definition: 'exact-summary-and-permitted-citation-sha256-v1';
};

export type CaseResult = {
  id: string;
  critical: boolean;
  passed: boolean;
  checks: Record<string, boolean>;
  outcome: string;
  decision_code: string | null;
  adapter_calls: number;
  credential_leases: number;
  cost_micros: number;
};

export type EvaluationArtifact = {
  artifact_version: 1;
  limitation: typeof LIMITATION;
  experiment: ExperimentIdentity;
  experiment_sha256: string;
  report: EvaluationReport;
  report_sha256: string;
  results: CaseResult[];
  gate: { passed: boolean; reasons: string[]; baseline_report_sha256: string | null };
};

function grounded(text: string | null, fixture: EvaluationCase): boolean {
  if (fixture.expectedSummary === null) return true;
  if (text === null) return false;
  try {
    const output = JSON.parse(text) as { citations?: unknown };
    // Exact coverage: invented, omitted, duplicated or stale-hash sources fail. A scorer must not just
    // ask whether the word "citation" appeared, nor let one valid citation hide an invented one.
    return hash(output.citations) === hash(fixture.permittedCitations);
  } catch {
    return false;
  }
}

function summaryMatches(text: string | null, fixture: EvaluationCase): boolean {
  if (fixture.expectedSummary === null) return true;
  try {
    return (JSON.parse(text ?? '') as { summary?: unknown }).summary === fixture.expectedSummary;
  } catch {
    return false;
  }
}

const comparableIdentity = (identity: ExperimentIdentity) => {
  // An upgrade may change model responses. Everything the comparison measures must stay pinned.
  const {
    scripted_responses_sha256: _responses,
    model_deployment: _model,
    baseline_report_sha256: _baseline,
    ...pinned
  } = identity;
  return pinned;
};

export async function evaluateScripted(input: {
  spec: AgentSpecV1;
  policyVersion: string;
  cases: readonly EvaluationCase[];
  baseline?: EvaluationArtifact;
  budgetMicros?: number;
}): Promise<EvaluationArtifact> {
  const spec = agentSpecV1Schema.parse(input.spec);
  if (spec.evaluation.suite_ref !== SUITE_REF) throw new Error('EVAL_SUITE_MISMATCH');
  if (input.cases.length === 0) throw new Error('EVAL_EMPTY_SUITE');
  if (new Set(input.cases.map((item) => item.id)).size !== input.cases.length) {
    throw new Error('EVAL_DUPLICATE_CASE');
  }
  const budgetMicros = input.budgetMicros ?? usdToMicros(spec.execution.max_cost_usd);
  if (!Number.isSafeInteger(budgetMicros) || budgetMicros < 0)
    throw new Error('EVAL_INVALID_BUDGET');
  const experiment: ExperimentIdentity = {
    task_fixture_version: DATASET_VERSION,
    fixture_sha256: hash(input.cases.map(({ script: _script, ...fixture }) => fixture)),
    agent_version: `${spec.id}@${spec.version}`,
    skill_version: 'none-m4',
    prompt_sha256: hash({ policy: PROMPT, instructions: spec.instructions }),
    model_deployment: 'ScriptedModelAdapter/v1',
    scripted_responses_sha256: hash(input.cases.map(({ id, script }) => ({ id, script }))),
    policy_version: input.policyVersion,
    policy_matrix_sha256: hash(EGRESS_MATRIX_SOURCE),
    spend_budget_micros: budgetMicros,
    baseline_report_sha256: input.baseline?.report_sha256 ?? null,
    context_compiler_version: 'explicit-fixture-assembly-v1',
    source_corpus_revision: SOURCE_SHA256,
    test_runner_version: 'ensemus-scripted-eval-1',
    scorer_definition: 'exact-summary-and-permitted-citation-sha256-v1',
  };
  const results: CaseResult[] = [];
  for (const fixture of input.cases) {
    const world = scriptedGateway({
      script: fixture.script,
      bundle: { version: input.policyVersion },
    });
    const turn = compiled({
      messages: [
        message({ role: 'policy', partId: 'fixed-policy', text: spec.instructions }),
        message({ text: fixture.prompt }),
        message({ role: 'evidence', partId: `artifact:${SOURCE_ID}`, text: SOURCE_TEXT }),
      ],
      task: task({ classification: fixture.classification }),
      responseSchema: briefSchema,
    });
    const output = await world.run(turn);
    const checks = {
      expected_outcome: output.outcome === fixture.expectedOutcome,
      exact_summary: summaryMatches(output.text, fixture),
      grounded_citations: grounded(output.text, fixture),
      no_credential_or_adapter_on_denial:
        !fixture.expectNoCredentialOrAdapter ||
        (world.credentials.asked.length === 0 && world.adapter.hits === 0),
      no_transaction_across_model_call: !world.adapter.sawOpenTransaction,
    };
    results.push({
      id: fixture.id,
      critical: fixture.critical,
      passed: Object.values(checks).every(Boolean),
      checks,
      outcome: output.outcome,
      decision_code: output.decisionCode,
      adapter_calls: world.adapter.hits,
      credential_leases: world.credentials.asked.length,
      cost_micros: output.usage.costMicros,
    });
  }
  const passRate = results.filter((item) => item.passed).length / results.length;
  const reasons: string[] = [];
  if (results.some((item) => item.critical && !item.passed)) reasons.push('CRITICAL_CASE_FAILED');
  if (results.some((item) => !item.checks.grounded_citations)) reasons.push('GROUNDING_FAILED');
  if (passRate < spec.evaluation.min_pass_rate) reasons.push('PASS_RATE_BELOW_REQUIRED');
  if (results.reduce((sum, item) => sum + item.cost_micros, 0) > budgetMicros) {
    reasons.push('SPEND_BUDGET_EXCEEDED');
  }
  if (input.baseline) {
    const baseline = input.baseline;
    if (
      !baseline.report.passed ||
      baseline.report_sha256 !== hash(baseline.report) ||
      baseline.experiment_sha256 !== hash(baseline.experiment) ||
      baseline.report.model_label !== `scripted:${baseline.experiment_sha256}` ||
      baseline.report.spec_sha256 !== agentSpecSha256(spec) ||
      hash(comparableIdentity(baseline.experiment)) !== hash(comparableIdentity(experiment))
    ) {
      reasons.push('BASELINE_NOT_COMPARABLE');
    } else if (passRate < baseline.report.pass_rate) {
      reasons.push('BASELINE_REGRESSION');
    }
  }
  const experimentSha256 = hash(experiment);
  const report = evaluationReportSchema.parse({
    report_version: 1,
    spec_sha256: agentSpecSha256(spec),
    policy_version: input.policyVersion,
    suite_ref: spec.evaluation.suite_ref,
    dataset_version: DATASET_VERSION,
    // The strict publication schema has no experiment field. The label binds the complete companion
    // identity cryptographically without changing the runtime contract or inventing accepted fields.
    model_label: `scripted:${experimentSha256}`,
    pass_rate: passRate,
    cases: results.length,
    passed: reasons.length === 0,
    scripted_model: true,
  });
  return {
    artifact_version: 1,
    limitation: LIMITATION,
    experiment,
    experiment_sha256: experimentSha256,
    report,
    report_sha256: hash(report),
    results,
    gate: {
      passed: report.passed,
      reasons,
      baseline_report_sha256: input.baseline?.report_sha256 ?? null,
    },
  };
}
