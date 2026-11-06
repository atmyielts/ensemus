import type { KnowledgeAnswerResult } from './knowledge-schemas';

/** The model Activity is attempted once. A lost result ends visibly, rather than making a second call. */
export async function runKnowledgeAnswer(ports: {
  answer(): Promise<KnowledgeAnswerResult>;
  fail(): Promise<void>;
  modelWorkerAbsent(error: unknown): boolean;
}): Promise<KnowledgeAnswerResult> {
  try {
    return await ports.answer();
  } catch (error) {
    await ports.fail();
    return { outcome: ports.modelWorkerAbsent(error) ? 'model_worker_absent' : 'failed' };
  }
}
