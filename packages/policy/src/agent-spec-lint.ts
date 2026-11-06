// Owned by the agents slice (AGENT-01). Pure rules checked at publish, so a bad grant never becomes an
// immutable version (ADR-028 FD-19, G10). It is here rather than in agent-runtime because the web tier
// runs this, and it may not import agent-runtime. This stub refuses every spec.

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

export function lintAgentSpec(_spec: unknown, _limits: OrgAgentLimits): SpecLintResult {
  return { ok: false, codes: ['NOT_LINTED'] };
}
