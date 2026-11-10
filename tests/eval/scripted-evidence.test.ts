// Explicit evidence writer: normal tests stay read-only. Opt in only when regenerating these synthetic
// artifacts, which contain IDs, digests and codes and never prompts, answers or customer material.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assuranceSpec,
  brief,
  FABRICATED_SOURCE_ID,
  SOURCE_SHA256,
  syntheticCases,
} from '../../evaluations/agents/fixtures';
import { evaluateScripted } from '../../evaluations/agents/harness';

describe('reproducible scripted evidence', () => {
  it('produces a passing baseline and three failing controls from actual executions', async () => {
    const run = (cases = syntheticCases(), overrides = {}) =>
      evaluateScripted({
        spec: assuranceSpec,
        policyVersion: 'synthetic-policy-1',
        cases,
        ...overrides,
      });
    const baseline = await run();
    const wrongFixtures = syntheticCases();
    wrongFixtures[0] = {
      ...wrongFixtures[0]!,
      expectedSummary: 'Deliberately wrong fixture.',
      critical: true,
    };
    const wrong = await run(wrongFixtures);
    const regressionCases = syntheticCases();
    regressionCases[0] = {
      ...regressionCases[0]!,
      script: [{ kind: 'final', text: brief('Budget is 999 units.') }],
    };
    const regression = await run(regressionCases, { baseline });
    const fabricatedCases = syntheticCases();
    fabricatedCases[0] = {
      ...fabricatedCases[0]!,
      script: [
        {
          kind: 'final',
          text: brief('Budget is 120 units.', [
            { source_id: FABRICATED_SOURCE_ID, sha256: SOURCE_SHA256 },
          ]),
        },
      ],
    };
    const grounding = await run(fabricatedCases);
    expect(baseline.report.passed).toBe(true);
    expect(wrong.report.passed).toBe(false);
    expect(regression.gate.reasons).toEqual(['BASELINE_REGRESSION']);
    expect(grounding.gate.reasons).toContain('GROUNDING_FAILED');
    if (process.env.ENSEMUS_WRITE_M4_EVIDENCE === '1') {
      const directory = new URL('../../docs/06-delivery/evidence/m4/', import.meta.url);
      await mkdir(directory, { recursive: true });
      for (const [name, artifact] of Object.entries({
        baseline,
        'wrong-fixture-control': wrong,
        'baseline-regression-control': regression,
        'fabricated-citation-control': grounding,
      })) {
        await writeFile(
          fileURLToPath(new URL(`scripted-${name}.json`, directory)),
          `${JSON.stringify(artifact, null, 2)}\n`,
          'utf8',
        );
      }
    }
  });
});
