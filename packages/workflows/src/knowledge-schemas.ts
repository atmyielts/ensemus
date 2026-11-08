import { z } from 'zod';

// M5 (ADR-029). ADR-024 D2's rule: only identifiers, enums and counters cross Temporal. A question, a
// passage, a title or a vector never does, and an Activity reads them from PostgreSQL by ID.

export const knowledgeIngestInputSchema = z.strictObject({
  organizationId: z.uuid(),
  documentId: z.uuid(),
});
export type KnowledgeIngestInput = z.infer<typeof knowledgeIngestInputSchema>;
export const knowledgeIngestWorkflowIdFor = (input: KnowledgeIngestInput) =>
  `knowledge-ingest-${input.organizationId}-${input.documentId}`;

/** What a document's ingest ended on. `embedding` says how far vectors got: lexical search works anyway. */
export type KnowledgeIngestResult = {
  outcome: 'searchable' | 'rejected' | 'failed' | 'closed' | 'already_done';
  chunks: number;
  embedding: 'embedded' | 'denied' | 'failed' | 'skipped' | 'model_worker_absent';
};

export const knowledgePurgeInputSchema = z.strictObject({
  organizationId: z.uuid(),
  sourceId: z.uuid(),
});
export type KnowledgePurgeInput = z.infer<typeof knowledgePurgeInputSchema>;
export const knowledgePurgeWorkflowIdFor = (input: KnowledgePurgeInput) =>
  `knowledge-purge-${input.organizationId}-${input.sourceId}`;
export type KnowledgePurgeResult = { state: 'completed' | 'failed'; chunks: number };

export const knowledgeRecordPurgeInputSchema = z.strictObject({
  organizationId: z.uuid(),
  kind: z.enum(['work_unit', 'project', 'client', 'object_record']),
  id: z.uuid(),
  limit: z.number().int().min(1).max(100),
  /** Durable backoff only; never a material/read/cleanup certificate. */
  retryAttempt: z.number().int().min(0).max(10).optional(),
});
export type KnowledgeRecordPurgeInput = z.infer<typeof knowledgeRecordPurgeInputSchema>;
export const knowledgeRecordPurgeWorkflowIdFor = (input: KnowledgeRecordPurgeInput) =>
  `knowledge-record-purge-${input.organizationId}-${input.kind}-${input.id}`;

export const knowledgeAnswerInputSchema = z.strictObject({
  organizationId: z.uuid(),
  answerId: z.uuid(),
});
export type KnowledgeAnswerInput = z.infer<typeof knowledgeAnswerInputSchema>;
export const knowledgeAnswerWorkflowIdFor = (input: KnowledgeAnswerInput) =>
  `knowledge-answer-${input.organizationId}-${input.answerId}`;
export type KnowledgeAnswerResult = {
  outcome:
    'answered' | 'no_evidence' | 'refused' | 'failed' | 'already_done' | 'model_worker_absent';
};

/** One tenant's sweep, from a Temporal Schedule (ADR-029 D1). */
export const knowledgeSweepScheduleIdFor = (organizationId: string) =>
  `knowledge-sweep-${organizationId}`;
export type KnowledgeSweepResult = {
  fetched: number;
  closed: number;
  failed: number;
  purges?: readonly { sourceId: string; state: 'pending' | 'running' | 'completed' | 'failed' }[];
};

export const clientOnboardingInputSchema = z.strictObject({
  organizationId: z.uuid(),
  onboardingId: z.uuid(),
});
export type ClientOnboardingInput = z.infer<typeof clientOnboardingInputSchema>;
export const clientOnboardingWorkflowIdFor = (input: ClientOnboardingInput) =>
  `client-onboarding-${input.organizationId}-${input.onboardingId}`;
export type ClientOnboardingResult = {
  state: 'completed' | 'failed' | 'unknown';
};
