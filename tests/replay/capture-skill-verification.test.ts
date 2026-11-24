import { randomUUID } from 'node:crypto';
import { ApplicationFailure } from '@temporalio/common';
import { SANDBOX_TASK_QUEUE } from '@ensemus/workflows/constants';
import { describe, expect, it } from 'vitest';
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

  it('records passing fixture children and stops when the runner is unavailable', async () => {
    let fixtureIds: string[];
    let unavailable = false;
    const executed: string[] = [];
    await withCaptureWorkers(
      {
        queues: ['ensemus-platform', SANDBOX_TASK_QUEUE],
        activities: {
          checkSkillBundle: async () => ({ step: 'run_fixtures', sandboxRunIds: fixtureIds }),
          executeSandboxRun: async ({ sandboxRunId }: { sandboxRunId: string }) => {
            executed.push(sandboxRunId);
            return { step: 'settled', outcome: unavailable ? 'runner_unavailable' : 'succeeded' };
          },
          finishSkillVerification: async () => (unavailable ? 'rejected' : 'verified'),
        },
      },
      async (run) => {
        for (const scenario of ['sandbox-verified', 'sandbox-unavailable'] as const) {
          unavailable = scenario === 'sandbox-unavailable';
          fixtureIds = [randomUUID(), randomUUID()];
          executed.length = 0;
          await run.record(`skill-verification-${scenario}`, {
            workflowType: 'skillVerificationWorkflow',
            args: [{ organizationId: randomUUID(), skillVersionId: randomUUID() }],
            async afterStart(handle) {
              await expect(handle.result()).resolves.toBe(unavailable ? 'rejected' : 'verified');
              expect(executed).toEqual(unavailable ? [fixtureIds[0]] : fixtureIds);
            },
          });
        }
      },
    );
  }, 120_000);
});
