import { describe, expect, it } from 'vitest';
import { runClientOnboarding } from './client-onboarding-step';
describe('client onboarding durable orchestration', () => {
  it.each(['completed', 'failed', 'unknown'] as const)(
    'stops on %s without an automatic repeat',
    async (state) => {
      let calls = 0;
      expect(
        await runClientOnboarding({
          advance: async () => {
            calls++;
            return { state, waitFor: 'nothing' };
          },
          wait: async () => {
            throw new Error('MUST_NOT_WAIT');
          },
        }),
      ).toEqual({ state });
      expect(calls).toBe(1);
    },
  );
  it('waits for actual human/run/effect progress and continues before unbounded history', async () => {
    let ticks = 0,
      waits = 0;
    expect(
      await runClientOnboarding(
        {
          advance: async () => {
            ticks++;
            return { state: 'waiting_for_acceptance', waitFor: 'person' };
          },
          wait: async (reason) => {
            expect(reason).toBe('person');
            waits++;
          },
        },
        3,
      ),
    ).toEqual({ continue: true });
    expect([ticks, waits]).toEqual([3, 3]);
  });
});
