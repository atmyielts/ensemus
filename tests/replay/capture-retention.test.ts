import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { capturing, withCaptureWorkers } from './capture-support';
describe.skipIf(!capturing)('capture bounded retention pages', () => {
  it('records complete, held and continuing pages using counters only', async () => {
    let variant = 'complete';
    await withCaptureWorkers(
      {
        queues: ['ensemus-platform'],
        activities: {
          sweepRetentionPage: async () => ({
            categories: 1,
            removed: variant === 'held' ? 0 : 1,
            held: variant === 'held' ? 1 : 0,
            more: variant === 'more',
          }),
        },
      },
      async (run) => {
        for (const path of ['complete', 'held', 'more']) {
          variant = path;
          await run.record(`retention-${path}`, {
            workflowType: 'retentionSweepWorkflow',
            args: [{ organizationId: randomUUID() }],
          });
        }
      },
    );
  }, 120000);
});
