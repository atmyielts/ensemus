// Records connectorSyncWorkflow's paths, one history each, with stub Activities. Skipped unless
// ENSEMUS_CAPTURE_REPLAY=1, with a Temporal from compose.capture.yaml (see capture-support.ts). A recorded
// history is never rewritten: it is what proves a later change keeps runs like it working.
import { randomUUID } from 'node:crypto';
import { ApplicationFailure } from '@temporalio/common';
import { describe, it } from 'vitest';
import { PLATFORM_TASK_QUEUE, CONNECTOR_TASK_QUEUE } from '@ensemus/workflows/constants';
import type { ConnectorSyncOutcome } from '@ensemus/workflows/schemas';
import { capturing, withCaptureWorkers } from './capture-support';

const input = () => ({ organizationId: randomUUID(), connectionId: randomUUID() });

describe.skipIf(!capturing)('capture connector sync histories', () => {
  it('records each path', async () => {
    // What each pass finds, in order. A thrown result fails that Activity for good.
    let script: Array<ConnectorSyncOutcome | 'fail'> = [];
    const activities = {
      syncConnection: async (): Promise<ConnectorSyncOutcome> => {
        const next = script.shift();
        if (!next || next === 'fail') {
          throw ApplicationFailure.nonRetryable('Nothing real here', 'CAPTURE');
        }
        return next;
      },
    };

    await withCaptureWorkers(
      { activities, queues: [PLATFORM_TASK_QUEUE, CONNECTOR_TASK_QUEUE] },
      async (run) => {
        const record = async (name: string, passes: typeof script) => {
          script = passes;
          await run.record(name, { workflowType: 'connectorSyncWorkflow', args: [input()] });
        };
        await record('connector-sync-synced', [{ outcome: 'synced', pages: 2, resources: 5 }]);
        await record('connector-sync-more-pages', [
          { outcome: 'synced', pages: 20, resources: 400 },
          { outcome: 'synced', pages: 3, resources: 12 },
        ]);
        await record(
          'connector-sync-pass-limit',
          Array.from({ length: 10 }, () => ({
            outcome: 'synced' as const,
            pages: 20,
            resources: 1,
          })),
        );
        await record('connector-sync-revoked', [{ outcome: 'revoked', pages: 0, resources: 0 }]);
        await record('connector-sync-nothing-to-do', [
          { outcome: 'nothing_to_do', pages: 0, resources: 0 },
        ]);
        await record('connector-sync-failed', [{ outcome: 'failed', pages: 1, resources: 2 }]);
        await record('connector-sync-activity-failed', ['fail']);
      },
    );
  }, 120_000);
});
