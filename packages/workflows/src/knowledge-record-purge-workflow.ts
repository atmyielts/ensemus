import { proxyActivities } from '@temporalio/workflow';
import { AGENT_TASK_QUEUE, KNOWLEDGE_TASK_QUEUE } from './constants';
import type {
  KnowledgePurgeActivities,
  KnowledgeTranscriptActivities,
} from './knowledge-purge-activities';
import type { KnowledgeRecordPurgeInput } from './knowledge-schemas';
import { runRecordPurge, type RecordPurgeResult } from './knowledge-record-purge-step';

/** Metadata only. Starting/restarting this canonical workflow must originate from the genuine
 * record-deletion outbox/control path; it cannot authorize an active record or invent read history. */
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
