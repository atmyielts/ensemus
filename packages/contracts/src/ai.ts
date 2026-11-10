// Runtime contracts for governed AI (ADR-028). Request and response shapes match
// docs/specifications/openapi.yaml, and the agent spec matches
// docs/specifications/schemas/agent-definition.schema.json. Money is integer micro-USD everywhere.
import { z } from 'zod';
import { classificationSchema } from './index';

const uuid = z.uuid().toLowerCase();

const micros = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const providerKindSchema = z.enum([
  'openai_hosted',
  'anthropic_hosted',
  'openai_compatible',
  'local_openai_compatible',
]);
export const modelProfileStatusSchema = z.enum([
  'draft',
  'probing',
  'probe_failed',
  'active',
  'disabled',
]);
export const modelCapabilitySchema = z.enum([
  'text',
  'tools',
  'structured_output',
  'vision',
  'long_context',
]);
export const modelPurposeSchema = z.enum([
  'classify',
  'extract',
  'reason',
  'research',
  'compose',
  'embed',
  'rerank',
  'answer',
]);

export const modelLimitsSchema = z.strictObject({
  max_input_tokens: z.int().min(128),
  max_output_tokens: z.int().min(1),
});

/**
 * Creating a profile. There is no key field: the form seals a key in the browser's session handler and
 * sends only `secret_ref`, and a response can never carry either (no `secret_ref` in the view below).
 */
export const createModelProfileSchema = z.strictObject({
  provider_kind: providerKindSchema,
  model_id: z.string().trim().min(1).max(200),
  alias: z.string().trim().min(1).max(80),
  endpoint_url: z.url().max(500),
  billing_owner: z.enum(['customer', 'ensemus']),
  region: z.string().trim().min(1).max(64).nullable(),
  capabilities: z.array(modelCapabilitySchema).min(1),
  limits: modelLimitsSchema,
  allowed_classes: z.array(classificationSchema).min(1),
  allowed_purposes: z.array(modelPurposeSchema).min(1),
  retention_basis: z.enum(['unreviewed', 'contract_recorded', 'self_hosted']),
  contract_ref: z.string().trim().min(1).max(200).nullable(),
  fallback_profile_ids: z.array(uuid).max(5),
});
export type CreateModelProfile = z.infer<typeof createModelProfileSchema>;

export const updateModelProfileSchema = createModelProfileSchema
  .omit({ provider_kind: true })
  .partial()
  .extend({ expected_version: z.int().min(1) });
export type UpdateModelProfile = z.infer<typeof updateModelProfileSchema>;

/** What anyone can be shown about a profile. No key, no `secret_ref`: only whether a key is on file. */
export const modelProfileViewSchema = z.strictObject({
  id: uuid,
  version: z.int().min(1),
  provider_kind: providerKindSchema,
  model_id: z.string(),
  alias: z.string(),
  endpoint_url: z.string(),
  has_credential: z.boolean(),
  billing_owner: z.enum(['customer', 'ensemus']),
  region: z.string().nullable(),
  capabilities: z.array(modelCapabilitySchema),
  limits: modelLimitsSchema,
  allowed_classes: z.array(classificationSchema),
  allowed_purposes: z.array(modelPurposeSchema),
  retention_basis: z.enum(['unreviewed', 'contract_recorded', 'self_hosted']),
  contract_ref: z.string().nullable(),
  fallback_profile_ids: z.array(uuid),
  status: modelProfileStatusSchema,
  qualified_at: z.iso.datetime({ offset: true }).nullable(),
});
export type ModelProfileView = z.infer<typeof modelProfileViewSchema>;

export const createRateCardSchema = z.strictObject({
  input_micros_per_mtok: micros,
  output_micros_per_mtok: micros,
});

// --- The agent spec, v1 (ADR-028 G10).

const toolName = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

export const agentSpecV1Schema = z.strictObject({
  api_version: z.literal('ensemus.ai/v1'),
  id: z.string().regex(/^[a-z][a-z0-9-]{2,80}$/),
  version: z.int().min(1),
  objective: z.string().min(10).max(1000),
  /** Treated as policy text in the prompt. Never interpolated with data, and holds no secret. */
  instructions: z.string().min(1).max(8000),
  model: z.strictObject({
    required_capabilities: z.array(modelCapabilitySchema).min(1),
    quality_tier: z.enum(['economy', 'balanced', 'high']),
    /** A manifest can only turn fallback off. What is allowed is on the profile (FD-9). */
    fallback: z.enum(['approved_profiles_only', 'disabled']),
  }),
  context: z.strictObject({
    allowed_scopes: z.array(z.string()),
    /** `verified_by_policy` is gone: a model's guess cannot become verified memory (G10). */
    memory_write_policy: z.enum(['none', 'propose_only']),
    max_input_tokens: z.int().min(128).optional(),
  }),
  /** Empty in M4. Skills arrive with Studio. */
  skills: z.array(z.string()).max(0).optional(),
  tools: z.strictObject({
    allow: z.array(toolName),
    deny: z.array(toolName).optional(),
  }),
  execution: z.strictObject({
    max_model_turns: z.int().min(1).max(100),
    max_tool_calls: z.int().min(0).max(500),
    max_total_tokens: z.int().min(1),
    /** Decimal text, parsed once to micros by usdToMicros at publish. */
    max_cost_usd: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/),
    timeout_seconds: z.int().min(1),
    max_delegation_depth: z.int().min(0).max(5),
  }),
  output: z.strictObject({
    schema_ref: z.string(),
    verification: z.array(z.string()),
  }),
  evaluation: z.strictObject({
    suite_ref: z.string(),
    min_pass_rate: z.number().min(0).max(1),
  }),
});
export type AgentSpecV1 = z.infer<typeof agentSpecV1Schema>;

