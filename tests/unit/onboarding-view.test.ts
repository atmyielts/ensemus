import { describe, expect, it } from 'vitest';
import { onboardingOutcomeMessage } from '../../apps/web/src/lib/onboarding-view';

describe('onboarding outcome wording', () => {
  it('explains unavailable approved setup and uncertain delivery in plain terms', () => {
    expect(onboardingOutcomeMessage('AGENT_UNAVAILABLE')).toContain('published client brief agent');
    expect(onboardingOutcomeMessage('EMAIL_OUTCOME_UNVERIFIED')).toContain(
      'not been automatically sent again',
    );
  });
  it('keeps unknown technical codes out of the primary outcome', () => {
    const unknown = 'UNRECOGNIZED_PRIVATE_DIAGNOSTIC';
    expect(onboardingOutcomeMessage(unknown)).not.toContain(unknown);
    expect(onboardingOutcomeMessage(unknown)).toContain('Open the linked work');
  });
});
