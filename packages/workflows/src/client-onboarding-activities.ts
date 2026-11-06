// Owned by the flagship slice (AGENT-12). See docs/06-delivery/m5-slices.md. Runs in the main worker.
import type { OnboardingStep } from '@ensemus/application/knowledge/onboarding';
import type { OnboardingDeps } from './knowledge-deps';
import type { ClientOnboardingInput } from './knowledge-schemas';
import { advanceClientOnboarding } from '@ensemus/application/knowledge/onboarding';
import { createServiceContext } from '@ensemus/database/service';

export function createClientOnboardingActivities(deps: OnboardingDeps) {
  return {
    async advanceOnboarding(input: ClientOnboardingInput): Promise<OnboardingStep> {
      return advanceClientOnboarding(
        deps.database,
        createServiceContext(input.organizationId),
        deps,
        input,
      );
    },
  };
}
export type ClientOnboardingActivities = ReturnType<typeof createClientOnboardingActivities>;
