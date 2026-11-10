import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { capturing, withCaptureWorkers } from './capture-support';
describe.skipIf(!capturing)('capture offboarding prerequisites and operator stops', () => {
  it('records wait, hold, cancellation and reported histories with only IDs and outcomes', async () => {
    let variant = 'awaiting_operator',
      call = 0;
    await withCaptureWorkers(
      {
        queues: ['ensemus-platform'],
        activities: {
          advanceOffboardingStep: async () => {
            call += 1;
            if (variant === 'wait' && call === 1) return { kind: 'wait', untilMs: Date.now() + 1 };
            if (variant === 'awaiting_operator' && call === 1) return { kind: 'continue' };
            return { kind: 'stop', outcome: variant === 'wait' ? 'awaiting_operator' : variant };
          },
        },
      },
      async (run) => {
        for (const path of [
          'awaiting_operator',
          'wait',
          'blocked_by_hold',
          'cancelled',
          'reported',
        ]) {
          variant = path;
          call = 0;
          await run.record(`offboarding-${path}`, {
            workflowType: 'tenantOffboardingWorkflow',
            args: [{ organizationId: randomUUID(), offboardingId: randomUUID() }],
          });
        }
      },
    );
  }, 120000);
});
