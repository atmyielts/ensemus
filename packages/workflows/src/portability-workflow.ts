// Owned by the export slice (COMM-05). See docs/06-delivery/m6-slices.md and ADR-030 D7. Deterministic workflow
// code: only @temporalio/workflow and types may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { OrganizationExportInput, OrganizationExportResult } from './schemas';

/** Writes one archive, one bounded Activity at a time, with its place kept in PostgreSQL. */
export async function organizationExportWorkflow(
  _input: OrganizationExportInput,
): Promise<OrganizationExportResult> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
