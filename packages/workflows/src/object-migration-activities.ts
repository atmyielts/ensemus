// Owned by the objects slice (KNOW-07). See docs/06-delivery/m7-slices.md and ADR-031 D11.
import {
  failObjectMigration,
  migrateObjectBatch,
  getObjectMigrationStatus,
} from '@ensemus/application/custom-objects';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { AppError } from '@ensemus/application';
import { ApplicationFailure } from '@temporalio/common';
import type { ObjectMigrationInput } from './product-schemas';

const BATCH_SIZE = 200;

/** No document/field values or driver errors cross the durable workflow boundary. */
export function objectMigrationActivityFailure(error: unknown): ApplicationFailure {
  return ApplicationFailure.create({
    type: error instanceof AppError ? error.code : 'OBJECT_MIGRATION_RETRYABLE',
    message: 'Custom record migration interrupted',
    details: [],
    nonRetryable:
      error instanceof AppError
        ? !['RESTORE_PENDING', 'VERSION_CONFLICT'].includes(error.code)
        : error instanceof ApplicationFailure && error.nonRetryable === true,
  });
}

export function createObjectMigrationActivities(deps: { database: AppDatabase }) {
  return {
    async migrateBatch(input: ObjectMigrationInput): Promise<{ more: boolean; failed: boolean }> {
      try {
        const context = createServiceContext(input.organizationId);
        const result = await migrateObjectBatch(deps.database, context, {
          migrationId: input.migrationId,
          batchSize: BATCH_SIZE,
        });
        return {
          ...result,
          failed:
            !result.more &&
            (await getObjectMigrationStatus(deps.database, context, input.migrationId)) ===
              'failed',
        };
      } catch (error) {
        throw objectMigrationActivityFailure(error);
      }
    },
    async failMigration(input: ObjectMigrationInput): Promise<void> {
      try {
        await failObjectMigration(deps.database, createServiceContext(input.organizationId), {
          migrationId: input.migrationId,
          code: 'MIGRATION_FAILED',
        });
      } catch (error) {
        throw objectMigrationActivityFailure(error);
      }
    },
  };
}
export type ObjectMigrationActivities = ReturnType<typeof createObjectMigrationActivities>;
