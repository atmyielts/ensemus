import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PLATFORM_TASK_QUEUE } from '@ensemus/workflows/constants';
import type { MeetingDerivationOutcome } from '@ensemus/workflows/schemas';
import { capturing, withCaptureWorkers } from './capture-support';

describe.skipIf(!capturing)('capture meeting derivation', () => {
  it('records completion, refusal, discarded output, and cleanup after both attempts fail', async () => {
    let outcome: MeetingDerivationOutcome = 'completed';
    let fail = false;
    let attempts = 0;
    await withCaptureWorkers(
      {
        queues: [`capture-meeting-derivation-${randomUUID()}`, PLATFORM_TASK_QUEUE],
        identity: 'meeting-derivation-replay-fixture',
        activities: {
          runMeetingDerivation: async () => {
            if (fail) {
              attempts++;
              const failure = new Error('MEETING_DERIVATION_ACTIVITY_FAILED');
              delete failure.stack;
              throw failure;
            }
            return outcome;
          },
          stopInterruptedDerivation: async () => 'failed',
        },
      },
      async ({ record }) => {
        const information = { organizationId: randomUUID(), derivationRunId: randomUUID() };
        for (const next of ['completed', 'refused', 'dropped'] as const) {
          outcome = next;
          await record(`meeting-derivation-${next}`, {
            workflowType: 'meetingDerivationWorkflow',
            args: [information],
            afterStart: async (handle) => expect(await handle.result()).toBe(next),
          });
        }
        fail = true;
        await record('meeting-derivation-interrupted', {
          workflowType: 'meetingDerivationWorkflow',
          args: [information],
          afterStart: async (handle) => {
            expect(await handle.result()).toBe('failed');
            expect(attempts).toBe(2);
          },
        });
      },
    );
  }, 90_000);
});
