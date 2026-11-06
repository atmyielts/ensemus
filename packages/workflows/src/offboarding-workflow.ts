// Owned by the offboarding slice (LIFE-04). Deterministic: only @temporalio/workflow and types. It asks for one
// step at a time and waits durably, and stops before anything irreversible, which an operator does by hand.
import { ApplicationFailure } from '@temporalio/workflow';
import type { OffboardingInput, OffboardingOutcome } from './saas-schemas';

export async function tenantOffboardingWorkflow(
  _input: OffboardingInput,
): Promise<OffboardingOutcome> {
  throw ApplicationFailure.nonRetryable('NOT_IMPLEMENTED');
}
