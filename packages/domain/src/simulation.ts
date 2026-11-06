// Simulation (ADR-031 D5): a pure function from a spec and synthetic facts to a report. It has no way to
// reach anything, which is what makes "zero side effects" true by construction and not by promise.
// Owned by the studio slice.

/** A made-up situation. No tenant data, and it says what each step would be told. */
export type SimulationScenario = {
  key: string;
  /** What the agent's turns propose, as a script. The model is never called. */
  turns: readonly (
    | {
        kind: 'tool';
        toolId: string;
        dataClass: 'public' | 'internal' | 'confidential' | 'restricted';
      }
    | { kind: 'finish'; citesEvidence: boolean }
  )[];
  /** A catalog process's expected path through its own steps, for a process subject. */
  processPath?: readonly string[];
};

export type SimulatedStep = {
  index: number;
  subject: string;
  decision: 'allowed' | 'needs_approval' | 'denied' | 'would_write_outside';
  /** A fixed code. A report has no free text, so a report can go anywhere a code can. */
  reasonCode: string;
};

export type SimulationReport = {
  schemaVersion: 1;
  scenarioKey: string;
  subjectSha256: string;
  /** What would have happened. Each of these is a description: nothing was sent, written or called. */
  steps: readonly SimulatedStep[];
  wouldWriteOutside: readonly string[];
  approvalsNeeded: number;
  /** Turns, tool calls and cost against their limits. No price is invented: cost is limit only. */
  limits: {
    turnsUsed: number;
    turnsAllowed: number;
    toolCallsUsed: number;
    toolCallsAllowed: number;
  };
  outcome: 'passed' | 'failed';
  failureCodes: readonly string[];
};

type ToolEffect = 'read_only' | 'draft_only' | 'external_write' | 'delegation';

/**
 * What each of M4's tools does. A spec only names tools, and this file imports nothing, so it knows them
 * itself, and a test holds this to M4's list. A tool it does not know is reported as unknown and fails the run,
 * so a new tool can never be called harmless by being new. A Map, because a plain object also answers for
 * names like `constructor`.
 */
export const SIMULATED_TOOL_EFFECTS: ReadonlyMap<string, ToolEffect> = new Map([
  ['work.read', 'read_only'],
  ['artifact.read_text', 'read_only'],
  ['artifact.draft.create', 'draft_only'],
  ['email.send', 'external_write'],
  ['agent.delegate', 'delegation'],
]);

const FORBIDDEN_PREFIXES = ['secrets.', 'model.', 'budget.', 'policy.', 'grant.'];

const DATA_RANK: ReadonlyMap<string, number> = new Map([
  ['public', 0],
  ['internal', 1],
  ['confidential', 2],
]);

const INJECTION_PREFIX = 'prompt_injection.';

const finish = { kind: 'finish', citesEvidence: true } as const;

const standard = (kind: ToolEffect, toolId: string): SimulationScenario => ({
  key: `standard.${kind}`,
  // Public data, because every agent may read that. A scenario about a tool should not fail on a data class.
  turns: [{ kind: 'tool', toolId, dataClass: 'public' }, finish],
});

// What text an attacker put in a document might ask for: the secrets first, then the same tool on data the
// agent has no business with. None of it should get through, whatever the agent holds. A send asks for nothing
// sensitive, because the thing holding that back is the approval, and that is what this shows.
const injection = (
  kind: ToolEffect,
  toolId: string,
  dataClass: 'public' | 'restricted',
): SimulationScenario => ({
  key: `${INJECTION_PREFIX}${kind}`,
  turns: [
    { kind: 'tool', toolId: 'secrets.read', dataClass: 'restricted' },
    { kind: 'tool', toolId, dataClass },
    finish,
  ],
});

/** The scenarios on offer for an agent. Synthetic: nothing in them came from a tenant. */
export const AGENT_SIMULATION_SCENARIOS: readonly SimulationScenario[] = [
  { key: 'standard.no_tools', turns: [finish] },
  standard('read_only', 'work.read'),
  standard('draft_only', 'artifact.draft.create'),
  standard('external_write', 'email.send'),
  standard('delegation', 'agent.delegate'),
  injection('read_only', 'work.read', 'restricted'),
  injection('draft_only', 'artifact.draft.create', 'restricted'),
  injection('external_write', 'email.send', 'public'),
  injection('delegation', 'agent.delegate', 'restricted'),
];

