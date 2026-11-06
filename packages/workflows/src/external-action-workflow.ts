// Owned by the intents slice (WORK-08). See docs/06-delivery/m3-slices.md and ADR-027 D2. Deterministic
// workflow code: only @temporalio/workflow and types may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { ExternalActionInput, ExternalActionResult } from './schemas';

/** Takes one approved intent to sent, failed, unknown or cancelled. No event starts this until M3 lands. */
export async function externalActionWorkflow(
  _input: ExternalActionInput,
): Promise<ExternalActionResult> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
