// AGENT-01, AGENT-16, threat SEC-007. The publish gate's decisions, with no database: every refusal here
// happens before a row could be written. tests/integration/ai-agents.test.ts tries the same gate as the
// real roles, along with what only SQL can show.
import { createHash, sign } from 'node:crypto';
import type { AgentSpecV1, EvaluationReportV2 } from '@ensemus/contracts/ai';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { canonicalJson } from '@ensemus/domain/approval';
import { NO_POLICY_AGENT_LIMITS } from '@ensemus/policy/agent-spec-lint';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors';
import {
  agentSpecSha256,
  AgentSpecRefused,
  DEFAULT_AGENT_POLICY_VERSION,
  getAgentPolicyVersion,
  getAgentVersion,
  isPublishGateRefusal,
  listAgentRegistry,
  listAgentVersions,
  preparePublication,
  publishAgentVersion,
} from './agents';
import { EVALUATION_SIGNATURE_CONTEXT, NO_EVALUATION_TRUST } from './evaluation-attestation';
import {
  generatedSigner,
  reportV2,
  signedReport,
  TEST_SIGNER,
  TEST_TRUST,
  trustFor,
} from './evaluation-attestation.test-support';

function testSpec(overrides: Partial<AgentSpecV1> = {}): AgentSpecV1 {
  return {
    api_version: 'ensemus.ai/v1',
    id: 'work-brief',
    version: 1,
    objective: 'Read the work and draft a short brief for its owner.',
    instructions: 'Use only what the work and its files say. Cite each claim.',
    model: {
      required_capabilities: ['text', 'tools'],
      quality_tier: 'balanced',
      fallback: 'disabled',
    },
    context: { allowed_scopes: ['work.read'], memory_write_policy: 'none' },
    tools: { allow: ['work.read', 'artifact.read_text'], deny: [] },
    execution: {
      max_model_turns: 5,
      max_tool_calls: 5,
      max_total_tokens: 10_000,
      max_cost_usd: '1.25',
      timeout_seconds: 60,
      max_delegation_depth: 0,
    },
    output: { schema_ref: 'schemas/work-brief.schema.json', verification: ['schema_check'] },
    evaluation: { suite_ref: 'evaluations/agents/work-brief', min_pass_rate: 0.9 },
    ...overrides,
  };
}

const POLICY = 'policy-7';

/** The report an evaluator would sign for this spec: consistent, recent, from a model and not a script. */
const unsignedFor = (spec: unknown, overrides: Partial<EvaluationReportV2> = {}) =>
  reportV2(agentSpecSha256(spec), POLICY, overrides);
const reportFor = (spec: unknown, overrides: Partial<EvaluationReportV2> = {}) =>
  signedReport(unsignedFor(spec, overrides));

/** Cases that agree with each other and with the totals, so only the field a test names is wrong. */
function results(passed: readonly boolean[], critical = false) {
  const caseResults = passed.map((ok, index) => ({
    id: `case-${index}`,
    critical,
    passed: ok,
    cost_micros: 1,
    latency_ms: 1,
    model: null,
  }));
  return {
    case_results: caseResults,
    cases: passed.length,
    pass_rate: passed.filter(Boolean).length / passed.length,
    cost_micros: passed.length,
    latency_ms: passed.length,
  };
}

const NOW = new Date();
const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

const prepare = (
  spec: unknown,
  evaluationReport: unknown,
  policyVersion = POLICY,
  check = { trust: TEST_TRUST, now: NOW },
) =>
  preparePublication(
    { spec, evaluationReport, policyVersion },
    NO_POLICY_AGENT_LIMITS,
    POLICY,
    check,
  );

