// Owned by the flagship slice (AGENT-12). See docs/06-delivery/m5-slices.md and ADR-029 D12. Deterministic
// workflow code: only @temporalio/workflow and types may be imported here.
import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type { ClientOnboardingInput, ClientOnboardingResult } from './knowledge-schemas';
import type { ClientOnboardingActivities } from './client-onboarding-activities';
import { runClientOnboarding } from './client-onboarding-step';

/**
 * Calls `advanceOnboarding` on the platform queue, and sleeps on a durable timer between looks. It decides
 * nothing itself, so a change in the steps needs no patch here. `continueAsNew` before history grows long,
 * because a person's acceptance can take days.
 */
export async function clientOnboardingWorkflow(
  input: ClientOnboardingInput,
): Promise<ClientOnboardingResult> {
  const local = proxyActivities<ClientOnboardingActivities>({
    taskQueue: 'ensemus-platform',
    startToCloseTimeout: '1 minute',
    // SQL-only, atomically bound and idempotent. A prolonged outage must not strand the saved
    // onboarding. Declared permanent refusals leave the activity as non-retryable failures.
    retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '1 minute' },
  });
  const result = await runClientOnboarding({
    advance: () => local.advanceOnboarding(input),
    wait: (reason) =>
      sleep(
        reason === 'person'
          ? '30 seconds'
          : reason === 'external_action'
            ? '10 seconds'
            : '15 seconds',
      ),
  });
  if ('continue' in result) return continueAsNew<typeof clientOnboardingWorkflow>(input);
  return result;
}
