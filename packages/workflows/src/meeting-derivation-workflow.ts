// Owned by the meetings-derivation slice (EXP-03). See docs/06-delivery/m11a-slices.md and ADR-033 D6. Deterministic
// workflow code: only @temporalio/workflow, the queue names and types may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { MeetingDerivationInput, MeetingDerivationOutcome } from './schemas';

/** Takes one requested run to completed, failed or refused. It ends there, and starts nothing else. */
export async function meetingDerivationWorkflow(
  _input: MeetingDerivationInput,
): Promise<MeetingDerivationOutcome> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
