import { randomUUID } from 'node:crypto';
import { Context } from '@temporalio/activity';
import { describe, expect, it } from 'vitest';
import { AGENT_TASK_QUEUE, PLATFORM_TASK_QUEUE } from '@ensemus/workflows/constants';
import { capturing, withCaptureWorkers } from './capture-support';

describe.skipIf(!capturing)('capture governed meeting derivation', () => {
  it('routes model work and failure cleanup to their own worker queues', async () => {
    let fail = false;
    let attempts = 0;
    await withCaptureWorkers(
      {
        queues: [`capture-meeting-governed-${randomUUID()}`, AGENT_TASK_QUEUE, PLATFORM_TASK_QUEUE],
        identity: 'meeting-derivation-replay-fixture',
        activities: {
          runGovernedMeetingDerivation: async () => {
            expect(Context.current().info.taskQueue).toBe(AGENT_TASK_QUEUE);
            if (fail) {
              attempts++;
              const failure = new Error('MEETING_DERIVATION_ACTIVITY_FAILED');
              delete failure.stack;
              throw failure;
            }
            return 'completed';
          },
          stopInterruptedDerivation: async () => {
            expect(Context.current().info.taskQueue).toBe(PLATFORM_TASK_QUEUE);
            return 'failed';
          },
        },
      },
      async ({ record }) => {
        const args = [{ organizationId: randomUUID(), derivationRunId: randomUUID() }];
        await record('meeting-derivation-governed-completed', {
          workflowType: 'meetingDerivationWorkflow',
          args,
          afterStart: async (handle) => expect(await handle.result()).toBe('completed'),
        });
        fail = true;
        await record('meeting-derivation-governed-interrupted', {
          workflowType: 'meetingDerivationWorkflow',
          args,
          afterStart: async (handle) => {
            expect(await handle.result()).toBe('failed');
            expect(attempts).toBe(2);
          },
        });
      },
    );
  }, 90_000);
});
