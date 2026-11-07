// T0 for the simulator (ADR-031 D5, QA-033, QA-034). It imports nothing and reaches nothing, and these hold what
// it says about a spec. `MANIFESTS` is a copy of M4's TOOL_MANIFESTS from `git show
// m4-foundation:packages/domain/src/ai-tools.ts`, which the final merge swaps for the real one.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileBoundSpec, type AgentDraftAnswers } from './agent-draft';
import {
  AGENT_SIMULATION_SCENARIOS,
  agentScenario,
  applicableAgentScenarios,
  requiredAgentScenarioKey,
  SIMULATED_TOOL_EFFECTS,
  simulateAgent,
  type SimulationScenario,
} from './simulation';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const HASH = 'c'.repeat(64);

const MANIFESTS = [
  { id: 'work.read', class: 'read_only' },
  { id: 'artifact.read_text', class: 'read_only' },
  { id: 'artifact.draft.create', class: 'draft_only' },
  { id: 'email.send', class: 'external_write' },
  { id: 'agent.delegate', class: 'delegation' },
] as const;

const answers = (overrides: Partial<AgentDraftAnswers> = {}): AgentDraftAnswers => ({
  role: 'Prepares short briefs.',
  intendedOutcome: 'A one page brief with citations.',
  boundaries: [],
  knowledgeSourceIds: [],
  toolIds: ['work.read', 'artifact.draft.create'],
  triggerKind: 'manual',
  maxCostMicros: 1_000_000,
  maxTurns: 10,
  maxToolCalls: 10,
  maxTotalTokens: 100_000,
  timeoutSeconds: 180,
  qualityTier: 'balanced',
  autonomy: 'draft_for_review',
  memoryWrite: 'none',
  outputFormat: 'markdown_brief',
  dataClasses: ['internal'],
  ownerMembershipId: '00000000-0000-4000-8000-000000000001',
  ...overrides,
});

const specOf = (overrides: Partial<AgentDraftAnswers> = {}) =>
  compileBoundSpec(answers(overrides), { name: 'Test agent', version: 1 }, sha256).spec;

const emailer = () => specOf({ toolIds: ['email.send'], autonomy: 'act_with_approval' });

const tool = (
  toolId: string,
  dataClass: 'public' | 'internal' | 'confidential' | 'restricted' = 'public',
) => ({ kind: 'tool' as const, toolId, dataClass });
const finish = { kind: 'finish' as const, citesEvidence: true };

const toolSteps = (report: ReturnType<typeof simulateAgent>) =>
  report.steps.filter((step) => step.subject !== 'model' && step.subject !== 'finish');