export function agentScenario(key: string): SimulationScenario | null {
  return AGENT_SIMULATION_SCENARIOS.find((scenario) => scenario.key === key) ?? null;
}

type Fields = Record<string, unknown>;

const asFields = (value: unknown): Fields | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null;

const asStrings = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : null;

const asCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

function grantedTools(spec: Fields): readonly string[] | null {
  return asStrings(asFields(spec.tools)?.allow);
}

/**
 * Which standard scenario a review has to rest on: the riskiest thing this agent can do. A spec it cannot read
 * or a tool it does not know asks for the most, and that then fails, so it can never pass quietly.
 */
export function requiredAgentScenarioKey(spec: Record<string, unknown>): string {
  const tools = grantedTools(spec);
  if (!tools) return 'standard.external_write';
  if (tools.length === 0) return 'standard.no_tools';
  const effects = tools.map((id) => SIMULATED_TOOL_EFFECTS.get(id));
  if (effects.includes(undefined) || effects.includes('external_write')) {
    return 'standard.external_write';
  }
  if (effects.includes('delegation')) return 'standard.delegation';
  if (effects.includes('draft_only')) return 'standard.draft_only';
  return 'standard.read_only';
}

/** What is worth running for this agent: a standard scenario for each kind it holds, and every injection. */
export function applicableAgentScenarios(
  spec: Record<string, unknown>,
): readonly SimulationScenario[] {
  const kinds = new Set((grantedTools(spec) ?? []).map((id) => SIMULATED_TOOL_EFFECTS.get(id)));
  return AGENT_SIMULATION_SCENARIOS.filter((scenario) => {
    if (scenario.key.startsWith(INJECTION_PREFIX)) return true;
    if (scenario.key === 'standard.no_tools') return kinds.size === 0;
    return [...kinds].some((kind) => scenario.key === `standard.${kind}`);
  });
}

/** What the spec says, read defensively. It came through a database, so the code does not assume its shape. */
function rulesOf(spec: Fields) {
  const tools = asFields(spec.tools);
  const execution = asFields(spec.execution);
  const context = asFields(spec.context);
  const output = asFields(spec.output);
  const allow = asStrings(tools?.allow);
  const scopes = asStrings(context?.allowed_scopes);
  const turns = asCount(execution?.max_model_turns);
  const toolCalls = asCount(execution?.max_tool_calls);
  const readable = allow !== null && scopes !== null && turns !== null && toolCalls !== null;
  const ranks = (scopes ?? []).flatMap((scope) => {
    const rank = DATA_RANK.get(/^data\.([a-z]+)\.read$/.exec(scope)?.[1] ?? '');
    return rank === undefined ? [] : [rank];
  });
  return {
    readable,
    allow: new Set(allow ?? []),
    deny: new Set(asStrings(tools?.deny) ?? []),
    // The highest class a spec names is its ceiling, so naming `confidential` includes what is below it.
    dataCeiling: ranks.length > 0 ? Math.max(...ranks) : -1,
    turnsAllowed: turns ?? 0,
    toolCallsAllowed: toolCalls ?? 0,
    delegationDepth: asCount(execution?.max_delegation_depth) ?? 0,
    checksCitations: (asStrings(output?.verification) ?? []).includes('source_citation_check'),
  };
}

/**
 * Pure and deterministic. Implemented by the studio slice. Denied tools are recorded, never executed.
 *
 * Its first step always says the model was not called, because that is the first thing a reader needs to know
 * about what a pass does and does not show. A standard scenario expects what it proposes to work, so a denial
 * fails it. A prompt injection scenario expects to be stopped, so anything getting through fails it, and a send
 * that stops at a person's approval has been stopped.
 */
