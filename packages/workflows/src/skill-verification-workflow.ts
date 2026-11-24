// Owned by the skill-verification slice (EXP-04). See docs/06-delivery/m11b-slices.md and ADR-034 D1, D2.
// Deterministic workflow code: keep bundle bytes and fixture data in Activities.
import {
  ActivityFailure,
  ApplicationFailure,
  isCancellation,
  proxyActivities,
} from '@temporalio/workflow';
import type { SkillVerificationInput, SkillVerificationOutcome } from './schemas';
import type { SkillVerificationActivities } from './skill-verification-activities';

const activities = proxyActivities<SkillVerificationActivities>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '8 minutes',
  retry: { initialInterval: '2 seconds', maximumAttempts: 3 },
});

export async function skillVerificationWorkflow(
  input: SkillVerificationInput,
): Promise<SkillVerificationOutcome> {
  try {
    const step = await activities.checkSkillBundle(input);
    if (step.step === 'finished') return step.outcome;
    return await activities.finishSkillVerification(input);
  } catch (error) {
    if (isCancellation(error)) throw error;
    const cause = error instanceof ActivityFailure ? error.cause : error;
    const code =
      cause instanceof ApplicationFailure && cause.type === 'SKILL_BUNDLE_READ_FAILED'
        ? 'BUNDLE_UNAVAILABLE'
        : 'VERIFICATION_ERROR';
    return activities.abandonSkillVerification(input, code);
  }
}
