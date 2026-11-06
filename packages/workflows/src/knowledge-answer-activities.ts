// Owned by the compile slice (UX-18's backend). See docs/06-delivery/m5-slices.md. `answerQuestion` runs in
// M4's agent worker, under a delegated context for the person who asked, and never a bare service context.
// `failAnswer` runs in the knowledge worker, for when no agent worker came.
import type { AppDatabase } from '@ensemus/database';
import type { KnowledgeModelDeps } from './knowledge-deps';
import type { KnowledgeAnswerInput, KnowledgeAnswerResult } from './knowledge-schemas';

export function createKnowledgeAnswerActivities(_deps: KnowledgeModelDeps) {
  return {
    async answerQuestion(_input: KnowledgeAnswerInput): Promise<KnowledgeAnswerResult> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type KnowledgeAnswerActivities = ReturnType<typeof createKnowledgeAnswerActivities>;

export function createKnowledgeAnswerFallbackActivities(_deps: { database: AppDatabase }) {
  return {
    async failAnswer(_input: KnowledgeAnswerInput): Promise<void> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type KnowledgeAnswerFallbackActivities = ReturnType<
  typeof createKnowledgeAnswerFallbackActivities
>;
