import { proxyActivities } from '@temporalio/workflow';
import { AGENT_TASK_QUEUE, KNOWLEDGE_TASK_QUEUE } from './constants';
import type {
  KnowledgePurgeActivities,
  KnowledgeTranscriptActivities,
} from './knowledge-purge-activities';
import type { KnowledgeRecordPurgeInput } from './knowledge-schemas';
import { runRecordPurge, type RecordPurgeResult } from './knowledge-record-purge-step';

/** Metadata only. Two starters (ADR-028 lifecycle item 8a): the dispatcher, on a genuine
 * `knowledge.record_closed` outbox event (workers/workflow/src/record-purge-route.ts), and the tenant's
 * knowledgeSweepWorkflow, which restarts every record PostgreSQL does not yet prove purged. Neither can
 * authorize an active record or invent read history: a live record yields no purge snapshot. */
export async function knowledgeRecordPurgeWorkflow(
  input: KnowledgeRecordPurgeInput,
): Promise<RecordPurgeResult> {
  const agent = proxyActivities<KnowledgeTranscriptActivities>({
    taskQueue: AGENT_TASK_QUEUE,
    startToCloseTimeout: '5 minutes',
    scheduleToStartTimeout: '30 seconds',
    retry: { maximumAttempts: 1 },
  });
  const knowledge = proxyActivities<KnowledgePurgeActivities>({
    taskQueue: KNOWLEDGE_TASK_QUEUE,
    startToCloseTimeout: '5 minutes',
    retry: { maximumAttempts: 1 },
  });
  return runRecordPurge({
    materials: () => agent.purgeRecordMaterials(input),
    files: () => knowledge.purgeRecordFiles(input),
    confirm: () => knowledge.confirmRecordPurge(input),
  });
}
