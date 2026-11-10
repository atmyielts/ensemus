// Test-only activities capture real Temporal control flow, never stand in for product database work.
import { ApplicationFailure } from '@temporalio/common';
import { describe, it } from 'vitest';
import { capturing, withCaptureWorkers } from './capture-support';
describe.skipIf(!capturing)('capture custom object migration histories', () => {
  it('captures bounded batches, retryable interruption and permanent refusal', async () => {
    let count = 0,
      scenario: 'batches' | 'retry' | 'refusal' | 'partial' = 'batches';
    await withCaptureWorkers(
      {
        queues: ['capture-object-migration'],
        activities: {
          migrateBatch: async () => {
            count++;
            if (scenario === 'refusal')
              throw ApplicationFailure.nonRetryable('Synthetic refusal', 'INVALID_STATE');
            if (scenario === 'retry' && count === 1)
              throw new Error('Synthetic connection interruption');
            return { more: count < 3, failed: scenario === 'partial' && count >= 3 };
          },
          failMigration: async () => undefined,
        },
      },
      async ({ record }) => {
        const input = {
          organizationId: '00000000-0000-4000-8000-000000000701',
          migrationId: '00000000-0000-4000-8000-000000000702',
        };
        for (const [kind, name] of [
          ['batches', 'object-migration-batches'],
          ['retry', 'object-migration-interrupted'],
          ['refusal', 'object-migration-refused'],
          ['partial', 'object-migration-partial'],
        ] as const) {
          scenario = kind;
          count = 0;
          await record(name, { workflowType: 'objectMigrationWorkflow', args: [input] });
        }
      },
    );
  });
});
