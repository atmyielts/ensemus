// Owned by the meetings-connector slice (EXP-03). See docs/06-delivery/m11a-slices.md and ADR-033 D5. Deterministic
// workflow code: only @temporalio/workflow, the queue names and types may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { MeetingImportInput, MeetingImportOutcome } from './schemas';

/** Reads one meeting's notes from its source, once, on the connector queue. */
export async function meetingImportWorkflow(
  _input: MeetingImportInput,
): Promise<MeetingImportOutcome> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
