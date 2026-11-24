import { randomUUID } from 'node:crypto';
import { ApplicationFailure } from '@temporalio/common';
import { describe, it } from 'vitest';
import { capturing, withCaptureWorkers } from './capture-support';

describe.skipIf(!capturing)('capture skill verification outcomes', () => {
  it('records the successful check and the rejection after storage retries', async () => {
    let unavailable = false;
    await withCaptureWorkers(
      {
        queues: ['ensemus-platform'],
        activities: {
          checkSkillBundle: async () => {
            if (unavailable)
              throw ApplicationFailure.retryable(
                'Skill bundle read failed',
                'SKILL_BUNDLE_READ_FAILED',
              );
            return { step: 'finished', outcome: 'verified' };
          },
          abandonSkillVerification: async (_input: unknown, code: string) => {
            if (code !== 'BUNDLE_UNAVAILABLE')
              throw ApplicationFailure.nonRetryable('Wrong code', 'TEST_FAILURE');
            return 'rejected';
          },
        },
      },
      async (run) => {
        const args = () => [{ organizationId: randomUUID(), skillVersionId: randomUUID() }];
        await run.record('skill-verification-declarative-verified', {
          workflowType: 'skillVerificationWorkflow',
          args: args(),
        });
        unavailable = true;
        await run.record('skill-verification-bundle-unavailable', {
          workflowType: 'skillVerificationWorkflow',
          args: args(),
        });
      },
    );
  }, 120_000);
});
