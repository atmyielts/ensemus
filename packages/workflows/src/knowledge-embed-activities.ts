// Owned by the egress slice (MODEL-05). See docs/06-delivery/m5-slices.md. Runs in M4's agent worker.
import type { KnowledgeModelDeps } from './knowledge-deps';
import type { KnowledgeIngestInput } from './knowledge-schemas';
import { embedDocument } from '@ensemus/application/knowledge/embeddings';
import { createServiceContext } from '@ensemus/database/service';

export type EmbedStepResult = {
  state: 'embedded' | 'denied' | 'failed' | 'skipped';
  count: number;
};

export function createKnowledgeEmbedActivities(deps: KnowledgeModelDeps) {
  return {
    async embedDocumentChunks(input: KnowledgeIngestInput): Promise<EmbedStepResult> {
      const result = await embedDocument(
        deps.database,
        createServiceContext(input.organizationId),
        deps,
        {
          documentId: input.documentId,
          signal: deps.activitySignal?.() ?? AbortSignal.timeout(240_000),
        },
      );
      return {
        state:
          result.state === 'embedded' || result.state === 'denied' || result.state === 'failed'
            ? result.state
            : 'skipped',
        count: result.embedded,
      };
    },
  };
}
export type KnowledgeEmbedActivities = ReturnType<typeof createKnowledgeEmbedActivities>;
