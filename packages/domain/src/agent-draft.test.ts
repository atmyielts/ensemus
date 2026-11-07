// T0 for the guided builder (AGENT-08, ADR-031 D5). `assertAgentSpecV1` below is a field-by-field copy of M4's
// `agentSpecV1Schema` from `git show m4-foundation:packages/contracts/src/ai.ts`, because that module is not on
// this branch. The final merge swaps this copy for the real schema.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  agentSpecId,
  assessDraft,
  bindAgentSpec,
  compileBoundSpec,
  diffAgentSpecs,
  hashAgentSpec,
  microsFromUsdText,
  usdTextFromMicros,
  type AgentDraftAnswers,
  type ToolFacts,
} from './agent-draft';
import { canonicalJson } from './approval';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const OWNER = '00000000-0000-4000-8000-000000000001';

const tools: readonly ToolFacts[] = [
  { id: 'work.read', version: '1', class: 'read_only', requiresApproval: false },
  { id: 'artifact.read_text', version: '1', class: 'read_only', requiresApproval: false },
  { id: 'artifact.draft.create', version: '1', class: 'draft_only', requiresApproval: false },
  { id: 'email.send', version: '1', class: 'external_write', requiresApproval: true },
  { id: 'agent.delegate', version: '1', class: 'delegation', requiresApproval: false },
  // A catalog can never be trusted to leave this out, so assessDraft refuses it by name.
  { id: 'secrets.read', version: '1', class: 'read_only', requiresApproval: false },
];

const limits = { maxTurns: 50, maxToolCalls: 50, timeoutSeconds: 3600 };

