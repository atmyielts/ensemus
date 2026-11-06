// Owned by the purge slice (KNOW-05). See docs/06-delivery/m5-slices.md and ADR-029 D3. Deterministic
// workflow code: only @temporalio/workflow and types may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { KnowledgePurgeInput, KnowledgePurgeResult } from './knowledge-schemas';

/**
 * `purgeRunTranscripts` on `KNOWLEDGE_MODEL_TASK_QUEUE`, with a `scheduleToStartTimeout`: no agent worker
 * means no run could still be holding a prompt, so it carries on, and the job's row says so. Then
 * `purgeSource` on `KNOWLEDGE_TASK_QUEUE`, retried with backoff across a store outage. Serving stopped
 * before this began, so waiting here is safe, and the job's row shows the wait.
 */
export async function knowledgePurgeWorkflow(
  _input: KnowledgePurgeInput,
): Promise<KnowledgePurgeResult> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
