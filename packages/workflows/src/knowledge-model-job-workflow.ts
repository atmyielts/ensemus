import { ActivityFailure, TimeoutFailure, proxyActivities } from '@temporalio/workflow';
import { MAX_MODEL_JOB_TIMEOUT_SECONDS } from '@ensemus/domain/knowledge-models';
import { AGENT_TASK_QUEUE, KNOWLEDGE_TASK_QUEUE } from './constants';
import type { KnowledgeModelJobActivities } from './knowledge-model-job-activities';
import type { KnowledgeModelJobFallbackActivities } from './knowledge-model-job-fallback-activities';
import type {
  KnowledgeModelJobInput,
  KnowledgeModelJobResult,
} from './knowledge-model-job-schemas';
/** Only IDs/codes cross history. Unknown paid attempts are never automatically dispatched again. */
export async function knowledgeModelJobWorkflow(
  input: KnowledgeModelJobInput,
): Promise<KnowledgeModelJobResult> {
  const models = proxyActivities<KnowledgeModelJobActivities>({
    taskQueue: AGENT_TASK_QUEUE,
    startToCloseTimeout: MAX_MODEL_JOB_TIMEOUT_SECONDS * 1000,
    scheduleToStartTimeout: '30 seconds',
    retry: { maximumAttempts: 1 },
  });
  const control = proxyActivities<KnowledgeModelJobFallbackActivities>({
    taskQueue: KNOWLEDGE_TASK_QUEUE,
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 3 },
  });
  try {
    return await models.runKnowledgeModelJob(input);
  } catch (error) {
    const absent =
      error instanceof ActivityFailure &&
      error.cause instanceof TimeoutFailure &&
      error.cause.timeoutType === 'SCHEDULE_TO_START';
    // This can only refuse a still-unclaimed job. A dispatched unknown remains unresolved; no false
    // success or side-effect replay is attempted by the keyless worker.
    await control.refuseUnclaimedModelJob(input);
    return { state: absent ? 'model_worker_absent' : 'refused', code: 'MODEL_UNAVAILABLE' };
  }
}