/** What an evaluation run produced. Its hash goes on the version, so a report cannot be reused. */
export const evaluationReportSchema = z.strictObject({
  report_version: z.literal(1),
  spec_sha256: sha256,
  policy_version: z.string().min(1),
  suite_ref: z.string().min(1),
  dataset_version: z.string().min(1),
  model_label: z.string().min(1),
  pass_rate: z.number().min(0).max(1),
  cases: z.int().min(1),
  passed: z.boolean(),
  /** Says plainly when a report came from a scripted model and proves the gates, not model quality. */
  scripted_model: z.boolean(),
});
export type EvaluationReport = z.infer<typeof evaluationReportSchema>;

export const publishAgentVersionSchema = z.strictObject({
  spec: agentSpecV1Schema,
  evaluation_report: evaluationReportSchema,
});

export const agentVersionViewSchema = z.strictObject({
  id: uuid,
  definition_id: uuid,
  version_number: z.int().min(1),
  spec_sha256: sha256,
  evaluation_report_sha256: sha256,
  policy_version: z.string(),
  published_by_membership_id: uuid,
  published_at: z.iso.datetime({ offset: true }),
});
export type AgentVersionView = z.infer<typeof agentVersionViewSchema>;

// --- Runs, and what a timeline may show.

export const agentRunStatusSchema = z.enum([
  'queued',
  'preparing',
  'running',
  'paused',
  'waiting_for_approval',
  'waiting_for_child',
  'verifying',
  'completed',
  'failed',
  'cancelled',
  'budget_exhausted',
  'policy_denied',
  'timed_out',
  'outcome_unverified',
]);

export const startAgentRunSchema = z.strictObject({
  work_unit_id: uuid,
  agent_version_id: uuid,
});
export type StartAgentRun = z.infer<typeof startAgentRunSchema>;

export const runControlSchema = z.strictObject({
  kind: z.enum(['stop', 'pause', 'resume']),
});
export type RunControlRequest = z.infer<typeof runControlSchema>;

export const agentRunViewSchema = z.strictObject({
  id: uuid,
  work_unit_id: uuid,
  agent_version_id: uuid,
  parent_run_id: uuid.nullable(),
  status: agentRunStatusSchema,
  stop_code: z.string().nullable(),
  effective_classification: classificationSchema,
  model_turns: z.int().min(0),
  tool_calls: z.int().min(0),
  input_tokens: z.int().min(0),
  output_tokens: z.int().min(0),
  cost_micros: micros,
  /** True when no rate card from Ensemus backs the figure, as in BYOM. The page says "estimate". */
  cost_is_estimate: z.boolean(),
  created_at: z.iso.datetime({ offset: true }),
  ended_at: z.iso.datetime({ offset: true }).nullable(),
});
export type AgentRunView = z.infer<typeof agentRunViewSchema>;

/** A timeline row: codes and times, and no text from any model. */
export const executionStepViewSchema = z.strictObject({
  step_number: z.int().min(0),
  kind: z.enum([
    'prepare',
    'model_turn',
    'tool_call',
    'approval_wait',
    'delegation',
    'verification',
  ]),
  state: z.enum(['in_flight', 'completed', 'failed', 'cancelled']),
  label_code: z.string(),
  outcome: z.string().nullable(),
  decision_code: z.string().nullable(),
  started_at: z.iso.datetime({ offset: true }),
  ended_at: z.iso.datetime({ offset: true }).nullable(),
});
export type ExecutionStepView = z.infer<typeof executionStepViewSchema>;

// --- Usage and budgets.

export const setBudgetSchema = z.strictObject({
  scope: z.enum(['organization', 'agent_version']),
  agent_version_id: uuid.nullable(),
  period: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/),
  limit_micros: micros,
});
export type SetBudget = z.infer<typeof setBudgetSchema>;

export const usageSummarySchema = z.strictObject({
  period: z.string(),
  limit_micros: micros.nullable(),
  reserved_micros: micros,
  spent_micros: micros,
  /** BYOM and Sovereign costs are the tenant's own estimate, and are never billable. */
  billable: z.boolean(),
  is_estimate: z.boolean(),
  input_tokens: z.int().min(0),
  output_tokens: z.int().min(0),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;

export const entitlementsViewSchema = z.strictObject({
  mode: z.enum(['cloud', 'byom', 'sovereign']),
  features: z.array(z.string()),
  capacity: z.record(z.string(), z.int()),
});
export type EntitlementsView = z.infer<typeof entitlementsViewSchema>;

// --- Kill switches.

export const engageKillSwitchSchema = z.strictObject({
  scope: z.enum(['organization', 'agent_version']),
  target_ref: uuid.nullable(),
  reason_code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
});
export type EngageKillSwitch = z.infer<typeof engageKillSwitchSchema>;
