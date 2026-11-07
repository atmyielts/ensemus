// Owned by the objects slice (KNOW-07). See docs/06-delivery/m7-slices.md and ADR-031 D11.
import { failObjectMigration, migrateObjectBatch } from '@ensemus/application/custom-objects';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import type { ObjectMigrationInput } from './product-schemas';

const BATCH_SIZE = 200;

export function createObjectMigrationActivities(deps: { database: AppDatabase }) {
  return {
    async migrateBatch(input: ObjectMigrationInput): Promise<{ more: boolean }> {
      return migrateObjectBatch(deps.database, createServiceContext(input.organizationId), {
        migrationId: input.migrationId,
        batchSize: BATCH_SIZE,
      });
    },
    async failMigration(input: ObjectMigrationInput): Promise<void> {
      await failObjectMigration(deps.database, createServiceContext(input.organizationId), {
        migrationId: input.migrationId,
        code: 'MIGRATION_FAILED',
      });
    },
  };
}
export type ObjectMigrationActivities = ReturnType<typeof createObjectMigrationActivities>;
