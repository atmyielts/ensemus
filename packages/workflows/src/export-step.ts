// The decisions in an organization export, kept pure so they can be tested without Temporal. This file is
// imported by workflow code, so it may only import types.
import type { ExportStep } from '@ensemus/application';
import type { ExportFailureCode } from '@ensemus/domain/portability';
import type { OrganizationExportResult } from './schemas';

/** Which Activity the workflow is on: the batches, or the tombstones and manifest after them. */
export type ExportPhase = 'batch' | 'finish';

export type ExportMove =
  | { kind: 'batch' }
  | { kind: 'finish' }
  | { kind: 'fail'; code: ExportFailureCode }
  | { kind: 'ready'; parts: number }
  /** History is getting long. The next run begins again from what the export's row says. */
  | { kind: 'continue_as_new' };

/**
 * What comes after a step's answer. The answer to `begin` counts as a batch's: `finished` there means the row is
 * already done, and asking `finish` about a finished row is safe, so it needs no path of its own.
 */
export function nextExportMove(
  phase: ExportPhase,
  step: ExportStep,
  continueAsNewSuggested: boolean,
): ExportMove {
  switch (step.state) {
    case 'failed':
      return { kind: 'fail', code: step.code };
    case 'finished':
      return phase === 'batch' ? { kind: 'finish' } : { kind: 'ready', parts: step.parts };
    case 'continue':
      if (continueAsNewSuggested) return { kind: 'continue_as_new' };
      return { kind: phase };
  }
}

/**
 * The code for an Activity that failed for good. Only the error's type is read, so no text from a store or a
 * record can reach a row. A store that stayed down says so, and anything else is the section's own failure.
 */
export function exportFailureFor(errorType: string | null | undefined): ExportFailureCode {
  return errorType === 'STORE_UNAVAILABLE' ? 'STORE_UNAVAILABLE' : 'SECTION_FAILED';
}

export const exportResult = (
  exportId: string,
  outcome: OrganizationExportResult['outcome'],
  parts: number,
): OrganizationExportResult => ({ exportId, outcome, parts });
