// COMM-06, AGENT-01: generated agent manifests, one set for every mode, so "the same manifests are accepted
// and the same refused" means something. Their shape follows
// docs/specifications/schemas/agent-definition.schema.json as M4 settled it (`instructions`,
// `max_total_tokens`, and `max_cost_usd` as decimal text), because M4 is what these get published to. The
// scenario checks each one against that file before using it, so a manifest that has drifted fails loudly
// instead of being refused for the wrong reason.
//
// Nothing here is real. `max_cost_usd` is a field the format requires, and its value is a test value: it is
// not a price, and no observation holds it.

export interface ManifestCase {
  /** What the case is. An observation is keyed by this, so it says nothing about any one run. */
  readonly name: string;
  readonly manifest: unknown;
}

type Fields = Readonly<Record<string, unknown>>;

const MODEL = {
  required_capabilities: ['text', 'tools'],
  quality_tier: 'balanced',
  fallback: 'disabled',
} as const;
const CONTEXT = { allowed_scopes: ['work.read'], memory_write_policy: 'none' } as const;
const TOOLS = { allow: ['work.read'] } as const;
const EXECUTION = {
  max_model_turns: 5,
  max_tool_calls: 5,
  max_total_tokens: 10_000,
  max_cost_usd: '1',
  timeout_seconds: 60,
  max_delegation_depth: 0,
} as const;
const OUTPUT = { schema_ref: 'schemas/parity.schema.json', verification: ['schema_check'] } as const;
const EVALUATION = { suite_ref: 'evaluations/agents/parity', min_pass_rate: 0.9 } as const;

/** Each case has its own agent ID, so what one case does cannot change the answer to another. */
const manifestNamed = (name: string, overrides: Fields = {}): Fields => ({
  api_version: 'ensemus.ai/v1',
  id: `parity-${name.replaceAll('_', '-')}`,
  version: 1,
  objective: 'Read the work and draft a short brief for its owner.',
  instructions: 'Use only what the work and its files say. Cite each claim.',
  model: MODEL,
  context: CONTEXT,
  tools: TOOLS,
  execution: EXECUTION,
  output: OUTPUT,
  evaluation: EVALUATION,
  ...overrides,
});

const manifestCase = (name: string, overrides: Fields = {}): ManifestCase => ({
  name,
  manifest: manifestNamed(name, overrides),
});

const without = (name: string, field: string): ManifestCase => {
  const { [field]: _dropped, ...rest } = manifestNamed(name);
  return { name, manifest: rest };
};

/** Valid in the format, and allowed by the rules. Every mode must accept each of these. */
export const ACCEPTED_MANIFESTS: readonly ManifestCase[] = [
  manifestCase('smallest', { model: { ...MODEL, required_capabilities: ['text'] } }),
  manifestCase('read_tools', {
    context: { ...CONTEXT, max_input_tokens: 4_000 },
    tools: { allow: ['work.read', 'artifact.read_text'], deny: ['email.send'] },
  }),
  manifestCase('draft_tool', {
    model: { ...MODEL, quality_tier: 'economy', fallback: 'approved_profiles_only' },
    context: { ...CONTEXT, memory_write_policy: 'propose_only' },
    tools: { allow: ['artifact.draft.create'] },
  }),
];

/** The format itself refuses these, so a code here means the product read the same format. */
export const MANIFESTS_REFUSED_BY_FORMAT: readonly ManifestCase[] = [
  { name: 'not_an_object', manifest: 'api_version: ensemus.ai/v1' },
  manifestCase('wrong_api_version', { api_version: 'ensemus.ai/v0' }),
  manifestCase('uppercase_id', { id: 'Parity-Uppercase' }),
  manifestCase('version_zero', { version: 0 }),
  manifestCase('objective_too_short', { objective: 'Too short' }),
  without('no_instructions', 'instructions'),
  without('no_model', 'model'),
  manifestCase('unknown_field', { allow_anything: true }),
  manifestCase('no_capabilities', { model: { ...MODEL, required_capabilities: [] } }),
  manifestCase('unknown_capability', {
    model: { ...MODEL, required_capabilities: ['mind_reading'] },
  }),
  manifestCase('unknown_tier', { model: { ...MODEL, quality_tier: 'whatever_is_best' } }),
  manifestCase('unknown_fallback', { model: { ...MODEL, fallback: 'any_provider' } }),
  // A model's guess cannot become verified memory (ADR-028 G10), so this value is gone from the format.
  manifestCase('memory_verified_by_policy', {
    context: { ...CONTEXT, memory_write_policy: 'verified_by_policy' },
  }),
  manifestCase('too_many_turns', { execution: { ...EXECUTION, max_model_turns: 101 } }),
  manifestCase('too_many_tool_calls', { execution: { ...EXECUTION, max_tool_calls: 501 } }),
  manifestCase('cost_as_a_number', { execution: { ...EXECUTION, max_cost_usd: 1 } }),
  manifestCase('delegation_too_deep', { execution: { ...EXECUTION, max_delegation_depth: 6 } }),
  manifestCase('pass_rate_above_one', { evaluation: { ...EVALUATION, min_pass_rate: 1.5 } }),
];

/** Well formed, and refused by the rules at publish. These are the grants no mode may allow. */
export const MANIFESTS_REFUSED_BY_RULES: readonly ManifestCase[] = [
  manifestCase('unknown_tool', { tools: { allow: ['web.browse'] } }),
  manifestCase('malformed_tool_name', { tools: { allow: ['Not A Tool'] } }),
  manifestCase('secrets_tool', { tools: { allow: ['secrets.read'] } }),
  manifestCase('model_tool', { tools: { allow: ['model.override'] } }),
  manifestCase('budget_tool', { tools: { allow: ['budget.raise'] } }),
  manifestCase('tool_allowed_and_denied', {
    tools: { allow: ['work.read'], deny: ['work.read'] },
  }),
  manifestCase('skill_nobody_has', { skills: ['parity-no-such-skill'] }),
];

const [first] = ACCEPTED_MANIFESTS;
if (!first) throw new Error('The accepted manifests are empty, and so would prove nothing.');

/** The first accepted manifest again, as a new version. That is how an agent changes. */
export const NEXT_VERSION: ManifestCase = {
  name: 'next_version',
  manifest: { ...(first.manifest as Fields), version: 2 },
};

/**
 * The first accepted manifest with the same ID and version and one more tool. A published version is
 * immutable, so this cannot be a way to widen what a running agent may do (ADR-028 FD-19).
 */
export const SAME_VERSION_WIDENED: ManifestCase = {
  name: 'same_version_widened',
  manifest: {
    ...(first.manifest as Fields),
    tools: { allow: ['work.read', 'artifact.read_text'] },
  },
};
