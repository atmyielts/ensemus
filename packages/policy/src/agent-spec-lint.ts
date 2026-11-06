// Owned by the agents slice (AGENT-01). Pure rules checked at publish, so a bad grant never becomes an
// immutable version (ADR-028 FD-19, G10). It is here rather than in agent-runtime because the web tier
// runs this, and it may not import agent-runtime.
import { usdToMicros } from '@ensemus/domain/ai';
import { FORBIDDEN_TOOL_PREFIXES, toolManifest } from '@ensemus/domain/ai-tools';

export type OrgAgentLimits = {
  maxDelegationDepth: number;
  maxModelTurns: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  maxCostMicros: number;
  timeoutSeconds: number;
};

export type SpecLintCode =
  | 'UNKNOWN_TOOL'
  | 'FORBIDDEN_TOOL'
  | 'TOOL_BOTH_ALLOWED_AND_DENIED'
  | 'LIMIT_ABOVE_POLICY'
  | 'SKILLS_NOT_SUPPORTED'
  | 'NOT_LINTED';

export type SpecLintResult = { ok: true } | { ok: false; codes: readonly SpecLintCode[] };

/** The largest whole amount `agent_runs.timeout_seconds` holds. A longer one could never start a run. */
const MAX_TIMEOUT_SECONDS = 2_147_483_647;
/** What the spec's own format can write, and what its schema allows for the two it bounds. */
const MAX_SPEC_MODEL_TURNS = 100;
const MAX_SPEC_TOOL_CALLS = 500;
const MAX_SPEC_DELEGATION_DEPTH = 5;
const MAX_SPEC_COST_USD = '999999999.999999';

/**
 * With no active policy document, only the spec's own ranges apply, and nothing may delegate. These are
 * the limits of the format and not choices about how much an agent should spend: a person's budget is
 * what holds spending, and there is no budget by default (ADR-028 open questions 8 and 10).
 */
