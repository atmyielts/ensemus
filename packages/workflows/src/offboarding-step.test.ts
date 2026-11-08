import { describe, expect, it, vi } from 'vitest';
import { runOffboarding } from './offboarding-step';
import type { OffboardingStepResult } from './saas-schemas';
describe('offboarding orchestration', () => {
  it('waits durably then stops at the operator boundary', async () => {
    const advance = vi
        .fn<() => Promise<OffboardingStepResult>>()
        .mockResolvedValueOnce({ kind: 'continue' })
        .mockResolvedValueOnce({ kind: 'wait', untilMs: 42 })
        .mockResolvedValueOnce({ kind: 'stop', outcome: 'awaiting_operator' }),
      sleep = vi.fn().mockResolvedValue(undefined);
    expect(await runOffboarding({ advance, now: () => 12, sleep })).toBe('awaiting_operator');
    expect(sleep).toHaveBeenCalledWith(30);
    expect(advance).toHaveBeenCalledTimes(3);
  });
  it('does not sleep for a boundary already reached', async () => {
    const advance = vi
        .fn<() => Promise<OffboardingStepResult>>()
        .mockResolvedValueOnce({ kind: 'wait', untilMs: 12 })
        .mockResolvedValueOnce({ kind: 'stop', outcome: 'awaiting_operator' }),
      sleep = vi.fn();
    await runOffboarding({ advance, now: () => 12, sleep });
    expect(sleep).not.toHaveBeenCalled();
  });
  it.each(['blocked_by_hold', 'cancelled', 'reported'] as const)(
    'ends on %s with no further action',
    async (outcome) => {
      const advance = vi
          .fn<() => Promise<OffboardingStepResult>>()
          .mockResolvedValue({ kind: 'stop', outcome }),
        sleep = vi.fn();
      expect(await runOffboarding({ advance, now: () => 0, sleep })).toBe(outcome);
      expect(advance).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );
});
