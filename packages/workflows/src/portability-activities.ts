// Owned by the export slice (COMM-05). See docs/06-delivery/m6-slices.md and ADR-030 D7. Each takes IDs, does
// one bounded piece of work, and is safe to retry. They read PostgreSQL and the object store and hold no
// private key, so they run on the platform queue.
import {
  beginExport,
  exportNextBatch,
  ExportStoreUnavailable,
  failExport,
  finishExport,
  type ExportDeps,
  type ExportStep,
  type ObjectStore,
} from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import type { ExportFailureCode } from '@ensemus/domain/portability';
import { createLogger } from '@ensemus/telemetry';
import { ApplicationFailure } from '@temporalio/common';
import {
  organizationExportInputSchema,
  organizationExportWorkflowIdFor,
  type OrganizationExportInput,
} from './schemas';

const log = createLogger('worker');

/**
 * Names a store outage for the workflow, which only ever reads this type. It stays retryable, so an outage is
 * waited out, and the name is what ends up as the code if it never comes back.
 */
async function namingOutage<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ExportStoreUnavailable) {
      throw ApplicationFailure.retryable('The object store did not answer', 'STORE_UNAVAILABLE');
    }
    throw error;
  }
}

export function createPortabilityActivities(deps: {
  database: AppDatabase;
  store: ObjectStore;
  exportDeps: ExportDeps;
}) {
  const { database, store, exportDeps } = deps;

  /** Anything that was not made here is refused before it can name a tenant. */
  const scope = (raw: OrganizationExportInput) => {
    const input = organizationExportInputSchema.parse(raw);
    return {
      context: createServiceContext(input.organizationId),
      exportId: input.exportId,
      // IDs and a code, which is all a log line about an export ever holds.
      workflowId: organizationExportWorkflowIdFor(input),
    };
  };

  return {
    async beginOrganizationExport(input: OrganizationExportInput): Promise<ExportStep> {
      const { context, exportId } = scope(input);
      return beginExport(database, context, { exportId }, exportDeps);
    },
    async exportOrganizationBatch(input: OrganizationExportInput): Promise<ExportStep> {
      const { context, exportId } = scope(input);
      return namingOutage(() =>
        exportNextBatch(database, store, context, { exportId }, exportDeps),
      );
    },
    async finishOrganizationExport(input: OrganizationExportInput): Promise<ExportStep> {
      const { context, exportId } = scope(input);
      return namingOutage(() => finishExport(database, store, context, { exportId }, exportDeps));
    },
    async failOrganizationExport(
      input: OrganizationExportInput & { code: ExportFailureCode },
    ): Promise<void> {
      const { code, ...ids } = input;
      const { context, exportId, workflowId } = scope(ids);
      await failExport(database, context, { exportId, code });
      log.warn('organization_export.failed', { workflowId, reasonCode: code });
    },
  };
}
export type PortabilityActivities = ReturnType<typeof createPortabilityActivities>;
