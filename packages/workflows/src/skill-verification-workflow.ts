// Owned by the skill-verification slice (EXP-04). See docs/06-delivery/m11b-slices.md and ADR-034 D1, D2.
// Deterministic workflow code: only @temporalio/workflow and types may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { SkillVerificationInput, SkillVerificationOutcome } from './schemas';

/**
 * Takes one uploaded version to `verified` or `rejected`. Checks the bundle in one Activity, and for a
 * package with code runs each fixture as a child sandboxRunWorkflow, in order, then settles from the rows.
 */
export async function skillVerificationWorkflow(
  _input: SkillVerificationInput,
): Promise<SkillVerificationOutcome> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
