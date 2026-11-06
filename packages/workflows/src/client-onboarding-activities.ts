// Owned by the flagship slice (AGENT-12). See docs/06-delivery/m5-slices.md. Runs in the main worker.
import type { OnboardingStep } from '@ensemus/application/knowledge/onboarding';
import type { OnboardingDeps } from './knowledge-deps';
import type { ClientOnboardingInput } from './knowledge-schemas';

export function createClientOnboardingActivities(_deps: OnboardingDeps) {
  return {
    async advanceOnboarding(_input: ClientOnboardingInput): Promise<OnboardingStep> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type ClientOnboardingActivities = ReturnType<typeof createClientOnboardingActivities>;
