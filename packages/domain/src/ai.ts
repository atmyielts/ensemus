// Governed AI vocabulary (ADR-028). Pure data and pure rules with no imports at all, so workflow code,
// the web tier and migrations' tests can all read the same lists. Migration 0101 holds the same run
// state machine, and tests/unit/ai-vocabulary.test.ts keeps the two equal.

export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type AiClassification = (typeof CLASSIFICATIONS)[number];

/** Mixing inherits the strongest class (security blueprint §2). A class can only ever rise. */
export function strongestClassification(
  a: AiClassification,
  b: AiClassification,
): AiClassification {
  return CLASSIFICATIONS.indexOf(a) >= CLASSIFICATIONS.indexOf(b) ? a : b;
}

// --- Runs (ADR-028 FD-7). A failed run stays failed: a retry is a new run on the same Work Unit.

export const AGENT_RUN_STATUSES = [
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
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

const STOPPED: readonly AgentRunStatus[] = [
  'failed',
  'cancelled',
  'budget_exhausted',
  'policy_denied',
  'timed_out',
];

/** The state machine. Trigger `ai.check_agent_run_change` in migration 0101 holds the same table. */
export const AGENT_RUN_TRANSITIONS: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  queued: ['preparing', ...STOPPED],
  preparing: ['running', ...STOPPED],
  running: [
    'paused',
    'waiting_for_approval',
    'waiting_for_child',
    'verifying',
    'outcome_unverified',
    ...STOPPED,
  ],
  paused: ['running', ...STOPPED],
  waiting_for_approval: ['running', 'paused', 'outcome_unverified', ...STOPPED],
  waiting_for_child: ['running', 'paused', ...STOPPED],
  verifying: ['completed', 'outcome_unverified', ...STOPPED],
  completed: [],
  failed: [],
  cancelled: [],
  budget_exhausted: [],
  policy_denied: [],
  timed_out: [],
  outcome_unverified: [],
};

export function canTransitionAgentRun(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return AGENT_RUN_TRANSITIONS[from].includes(to);
}

export function isTerminalAgentRun(status: AgentRunStatus): boolean {
  return AGENT_RUN_TRANSITIONS[status].length === 0;
}

/** Why a run stopped. Fixed codes, so no provider text or model words can reach the row. */
export const STOP_CODES = [
  'TURN_LIMIT',
  'TOOL_LIMIT',
  'TOKEN_LIMIT',
  'COST_LIMIT',
  'TIME_LIMIT',
  'BUDGET_EXHAUSTED',
  'BUDGET_NOT_CONFIGURED',
  'RATE_CARD_MISSING',
  'ENTITLEMENT_DENIED',
  'POLICY_DENIED',
  'PROFILE_CHANGED',
  'MODEL_UNAVAILABLE',
  'CREDENTIAL_UNAVAILABLE',
  'INVALID_OUTPUT',
  'HALTED',
  'STOPPED_BY_PERSON',
  'WORK_STOPPED',
  'INITIATOR_INACTIVE',
  'UNKNOWN_EXTERNAL_STATE',
  'APPROVAL_DENIED',
  'APPROVAL_EXPIRED',
  'DELEGATION_DENIED',
  'CHILD_FAILED',
  'WORKER_UNAVAILABLE',
  'OUTPUT_UNVERIFIED',
  'STRANDED',
  'INTERNAL_ERROR',
] as const;
export type StopCode = (typeof STOP_CODES)[number];

export const RUN_CONTROL_KINDS = ['stop', 'pause', 'resume'] as const;
export type RunControlKind = (typeof RUN_CONTROL_KINDS)[number];

// --- Steps. A step row has no free text at all: only codes, counters and references.

