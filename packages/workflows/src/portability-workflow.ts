// Owned by the export slice (COMM-05). See docs/06-delivery/m6-slices.md and ADR-030 D7. Deterministic workflow
// code: only @temporalio/workflow and types may be imported here, and `export-step.ts`, which only imports types.
import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  continueAsNew,
  isCancellation,
  proxyActivities,
  workflowInfo,
} from '@temporalio/workflow';
import { exportFailureFor, exportResult, nextExportMove, type ExportPhase } from './export-step';
import type { PortabilityActivities } from './portability-activities';
import type { OrganizationExportInput, OrganizationExportResult } from './schemas';

// An outage must not end an export, so these retry through any shorter than a day, as workUnitWorkflow's do. A
// refusal can never succeed by retrying, and goes straight to the failure path. The longest step seals and writes
// one part of 32 MiB, and portability-export.ts stops a step that nears this limit from writing anything.
const {
  beginOrganizationExport,
  exportOrganizationBatch,
  finishOrganizationExport,
  failOrganizationExport,
} = proxyActivities<PortabilityActivities>({
  startToCloseTimeout: '10 minutes',
  scheduleToCloseTimeout: '24 hours',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '1 minute',
    nonRetryableErrorTypes: ['AppError', 'TenantAccessDenied'],
  },
});

/** The steps, until they end or history is long enough to start over. Each one finds its place in PostgreSQL. */
async function runSteps(
  input: OrganizationExportInput,
): Promise<OrganizationExportResult | 'start_over'> {
  let phase: ExportPhase = 'batch';
  let parts = 0;
  let step = await beginOrganizationExport(input);
  for (;;) {
    if (step.state !== 'failed') parts = step.parts;
    const move = nextExportMove(phase, step, workflowInfo().continueAsNewSuggested);
    switch (move.kind) {
      case 'batch':
        step = await exportOrganizationBatch(input);
        break;
      case 'finish':
        phase = 'finish';
        step = await finishOrganizationExport(input);
        break;
      case 'fail':
        await failOrganizationExport({ ...input, code: move.code });
        return exportResult(input.exportId, 'failed', parts);
      case 'ready':
        return exportResult(input.exportId, 'ready', move.parts);
      case 'continue_as_new':
        return 'start_over';
    }
  }
}

/** Writes one archive, one bounded Activity at a time, with its place kept in PostgreSQL. */
export async function organizationExportWorkflow(
  input: OrganizationExportInput,
): Promise<OrganizationExportResult> {
  let outcome: OrganizationExportResult | 'start_over';
  try {
    outcome = await runSteps(input);
  } catch (error) {
    // A running row holds the tenant's one place for an export, so it must not be left running. If even this
    // fails, the workflow fails and stays visible.
    if (isCancellation(error)) {
      await CancellationScope.nonCancellable(() =>
        failOrganizationExport({ ...input, code: 'SECTION_FAILED' }),
      );
      throw error;
    }
    const type =
      error instanceof ActivityFailure && error.cause instanceof ApplicationFailure
        ? error.cause.type
        : null;
    await CancellationScope.nonCancellable(() =>
      failOrganizationExport({ ...input, code: exportFailureFor(type) }),
    );
    return exportResult(input.exportId, 'failed', 0);
  }
  // Out here because this works by throwing, and the handler above must not take it for a failure.
  if (outcome === 'start_over') return continueAsNew<typeof organizationExportWorkflow>(input);
  return outcome;
}
