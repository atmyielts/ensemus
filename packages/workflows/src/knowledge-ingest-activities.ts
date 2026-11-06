// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md. Runs in the knowledge worker.
import type { KnowledgeWorkerDeps } from './knowledge-deps';
import {
  ingestDocument,
  listStaleConnectorResources,
  listDocumentsNeedingIngestion,
  recoverUnannouncedDocuments,
} from '@ensemus/application/knowledge/ingest';
import { closeOrphanedConnectorSources } from '@ensemus/application/knowledge/purge';
import { listDocumentsNeedingEmbedding } from '@ensemus/application/knowledge/embeddings';
import { connections, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { and, asc, eq } from 'drizzle-orm';
import type { KnowledgeIngestInput } from './knowledge-schemas';
import type { TenantInput } from './schemas';

export type ParseStep = {
  outcome: 'searchable' | 'rejected' | 'failed' | 'closed' | 'already_done';
  chunks: number;
};

export function createKnowledgeIngestActivities(deps: KnowledgeWorkerDeps) {
  return {
    async listDocumentsNeedingIngestion(
      input: TenantInput,
    ): Promise<readonly { documentId: string }[]> {
      return listDocumentsNeedingIngestion(
        deps.database,
        createServiceContext(input.organizationId),
        { limit: 50 },
      );
    },
    async listDocumentsNeedingEmbedding(
      input: TenantInput,
    ): Promise<readonly { documentId: string }[]> {
      return listDocumentsNeedingEmbedding(
        deps.database,
        createServiceContext(input.organizationId),
        { limit: 50 },
      );
    },
    async parseAndChunk(input: KnowledgeIngestInput): Promise<ParseStep> {
      const step = await ingestDocument(
        deps.database,
        deps.store,
        createServiceContext(input.organizationId),
        deps.ingest,
        input,
      );
      return { outcome: step.outcome, chunks: step.chunks };
    },
    /** IDs only, and bounded. The workflow hands each to `fetchConnectorContent`. */
    async listStaleResources(
      input: TenantInput,
    ): Promise<readonly { externalResourceId: string }[]> {
      const context = createServiceContext(input.organizationId);
      await recoverUnannouncedDocuments(deps.database, deps.store, context);
      const rows = await listStaleConnectorResources(deps.database, context, { limit: 50 });
      return rows.map(({ externalResourceId }) => ({ externalResourceId }));
    },
    async closeOrphanedSources(input: TenantInput): Promise<{ closed: number }> {
      return closeOrphanedConnectorSources(
        deps.database,
        createServiceContext(input.organizationId),
        { limit: 50 },
      );
    },
    /** Active `mcp_server` connections, whose tools the sweep refreshes through `refreshMcpTools`. */
    async listMcpConnections(input: TenantInput): Promise<readonly { connectionId: string }[]> {
      return withTenantTx(deps.database, createServiceContext(input.organizationId), (tx) =>
        tx
          .select({ connectionId: connections.id })
          .from(connections)
          .where(and(eq(connections.state, 'active'), eq(connections.connectorType, 'mcp_server')))
          .orderBy(asc(connections.id))
          .limit(50),
      );
    },
  };
}
export type KnowledgeIngestActivities = ReturnType<typeof createKnowledgeIngestActivities>;
