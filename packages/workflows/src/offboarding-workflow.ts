// Owned by the offboarding slice (LIFE-04). Deterministic: only @temporalio/workflow and types. It asks for one
// step at a time and waits durably, and stops before anything irreversible, which an operator does by hand.
import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type { OffboardingActivities } from './offboarding-activities';
import { runOffboarding } from './offboarding-step';
import type { OffboardingInput, OffboardingOutcome } from './saas-schemas';

const platform = proxyActivities<OffboardingActivities>({
  taskQueue: 'ensemus-platform',
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '24 hours',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '1 minute',
    nonRetryableErrorTypes: ['AppError'],
  },
});
export async function tenantOffboardingWorkflow(
  input: OffboardingInput,
): Promise<OffboardingOutcome> {
  return runOffboarding({
    advance: () => platform.advanceOffboardingStep(input),
    now: () => Date.now(),
    sleep: (ms) => sleep(ms),
    restart: () => continueAsNew<typeof tenantOffboardingWorkflow>(input),
  });
}
