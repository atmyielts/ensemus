// AGENT-01, AGENT-16, threat SEC-007. The publish gate's decisions, with no database: every refusal here
// happens before a row could be written. tests/integration/ai-agents.test.ts tries the same gate as the
// real roles, along with what only SQL can show.
import { createHash } from 'node:crypto';
import type { AgentSpecV1, EvaluationReport } from '@ensemus/contracts/ai';
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

function reportFor(spec: unknown, overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    report_version: 1,
    spec_sha256: agentSpecSha256(spec),
    policy_version: POLICY,
    suite_ref: 'evaluations/agents/work-brief',
    dataset_version: 'synthetic-1',
    model_label: 'scripted',
    pass_rate: 1,
    cases: 3,
    passed: true,
    scripted_model: true,
    ...overrides,
  };
}

const prepare = (spec: unknown, evaluationReport: unknown, policyVersion = POLICY) =>
  preparePublication({ spec, evaluationReport, policyVersion }, NO_POLICY_AGENT_LIMITS, POLICY);

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
  it('passes a good spec with a report bound to it', () => {
    const spec = testSpec();
    const report = reportFor(spec);
    const prepared = prepare(spec, report);
    expect(prepared.spec).toEqual(spec);
    expect(prepared.specSha256).toBe(
      createHash('sha256').update(canonicalJson(spec)).digest('hex'),
    );
    expect(prepared.reportSha256).toBe(
      createHash('sha256').update(canonicalJson(report)).digest('hex'),
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

    it.each<[string, unknown]>([
      ['no report', undefined],
      ['null', null],
      ['not a report', { passed: true }],
      ['a field nobody defined', { ...reportFor(spec), approved_by: 'someone' }],
      ['a failing report', reportFor(spec, { passed: false })],
      ['a report for another spec', reportFor(testSpec({ version: 2 }))],
      ['a stale report, from an older policy', reportFor(spec, { policy_version: 'policy-6' })],
      ['a report for another suite', reportFor(spec, { suite_ref: 'evaluations/agents/other' })],
      ['a pass rate under what the spec requires', reportFor(spec, { pass_rate: 0.89 })],
      ['an empty report', reportFor(spec, { cases: 0 })],
      ['a pass rate above one', reportFor(spec, { pass_rate: 1.1 })],
      ['a hash that is not a hash', reportFor(spec, { spec_sha256: 'abc' })],
    ])('refuses %s', (_label, report) => {
      expect(refusalOf(() => prepare(spec, report)).code).toBe('AGENT_EVALUATION_REQUIRED');
    });

    it('accepts a pass rate exactly at what the spec requires', () => {
      expect(prepare(spec, reportFor(spec, { pass_rate: 0.9 })).specSha256).toBeTruthy();
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
});

describe('isPublishGateRefusal', () => {
  it('is true of what the gate refuses, and false of the rest', () => {
    expect(isPublishGateRefusal(new AgentSpecRefused([]))).toBe(true);
    expect(isPublishGateRefusal(new AppError('AGENT_EVALUATION_REQUIRED'))).toBe(true);
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
  const input = { spec, evaluationReport: reportFor(spec), policyVersion: POLICY };

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
