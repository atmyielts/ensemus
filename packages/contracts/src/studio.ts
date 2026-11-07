// Runtime contracts for Agent Studio and process specs (ADR-031). The shapes match the planned operations in
// docs/specifications/openapi.yaml.
import { z } from 'zod';
const uuid = z.uuid().toLowerCase();

const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/\0/.test(value));

export const dataClassSchema = z.enum(['public', 'internal', 'confidential', 'restricted']);

/** The guided answers. A person never writes a grant list or a raw prompt into this. */
export const agentDraftAnswersSchema = z.strictObject({
  role: plainText(2000),
  intendedOutcome: plainText(2000),
  boundaries: z.array(plainText(500)).max(20),
  knowledgeSourceIds: z.array(uuid).max(50),
  toolIds: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/)).max(50),
  triggerKind: z.literal('manual'),
  maxCostMicros: z.number().int().positive().max(1_000_000_000_000).nullable(),
  maxTurns: z.number().int().min(1).max(1000),
  maxToolCalls: z.number().int().min(0).max(1000),
  maxTotalTokens: z.number().int().min(1).max(100_000_000),
  qualityTier: z.enum(['economy', 'balanced', 'high']),
  timeoutSeconds: z.number().int().min(1).max(86_400),
  autonomy: z.enum(['suggest_only', 'draft_for_review', 'act_with_approval']),
  memoryWrite: z.enum(['none', 'propose_only']),
  outputFormat: z.enum(['markdown_brief', 'structured_report']),
  // Restricted is not on offer here at all (ADR-031 D5).
  dataClasses: z
    .array(z.enum(['public', 'internal', 'confidential']))
    .min(1)
    .max(3),
  ownerMembershipId: uuid,
});
export type AgentDraftAnswersBody = z.infer<typeof agentDraftAnswersSchema>;

export const createAgentDraftSchema = z.strictObject({
  name: plainText(120),
  answers: agentDraftAnswersSchema,
  agent_definition_id: uuid.optional(),
});
export type CreateAgentDraftBody = z.infer<typeof createAgentDraftSchema>;

export const updateAgentDraftSchema = z.strictObject({
  name: plainText(120).optional(),
  answers: agentDraftAnswersSchema.optional(),
});
export type UpdateAgentDraftBody = z.infer<typeof updateAgentDraftSchema>;

export const requestSimulationSchema = z.strictObject({
  scenario_key: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
});
export type RequestSimulationBody = z.infer<typeof requestSimulationSchema>;

export const requestPublishReviewSchema = z.strictObject({
  subject_kind: z.enum(['agent_draft', 'process_draft']),
  subject_id: uuid,
  simulation_run_id: uuid,
  reviewer_membership_id: uuid.optional(),
});
export type RequestPublishReviewBody = z.infer<typeof requestPublishReviewSchema>;

export const decidePublishReviewSchema = z
  .strictObject({
    decision: z.enum(['approved', 'rejected']),
    reason: plainText(2000).optional(),
  })
  .refine((body) => body.decision === 'approved' || body.reason !== undefined, {
    path: ['reason'],
  });
export type DecidePublishReviewBody = z.infer<typeof decidePublishReviewSchema>;

const nodeId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

export const processGraphSchema = z.strictObject({
  schemaVersion: z.literal(1),
  nodes: z
    .array(
      z.strictObject({
        id: nodeId,
        kind: z.enum([
          'start',
          'work_item',
          'agent_task',
          'human_approval',
          'external_action',
          'evidence_check',
          'end',
        ]),
        label: plainText(120),
        agentDefinitionId: uuid.optional(),
        toolId: z
          .string()
          .regex(/^[a-z][a-z0-9_.-]{1,63}$/)
          .optional(),
        approverRole: z.enum(['process_owner', 'starter_manager', 'named_reviewer']).optional(),
        evidence: z.enum(['artifact_attached', 'external_receipt', 'reviewer_approved']).optional(),
        x: z.number().finite(),
        y: z.number().finite(),
      }),
    )
    .max(64),
  edges: z.array(z.strictObject({ from: nodeId, to: nodeId })).max(128),
});
export type ProcessGraphBody = z.infer<typeof processGraphSchema>;

/** The immutable executable shape, also used to validate a saved rehearsal before displaying it. */
export const processSpecSchema = z.strictObject({
  schemaVersion: z.literal(1),
  classification: dataClassSchema,
  steps: z
    .array(
      z.strictObject({
        key: nodeId,
        kind: z.enum([
          'work_item',
          'agent_task',
          'human_approval',
          'external_action',
          'evidence_check',
        ]),
        after: z.array(nodeId).max(64),
        labelCode: z.string().max(128).nullable(),
        label: plainText(120),
        agentDefinitionId: uuid.optional(),
        toolId: z
          .string()
          .regex(/^[a-z][a-z0-9_.-]{1,63}$/)
          .optional(),
        approverRole: z.enum(['process_owner', 'starter_manager', 'named_reviewer']).optional(),
        evidence: z.enum(['artifact_attached', 'external_receipt', 'reviewer_approved']).optional(),
      }),
    )
    .max(64),
});

export const createProcessDraftSchema = z.strictObject({
  name: plainText(120),
  classification: dataClassSchema,
});
export type CreateProcessDraftBody = z.infer<typeof createProcessDraftSchema>;

export const updateProcessDraftSchema = z.strictObject({
  name: plainText(120).optional(),
  classification: dataClassSchema.optional(),
  graph: processGraphSchema.optional(),
});
export type UpdateProcessDraftBody = z.infer<typeof updateProcessDraftSchema>;

export const startProcessRunSchema = z.strictObject({
  spec_id: uuid,
  title: plainText(200),
  due_at: z.iso.datetime({ offset: true }).optional(),
});
export type StartProcessRunBody = z.infer<typeof startProcessRunSchema>;
