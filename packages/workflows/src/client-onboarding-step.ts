import type { OnboardingStep } from '@ensemus/application/knowledge/onboarding';
import type { ClientOnboardingResult } from './knowledge-schemas';

/** The database owns each decision. Timers wait for a person, run or receipt; no external action is
 * invoked here. A bounded batch requests continue-as-new before a long human review grows history. */
export async function runClientOnboarding(
  ports: {
    advance(): Promise<OnboardingStep>;
    wait(waitFor: OnboardingStep['waitFor']): Promise<void>;
  },
  maxTicks = 200,
): Promise<ClientOnboardingResult | { continue: true }> {
  for (let tick = 0; tick < maxTicks; tick++) {
    const step = await ports.advance();
    if (step.state === 'completed' || step.state === 'failed' || step.state === 'unknown')
      return { state: step.state };
    await ports.wait(step.waitFor);
  }
  return { continue: true };
}
