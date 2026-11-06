// What crosses Temporal for governed AI (ADR-024 D2, ADR-028 FD-5). IDs, enums and counters, and no field
// for text: strict objects reject anything extra. Workflow code imports only the types from here, as it
// does from schemas.ts, and takes its constants from constants.ts.
import { MODEL_OUTCOMES, TOOL_OUTCOMES } from '@ensemus/domain/ai';
import { z } from 'zod';

/** The Work Unit's standard ID (FD-1), so approval.resolved and work.stop_requested need no change. */
export const agentRunInputSchema = z.strictObject({
  organizationId: z.uuid(),
  workUnitId: z.uuid(),
});
export type AgentRunInput = z.infer<typeof agentRunInputSchema>;

const counters = {
  modelTurns: z.int().min(0),
  toolCalls: z.int().min(0),
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  costMicros: z.int().min(0),
  activeMs: z.int().min(0),
};
export const runCountersSchema = z.strictObject(counters);

export const runLimitsSchema = z.strictObject({
  maxModelTurns: z.int().min(1),
  maxToolCalls: z.int().min(0),
  maxTotalTokens: z.int().min(1),
  maxCostMicros: z.int().min(0),
  timeoutSeconds: z.int().min(1),
  maxDelegationDepth: z.int().min(0),
});

/** Which run asks, in every Activity. The workflow run ID stops an old run acting on a new one. */
export const runRefSchema = z.strictObject({
  organizationId: z.uuid(),
  workUnitId: z.uuid(),
  agentRunId: z.uuid(),
  temporalRunId: z.string().min(1).max(64),
});
export type RunRef = z.infer<typeof runRefSchema>;

export const claimInputSchema = z.strictObject({
  organizationId: z.uuid(),
  workUnitId: z.uuid(),
  temporalRunId: z.string().min(1).max(64),
});
export type ClaimInput = z.infer<typeof claimInputSchema>;

export const claimResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('claimed'),
    agentRunId: z.uuid(),
    limits: runLimitsSchema,
    counters: runCountersSchema,
    nextStepNumber: z.int().min(0),
  }),
  /** No queued run for this Work Unit, or it already finished. The workflow ends quietly. */
  z.strictObject({ kind: z.literal('nothing_queued') }),
]);
export type ClaimResult = z.infer<typeof claimResultSchema>;

export const stepInputSchema = runRefSchema.extend({
  stepNumber: z.int().min(0),
});
export type StepInput = z.infer<typeof stepInputSchema>;

export const modelTurnResultSchema = z.strictObject({
  outcome: z.enum(MODEL_OUTCOMES),
  stopCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
    .nullable(),
  counters: runCountersSchema,
});
export type ModelTurnResult = z.infer<typeof modelTurnResultSchema>;

export const toolCallResultSchema = z.strictObject({
  outcome: z.enum(TOOL_OUTCOMES),
  stopCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
    .nullable(),
  counters: runCountersSchema,
  /** Set for `agent.delegate` when a child must be started. */
  delegation: z.strictObject({ organizationId: z.uuid(), workUnitId: z.uuid() }).nullable(),
});
export type ToolCallResult = z.infer<typeof toolCallResultSchema>;

/** What PostgreSQL says should happen next. Each step reads this: a signal is only a wake-up. */
export const runDirectiveSchema = z.enum(['continue', 'pause', 'stop', 'halted']);
export type RunDirective = z.infer<typeof runDirectiveSchema>;

/** The state of a tool step that is waiting on a person or on M3's send. Read from PostgreSQL. */
export const toolWaitStateSchema = z.enum([
  'waiting',
  'done',
  'denied',
  'expired',
  'failed',
  'unknown_external_state',
]);
export type ToolWaitState = z.infer<typeof toolWaitStateSchema>;

export const createChildRunInputSchema = stepInputSchema;
export type CreateChildRunInput = z.infer<typeof createChildRunInputSchema>;

export const finishRunInputSchema = runRefSchema.extend({
  status: z.enum([
    'completed',
    'failed',
    'cancelled',
    'budget_exhausted',
    'policy_denied',
    'timed_out',
    'outcome_unverified',
  ]),
  stopCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
    .nullable(),
});
export type FinishRunInput = z.infer<typeof finishRunInputSchema>;

export type AgentRunResult = {
  workUnitId: string;
  agentRunId: string | null;
  status: FinishRunInput['status'] | 'nothing_queued';
};

/** What continue-as-new carries: counters and the next step, and nothing else. */
export type AgentRunCarry = {
  agentRunId: string;
  nextStepNumber: number;
};

// --- The activation probe (FD-23).

export const modelProbeInputSchema = z.strictObject({
  organizationId: z.uuid(),
  modelProfileId: z.uuid(),
});
export type ModelProbeInput = z.infer<typeof modelProbeInputSchema>;
export const modelProbeWorkflowIdFor = (input: ModelProbeInput) =>
  `model-probe-${input.organizationId}-${input.modelProfileId}`;
export type ModelProbeOutcome = 'passed' | 'failed' | 'skipped';