export const NO_POLICY_AGENT_LIMITS: OrgAgentLimits = {
  maxDelegationDepth: 0,
  maxModelTurns: MAX_SPEC_MODEL_TURNS,
  maxToolCalls: MAX_SPEC_TOOL_CALLS,
  maxTotalTokens: Number.MAX_SAFE_INTEGER,
  maxCostMicros: usdToMicros(MAX_SPEC_COST_USD),
  timeoutSeconds: MAX_TIMEOUT_SECONDS,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function microsOf(usd: unknown): number | null {
  if (typeof usd !== 'string') return null;
  try {
    return usdToMicros(usd);
  } catch {
    return null;
  }
}

function lintTools(tools: unknown, codes: Set<SpecLintCode>) {
  if (!isRecord(tools) || !isStringList(tools.allow)) {
    codes.add('NOT_LINTED');
    return;
  }
  // A denied name asks for nothing, so anything may be denied. Only what is allowed has to exist.
  for (const tool of tools.allow) {
    const name = tool.toLowerCase();
    if (FORBIDDEN_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      codes.add('FORBIDDEN_TOOL');
    } else if (!toolManifest(tool)) {
      codes.add('UNKNOWN_TOOL');
    }
  }
  if (tools.deny === undefined) return;
  if (!isStringList(tools.deny)) {
    codes.add('NOT_LINTED');
    return;
  }
  const denied = new Set(tools.deny);
  if (tools.allow.some((tool) => denied.has(tool))) codes.add('TOOL_BOTH_ALLOWED_AND_DENIED');
}

function lintSkills(skills: unknown, codes: Set<SpecLintCode>) {
  if (skills === undefined) return;
  if (!Array.isArray(skills)) codes.add('NOT_LINTED');
  else if (skills.length > 0) codes.add('SKILLS_NOT_SUPPORTED');
}

/**
 * Written as "not at or under", so a limit that is not a number refuses rather than letting everything
 * through, which is what `value > NaN` would do.
 */
const within = (value: number, limit: number) => value <= limit;

function lintLimits(execution: unknown, limits: OrgAgentLimits, codes: Set<SpecLintCode>) {
  if (!isRecord(execution)) {
    codes.add('NOT_LINTED');
    return;
  }
  const cost = microsOf(execution.max_cost_usd);
  const pairs: readonly [unknown, number][] = [
    [execution.max_model_turns, limits.maxModelTurns],
    [execution.max_tool_calls, limits.maxToolCalls],
    [execution.max_total_tokens, limits.maxTotalTokens],
    [execution.timeout_seconds, limits.timeoutSeconds],
    [execution.max_delegation_depth, limits.maxDelegationDepth],
    [cost, limits.maxCostMicros],
  ];
  for (const [value, limit] of pairs) {
    if (!isCount(value)) codes.add('NOT_LINTED');
    else if (!within(value, limit)) codes.add('LIMIT_ABOVE_POLICY');
  }
}

/**
 * Checks what a manifest asks for. It takes `unknown` because a caller may lint something the schema has
 * not passed, so anything it cannot read is refused with `NOT_LINTED` and never taken to mean "none".
 */
export function lintAgentSpec(spec: unknown, limits: OrgAgentLimits): SpecLintResult {
  if (!isRecord(spec)) return { ok: false, codes: ['NOT_LINTED'] };
  const codes = new Set<SpecLintCode>();
  lintTools(spec.tools, codes);
  lintSkills(spec.skills, codes);
  lintLimits(spec.execution, limits, codes);
  if (codes.size === 0) return { ok: true };
  return { ok: false, codes: [...codes] };
}

/**
 * The agent limits in a `governance.policy_bundles` document, where company-security-policy.yaml puts
 * them: `organization_policy.agent_limits`. A document can only tighten the spec's range. A limit it does
 * not name stays at that range, except delegation, which stays at none.
 *
 * Null means the document says something this cannot read. The caller refuses to publish against it, since
 * skipping a limit somebody wrote would let through what they meant to stop.
 */
export function agentLimitsFromPolicyDocument(document: unknown): OrgAgentLimits | null {
  if (!isRecord(document)) return null;
  const policy = document.organization_policy;
  if (policy === undefined) return NO_POLICY_AGENT_LIMITS;
  if (!isRecord(policy)) return null;
  const block = policy.agent_limits;
  if (block === undefined) return NO_POLICY_AGENT_LIMITS;
  if (!isRecord(block)) return null;

  const counts: readonly (readonly [unknown, number])[] = [
    [block.max_delegation_depth, MAX_SPEC_DELEGATION_DEPTH],
    [block.max_model_turns, MAX_SPEC_MODEL_TURNS],
    [block.max_tool_calls, MAX_SPEC_TOOL_CALLS],
    [block.max_total_tokens, NO_POLICY_AGENT_LIMITS.maxTotalTokens],
    [block.timeout_seconds, NO_POLICY_AGENT_LIMITS.timeoutSeconds],
  ];
  if (counts.some(([value]) => value !== undefined && !isCount(value))) return null;
  const tightened = (value: unknown, range: number, absent = range) =>
    isCount(value) ? Math.min(value, range) : absent;

  const cost = block.max_cost_usd === undefined ? undefined : microsOf(block.max_cost_usd);
  if (cost === null) return null;

  return {
    maxDelegationDepth: tightened(
      block.max_delegation_depth,
      MAX_SPEC_DELEGATION_DEPTH,
      NO_POLICY_AGENT_LIMITS.maxDelegationDepth,
    ),
    maxModelTurns: tightened(block.max_model_turns, MAX_SPEC_MODEL_TURNS),
    maxToolCalls: tightened(block.max_tool_calls, MAX_SPEC_TOOL_CALLS),
    maxTotalTokens: tightened(block.max_total_tokens, NO_POLICY_AGENT_LIMITS.maxTotalTokens),
    maxCostMicros: cost ?? NO_POLICY_AGENT_LIMITS.maxCostMicros,
    timeoutSeconds: tightened(block.timeout_seconds, NO_POLICY_AGENT_LIMITS.timeoutSeconds),
  };
}
