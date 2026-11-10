// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md and ADR-029 D1. Deterministic
// workflow code: only @temporalio/workflow and types may be imported here.
import { ActivityFailure, proxyActivities, TimeoutFailure } from '@temporalio/workflow';
import type { KnowledgeIngestInput, KnowledgeIngestResult } from './knowledge-schemas';
import type { KnowledgeIngestActivities } from './knowledge-ingest-activities';
import type { KnowledgeEmbedActivities } from './knowledge-embed-activities';
import { runKnowledgeIngest } from './knowledge-ingest-step';

/**
 * One document. `parseAndChunk` on `KNOWLEDGE_TASK_QUEUE`, then, if it is searchable, `embedDocumentChunks`
 * on `KNOWLEDGE_MODEL_TASK_QUEUE` with a `scheduleToStartTimeout`, so a deployment with no model worker
 * ends `model_worker_absent` and the document stays lexically searchable.
 */
export async function knowledgeIngestWorkflow(
  input: KnowledgeIngestInput,
): Promise<KnowledgeIngestResult> {
  const parsing = proxyActivities<KnowledgeIngestActivities>({
    taskQueue: 'ensemus-knowledge',
    startToCloseTimeout: '5 minutes',
    retry: { maximumAttempts: 3 },
  });
  const models = proxyActivities<KnowledgeEmbedActivities>({
    taskQueue: 'ensemus-agent',
    startToCloseTimeout: '5 minutes',
    scheduleToStartTimeout: '30 seconds',
    retry: { maximumAttempts: 1 },
  });
  return runKnowledgeIngest({
    parse: () => parsing.parseAndChunk(input),
    embed: () => models.embedDocumentChunks(input),
    modelWorkerAbsent: (error) =>
      error instanceof ActivityFailure &&
      error.cause instanceof TimeoutFailure &&
      error.cause.timeoutType === 'SCHEDULE_TO_START',
  });
}
