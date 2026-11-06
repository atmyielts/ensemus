// Owned by the compile slice (UX-18's backend). See docs/06-delivery/m5-slices.md and ADR-029 D5.
// Deterministic workflow code: only @temporalio/workflow and types may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { KnowledgeAnswerInput, KnowledgeAnswerResult } from './knowledge-schemas';

/**
 * One Activity, `answerQuestion`, on `KNOWLEDGE_MODEL_TASK_QUEUE`, with a `scheduleToStartTimeout`. If no
 * model worker takes it, `failAnswer` on `KNOWLEDGE_TASK_QUEUE` ends it with `MODEL_UNAVAILABLE`. A model
 * call is not retried here, because M4's ledger has to count what a lost answer cost.
 */
export async function knowledgeAnswerWorkflow(
  _input: KnowledgeAnswerInput,
): Promise<KnowledgeAnswerResult> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
