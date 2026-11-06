// Owned by the export slice (COMM-05). See docs/06-delivery/m6-slices.md and ADR-030 D7. Each takes IDs, does
// one bounded piece of work, and is safe to retry. They read PostgreSQL and the object store and hold no
// private key, so they run on the platform queue.
import type { ExportDeps, ExportStep, ObjectStore } from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';
import type { ExportFailureCode } from '@ensemus/domain/portability';
import type { OrganizationExportInput } from './schemas';

export function createPortabilityActivities(_deps: {
  database: AppDatabase;
  store: ObjectStore;
  exportDeps: ExportDeps;
}) {
  return {
    async beginOrganizationExport(_input: OrganizationExportInput): Promise<ExportStep> {
      throw new Error('NOT_IMPLEMENTED');
    },
    async exportOrganizationBatch(_input: OrganizationExportInput): Promise<ExportStep> {
      throw new Error('NOT_IMPLEMENTED');
    },
    async finishOrganizationExport(_input: OrganizationExportInput): Promise<ExportStep> {
      throw new Error('NOT_IMPLEMENTED');
    },
    async failOrganizationExport(
      _input: OrganizationExportInput & { code: ExportFailureCode },
    ): Promise<void> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type PortabilityActivities = ReturnType<typeof createPortabilityActivities>;
