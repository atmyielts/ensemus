// AGENT-01, threat SEC-007. What a manifest may ask for is decided here, before it can become an immutable
// version. These are pure, so every refusal below runs without a database.
import { TOOL_IDS } from '@ensemus/domain/ai-tools';
import { describe, expect, it } from 'vitest';
import {
  agentLimitsFromPolicyDocument,
  lintAgentSpec,
  NO_POLICY_AGENT_LIMITS,
  type OrgAgentLimits,
  type SpecLintCode,
} from './agent-spec-lint';

const LIMITS: OrgAgentLimits = {
  maxDelegationDepth: 1,
  maxModelTurns: 10,
  maxToolCalls: 10,
  maxTotalTokens: 10_000,
  maxCostMicros: 2_000_000,
  timeoutSeconds: 120,
};

type Execution = Record<string, unknown>;

function spec(
  overrides: { allow?: unknown; deny?: unknown; execution?: Execution; skills?: unknown } = {},
) {
  return {
    tools: {
      allow: overrides.allow ?? ['work.read', 'artifact.read_text'],
      ...('deny' in overrides ? { deny: overrides.deny } : {}),
    },
    execution: {
      max_model_turns: 5,
      max_tool_calls: 5,
      max_total_tokens: 5_000,
      max_cost_usd: '1',
      timeout_seconds: 60,
      max_delegation_depth: 0,
      ...overrides.execution,
    },
    ...('skills' in overrides ? { skills: overrides.skills } : {}),
  };
}

const codesOf = (value: unknown, limits: OrgAgentLimits = LIMITS): readonly SpecLintCode[] => {
  const result = lintAgentSpec(value, limits);
  return result.ok ? [] : result.codes;
};

describe('lintAgentSpec', () => {
  it('passes a spec that asks only for known tools within the limits', () => {
    expect(lintAgentSpec(spec(), LIMITS)).toEqual({ ok: true });
  });

  it('passes every tool in the code-defined list, and a spec exactly at each limit', () => {
    const atTheLimit = spec({
      allow: [...TOOL_IDS],
      execution: {
        max_model_turns: LIMITS.maxModelTurns,
        max_tool_calls: LIMITS.maxToolCalls,
        max_total_tokens: LIMITS.maxTotalTokens,
        max_cost_usd: '2',
        timeout_seconds: LIMITS.timeoutSeconds,
        max_delegation_depth: LIMITS.maxDelegationDepth,
      },
    });
    expect(lintAgentSpec(atTheLimit, LIMITS)).toEqual({ ok: true });
  });

  describe('tools', () => {
    it('refuses a tool nobody has defined', () => {
      expect(codesOf(spec({ allow: ['work.read', 'web.search'] }))).toEqual(['UNKNOWN_TOOL']);
    });

    it.each(['secrets.read', 'secrets.list', 'model.switch', 'budget.raise', 'policy.set'])(
      'refuses %s, which no manifest may ever allow',
      (tool) => {
        expect(codesOf(spec({ allow: [tool] }))).toEqual(['FORBIDDEN_TOOL']);
      },
    );

    it('refuses the same names in another case, so a capital letter is no way round the list', () => {
      expect(codesOf(spec({ allow: ['SECRETS.read'] }))).toEqual(['FORBIDDEN_TOOL']);
    });

    it('is not fooled by the names every object answers to', () => {
      expect(codesOf(spec({ allow: ['constructor', '__proto__'] }))).toEqual(['UNKNOWN_TOOL']);
    });

    it('refuses a tool both allowed and denied, rather than guessing which was meant', () => {
      expect(codesOf(spec({ allow: ['work.read'], deny: ['work.read'] }))).toEqual([
        'TOOL_BOTH_ALLOWED_AND_DENIED',
      ]);
    });

    it('lets a manifest deny anything, because denying asks for nothing', () => {
      expect(
        lintAgentSpec(
          spec({ allow: ['work.read'], deny: ['secrets.read', 'not.defined'] }),
          LIMITS,
        ),
      ).toEqual({ ok: true });
    });

    it('reports every kind of fault at once, each code once', () => {
      expect(
        codesOf(
          spec({
            allow: ['secrets.read', 'secrets.list', 'web.search', 'work.read'],
            deny: ['work.read'],
            execution: { max_model_turns: 11, max_tool_calls: 11 },
            skills: ['a-skill'],
          }),
        ),
      ).toEqual([
        'FORBIDDEN_TOOL',
        'UNKNOWN_TOOL',
        'TOOL_BOTH_ALLOWED_AND_DENIED',
        'SKILLS_NOT_SUPPORTED',
        'LIMIT_ABOVE_POLICY',
      ]);
    });
  });

  describe('limits', () => {
    it.each([
      ['max_model_turns', 11],
      ['max_tool_calls', 11],
      ['max_total_tokens', 10_001],
      ['max_cost_usd', '2.000001'],
      ['timeout_seconds', 121],
      ['max_delegation_depth', 2],
    ])('refuses %s above the organization limit', (field, value) => {
      expect(codesOf(spec({ execution: { [field]: value } }))).toEqual(['LIMIT_ABOVE_POLICY']);
    });

    it('fails closed if a limit it was given is not a number', () => {
      expect(codesOf(spec(), { ...LIMITS, maxModelTurns: Number.NaN })).toEqual([
        'LIMIT_ABOVE_POLICY',
      ]);
    });

    it('with no policy, refuses any delegation', () => {
      expect(
        codesOf(spec({ execution: { max_delegation_depth: 1 } }), NO_POLICY_AGENT_LIMITS),
      ).toEqual(['LIMIT_ABOVE_POLICY']);
      expect(lintAgentSpec(spec(), NO_POLICY_AGENT_LIMITS)).toEqual({ ok: true });
    });

    it('with no policy, still refuses what the spec itself cannot hold', () => {
      expect(
        codesOf(spec({ execution: { max_model_turns: 101 } }), NO_POLICY_AGENT_LIMITS),
      ).toEqual(['LIMIT_ABOVE_POLICY']);
      expect(codesOf(spec({ execution: { max_tool_calls: 501 } }), NO_POLICY_AGENT_LIMITS)).toEqual(
        ['LIMIT_ABOVE_POLICY'],
      );
    });

    it('with no policy, refuses a timeout that could never start a run', () => {
      expect(
        codesOf(spec({ execution: { timeout_seconds: 2 ** 31 } }), NO_POLICY_AGENT_LIMITS),
      ).toEqual(['LIMIT_ABOVE_POLICY']);
    });

    it('with no policy, takes the largest amount the spec can write', () => {
      expect(
        lintAgentSpec(
          spec({ execution: { max_cost_usd: '999999999.999999' } }),
          NO_POLICY_AGENT_LIMITS,
        ),
      ).toEqual({ ok: true });
    });
  });

  describe('skills', () => {
    it('refuses them in M4', () => {
      expect(codesOf(spec({ skills: ['a-skill'] }))).toEqual(['SKILLS_NOT_SUPPORTED']);
    });

    it('accepts an empty list', () => {
      expect(lintAgentSpec(spec({ skills: [] }), LIMITS)).toEqual({ ok: true });
    });

    it('does not take a skills field it cannot read to mean there are none', () => {
      expect(codesOf(spec({ skills: 'a-skill' }))).toEqual(['NOT_LINTED']);
    });
  });

  describe('what it cannot read, it refuses', () => {
    it.each<[string, unknown]>([
      ['nothing', undefined],
      ['null', null],
      ['a string', 'spec'],
      ['a list', []],
      ['no tools or limits', {}],
      ['tools that are not a list', spec({ allow: 'work.read' })],
      ['a tool that is not a name', spec({ allow: [1] })],
      ['a denied tool that is not a name', spec({ deny: [1] })],
      ['a limit that is text', spec({ execution: { max_model_turns: '5' } })],
      ['a limit that is not finite', spec({ execution: { max_tool_calls: Number.NaN } })],
      ['a negative limit', spec({ execution: { max_tool_calls: -1 } })],
      ['a fractional limit', spec({ execution: { max_tool_calls: 1.5 } })],
      ['a cost given as a number', spec({ execution: { max_cost_usd: 1 } })],
      ['a cost in an unknown format', spec({ execution: { max_cost_usd: '1e3' } })],
      ['a cost finer than a micro', spec({ execution: { max_cost_usd: '0.0000001' } })],
    ])('%s', (_label, value) => {
      expect(codesOf(value)).toContain('NOT_LINTED');
    });
  });
});

