// Owned by the purge slice (KNOW-05). See docs/06-delivery/m5-slices.md. Runs in the knowledge worker.
import type { KnowledgeWorkerDeps } from './knowledge-deps';
import type { KnowledgePurgeInput, KnowledgePurgeResult } from './knowledge-schemas';

export function createKnowledgePurgeActivities(_deps: KnowledgeWorkerDeps) {
  return {
    async purgeSource(_input: KnowledgePurgeInput): Promise<KnowledgePurgeResult> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type KnowledgePurgeActivities = ReturnType<typeof createKnowledgePurgeActivities>;
