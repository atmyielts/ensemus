// Capture only on the isolated capture stack, with product workers stopped. Never rewrite a history.
import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import type { ParseStep } from '@ensemus/workflows/knowledge-ingest-activities';
import type { EmbedStepResult } from '@ensemus/workflows/knowledge-embed-activities';
import { capturing, withCaptureWorkers } from './capture-support';

describe.skipIf(!capturing)('capture knowledge ingest and sweep histories', () => {
  it('records success, policy denial, rejected content, closure and a bounded sweep', async () => {
    let outcome: ParseStep['outcome'] = 'searchable';
    let embedding: EmbedStepResult['state'] = 'embedded';
    let reindex = false;
    let repair = false;
    let retryPurge = false;
    await withCaptureWorkers(
      {
        queues: [
          `capture-knowledge-${randomUUID()}`,
          'ensemus-knowledge',
          'ensemus-agent',
          'ensemus-connectors',
          'ensemus-platform',
        ],
        activities: {
          parseAndChunk: async () => ({ outcome, chunks: outcome === 'searchable' ? 2 : 0 }),
          embedDocumentChunks: async () => ({
            state: embedding,
            count: embedding === 'embedded' ? 2 : 0,
          }),
          closeOrphanedSources: async () => ({ closed: 1 }),
          listStaleResources: async () => [
            { externalResourceId: '00000000-0000-4000-8000-000000000e01' },
          ],
          fetchConnectorContent: async () => ({ outcome: 'staged', bytes: 10 }),
          listMcpConnections: async () => [],
          listDocumentsNeedingEmbedding: async () =>
            reindex ? [{ documentId: '00000000-0000-4000-8000-000000000d01' }] : [],
          listDocumentsNeedingIngestion: async () =>
            repair ? [{ documentId: '00000000-0000-4000-8000-000000000d01' }] : [],
          claimSourcePurgeRetries: async () =>
            retryPurge ? [{ sourceId: '00000000-0000-4000-8000-000000000501' }] : [],
          readSourcePurgeState: async () => ({ state: 'completed', chunks: 2 }),
          purgeRunTranscripts: async () => ({ removed: 0 }),
          purgeSource: async () => ({ state: 'completed', chunks: 2 }),
          markPurgeFailed: async () => ({ state: 'failed', chunks: 0 }),
        },
      },
      async ({ record }) => {
        const input = {
          organizationId: '00000000-0000-4000-8000-000000000a01',
          documentId: '00000000-0000-4000-8000-000000000d01',
        };
        await record('knowledge-ingest-searchable', {
          workflowType: 'knowledgeIngestWorkflow',
          args: [input],
        });
        embedding = 'denied';
        await record('knowledge-ingest-embedding-denied', {
          workflowType: 'knowledgeIngestWorkflow',
          args: [input],
        });
        outcome = 'rejected';
        await record('knowledge-ingest-rejected', {
          workflowType: 'knowledgeIngestWorkflow',
          args: [input],
        });
        outcome = 'closed';
        await record('knowledge-ingest-closed', {
          workflowType: 'knowledgeIngestWorkflow',
          args: [input],
        });
        await record('knowledge-sweep-staged', {
          workflowType: 'knowledgeSweepWorkflow',
          args: [{ organizationId: input.organizationId }],
        });
        reindex = true;
        embedding = 'embedded';
        await record('knowledge-sweep-reindex', {
          workflowType: 'knowledgeSweepWorkflow',
          args: [{ organizationId: input.organizationId }],
        });
        repair = true;
        reindex = false;
        outcome = 'searchable';
        await record('knowledge-sweep-repair-ingest', {
          workflowType: 'knowledgeSweepWorkflow',
          args: [{ organizationId: input.organizationId }],
        });
        repair = false;
        retryPurge = true;
        await record('knowledge-sweep-retry-purge', {
          workflowType: 'knowledgeSweepWorkflow',
          args: [{ organizationId: input.organizationId }],
        });
      },
    );
  }, 180_000);
});