describe('agentLimitsFromPolicyDocument', () => {
  const document = (limits: unknown) => ({ organization_policy: { agent_limits: limits } });

  it('reads the limits in a policy document', () => {
    expect(
      agentLimitsFromPolicyDocument(
        document({
          max_delegation_depth: 2,
          max_model_turns: 20,
          max_tool_calls: 30,
          max_total_tokens: 40_000,
          max_cost_usd: '1.5',
          timeout_seconds: 300,
        }),
      ),
    ).toEqual({
      maxDelegationDepth: 2,
      maxModelTurns: 20,
      maxToolCalls: 30,
      maxTotalTokens: 40_000,
      maxCostMicros: 1_500_000,
      timeoutSeconds: 300,
    });
  });

  it('ignores the policy fields that are not agent limits', () => {
    expect(
      agentLimitsFromPolicyDocument(
        document({ max_concurrent_runs_per_org: 15, tool_actions_recheck_policy: true }),
      ),
    ).toEqual(NO_POLICY_AGENT_LIMITS);
  });

  it('gives what no limit names the spec range, and delegation nothing at all', () => {
    expect(agentLimitsFromPolicyDocument({})).toEqual(NO_POLICY_AGENT_LIMITS);
    expect(agentLimitsFromPolicyDocument({ organization_policy: {} })).toEqual(
      NO_POLICY_AGENT_LIMITS,
    );
    expect(agentLimitsFromPolicyDocument(document({ max_model_turns: 3 }))).toEqual({
      ...NO_POLICY_AGENT_LIMITS,
      maxModelTurns: 3,
    });
    expect(NO_POLICY_AGENT_LIMITS.maxDelegationDepth).toBe(0);
  });

  it('cannot loosen the range the spec has: a policy can only tighten it', () => {
    const limits = agentLimitsFromPolicyDocument(
      document({ max_model_turns: 1_000, max_tool_calls: 1_000, max_delegation_depth: 50 }),
    );
    expect(limits?.maxModelTurns).toBe(100);
    expect(limits?.maxToolCalls).toBe(500);
    expect(limits?.maxDelegationDepth).toBe(5);
  });

  it.each<[string, unknown]>([
    ['nothing', undefined],
    ['null', null],
    ['a list', []],
    ['a policy that is not an object', { organization_policy: 'open' }],
    ['limits that are not an object', document('none')],
    ['a limit that is text', document({ max_model_turns: '5' })],
    ['a negative limit', document({ max_delegation_depth: -1 })],
    ['a fractional limit', document({ max_tool_calls: 1.5 })],
    ['a cost given as a number', document({ max_cost_usd: 5 })],
    ['a cost in an unknown format', document({ max_cost_usd: 'lots' })],
  ])('reads %s as unreadable, so nothing is published against it', (_label, value) => {
    expect(agentLimitsFromPolicyDocument(value)).toBeNull();
  });
});
