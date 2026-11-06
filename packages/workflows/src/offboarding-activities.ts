// Owned by the offboarding slice (LIFE-04). See docs/06-delivery/m8-slices.md.
import type { OffboardingActivityDeps } from './saas-deps';
import type { OffboardingInput, OffboardingStepResult } from './saas-schemas';

export function createOffboardingActivities(_deps: OffboardingActivityDeps) {
  return {
    /** One idempotent step. It reads what to do from the row, and its answer holds no text. */
    async advanceOffboardingStep(_input: OffboardingInput): Promise<OffboardingStepResult> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type OffboardingActivities = ReturnType<typeof createOffboardingActivities>;
