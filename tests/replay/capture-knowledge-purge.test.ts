// Capture only on the isolated capture stack. These are Activity-boundary histories, not DB acceptance.
import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { capturing, withCaptureWorkers } from './capture-support';
describe.skipIf(!capturing)('capture knowledge purge histories', () => {
  it('records completion, a store retry with a fresh fence, and an unavailable transcript worker', async () => {
    let mode: 'complete' | 'store_retry' | 'unconfirmed' = 'complete',
      attempt = 0;
    await withCaptureWorkers(
      {
        queues: [`capture-purge-${randomUUID()}`, 'ensemus-agent', 'ensemus-knowledge'],
        activities: {
          purgeRunTranscripts: async () => {
            if (mode === 'unconfirmed') throw new Error('TRANSCRIPT_PURGE_UNCONFIRMED');
            return { removed: 1 };
          },
          purgeSource: async () => ({
            state: mode === 'store_retry' && attempt++ === 0 ? 'failed' : 'completed',
            chunks: 2,
          }),
          markPurgeFailed: async () => ({ state: 'failed', chunks: 0 }),
        },
      },
      async ({ record }) => {
        const args = [
          {
            organizationId: '00000000-0000-4000-8000-000000000a01',
            sourceId: '00000000-0000-4000-8000-000000000501',
          },
        ];
        await record('knowledge-purge-completed', { workflowType: 'knowledgePurgeWorkflow', args });
        mode = 'store_retry';
        await record('knowledge-purge-store-retry', {
          workflowType: 'knowledgePurgeWorkflow',
          args,
        });
        mode = 'unconfirmed';
        await record('knowledge-purge-unconfirmed', {
          workflowType: 'knowledgePurgeWorkflow',
          args,
        });
      },
    );
  }, 180_000);
});
