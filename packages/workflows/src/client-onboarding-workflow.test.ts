// SDK seam only; real retry timers/history remain a separate Temporal runtime/replay gate.
import { describe, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ options: undefined as unknown, advance: vi.fn(), wait: vi.fn() }));
vi.mock('@temporalio/workflow', () => ({
  proxyActivities: (options: unknown) => {
    sdk.options = options;
    return { advanceOnboarding: sdk.advance };
  },
  sleep: sdk.wait,
  continueAsNew: vi.fn(),
}));
const { clientOnboardingWorkflow } = await import('./client-onboarding-workflow');
const input = {
  organizationId: '7f0c1f6e-3a39-4f5e-9d7a-3f4a0a4f1b11',
  onboardingId: 'c4f597fe-375d-4fad-8870-e4959644df32',
};

describe('onboarding durable SQL retry policy', () => {
  it('configures continued retries beyond three attempts with bounded exponential intervals', async () => {
    sdk.advance.mockResolvedValueOnce({ state: 'completed', waitFor: 'nothing' });
    await expect(clientOnboardingWorkflow(input)).resolves.toEqual({ state: 'completed' });
    expect(sdk.options).toMatchObject({
      taskQueue: 'ensemus-platform',
      startToCloseTimeout: '1 minute',
      retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '1 minute' },
    });
    expect((sdk.options as { retry: object }).retry).not.toHaveProperty('maximumAttempts');
    expect(sdk.advance).toHaveBeenLastCalledWith(input);
  });
  it('does not hide a terminal activity failure from the workflow', async () => {
    const failure = new Error('Synthetic declared terminal refusal');
    sdk.advance.mockRejectedValueOnce(failure);
    await expect(clientOnboardingWorkflow(input)).rejects.toBe(failure);
  });
});
