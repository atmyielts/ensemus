import { randomUUID } from 'node:crypto';
import { Context } from '@temporalio/activity';
import { CONNECTOR_TASK_QUEUE, PLATFORM_TASK_QUEUE } from '@ensemus/workflows/constants';
import { describe, expect, it } from 'vitest';
import { capturing, withCaptureWorkers } from './capture-support';

describe.skipIf(!capturing)('capture meeting import routes', () => {
  it('records the connector read and platform fallback with identifier-only inputs', async () => {
    let interrupted = false;
    let failures = 0;
    await withCaptureWorkers(
      {
        queues: [
          `capture-meeting-import-${randomUUID()}`,
          CONNECTOR_TASK_QUEUE,
          PLATFORM_TASK_QUEUE,
        ],
        identity: 'meeting-import-replay-fixture',
        activities: {
          readMeetingNotes: async () => {
            expect(Context.current().info.taskQueue).toBe(CONNECTOR_TASK_QUEUE);
            if (!interrupted) return 'completed';
            failures++;
            const fault = new Error('MEETING_IMPORT_UNAVAILABLE');
            delete fault.stack;
            throw fault;
          },
          stopUnreadImport: async () => {
            expect(Context.current().info.taskQueue).toBe(PLATFORM_TASK_QUEUE);
            return 'failed';
          },
        },
      },
      async ({ record }) => {
        const args = [{ organizationId: randomUUID(), importRequestId: randomUUID() }];
        await record('meeting-import-completed', {
          workflowType: 'meetingImportWorkflow',
          args,
          afterStart: async (handle) => expect(await handle.result()).toBe('completed'),
        });
        interrupted = true;
        await record('meeting-import-fallback', {
          workflowType: 'meetingImportWorkflow',
          args,
          afterStart: async (handle) => {
            expect(await handle.result()).toBe('failed');
            expect(failures).toBe(3);
          },
        });
      },
    );
  }, 90_000);
});
