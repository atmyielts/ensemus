// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md. Runs in the knowledge worker.
import type { KnowledgeWorkerDeps } from './knowledge-deps';
import type { KnowledgeIngestInput } from './knowledge-schemas';
import type { TenantInput } from './schemas';

export type ParseStep = {
  outcome: 'searchable' | 'rejected' | 'failed' | 'closed' | 'already_done';
  chunks: number;
};

export function createKnowledgeIngestActivities(_deps: KnowledgeWorkerDeps) {
  return {
    async parseAndChunk(_input: KnowledgeIngestInput): Promise<ParseStep> {
      throw new Error('NOT_IMPLEMENTED');
    },
    /** IDs only, and bounded. The workflow hands each to `fetchConnectorContent`. */
    async listStaleResources(
      _input: TenantInput,
    ): Promise<readonly { externalResourceId: string }[]> {
      throw new Error('NOT_IMPLEMENTED');
    },
    async closeOrphanedSources(_input: TenantInput): Promise<{ closed: number }> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type KnowledgeIngestActivities = ReturnType<typeof createKnowledgeIngestActivities>;