/** Runs a refused call and hands back what it threw, so a test can say which refusal it was. */
function refusalOf(attempt: () => unknown): AppError {
  try {
    attempt();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('It was not refused');
}

const lintCodesOf = (attempt: () => unknown) => {
  const refusal = refusalOf(attempt);
  if (!(refusal instanceof AgentSpecRefused)) throw new Error(`Refused as ${refusal.code}`);
  return refusal.lintCodes;
};

describe('preparePublication', () => {
  it('passes a good spec with a signed report bound to it, and records the report it signed', () => {
    const spec = testSpec();
    const report = reportFor(spec);
    const prepared = prepare(spec, report);
    expect(prepared.spec).toEqual(spec);
    expect(prepared.specSha256).toBe(
      createHash('sha256').update(canonicalJson(spec)).digest('hex'),
    );
    expect(prepared.reportSha256).toBe(
      createHash('sha256').update(canonicalJson(report.report)).digest('hex'),
    );
  });

  it('parses the cost once, to exact micros', () => {
    expect(prepare(testSpec(), reportFor(testSpec())).maxCostMicros).toBe(1_250_000);
  });

  it('gives the same hash whatever order the keys arrive in', () => {
    const spec = testSpec();
    const reordered = Object.fromEntries(Object.entries(spec).reverse());
    expect(agentSpecSha256(reordered)).toBe(agentSpecSha256(spec));
  });

  describe('the spec', () => {
    it.each<[string, unknown]>([
      ['nothing', undefined],
      ['null', null],
      ['a field nobody defined', { ...testSpec(), grants_everything: true }],
      ['a missing field', { ...testSpec(), instructions: undefined }],
      ['another API version', { ...testSpec(), api_version: 'ensemus.ai/v2' }],
      [
        'a turn limit past its range',
        {
          ...testSpec(),
          execution: { ...testSpec().execution, max_model_turns: 101 },
        },
      ],
      [
        'a cost as a number',
        {
          ...testSpec(),
          execution: { ...testSpec().execution, max_cost_usd: 1 },
        },
      ],
      ['a sandbox flag set to false', { ...testSpec(), sandbox: false }],
      [
        'memory a model could mark as verified',
        {
          ...testSpec(),
          context: { allowed_scopes: [], memory_write_policy: 'verified_by_policy' },
        },
      ],
    ])('refuses %s', (_label, spec) => {
      expect(refusalOf(() => prepare(spec, reportFor(testSpec()))).code).toBe('AGENT_SPEC_INVALID');
    });

    it('names the fields at fault and never what they held', () => {
      const secret = 'value-a-person-pasted-in-by-mistake';
      const refusal = refusalOf(() =>
        prepare({ ...testSpec(), api_version: secret }, reportFor(testSpec())),
      );
      expect(refusal).toBeInstanceOf(AgentSpecRefused);
      expect((refusal as AgentSpecRefused).fields).toEqual(['api_version']);
      expect(JSON.stringify(refusal)).not.toContain(secret);
      expect(refusal.message).not.toContain(secret);
    });

    it('refuses skills, and says that is why', () => {
      const spec = { ...testSpec(), skills: ['a-skill'] };
      expect(lintCodesOf(() => prepare(spec, reportFor(spec)))).toEqual(['SKILLS_NOT_SUPPORTED']);
    });

    it('refuses an unknown tool in allow', () => {
      const spec = testSpec({ tools: { allow: ['web.search'] } });
      expect(lintCodesOf(() => prepare(spec, reportFor(spec)))).toEqual(['UNKNOWN_TOOL']);
    });

    it('refuses secrets.*, even with a passing report for exactly this spec', () => {
      const spec = testSpec({ tools: { allow: ['secrets.read'] } });
      expect(lintCodesOf(() => prepare(spec, reportFor(spec)))).toEqual(['FORBIDDEN_TOOL']);
    });

    it('refuses limits above organization policy', () => {
      const spec = testSpec();
      const attempt = () =>
        preparePublication(
          { spec, evaluationReport: reportFor(spec), policyVersion: POLICY },
          { ...NO_POLICY_AGENT_LIMITS, maxModelTurns: 4 },
          POLICY,
          { trust: TEST_TRUST, now: NOW },
        );
      expect(lintCodesOf(attempt)).toEqual(['LIMIT_ABOVE_POLICY']);
    });

    it('refuses delegation when no policy allows it', () => {
      const spec = testSpec({ execution: { ...testSpec().execution, max_delegation_depth: 1 } });
      expect(lintCodesOf(() => prepare(spec, reportFor(spec)))).toEqual(['LIMIT_ABOVE_POLICY']);
    });

    it('checks the spec first, so a refused one never reaches its report', () => {
      expect(refusalOf(() => prepare({}, undefined)).code).toBe('AGENT_SPEC_INVALID');
    });
  });

  describe('the evaluation report', () => {
    const spec = testSpec();
    const refusedAs = (report: unknown, check?: Parameters<typeof prepare>[3]) =>
      refusalOf(() => prepare(spec, report, POLICY, check)).code;

    describe('is refused when it does not bind to this spec and policy, or did not pass', () => {
      it.each<[string, unknown]>([
        ['a failing report', reportFor(spec, { passed: false })],
        ['a report for another spec', reportFor(testSpec({ version: 2 }))],
        ['a stale report, from an older policy', reportFor(spec, { policy_version: 'policy-6' })],
        ['a report for another suite', reportFor(spec, { suite_ref: 'evaluations/agents/other' })],
        [
          'a pass rate under what the spec requires',
          reportFor(spec, results([true, true, true, true, true, true, true, true, false, false])),
        ],
      ])('%s', (_label, report) => {
        expect(refusedAs(report)).toBe('AGENT_EVALUATION_REQUIRED');
      });

      it('accepts a pass rate exactly at what the spec requires', () => {
        const nine = [true, true, true, true, true, true, true, true, true, false];
        expect(prepare(spec, reportFor(spec, results(nine))).specSha256).toBeTruthy();
      });

      it('refuses a caller who names an older policy, even with a report that matches it', () => {
        const old = reportFor(spec, { policy_version: 'policy-6' });
        expect(refusalOf(() => prepare(spec, old, 'policy-6')).code).toBe(
          'AGENT_EVALUATION_REQUIRED',
        );
      });

      it('binds to the spec as parsed, so changing one tool voids the report', () => {
        const report = reportFor(spec);
        const wider = testSpec({
          tools: { allow: [...spec.tools.allow, 'email.send'], deny: [] },
        });
        expect(refusalOf(() => prepare(wider, report)).code).toBe('AGENT_EVALUATION_REQUIRED');
      });
    });

    describe('is refused when no trusted evaluator signed it', () => {
      const good = reportFor(spec);
      const tampered = (change: Partial<EvaluationReportV2>) => ({
        ...good,
        report: { ...good.report, ...change },
      });

      it.each<[string, unknown]>([
        ['no report', undefined],
        ['null', null],
        ['not a report', { passed: true }],
        [
          'the old unsigned format, however well it binds',
          {
            report_version: 1,
            spec_sha256: agentSpecSha256(spec),
            policy_version: POLICY,
            suite_ref: spec.evaluation.suite_ref,
            dataset_version: 'synthetic-1',
            model_label: 'typed-by-hand',
            pass_rate: 1,
            cases: 3,
            passed: true,
            scripted_model: false,
          },
        ],
        ['a report with no signature', unsignedFor(spec)],
        ['a report whose signature was taken off', { ...good, signature: undefined }],
        ['a field nobody defined', { ...good, approved_by: 'someone' }],
        [
          'a signature of the wrong length',
          { ...good, signature: { ...good.signature, value: 'abc' } },
        ],
        ['another algorithm', { ...good, signature: { ...good.signature, algorithm: 'rsa' } }],
        [
          'a key id this deployment never named',
          { ...good, signature: { ...good.signature, key_id: 'other' } },
        ],
        ['a pass rate changed after signing', tampered({ ...results([true, false]) })],
        ['a failing report flipped to passing', tampered({ passed: false })],
        ['a model report relabelled as scripted', tampered({ scripted_model: true })],
        ['a spec hash swapped after signing', tampered({ spec_sha256: '0'.repeat(64) })],
        ['a newer date put on an old report', tampered({ issued_at: at(1000) })],
        ['an empty report', tampered({ cases: 0, case_results: [] })],
        ['a hash that is not a hash', tampered({ spec_sha256: 'abc' })],
      ])('%s', (_label, report) => {
        expect(refusedAs(report)).toBe('AGENT_EVALUATION_UNVERIFIED');
      });

      it('refuses a report signed by a key with the trusted id but not the trusted key', () => {
        const impostor = generatedSigner(TEST_SIGNER.keyId);
        expect(refusedAs(signedReport(unsignedFor(spec), impostor))).toBe(
          'AGENT_EVALUATION_UNVERIFIED',
        );
      });

      it('refuses every report when the deployment names no key', () => {
        expect(refusedAs(good, { trust: NO_EVALUATION_TRUST, now: NOW })).toBe(
          'AGENT_EVALUATION_UNVERIFIED',
        );
      });

      it.each<[string, Partial<EvaluationReportV2>]>([
        ['more cases claimed than reported', { cases: 3 }],
        ['a cost total that is not the sum of its cases', { cost_micros: 1 }],
        ['a latency total that is not the sum of its cases', { latency_ms: 1 }],
        ['a pass rate its cases do not give', { pass_rate: 0.5 }],
        [
          'the same case twice',
          {
            case_results: [good.report.case_results[0]!, good.report.case_results[0]!],
            cost_micros: 20,
            latency_ms: 10,
          },
        ],
        ['a pass with a critical case failed', { ...results([true, false], true), passed: true }],
      ])('refuses %s, even under a genuine signature', (_label, change) => {
        // Signed by hand with the trusted key, past the harness's own refusal to sign it.
        const report = { ...unsignedFor(spec), ...change };
        const value = sign(
          null,
          Buffer.from(`${EVALUATION_SIGNATURE_CONTEXT}${canonicalJson(report)}`),
          TEST_SIGNER.privateKey,
        ).toString('base64url');
        const presented = {
          report,
          signature: { algorithm: 'ed25519', key_id: TEST_SIGNER.keyId, value },
        };
        expect(refusedAs(presented)).toBe('AGENT_EVALUATION_UNVERIFIED');
      });

      it('accepts a report from either key while one is being rotated out', () => {
        const next = generatedSigner('next-evaluator');
        const trust = trustFor([TEST_SIGNER, next]);
        for (const signer of [TEST_SIGNER, next]) {
          const presented = signedReport(unsignedFor(spec), signer);
          expect(prepare(spec, presented, POLICY, { trust, now: NOW }).specSha256).toBeTruthy();
        }
      });
    });

    describe('is refused when it is too old to say anything about today', () => {
      it.each<[string, string]>([
        ['issued eight days ago, past the week it may live', at(-8 * 24 * HOUR)],
        ['dated an hour ahead of this clock', at(HOUR)],
      ])('%s', (_label, issuedAt) => {
        expect(refusedAs(reportFor(spec, { issued_at: issuedAt }))).toBe('AGENT_EVALUATION_STALE');
      });

      it('accepts a report a minute ahead, within ordinary clock drift', () => {
        expect(prepare(spec, reportFor(spec, { issued_at: at(60_000) })).specSha256).toBeTruthy();
      });

      it('follows the limit the deployment sets', () => {
        const report = reportFor(spec, { issued_at: at(-2 * HOUR) });
        expect(refusedAs(report, { trust: trustFor([TEST_SIGNER], 1), now: NOW })).toBe(
          'AGENT_EVALUATION_STALE',
        );
        const longer = { trust: trustFor([TEST_SIGNER], 3), now: NOW };
        expect(prepare(spec, report, POLICY, longer).specSha256).toBeTruthy();
      });

      it('checks the signature first, so an unsigned old report is unverified and not stale', () => {
        expect(refusedAs(unsignedFor(spec, { issued_at: at(-30 * 24 * HOUR) }))).toBe(
          'AGENT_EVALUATION_UNVERIFIED',
        );
      });
    });

    describe('from a scripted model', () => {
      const sandbox = { ...testSpec(), sandbox: true as const };

      it('is refused for a production agent, however well it passed', () => {
        expect(refusedAs(reportFor(spec, { scripted_model: true }))).toBe(
          'AGENT_EVALUATION_SCRIPTED',
        );
      });

      it('is accepted for a sandbox agent', () => {
        const prepared = prepare(sandbox, reportFor(sandbox, { scripted_model: true }));
        expect(prepared.spec.sandbox).toBe(true);
      });

      it('does not make a sandbox of an agent that may act outside Ensemus', () => {
        const acting = { ...sandbox, tools: { allow: ['work.read', 'email.send'], deny: [] } };
        const report = reportFor(acting, { scripted_model: true });
        expect(lintCodesOf(() => prepare(acting, report))).toEqual(['SANDBOX_GRANT_TOO_WIDE']);
      });

      it('gives a sandbox spec its own hash, so a production report cannot be reused for it', () => {
        expect(agentSpecSha256(sandbox)).not.toBe(agentSpecSha256(spec));
        expect(refusalOf(() => prepare(sandbox, reportFor(spec))).code).toBe(
          'AGENT_EVALUATION_REQUIRED',
        );
      });
    });
  });
});

describe('isPublishGateRefusal', () => {
  it('is true of what the gate refuses, and false of the rest', () => {
    expect(isPublishGateRefusal(new AgentSpecRefused([]))).toBe(true);
    expect(isPublishGateRefusal(new AppError('AGENT_EVALUATION_REQUIRED'))).toBe(true);
    expect(isPublishGateRefusal(new AppError('AGENT_EVALUATION_UNVERIFIED'))).toBe(true);
    expect(isPublishGateRefusal(new AppError('AGENT_EVALUATION_STALE'))).toBe(true);
    expect(isPublishGateRefusal(new AppError('AGENT_EVALUATION_SCRIPTED'))).toBe(true);
    expect(isPublishGateRefusal(new AppError('POLICY_DENIED'))).toBe(true);
    expect(isPublishGateRefusal(new AppError('FORBIDDEN'))).toBe(false);
    expect(isPublishGateRefusal(new Error('AGENT_SPEC_INVALID'))).toBe(false);
  });
});

describe('who may reach the registry', () => {
  /** Any use of this fails the test: a refusal has to come before the database is touched. */
  const untouched = new Proxy({} as AppDatabase, {
    get() {
      throw new Error('The database was used before the permission check');
    },
  });

  const contextAs = (role: string, actorType: TenantContext['actorType']) =>
    ({
      organizationId: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000002',
      membershipId: '00000000-0000-4000-8000-000000000003',
      role,
      actorType,
    }) as unknown as TenantContext;

  const VERSION_ID = '00000000-0000-4000-8000-000000000004';
  const spec = testSpec();
  const input = {
    spec,
    evaluationReport: reportFor(spec),
    policyVersion: POLICY,
    evaluationTrust: TEST_TRUST,
  };

  const calls: readonly [string, (context: TenantContext) => unknown][] = [
    ['publish', (context) => publishAgentVersion(untouched, context, input)],
    ['list', (context) => listAgentVersions(untouched, context)],
    ['read one', (context) => getAgentVersion(untouched, context, VERSION_ID)],
    ['read the registry', (context) => listAgentRegistry(untouched, context)],
    ['read the policy version', (context) => getAgentPolicyVersion(untouched, context)],
  ];

  for (const [name, call] of calls) {
    it(`a member cannot ${name}`, async () => {
      await expect(call(contextAs('member', 'user'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it(`a worker cannot ${name}`, async () => {
      await expect(call(contextAs('service', 'service'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    // An agent carries its initiator's role, so the role alone would let this one through (FD-3).
    it(`an agent acting for an owner cannot ${name}`, async () => {
      await expect(call(contextAs('owner', 'agent'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  }

  it('an ID that is no ID finds nothing, rather than reaching the database', async () => {
    await expect(
      getAgentVersion(untouched, contextAs('owner', 'user'), 'not-an-id'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the default policy version', () => {
  it('has a name a report can carry', () => {
    expect(DEFAULT_AGENT_POLICY_VERSION.length).toBeGreaterThan(0);
  });
});
