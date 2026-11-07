import { z } from 'zod';
export const knowledgeModelJobInputSchema = z.strictObject({
  organizationId: z.uuid().toLowerCase(),
  jobId: z.uuid().toLowerCase(),
});
export type KnowledgeModelJobInput = z.infer<typeof knowledgeModelJobInputSchema>;
export const knowledgeModelJobWorkflowIdFor = (input: KnowledgeModelJobInput) =>
  `knowledge-model-${input.organizationId}-${input.jobId}`;
export type KnowledgeModelJobResult = {
  state: 'completed' | 'refused' | 'missing' | 'model_worker_absent';
  code: string | null;
};