export const STEP_KINDS = [
  'prepare',
  'model_turn',
  'tool_call',
  'approval_wait',
  'delegation',
  'verification',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const STEP_STATES = ['in_flight', 'completed', 'failed', 'cancelled'] as const;
export type StepState = (typeof STEP_STATES)[number];

/** What a model turn ended with. This is the whole of what crosses Temporal for a turn. */
export const MODEL_OUTCOMES = [
  'tool_proposed',
  'final_output',
  'invalid_output',
  'budget_exhausted',
  'policy_denied',
  'model_unavailable',
  'credential_unavailable',
  'stopped',
] as const;
export type ModelOutcome = (typeof MODEL_OUTCOMES)[number];

/** What a tool call ended with. */
export const TOOL_OUTCOMES = [
  'done',
  'needs_approval',
  'denied',
  'unknown_external_state',
  'budget_exhausted',
  'stopped',
] as const;
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

export const STEP_PAYLOAD_KINDS = ['prompt', 'completion', 'tool_args', 'tool_output'] as const;
export type StepPayloadKind = (typeof STEP_PAYLOAD_KINDS)[number];

/** What a timeline can say about a step, in words the web tier owns. Never a model's words. */
export const STEP_LABEL_CODES = [
  'PREPARING',
  'THINKING',
  'READING_WORK',
  'READING_FILE',
  'DRAFTING',
  'PROPOSING_EMAIL',
  'WAITING_FOR_APPROVAL',
  'SENDING_EMAIL',
  'DELEGATING',
  'WAITING_FOR_CHILD',
  'CHECKING_RESULT',
  'STOPPING',
] as const;
export type StepLabelCode = (typeof STEP_LABEL_CODES)[number];

// --- Model profiles (ADR-028 FD-10, FD-21, FD-23).

export const PROVIDER_KINDS = [
  'openai_hosted',
  'anthropic_hosted',
  'openai_compatible',
  'local_openai_compatible',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Kinds that send to a provider's own hosts. A real key for one needs the review interlock. */
export const HOSTED_PROVIDER_KINDS: readonly ProviderKind[] = ['openai_hosted', 'anthropic_hosted'];

export function isHostedProviderKind(kind: ProviderKind): boolean {
  return HOSTED_PROVIDER_KINDS.includes(kind);
}

export const MODEL_PROFILE_STATUSES = [
  'draft',
  'probing',
  'probe_failed',
  'active',
  'disabled',
] as const;
export type ModelProfileStatus = (typeof MODEL_PROFILE_STATUSES)[number];

export const BILLING_OWNERS = ['customer', 'ensemus'] as const;
export type BillingOwner = (typeof BILLING_OWNERS)[number];

export const MODEL_CAPABILITIES = [
  'text',
  'tools',
  'structured_output',
  'vision',
  'long_context',
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export const MODEL_PURPOSES = ['classify', 'extract', 'reason', 'research', 'compose'] as const;
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

export const RETENTION_BASES = ['unreviewed', 'contract_recorded', 'self_hosted'] as const;
export type RetentionBasis = (typeof RETENTION_BASES)[number];

/** Which column of data-egress-matrix.csv a profile's destination falls under. */
export const EGRESS_DESTINATIONS = [
  'ensemus_cloud_managed_model',
  'customer_byom_public_api',
  'customer_private_inference',
] as const;
export type EgressDestination = (typeof EGRESS_DESTINATIONS)[number];

// --- Why something was denied. Codes only: these reach rows, logs and pages.

export const AI_REASON_CODES = [
  'ALLOWED',
  'ENTITLEMENT_DENIED',
  'CLASS_DENIED',
  'CLASS_NOT_ON_PROFILE',
  'PURPOSE_NOT_ON_PROFILE',
  'WRONG_REGION',
  'REGION_REQUIRED',
  'CONTRACT_MISSING',
  'PROFILE_NOT_ACTIVE',
  'PROFILE_CHANGED',
  'PROFILE_NOT_QUALIFIED',
  'CAPABILITY_MISSING',
  'FALLBACK_NOT_ALLOWED',
  'BILLING_OWNER_CROSSED',
  'NO_CANDIDATE',
  'BUDGET_EXHAUSTED',
  'BUDGET_NOT_CONFIGURED',
  'RATE_CARD_MISSING',
  'SECRET_FOUND_IN_PAYLOAD',
  'HALTED',
  'POLICY_UNREADABLE',
  'UNKNOWN_INPUT',
  'TOOL_NOT_GRANTED',
  'TOOL_DENIED_BY_SPEC',
  'TOOL_UNKNOWN',
  'TOOL_ARGS_INVALID',
  'RESOURCE_NOT_PERMITTED',
  'DESTRUCTIVE_DENIED',
  'APPROVAL_REQUIRED',
  'INITIATOR_INACTIVE',
  'DELEGATION_WIDENED',
  'DELEGATION_DEPTH',
  'DELEGATION_FANOUT',
] as const;
export type AiReasonCode = (typeof AI_REASON_CODES)[number];

export const EGRESS_DECISIONS = ['allow', 'deny'] as const;
export type EgressDecisionKind = (typeof EGRESS_DECISIONS)[number];

// --- Money and usage (ADR-028 FD-6, FD-12). Integers of micro-USD, everywhere.

export const LEDGER_STATUSES = ['estimated', 'final', 'correction'] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export const USAGE_METERS = ['model_input_tokens', 'model_output_tokens', 'tool_call'] as const;
export type UsageMeter = (typeof USAGE_METERS)[number];

export const RESERVATION_STATUSES = ['held', 'settled', 'released'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const BUDGET_SCOPES = ['organization', 'agent_version'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const RATE_CARD_SOURCES = ['tenant_estimate', 'ensemus_card'] as const;
export type RateCardSource = (typeof RATE_CARD_SOURCES)[number];

/** The ledger key of one model call. The same key twice is one row, so a retry cannot double-count. */
export const modelLedgerKey = (runId: string, stepNumber: number, attempt: number) =>
  `model:${runId}:${stepNumber}:${attempt}`;

/** One tool call's ledger key. */
export const toolLedgerKey = (runId: string, stepNumber: number) => `tool:${runId}:${stepNumber}`;

/**
 * Parses a manifest's `max_cost_usd` once, at publish, from its decimal text. Refuses anything finer
 * than one micro-USD or too large to stay exact, so no float ever reaches a budget.
 */
export function usdToMicros(usd: string): number {
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(usd)) throw new RangeError('Not a micro-USD amount');
  const [whole = '0', fraction = ''] = usd.split('.');
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
}

// --- Kill switch (ADR-028 FD-15).

export const KILL_SWITCH_SCOPES = ['global', 'organization', 'provider', 'agent_version'] as const;
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];

/** Limits a run starts with. A run can never raise them: no role can update these columns. */
export type RunLimits = {
  maxModelTurns: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  maxCostMicros: number;
  /** Active time only. Approval waits and paused time do not count (FD-22). */
  timeoutSeconds: number;
  maxDelegationDepth: number;
};

export type RunCounters = {
  modelTurns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  activeMs: number;
};
