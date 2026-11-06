// AGENT-16 / MODEL-06. No provider or quality claim: every response is an explicit script.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { preparePublication } from '@ensemus/application/ai-agents';
import { evaluationReportSchema } from '@ensemus/contracts/ai';
import { canonicalJson } from '@ensemus/domain/approval';
import { NO_POLICY_AGENT_LIMITS } from '@ensemus/policy/agent-spec-lint';
import {
  assuranceSpec,
  brief,
  FABRICATED_SOURCE_ID,
  SOURCE_SHA256,
  syntheticCases,
} from '../../evaluations/agents/fixtures';
import { evaluateScripted, LIMITATION } from '../../evaluations/agents/harness';

const policyVersion = 'synthetic-policy-1';
const evaluate = (overrides: Partial<Parameters<typeof evaluateScripted>[0]> = {}) =>
  evaluateScripted({ spec: assuranceSpec, policyVersion, cases: syntheticCases(), ...overrides });
const publish = (report: unknown, spec = assuranceSpec) =>
  preparePublication(
    { spec, evaluationReport: report, policyVersion },
    NO_POLICY_AGENT_LIMITS,
    policyVersion,
  );

describe('versioned scripted evaluation', () => {
  it('runs real gateway composition and produces a publishable strict-schema report', async () => {
    const artifact = await evaluate();
    expect(evaluationReportSchema.parse(artifact.report)).toEqual(artifact.report);
    expect(artifact.report).toMatchObject({
      scripted_model: true,
      passed: true,
      cases: 4,
      pass_rate: 1,
    });
    expect(artifact.limitation).toBe(LIMITATION);
    expect(artifact.results.map((item) => item.adapter_calls)).toEqual([1, 1, 1, 0]);
    expect(artifact.results.map((item) => item.credential_leases)).toEqual([1, 1, 1, 0]);
    expect(artifact.results.every((item) => item.checks.no_transaction_across_model_call)).toBe(
      true,
    );
    expect(publish(artifact.report).reportSha256).toBe(artifact.report_sha256);
    expect(artifact.experiment_sha256).toBe(
      createHash('sha256').update(canonicalJson(artifact.experiment)).digest('hex'),
    );
    expect(artifact.report.model_label).toBe(`scripted:${artifact.experiment_sha256}`);
  });

  it('is reproducible with the same inputs and binds every required experiment dimension', async () => {
    const first = await evaluate();
    expect(await evaluate()).toEqual(first);
    expect(Object.keys(first.experiment).sort()).toEqual(
      [
        'task_fixture_version',
        'fixture_sha256',
        'agent_version',
        'skill_version',
        'prompt_sha256',
        'model_deployment',
        'scripted_responses_sha256',
        'policy_version',
        'policy_matrix_sha256',
        'spend_budget_micros',
        'baseline_report_sha256',
        'context_compiler_version',
        'source_corpus_revision',
        'test_runner_version',
        'scorer_definition',
      ].sort(),
    );
    const spec = {
      ...assuranceSpec,
      instructions: 'A changed instruction requires a fresh evaluation.',
    };
    expect(() => publish(first.report, spec)).toThrow(
      expect.objectContaining({ code: 'AGENT_EVALUATION_REQUIRED' }),
    );
    const changed = await evaluate({ spec });
    expect(changed.report.spec_sha256).not.toBe(first.report.spec_sha256);
    expect(changed.experiment_sha256).not.toBe(first.experiment_sha256);
    expect(() => publish({ ...first.report, policy_version: 'stale' })).toThrow(
      expect.objectContaining({ code: 'AGENT_EVALUATION_REQUIRED' }),
    );
  });

  it('control: deliberately wrong fixture fails rather than silently passing the suite', async () => {
    const cases = syntheticCases();
    cases[0] = { ...cases[0]!, expectedSummary: 'The deliberately wrong expected answer.' };
    const artifact = await evaluate({
      cases,
      spec: { ...assuranceSpec, evaluation: { ...assuranceSpec.evaluation, min_pass_rate: 1 } },
    });
    expect(artifact.results[0]?.checks.exact_summary).toBe(false);
    expect(artifact.report.pass_rate).toBe(0.75);
    expect(artifact.gate.reasons).toContain('PASS_RATE_BELOW_REQUIRED');
    expect(artifact.report.passed).toBe(false);
    expect(() => publish(artifact.report)).toThrow(
      expect.objectContaining({ code: 'AGENT_EVALUATION_REQUIRED' }),
    );
  });

  it('blocks a worse score than the accepted baseline even above the manifest threshold', async () => {
    const baseline = await evaluate();
    const cases = syntheticCases();
    cases[0] = { ...cases[0]!, script: [{ kind: 'final', text: brief('Budget is 999 units.') }] };
    const withoutBaseline = await evaluate({ cases });
    expect(withoutBaseline.report.pass_rate).toBe(0.75);
    expect(withoutBaseline.report.passed).toBe(true);
    const regressed = await evaluate({ cases, baseline });
    expect(regressed.gate.reasons).toEqual(['BASELINE_REGRESSION']);
    expect(regressed.report.passed).toBe(false);
    expect(regressed.gate.baseline_report_sha256).toBe(baseline.report_sha256);
    expect(() => publish(regressed.report)).toThrow(
      expect.objectContaining({ code: 'AGENT_EVALUATION_REQUIRED' }),
    );
  });

  it.each(['invented-source', 'stale-source-hash', 'missing-source', 'extra-invented-source'])(
    'fails grounding for %s independently of the pass-rate threshold',
    async (variant) => {
      const citations =
        variant === 'missing-source'
          ? []
          : variant === 'extra-invented-source'
            ? [
                { source_id: '00000000-0000-4000-8000-00000000000a', sha256: SOURCE_SHA256 },
                { source_id: FABRICATED_SOURCE_ID, sha256: SOURCE_SHA256 },
              ]
            : [
                {
                  source_id:
                    variant === 'invented-source'
                      ? FABRICATED_SOURCE_ID
                      : '00000000-0000-4000-8000-00000000000a',
                  sha256: variant === 'stale-source-hash' ? '0'.repeat(64) : SOURCE_SHA256,
                },
              ];
      const cases = syntheticCases();
      cases[0] = {
        ...cases[0]!,
        script: [{ kind: 'final', text: brief('Budget is 120 units.', citations) }],
      };
      const artifact = await evaluate({ cases });
      expect(artifact.results[0]?.checks.grounded_citations).toBe(false);
      expect(artifact.gate.reasons).toContain('GROUNDING_FAILED');
      expect(artifact.report.passed).toBe(false);
      expect(() => publish(artifact.report)).toThrow(
        expect.objectContaining({ code: 'AGENT_EVALUATION_REQUIRED' }),
      );
    },
  );

  it('refuses an incompatible or modified baseline', async () => {
    const baseline = await evaluate();
    const tampered = structuredClone(baseline);
    tampered.report.pass_rate = 0.01;
    expect((await evaluate({ baseline: tampered })).gate.reasons).toContain(
      'BASELINE_NOT_COMPARABLE',
    );
    expect(
      (await evaluate({ baseline, policyVersion: 'a-different-policy' })).gate.reasons,
    ).toContain('BASELINE_NOT_COMPARABLE');
  });

  it('blocks spend beyond the named synthetic budget', async () => {
    const artifact = await evaluate({ budgetMicros: 0 });
    expect(artifact.gate.reasons).toContain('SPEND_BUDGET_EXCEEDED');
    expect(artifact.report.passed).toBe(false);
  });

  it('a critical contract failure blocks even when the aggregate threshold is met', async () => {
    const cases = syntheticCases();
    cases[2] = { ...cases[2]!, script: [{ kind: 'final', text: brief('Budget is 120 units.') }] };
    const artifact = await evaluate({ cases });
    expect(artifact.report.pass_rate).toBe(0.75);
    expect(artifact.gate.reasons).toContain('CRITICAL_CASE_FAILED');
    expect(artifact.report.passed).toBe(false);
  });

  it('refuses empty, duplicate or wrong-suite datasets', async () => {
    await expect(evaluate({ cases: [] })).rejects.toThrow('EVAL_EMPTY_SUITE');
    await expect(evaluate({ cases: [syntheticCases()[0]!, syntheticCases()[0]!] })).rejects.toThrow(
      'EVAL_DUPLICATE_CASE',
    );
    await expect(
      evaluate({
        spec: { ...assuranceSpec, evaluation: { suite_ref: 'other', min_pass_rate: 1 } },
      }),
    ).rejects.toThrow('EVAL_SUITE_MISMATCH');
  });
});