describe('simulateAgent', () => {
  it('says on the face of the report that the model was not called', () => {
    const report = simulateAgent(specOf(), HASH, agentScenario('standard.read_only')!);
    expect(report.steps[0]).toEqual({
      index: 0,
      subject: 'model',
      decision: 'denied',
      reasonCode: 'MODEL_NOT_CALLED',
    });
  });

  it('passes a read and a finish on an agent that holds the tool', () => {
    const report = simulateAgent(specOf(), HASH, agentScenario('standard.read_only')!);
    expect(report).toMatchObject({
      schemaVersion: 1,
      scenarioKey: 'standard.read_only',
      subjectSha256: HASH,
      wouldWriteOutside: [],
      approvalsNeeded: 0,
      outcome: 'passed',
      failureCodes: [],
      limits: { turnsUsed: 2, turnsAllowed: 10, toolCallsUsed: 1, toolCallsAllowed: 10 },
    });
    expect(toolSteps(report)).toEqual([
      { index: 1, subject: 'work.read', decision: 'allowed', reasonCode: 'GRANTED_READ' },
    ]);
  });

  it('records email.send as would write outside, needing an approval, and passes', () => {
    const report = simulateAgent(emailer(), HASH, agentScenario('standard.external_write')!);
    expect(toolSteps(report)).toEqual([
      {
        index: 1,
        subject: 'email.send',
        decision: 'would_write_outside',
        reasonCode: 'STOPS_AT_APPROVAL',
      },
    ]);
    expect(report.wouldWriteOutside).toEqual(['email.send']);
    expect(report.approvalsNeeded).toBe(1);
    expect(report.outcome).toBe('passed');
  });

  it('denies an ungranted tool, and that fails a scenario that expected it to work', () => {
    const report = simulateAgent(specOf(), HASH, agentScenario('standard.external_write')!);
    expect(toolSteps(report)[0]).toMatchObject({ decision: 'denied', reasonCode: 'NOT_GRANTED' });
    expect(report.outcome).toBe('failed');
    expect(report.failureCodes).toEqual(['NOT_GRANTED']);
    expect(report.wouldWriteOutside).toEqual([]);
  });

  it('denies an ungranted tool in a scenario that expected that, and passes', () => {
    const report = simulateAgent(specOf(), HASH, agentScenario('prompt_injection.external_write')!);
    expect(toolSteps(report).map((step) => step.decision)).toEqual(['denied', 'denied']);
    expect(report.outcome).toBe('passed');
  });

  it('denies any secrets tool, whatever a spec says', () => {
    const report = simulateAgent(
      { ...specOf(), tools: { allow: ['secrets.read', 'work.read'] } },
      HASH,
      { key: 'standard.custom', turns: [tool('secrets.read'), finish] },
    );
    expect(toolSteps(report)[0]).toMatchObject({
      decision: 'denied',
      reasonCode: 'FORBIDDEN_TOOL',
    });
    expect(report.outcome).toBe('failed');
  });

  it('denies a tool a spec denies', () => {
    const report = simulateAgent(
      { ...specOf(), tools: { allow: ['work.read'], deny: ['work.read'] } },
      HASH,
      { key: 'standard.custom', turns: [tool('work.read')] },
    );
    expect(toolSteps(report)[0]).toMatchObject({ decision: 'denied', reasonCode: 'NOT_GRANTED' });
  });

  it.each([
    ['restricted', 'restricted', ['confidential'], 'RESTRICTED_DATA'],
    ['above what it may read', 'confidential', ['internal'], 'DATA_CLASS_NOT_ALLOWED'],
  ] as const)('denies data that is %s', (_name, dataClass, dataClasses, reasonCode) => {
    const report = simulateAgent(specOf({ dataClasses: [...dataClasses] }), HASH, {
      key: 'standard.custom',
      turns: [tool('work.read', dataClass), finish],
    });
    expect(toolSteps(report)[0]).toMatchObject({ decision: 'denied', reasonCode });
    expect(report.outcome).toBe('failed');
  });

  it('allows data at or below the highest class named', () => {
    const report = simulateAgent(specOf({ dataClasses: ['confidential'] }), HASH, {
      key: 'standard.custom',
      turns: [tool('work.read', 'internal'), tool('work.read', 'confidential'), finish],
    });
    expect(report.outcome).toBe('passed');
  });

  it('stops at the turn limit and says so', () => {
    const scenario: SimulationScenario = {
      key: 'standard.long',
      turns: [tool('work.read'), tool('work.read'), tool('work.read'), finish],
    };
    const report = simulateAgent(specOf({ maxTurns: 2 }), HASH, scenario);
    expect(report.limits.turnsUsed).toBe(2);
    expect(report.failureCodes).toEqual(['TURN_LIMIT_REACHED']);
    expect(report.outcome).toBe('failed');
  });

  it('denies tool calls past the limit', () => {
    const report = simulateAgent(specOf({ maxToolCalls: 1 }), HASH, {
      key: 'standard.calls',
      turns: [tool('work.read'), tool('work.read'), finish],
    });
    expect(toolSteps(report).map((step) => step.reasonCode)).toEqual([
      'GRANTED_READ',
      'TOOL_CALL_LIMIT_REACHED',
    ]);
    expect(report.limits.toolCallsUsed).toBe(1);
    expect(report.outcome).toBe('failed');
  });

  it('allows a delegation on a spec with depth, and denies one without', () => {
    const allowed = simulateAgent(
      specOf({ toolIds: ['agent.delegate'] }),
      HASH,
      agentScenario('standard.delegation')!,
    );
    expect(toolSteps(allowed)[0]).toMatchObject({
      decision: 'allowed',
      reasonCode: 'GRANTED_DELEGATION',
    });
    const spec = specOf({ toolIds: ['agent.delegate'] });
    const flat = {
      ...spec,
      execution: { ...(spec.execution as object), max_delegation_depth: 0 },
    };
    const denied = simulateAgent(flat, HASH, agentScenario('standard.delegation')!);
    expect(toolSteps(denied)[0]).toMatchObject({
      decision: 'denied',
      reasonCode: 'DELEGATION_NOT_ALLOWED',
    });
  });

  it('fails closed on a granted tool it cannot describe, rather than calling it harmless', () => {
    const report = simulateAgent({ ...specOf(), tools: { allow: ['brand.new_tool'] } }, HASH, {
      key: 'standard.custom',
      turns: [tool('brand.new_tool'), finish],
    });
    expect(toolSteps(report)[0]).toMatchObject({
      decision: 'needs_approval',
      reasonCode: 'EFFECT_UNKNOWN',
    });
    expect(report.approvalsNeeded).toBe(1);
    expect(report.outcome).toBe('failed');
    expect(report.failureCodes).toEqual(['EFFECT_UNKNOWN']);
  });

  it('fails a finish with no evidence when the spec checks citations', () => {
    const report = simulateAgent(specOf(), HASH, {
      key: 'standard.custom',
      turns: [{ kind: 'finish', citesEvidence: false }],
    });
    expect(report.failureCodes).toEqual(['FINISH_WITHOUT_EVIDENCE']);
  });

  it('fails a scenario that never finishes', () => {
    const report = simulateAgent(specOf(), HASH, {
      key: 'standard.custom',
      turns: [tool('work.read')],
    });
    expect(report.failureCodes).toEqual(['NEVER_FINISHED']);
  });

  it('fails an injection that reached a tool', () => {
    const report = simulateAgent(specOf(), HASH, {
      key: 'prompt_injection.custom',
      turns: [tool('work.read', 'public')],
    });
    expect(report.outcome).toBe('failed');
    expect(report.failureCodes).toEqual(['INJECTION_REACHED_TOOL']);
  });

  it('reports a fully refused injection as held without inventing a normal finish', () => {
    const report = simulateAgent(specOf(), HASH, {
      key: 'prompt_injection.custom',
      turns: [tool('secrets.read', 'restricted')],
    });
    expect(report.outcome).toBe('passed');
    expect(report.failureCodes).toEqual([]);
    expect(report.steps.some((step) => step.subject === 'finish')).toBe(false);
    expect(toolSteps(report)).toMatchObject([
      { subject: 'secrets.read', decision: 'denied', reasonCode: 'FORBIDDEN_TOOL' },
    ]);
  });

  it('counts an injection stopped at an approval as held', () => {
    const report = simulateAgent(
      emailer(),
      HASH,
      agentScenario('prompt_injection.external_write')!,
    );
    expect(report.outcome).toBe('passed');
    expect(report.wouldWriteOutside).toEqual(['email.send']);
    expect(report.approvalsNeeded).toBe(1);
  });

  it.each([
    ['nothing', {}],
    ['no tools', { execution: { max_model_turns: 3 } }],
    ['no limits', { tools: { allow: ['work.read'] } }],
    ['text for a list', { tools: { allow: 'work.read' }, context: { allowed_scopes: 'all' } }],
    ['nulls', { tools: null, execution: null, context: null }],
  ])('fails closed on a spec with %s', (_name, spec) => {
    const report = simulateAgent(spec, HASH, agentScenario('standard.read_only')!);
    expect(report.outcome).toBe('failed');
    expect(report.failureCodes).toContain('SPEC_UNREADABLE');
    expect(toolSteps(report).every((step) => step.decision === 'denied')).toBe(true);
  });

  it('is deterministic', () => {
    for (const scenario of AGENT_SIMULATION_SCENARIOS) {
      expect(simulateAgent(emailer(), HASH, scenario)).toEqual(
        simulateAgent(emailer(), HASH, scenario),
      );
    }
  });

  it('holds no free text from the answers in any report', () => {
    const canary = 'CANARY-c0a1';
    const spec = compileBoundSpec(
      answers({
        role: `Role ${canary}`,
        intendedOutcome: `Outcome ${canary} long enough`,
        boundaries: [`Boundary ${canary}`],
        toolIds: ['work.read', 'artifact.draft.create', 'email.send', 'agent.delegate'],
        autonomy: 'act_with_approval',
      }),
      { name: `Name ${canary}`, version: 1 },
      sha256,
    ).spec;
    for (const scenario of AGENT_SIMULATION_SCENARIOS) {
      expect(JSON.stringify(simulateAgent(spec, HASH, scenario))).not.toContain(canary);
    }
  });
});

