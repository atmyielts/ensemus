// Owned by the compile slice (UX-18's backend). See docs/06-delivery/m5-slices.md and ADR-029 D5.
// Deterministic workflow code: only @temporalio/workflow and types may be imported here.
import { ActivityFailure, proxyActivities, TimeoutFailure } from '@temporalio/workflow';
import type { KnowledgeAnswerInput, KnowledgeAnswerResult } from './knowledge-schemas';
import type {
  KnowledgeAnswerActivities,
  KnowledgeAnswerFallbackActivities,
} from './knowledge-answer-activities';
import { runKnowledgeAnswer } from './knowledge-answer-step';

/**
 * One Activity, `answerQuestion`, on `KNOWLEDGE_MODEL_TASK_QUEUE`, with a `scheduleToStartTimeout`. If no
 * model worker takes it, `failAnswer` on `KNOWLEDGE_TASK_QUEUE` ends it with `MODEL_UNAVAILABLE`. A model
 * call is not retried here, because M4's ledger has to count what a lost answer cost.
 */
export async function knowledgeAnswerWorkflow(
  input: KnowledgeAnswerInput,
): Promise<KnowledgeAnswerResult> {
  const models = proxyActivities<KnowledgeAnswerActivities>({
    taskQueue: 'ensemus-agent',
    startToCloseTimeout: '5 minutes',
    scheduleToStartTimeout: '30 seconds',
    retry: { maximumAttempts: 1 },
  });
  const local = proxyActivities<KnowledgeAnswerFallbackActivities>({
    taskQueue: 'ensemus-knowledge',
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 3 },
  });
  return runKnowledgeAnswer({
    answer: () => models.answerQuestion(input),
    fail: () => local.failAnswer(input),
    modelWorkerAbsent: (error) =>
      error instanceof ActivityFailure &&
      error.cause instanceof TimeoutFailure &&
      error.cause.timeoutType === 'SCHEDULE_TO_START',
  });
}
