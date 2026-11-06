// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md and ADR-029 D1. Deterministic
// workflow code: only @temporalio/workflow and types may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { KnowledgeIngestInput, KnowledgeIngestResult } from './knowledge-schemas';

/**
 * One document. `parseAndChunk` on `KNOWLEDGE_TASK_QUEUE`, then, if it is searchable, `embedDocumentChunks`
 * on `KNOWLEDGE_MODEL_TASK_QUEUE` with a `scheduleToStartTimeout`, so a deployment with no model worker
 * ends `model_worker_absent` and the document stays lexically searchable.
 */
export async function knowledgeIngestWorkflow(
  _input: KnowledgeIngestInput,
): Promise<KnowledgeIngestResult> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