describe('the shipped scenarios', () => {
  it('has a standard and a prompt injection scenario for each tool kind', () => {
    const keys = AGENT_SIMULATION_SCENARIOS.map((scenario) => scenario.key);
    for (const kind of ['read_only', 'draft_only', 'external_write', 'delegation']) {
      expect(keys).toContain(`standard.${kind}`);
      expect(keys).toContain(`prompt_injection.${kind}`);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses keys the contract accepts', () => {
    for (const { key } of AGENT_SIMULATION_SCENARIOS) {
      expect(key).toMatch(/^[a-z][a-z0-9_.-]{1,63}$/);
    }
  });

  it('answers nothing for an unknown key, including an object method name', () => {
    expect(agentScenario('made.up')).toBeNull();
    expect(agentScenario('__proto__')).toBeNull();
    expect(agentScenario('constructor')).toBeNull();
  });

  it('passes on an agent that holds the tool, for every standard scenario', () => {
    const toolFor: Record<string, string> = {
      'standard.read_only': 'work.read',
      'standard.draft_only': 'artifact.draft.create',
      'standard.external_write': 'email.send',
      'standard.delegation': 'agent.delegate',
    };
    for (const [key, toolId] of Object.entries(toolFor)) {
      const report = simulateAgent(
        specOf({ toolIds: [toolId], autonomy: 'act_with_approval', dataClasses: ['public'] }),
        HASH,
        agentScenario(key)!,
      );
      expect(report.outcome, key).toBe('passed');
    }
  });

  it('holds on every prompt injection scenario, for an agent that holds everything', () => {
    const spec = specOf({
      toolIds: ['work.read', 'artifact.draft.create', 'email.send', 'agent.delegate'],
      autonomy: 'act_with_approval',
      dataClasses: ['confidential'],
    });
    for (const scenario of AGENT_SIMULATION_SCENARIOS) {
      if (!scenario.key.startsWith('prompt_injection.')) continue;
      expect(simulateAgent(spec, HASH, scenario).outcome, scenario.key).toBe('passed');
    }
  });
});

describe('which scenario a review needs', () => {
  it.each([
    [[], 'standard.no_tools'],
    [['work.read'], 'standard.read_only'],
    [['work.read', 'artifact.draft.create'], 'standard.draft_only'],
    [['work.read', 'agent.delegate'], 'standard.delegation'],
    [['agent.delegate', 'email.send', 'work.read'], 'standard.external_write'],
    [['brand.new_tool'], 'standard.external_write'],
  ])('%j needs %s', (toolIds, key) => {
    expect(requiredAgentScenarioKey({ tools: { allow: toolIds } })).toBe(key);
  });

  it('asks for the most it can of a spec it cannot read', () => {
    expect(requiredAgentScenarioKey({})).toBe('standard.external_write');
  });

  it('offers only the standard scenarios for what the agent holds, and every injection', () => {
    const keys = applicableAgentScenarios(specOf({ toolIds: ['work.read'] })).map((s) => s.key);
    expect(keys).toContain('standard.read_only');
    expect(keys).not.toContain('standard.external_write');
    expect(keys).toContain('prompt_injection.external_write');
  });
});

describe('the simulator itself', () => {
  it('knows M4 tool list as M4 does', () => {
    expect(Object.fromEntries(SIMULATED_TOOL_EFFECTS)).toEqual(
      Object.fromEntries(MANIFESTS.map((manifest) => [manifest.id, manifest.class])),
    );
  });

  it('imports nothing, so it cannot reach anything', () => {
    const source = readFileSync(fileURLToPath(new URL('./simulation.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(|\bimport\(|\bfetch\(/);
  });
});
