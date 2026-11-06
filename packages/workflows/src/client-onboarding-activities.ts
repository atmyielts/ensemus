// Owned by the flagship slice (AGENT-12). See docs/06-delivery/m5-slices.md. Runs in the main worker.
import type { OnboardingStep } from '@ensemus/application/knowledge/onboarding';
import type { OnboardingDeps } from './knowledge-deps';
import type { ClientOnboardingInput } from './knowledge-schemas';
import { advanceClientOnboarding } from '@ensemus/application/knowledge/onboarding';
import { createServiceContext } from '@ensemus/database/service';
import { TenantAccessDenied } from '@ensemus/database';
import { AppError } from '@ensemus/application';
import { ApplicationFailure } from '@temporalio/common';

/** Only fixed messages/codes cross Temporal. Its common failure converter also encrypts attributes. */
export function onboardingActivityFailure(error: unknown): ApplicationFailure {
  if (error instanceof AppError)
    return ApplicationFailure.create({
      type: error.code,
      message: 'Onboarding advancement refused',
      details: [],
      // Both can resolve by a fresh snapshot; neither grants new authority on a retry.
      nonRetryable: !['RESTORE_PENDING', 'VERSION_CONFLICT'].includes(error.code),
    });
  if (error instanceof TenantAccessDenied)
    return ApplicationFailure.create({
      type: 'FORBIDDEN',
      message: 'Onboarding advancement refused',
      nonRetryable: true,
      details: [],
    });
  return ApplicationFailure.create({
    type: 'ONBOARDING_RETRYABLE',
    message: 'Onboarding advancement interrupted',
    nonRetryable: error instanceof ApplicationFailure && error.nonRetryable === true,
    details: [],
  });
}

export function createClientOnboardingActivities(deps: OnboardingDeps) {
  return {
    async advanceOnboarding(input: ClientOnboardingInput): Promise<OnboardingStep> {
      try {
        return await advanceClientOnboarding(
          deps.database,
          createServiceContext(input.organizationId),
          deps,
          input,
        );
      } catch (error) {
        throw onboardingActivityFailure(error);
      }
    },
  };
}
export type ClientOnboardingActivities = ReturnType<typeof createClientOnboardingActivities>;
