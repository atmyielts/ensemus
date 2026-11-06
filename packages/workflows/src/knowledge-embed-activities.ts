// Owned by the egress slice (MODEL-05). See docs/06-delivery/m5-slices.md. Runs in M4's agent worker.
import type { KnowledgeModelDeps } from './knowledge-deps';
import type { KnowledgeIngestInput } from './knowledge-schemas';

export type EmbedStepResult = { state: 'embedded' | 'denied' | 'failed' | 'skipped'; count: number };

export function createKnowledgeEmbedActivities(_deps: KnowledgeModelDeps) {
  return {
    async embedDocumentChunks(_input: KnowledgeIngestInput): Promise<EmbedStepResult> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type KnowledgeEmbedActivities = ReturnType<typeof createKnowledgeEmbedActivities>;
