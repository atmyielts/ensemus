// Owned by the purge slice (KNOW-05). See docs/06-delivery/m5-slices.md. `purgeSource` runs in the knowledge
// worker. `purgeRunTranscripts` runs in M4's agent worker, because only its role can reach prompts.
import type { KnowledgeTranscriptDeps, KnowledgeWorkerDeps } from './knowledge-deps';
import type { KnowledgePurgeInput, KnowledgePurgeResult } from './knowledge-schemas';

export function createKnowledgePurgeActivities(_deps: KnowledgeWorkerDeps) {
  return {
    async purgeSource(_input: KnowledgePurgeInput): Promise<KnowledgePurgeResult> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type KnowledgePurgeActivities = ReturnType<typeof createKnowledgePurgeActivities>;

export function createKnowledgeTranscriptActivities(_deps: KnowledgeTranscriptDeps) {
  return {
    /** Counts only. No prompt, and no run's content, comes back across Temporal. */
    async purgeRunTranscripts(_input: KnowledgePurgeInput): Promise<{ removed: number }> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type KnowledgeTranscriptActivities = ReturnType<typeof createKnowledgeTranscriptActivities>;