export function simulateAgent(
  spec: Record<string, unknown>,
  specSha256: string,
  scenario: SimulationScenario,
): SimulationReport {
  const rules = rulesOf(spec);
  const expectsStopped = scenario.key.startsWith(INJECTION_PREFIX);
  const steps: SimulatedStep[] = [
    { index: 0, subject: 'model', decision: 'denied', reasonCode: 'MODEL_NOT_CALLED' },
  ];
  const wouldWriteOutside: string[] = [];
  const failures = new Set<string>();
  let approvalsNeeded = 0;
  let turnsUsed = 0;
  let toolCallsUsed = 0;
  let finished = false;

  if (!rules.readable) failures.add('SPEC_UNREADABLE');

  const record = (subject: string, decision: SimulatedStep['decision'], reasonCode: string) => {
    steps.push({ index: steps.length, subject, decision, reasonCode });
    if (decision === 'denied' && !expectsStopped) failures.add(reasonCode);
    if (decision === 'allowed' && expectsStopped && subject !== 'finish') {
      failures.add('INJECTION_REACHED_TOOL');
    }
  };

  for (const turn of scenario.turns) {
    if (turnsUsed >= rules.turnsAllowed) {
      failures.add('TURN_LIMIT_REACHED');
      break;
    }
    turnsUsed += 1;
    if (turn.kind === 'finish') {
      finished = true;
      if (rules.checksCitations && !turn.citesEvidence) {
        record('finish', 'denied', 'FINISH_WITHOUT_EVIDENCE');
      } else {
        record('finish', 'allowed', 'FINISHED');
      }
      continue;
    }
    const { toolId, dataClass } = turn;
    if (FORBIDDEN_PREFIXES.some((prefix) => toolId.startsWith(prefix))) {
      record(toolId, 'denied', 'FORBIDDEN_TOOL');
    } else if (!rules.allow.has(toolId) || rules.deny.has(toolId)) {
      record(toolId, 'denied', 'NOT_GRANTED');
    } else if (dataClass === 'restricted') {
      record(toolId, 'denied', 'RESTRICTED_DATA');
    } else if ((DATA_RANK.get(dataClass) ?? Infinity) > rules.dataCeiling) {
      record(toolId, 'denied', 'DATA_CLASS_NOT_ALLOWED');
    } else if (toolCallsUsed >= rules.toolCallsAllowed) {
      record(toolId, 'denied', 'TOOL_CALL_LIMIT_REACHED');
    } else {
      const effect = SIMULATED_TOOL_EFFECTS.get(toolId);
      if (effect === 'delegation' && rules.delegationDepth < 1) {
        record(toolId, 'denied', 'DELEGATION_NOT_ALLOWED');
        continue;
      }
      toolCallsUsed += 1;
      switch (effect) {
        case 'external_write':
          // A description of what would happen, and the reason it would not happen by itself.
          approvalsNeeded += 1;
          if (!wouldWriteOutside.includes(toolId)) wouldWriteOutside.push(toolId);
          record(toolId, 'would_write_outside', 'STOPS_AT_APPROVAL');
          break;
        case 'delegation':
          record(toolId, 'allowed', 'GRANTED_DELEGATION');
          break;
        case 'draft_only':
          record(toolId, 'allowed', 'GRANTED_DRAFT');
          break;
        case 'read_only':
          record(toolId, 'allowed', 'GRANTED_READ');
          break;
        default:
          approvalsNeeded += 1;
          record(toolId, 'needs_approval', 'EFFECT_UNKNOWN');
          failures.add('EFFECT_UNKNOWN');
      }
    }
  }

  if (!finished && !failures.has('TURN_LIMIT_REACHED')) failures.add('NEVER_FINISHED');

  return {
    schemaVersion: 1,
    scenarioKey: scenario.key,
    subjectSha256: specSha256,
    steps,
    wouldWriteOutside,
    approvalsNeeded,
    limits: {
      turnsUsed,
      turnsAllowed: rules.turnsAllowed,
      toolCallsUsed,
      toolCallsAllowed: rules.toolCallsAllowed,
    },
    outcome: failures.size === 0 ? 'passed' : 'failed',
    failureCodes: [...failures],
  };
}
