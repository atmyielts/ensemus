// Owned by the flagship slice (AGENT-12). See docs/06-delivery/m5-slices.md and ADR-029 D12. Deterministic
// workflow code: only @temporalio/workflow and types may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { ClientOnboardingInput, ClientOnboardingResult } from './knowledge-schemas';

/**
 * Calls `advanceOnboarding` on the platform queue, and sleeps on a durable timer between looks. It decides
 * nothing itself, so a change in the steps needs no patch here. `continueAsNew` before history grows long,
 * because a person's acceptance can take days.
 */
export async function clientOnboardingWorkflow(
  _input: ClientOnboardingInput,
): Promise<ClientOnboardingResult> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
