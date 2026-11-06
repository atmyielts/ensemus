// Activity-boundary histories only; the real kernel/receipt acceptance is an integration/stack gate.
import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import type { OnboardingStep } from '@ensemus/application/knowledge/onboarding';
import { capturing, withCaptureWorkers } from './capture-support';
describe.skipIf(!capturing)('capture client onboarding histories', () => {
  it('records verified completion and terminal unknown/failed outcomes', async () => {
    let state: 'completed' | 'unknown' | 'failed' = 'completed',
      tick = 0;
    await withCaptureWorkers(
      {
        queues: [`capture-onboarding-${randomUUID()}`, 'ensemus-platform'],
        activities: {
          advanceOnboarding: async (): Promise<OnboardingStep> => {
            if (state !== 'completed') return { state, waitFor: 'nothing' };
            const phases: OnboardingStep[] = [
              { state: 'waiting_for_brief', waitFor: 'agent_run' },
              { state: 'waiting_for_acceptance', waitFor: 'person' },
              { state: 'waiting_for_send', waitFor: 'external_action' },
              { state: 'completed', waitFor: 'nothing' },
            ];
            return phases[Math.min(tick++, phases.length - 1)]!;
          },
        },
      },
      async ({ record }) => {
        const args = [
          {
            organizationId: '00000000-0000-4000-8000-000000000a01',
            onboardingId: '00000000-0000-4000-8000-000000000701',
          },
        ];
        await record('client-onboarding-completed', {
          workflowType: 'clientOnboardingWorkflow',
          args,
        });
        state = 'unknown';
        await record('client-onboarding-unknown', {
          workflowType: 'clientOnboardingWorkflow',
          args,
        });
        state = 'failed';
        await record('client-onboarding-failed', {
          workflowType: 'clientOnboardingWorkflow',
          args,
        });
      },
    );
  }, 180_000);
});
