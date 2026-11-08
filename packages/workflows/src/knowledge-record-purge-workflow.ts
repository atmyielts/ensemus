import { continueAsNew, patched, proxyActivities, sleep } from '@temporalio/workflow';
import { AGENT_TASK_QUEUE, KNOWLEDGE_TASK_QUEUE } from './constants';
import type {
  KnowledgePurgeActivities,
  KnowledgeTranscriptActivities,
} from './knowledge-purge-activities';
import { knowledgeRecordPurgeInputSchema, type KnowledgeRecordPurgeInput } from './knowledge-schemas';
import { retryRecordPurge, runRecordPurge, type RecordPurgeResult } from './knowledge-record-purge-step';

/** Metadata only. Starting/restarting this canonical workflow must originate from the genuine
 * record-deletion outbox/control path; it cannot authorize an active record or invent read history. */
export async function knowledgeRecordPurgeWorkflow(
  input: KnowledgeRecordPurgeInput,
): Promise<RecordPurgeResult> {
  input = knowledgeRecordPurgeInputSchema.parse(input);
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
  const pass = () => runRecordPurge({
    materials: () => agent.purgeRecordMaterials(input),
    files: () => knowledge.purgeRecordFiles(input),
    confirm: () => knowledge.confirmRecordPurge(input),
  });
  // Existing manually started histories retain their original one-pass decisions.
  if (!patched('record-purge-durable-retry-v1')) return pass();
  const result = await retryRecordPurge({ pass, delay: (milliseconds) => sleep(milliseconds) }, input.retryAttempt);
  if (result.state === 'completed') return result.result;
  return continueAsNew<typeof knowledgeRecordPurgeWorkflow>({ ...input, retryAttempt: result.retryAttempt });
}