const answers = (overrides: Partial<AgentDraftAnswers> = {}): AgentDraftAnswers => ({
  role: 'Prepares short briefs for the people who own a piece of work.',
  intendedOutcome: 'A one page brief with citations.',
  boundaries: ['Only uses what it is given.'],
  knowledgeSourceIds: [],
  toolIds: ['work.read', 'artifact.draft.create'],
  triggerKind: 'manual',
  maxCostMicros: 1_500_000,
  maxTurns: 10,
  maxToolCalls: 10,
  maxTotalTokens: 100_000,
  timeoutSeconds: 180,
  qualityTier: 'balanced',
  autonomy: 'draft_for_review',
  memoryWrite: 'none',
  outputFormat: 'markdown_brief',
  dataClasses: ['internal'],
  ownerMembershipId: OWNER,
  ...overrides,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  expect(Object.keys(value).filter((key) => !allowed.includes(key))).toEqual([]);

const TOOL_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** M4's `agentSpecV1Schema`, strict objects and all, written out by hand. */
function assertAgentSpecV1(spec: Record<string, unknown> | null) {
  expect(isRecord(spec)).toBe(true);
  const value = spec as Record<string, unknown>;
  onlyKeys(value, [
    'api_version',
    'id',
    'version',
    'objective',
    'instructions',
    'model',
    'context',
    'skills',
    'tools',
    'execution',
    'output',
    'evaluation',
  ]);
  expect(value.api_version).toBe('ensemus.ai/v1');
  expect(value.id).toMatch(/^[a-z][a-z0-9-]{2,80}$/);
  expect(Number.isInteger(value.version) && (value.version as number) >= 1).toBe(true);
  expect((value.objective as string).length).toBeGreaterThanOrEqual(10);
  expect((value.objective as string).length).toBeLessThanOrEqual(1000);
  expect((value.instructions as string).length).toBeGreaterThanOrEqual(1);
  expect((value.instructions as string).length).toBeLessThanOrEqual(8000);
  // M4: `skills` is empty, and a guided agent leaves it out.
  expect(value).not.toHaveProperty('skills');

  const model = value.model as Record<string, unknown>;
  onlyKeys(model, ['required_capabilities', 'quality_tier', 'fallback']);
  const capabilities = model.required_capabilities as string[];
  expect(capabilities.length).toBeGreaterThanOrEqual(1);
  for (const capability of capabilities) {
    expect(['text', 'tools', 'structured_output', 'vision', 'long_context']).toContain(capability);
  }
  expect(['economy', 'balanced', 'high']).toContain(model.quality_tier);
  expect(['approved_profiles_only', 'disabled']).toContain(model.fallback);

  const context = value.context as Record<string, unknown>;
  onlyKeys(context, ['allowed_scopes', 'memory_write_policy', 'max_input_tokens']);
  expect(Array.isArray(context.allowed_scopes)).toBe(true);
  expect(['none', 'propose_only']).toContain(context.memory_write_policy);

  const grants = value.tools as Record<string, unknown>;
  onlyKeys(grants, ['allow', 'deny']);
  for (const tool of grants.allow as string[]) expect(tool).toMatch(TOOL_NAME);

  const execution = value.execution as Record<string, number | string>;
  onlyKeys(execution, [
    'max_model_turns',
    'max_tool_calls',
    'max_total_tokens',
    'max_cost_usd',
    'timeout_seconds',
    'max_delegation_depth',
  ]);
  expect(execution.max_model_turns).toBeGreaterThanOrEqual(1);
  expect(execution.max_model_turns).toBeLessThanOrEqual(100);
  expect(execution.max_tool_calls).toBeGreaterThanOrEqual(0);
  expect(execution.max_tool_calls).toBeLessThanOrEqual(500);
  expect(execution.max_total_tokens).toBeGreaterThanOrEqual(1);
  expect(execution.max_cost_usd).toMatch(/^\d{1,9}(\.\d{1,6})?$/);
  expect(execution.timeout_seconds).toBeGreaterThanOrEqual(1);
  expect(execution.max_delegation_depth).toBeGreaterThanOrEqual(0);
  expect(execution.max_delegation_depth).toBeLessThanOrEqual(5);

  const output = value.output as Record<string, unknown>;
  onlyKeys(output, ['schema_ref', 'verification']);
  expect(typeof output.schema_ref).toBe('string');
  expect(Array.isArray(output.verification)).toBe(true);

  const evaluation = value.evaluation as Record<string, unknown>;
  onlyKeys(evaluation, ['suite_ref', 'min_pass_rate']);
  expect(typeof evaluation.suite_ref).toBe('string');
  expect(evaluation.min_pass_rate as number).toBeGreaterThanOrEqual(0);
  expect(evaluation.min_pass_rate as number).toBeLessThanOrEqual(1);
}

const codes = (assessment: ReturnType<typeof assessDraft>) =>
  assessment.issues.map((issue) => issue.code);

describe('assessDraft', () => {
  it('compiles good answers to M4 spec shape, field by field', () => {
    const result = assessDraft(answers(), tools, limits, sha256);
    expect(result.issues).toEqual([]);
    assertAgentSpecV1(result.spec);
    expect(result.specSha256).toMatch(/^[0-9a-f]{64}$/);
    const spec = result.spec as Record<string, Record<string, unknown>>;
    expect(spec.execution?.max_cost_usd).toBe('1.5');
    expect(spec.execution?.max_model_turns).toBe(10);
    expect(spec.execution?.max_delegation_depth).toBe(0);
    expect(spec.model?.required_capabilities).toEqual(['text', 'tools']);
    expect(spec.model?.quality_tier).toBe('balanced');
    expect(spec.context?.memory_write_policy).toBe('none');
    expect(spec.tools?.allow).toEqual(['artifact.draft.create', 'work.read']);
  });

  it('uses only the text model capability for an agent with no tools', () => {
    const { spec } = assessDraft(answers({ toolIds: [] }), tools, limits, sha256);
    expect((spec as { model: { required_capabilities: string[] } }).model).toMatchObject({
      required_capabilities: ['text'],
    });
  });

  it('hashes the canonical spec, with the same bytes the approval hash uses', () => {
    const result = assessDraft(answers(), tools, limits, sha256);
    expect(result.specSha256).toBe(sha256(canonicalJson(result.spec)));
    expect(hashAgentSpec(result.spec as Record<string, unknown>, sha256)).toBe(result.specSha256);
  });

  it('gives the same hash for the same answers in any tool or class order', () => {
    const one = assessDraft(answers(), tools, limits, sha256);
    const two = assessDraft(
      answers({
        toolIds: ['artifact.draft.create', 'work.read'],
        dataClasses: ['internal'],
      }),
      [...tools].reverse(),
      limits,
      sha256,
    );
    expect(two.specSha256).toBe(one.specSha256);
  });

  it('moves the hash on every answer that matters', () => {
    const base = assessDraft(answers(), tools, limits, sha256).specSha256;
    const changes: Partial<AgentDraftAnswers>[] = [
      { role: 'Someone else entirely, doing a different job.' },
      { intendedOutcome: 'A two page brief with citations.' },
      { boundaries: ['A different boundary.'] },
      { toolIds: ['work.read'] },
      { maxCostMicros: 2_000_000 },
      { maxTurns: 11 },
      { maxToolCalls: 11 },
      { maxTotalTokens: 100_001 },
      { timeoutSeconds: 181 },
      { qualityTier: 'high' },
      { autonomy: 'suggest_only' },
      { memoryWrite: 'propose_only' },
      { outputFormat: 'structured_report' },
      { dataClasses: ['public'] },
      { knowledgeSourceIds: ['00000000-0000-4000-8000-0000000000aa'] },
    ];
    for (const change of changes) {
      expect(assessDraft(answers(change), tools, limits, sha256).specSha256, change.role).not.toBe(
        base,
      );
    }
  });

  it('keeps free text in instructions and objective, and nothing else', () => {
    const canary = 'CANARY-7f3a';
    const { spec } = assessDraft(
      answers({
        role: `Role text ${canary}`,
        intendedOutcome: `Outcome text ${canary}`,
        boundaries: [`Boundary ${canary}`],
      }),
      tools,
      limits,
      sha256,
    );
    const { instructions, objective, ...rest } = spec as Record<string, unknown>;
    expect(JSON.stringify(rest)).not.toContain(canary);
    expect(instructions).toContain(`Role text ${canary}`);
    expect(instructions).toContain(`Boundary ${canary}`);
    expect(objective).toBe(`Outcome text ${canary}`);
  });

  describe('refuses and never repairs', () => {
    const refused: [string, Partial<AgentDraftAnswers>, string][] = [
      ['an unknown tool', { toolIds: ['work.read', 'made.up'] }, 'UNKNOWN_TOOL'],
      [
        'any secrets tool, even in the catalog',
        { toolIds: ['secrets.read'] },
        'SECRET_TOOL_REFUSED',
      ],
      [
        'an external write in a draft mode',
        { toolIds: ['email.send'], autonomy: 'draft_for_review' },
        'TOOL_NEEDS_APPROVAL_MODE',
      ],
      [
        'an external write when only suggesting',
        { toolIds: ['email.send'], autonomy: 'suggest_only' },
        'TOOL_NEEDS_APPROVAL_MODE',
      ],
      ['turns above org policy', { maxTurns: 51 }, 'LIMIT_TOO_HIGH'],
      ['tool calls above org policy', { maxToolCalls: 51 }, 'LIMIT_TOO_HIGH'],
      ['a timeout above org policy', { timeoutSeconds: 3601 }, 'LIMIT_TOO_HIGH'],
      ['no budget', { maxCostMicros: null }, 'NO_BUDGET'],
      ['a budget of nothing', { maxCostMicros: 0 }, 'NO_BUDGET'],
      ['no role', { role: '   ' }, 'REQUIRED'],
      ['an outcome too short for the spec', { intendedOutcome: 'short' }, 'REQUIRED'],
      ['no data class', { dataClasses: [] }, 'REQUIRED'],
      ['no owner', { ownerMembershipId: '' }, 'REQUIRED'],
      ['an outcome too long for the spec', { intendedOutcome: 'x'.repeat(1001) }, 'LIMIT_TOO_HIGH'],
    ];

    it.each(refused)('%s', (_name, change, code) => {
      const result = assessDraft(answers(change), tools, limits, sha256);
      expect(codes(result)).toContain(code);
      expect(result.spec).toBeNull();
      expect(result.specSha256).toBeNull();
    });

    it('refuses restricted data, even past the type', () => {
      const result = assessDraft(
        answers({ dataClasses: ['restricted'] as unknown as AgentDraftAnswers['dataClasses'] }),
        tools,
        limits,
        sha256,
      );
      expect(codes(result)).toEqual(['RESTRICTED_NOT_OFFERED']);
      expect(result.specSha256).toBeNull();
    });

    it('refuses M4 own ceilings, whatever an organization allows', () => {
      const generous = { maxTurns: 1000, maxToolCalls: 1000, timeoutSeconds: 86_400 };
      expect(codes(assessDraft(answers({ maxTurns: 101 }), tools, generous, sha256))).toEqual([
        'LIMIT_TOO_HIGH',
      ]);
      expect(codes(assessDraft(answers({ maxToolCalls: 501 }), tools, generous, sha256))).toEqual([
        'LIMIT_TOO_HIGH',
      ]);
    });

    it('does not cap or fix what it refuses', () => {
      const result = assessDraft(answers({ maxTurns: 99 }), tools, limits, sha256);
      expect(result.issues).toEqual([{ path: 'maxTurns', code: 'LIMIT_TOO_HIGH' }]);
    });

    it('points each issue at the answer it is about', () => {
      const result = assessDraft(
        answers({ toolIds: ['work.read', 'made.up', 'secrets.read'] }),
        tools,
        limits,
        sha256,
      );
      expect(result.issues).toEqual([
        { path: 'toolIds.1', code: 'UNKNOWN_TOOL' },
        { path: 'toolIds.2', code: 'SECRET_TOOL_REFUSED' },
      ]);
    });

    it('still tells the reader the risk while there are issues', () => {
      const result = assessDraft(answers({ toolIds: ['email.send'] }), tools, limits, sha256);
      expect(result.spec).toBeNull();
      expect(result.riskLevel).toBe('elevated');
    });
  });

  describe('risk', () => {
    const risk = (change: Partial<AgentDraftAnswers>) =>
      assessDraft(answers(change), tools, limits, sha256);

    it('is standard for read-only and drafting on public or internal data', () => {
      expect(risk({}).riskLevel).toBe('standard');
      expect(risk({ dataClasses: ['public', 'internal'] }).riskLevel).toBe('standard');
    });

    it('is elevated for any external write', () => {
      const result = risk({ toolIds: ['email.send'], autonomy: 'act_with_approval' });
      expect(result.riskLevel).toBe('elevated');
      expect(result.risk).toContainEqual({ code: 'WRITES_OUTSIDE', subject: 'email.send' });
      expect(result.risk).toContainEqual({
        code: 'ACTS_WITH_APPROVAL',
        subject: 'act_with_approval',
      });
    });

    it('is elevated for a delegation tool, and allows one level of delegation for it', () => {
      const result = risk({ toolIds: ['agent.delegate'] });
      expect(result.riskLevel).toBe('elevated');
      expect(result.risk).toContainEqual({ code: 'DELEGATES', subject: 'agent.delegate' });
      expect(
        (result.spec as { execution: { max_delegation_depth: number } }).execution
          .max_delegation_depth,
      ).toBe(1);
    });

    it('is elevated for confidential data', () => {
      const result = risk({ dataClasses: ['internal', 'confidential'] });
      expect(result.riskLevel).toBe('elevated');
      expect(result.risk).toContainEqual({ code: 'READS_CONFIDENTIAL', subject: 'confidential' });
    });

    it('names proposed memory, without raising the level', () => {
      const result = risk({ memoryWrite: 'propose_only' });
      expect(result.riskLevel).toBe('standard');
      expect(result.risk).toEqual([{ code: 'PROPOSES_MEMORY', subject: 'propose_only' }]);
    });
  });
});

describe('agent identity', () => {
  it('slugs a name into M4 id format', () => {
    expect(agentSpecId('Weekly Brief Writer', sha256)).toBe('weekly-brief-writer');
    expect(agentSpecId('  Déjà  vu!! ', sha256)).toBe('deja-vu');
    expect(agentSpecId('9 lives', sha256)).toBe('agent-9-lives');
  });

  it('stays valid for a name with nothing to slug, and keeps two such names apart', () => {
    const one = agentSpecId('مساعد المبيعات', sha256);
    const two = agentSpecId('مساعد الدعم', sha256);
    expect(one).toMatch(/^[a-z][a-z0-9-]{2,80}$/);
    expect(one).not.toBe(two);
  });

  it('stays inside M4 length', () => {
    const id = agentSpecId(`${'a'.repeat(79)} b ${'c'.repeat(200)}`, sha256);
    expect(id).toMatch(/^[a-z][a-z0-9-]{2,80}$/);
    expect(id.endsWith('-')).toBe(false);
  });

  it('binds a name and version into the spec and the hash', () => {
    const assessed = assessDraft(answers(), tools, limits, sha256);
    const bound = bindAgentSpec(assessed, answers(), { name: 'Weekly Brief', version: 3 }, sha256);
    assertAgentSpecV1(bound.spec);
    expect(bound.spec).toMatchObject({ id: 'weekly-brief', version: 3 });
    expect(bound.specSha256).toBe(sha256(canonicalJson(bound.spec)));
    expect(bound.specSha256).not.toBe(assessed.specSha256);
    expect(bound.risk).toEqual(assessed.risk);
  });

  it('binds nothing onto a draft with issues', () => {
    const assessed = assessDraft(answers({ maxCostMicros: null }), tools, limits, sha256);
    const bound = bindAgentSpec(
      assessed,
      answers({ maxCostMicros: null }),
      { name: 'Weekly Brief', version: 3 },
      sha256,
    );
    expect(bound.spec).toBeNull();
    expect(bound.specSha256).toBeNull();
  });

  it('recompiles the same spec from the same row, with no catalog in reach', () => {
    const assessed = assessDraft(answers(), tools, limits, sha256);
    const bound = bindAgentSpec(assessed, answers(), { name: 'Weekly Brief', version: 3 }, sha256);
    const again = compileBoundSpec(answers(), { name: 'Weekly Brief', version: 3 }, sha256);
    expect(again.specSha256).toBe(bound.specSha256);
    expect(again.spec).toEqual(bound.spec);
  });
});

describe('money as decimal text', () => {
  it.each([
    [1, '0.000001'],
    [500_000, '0.5'],
    [1_000_000, '1'],
    [1_500_000, '1.5'],
    [12_345_678, '12.345678'],
    [1_000_000_000_000, '1000000'],
  ])('%d micros is %s', (micros, text) => {
    expect(usdTextFromMicros(micros)).toBe(text);
    expect(usdTextFromMicros(micros)).toMatch(/^\d{1,9}(\.\d{1,6})?$/);
    expect(microsFromUsdText(text)).toBe(micros);
  });

  it.each(['', ' ', 'abc', '-1', '1e3', '1.2345678', '.5', '1.', '1,000', '0x10', '1000000000'])(
    'reads %j as no amount',
    (text) => {
      expect(microsFromUsdText(text)).toBeNull();
    },
  );

  it('trims the spaces a person may type', () => {
    expect(microsFromUsdText(' 2.50 ')).toBe(2_500_000);
  });
});

describe('diffAgentSpecs', () => {
  const spec = (change: Partial<AgentDraftAnswers>) =>
    compileBoundSpec(answers(change), { name: 'Weekly Brief', version: 1 }, sha256).spec;

  it('says nothing changed for the same spec', () => {
    expect(diffAgentSpecs(spec({}), spec({}))).toEqual([]);
  });

  it('names each changed path with both values', () => {
    expect(diffAgentSpecs(spec({}), spec({ maxTurns: 12, qualityTier: 'high' }))).toEqual([
      { path: 'execution.max_model_turns', before: '10', after: '12' },
      { path: 'model.quality_tier', before: '"balanced"', after: '"high"' },
    ]);
  });

  it('shows a tool list changing', () => {
    expect(diffAgentSpecs(spec({}), spec({ toolIds: ['work.read'] }))).toEqual([
      {
        path: 'tools.allow',
        before: '["artifact.draft.create","work.read"]',
        after: '["work.read"]',
      },
    ]);
  });
});
