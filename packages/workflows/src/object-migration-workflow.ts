// Moving a custom type's records to its new shape, in batches (KNOW-07). Deterministic workflow code: only
// @temporalio/workflow and types may be imported here. Owned by the objects slice.
import { continueAsNew, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { ObjectMigrationActivities } from './object-migration-activities';
import type { ObjectMigrationInput, ObjectMigrationOutcome } from './product-schemas';

const { migrateBatch, failMigration } = proxyActivities<ObjectMigrationActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { initialInterval: '5 seconds', maximumInterval: '1 minute', backoffCoefficient: 2 },
});

export async function objectMigrationWorkflow(
  input: ObjectMigrationInput,
): Promise<ObjectMigrationOutcome> {
  try {
    for (;;) {
      const { more, failed } = await migrateBatch(input);
      if (!more) return failed ? 'failed' : 'completed';
      if (workflowInfo().continueAsNewSuggested) {
        await continueAsNew<typeof objectMigrationWorkflow>(input);
      }
    }
  } catch {
    await failMigration(input);
    return 'failed';
  }
}
