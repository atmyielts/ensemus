import { describe, expect, it } from 'vitest';
import { nextOffboardingStep, type OffboardingFacts } from './offboarding';
const now = new Date('2043-05-01T00:00:00.000Z');
const facts = (changes: Partial<OffboardingFacts> = {}): OffboardingFacts => ({
  state: 'requested',
  exportOfferedAt: null,
  transitionEndsAt: null,
  connectionsRevokedAt: null,
  workEndedAt: null,
  actionsSettledAt: null,
  activeHolds: 0,
  unsettledActions: 0,
  ...changes,
});
describe('offboarding requires every recorded prerequisite', () => {
  it('offers export before changing connections or deleting anything', () => {
    expect(nextOffboardingStep(facts({ activeHolds: 1 }), now)).toEqual({ kind: 'offer_export' });
  });
  it('never invents a contractual transition date', () => {
    expect(
      nextOffboardingStep(facts({ state: 'in_transition', exportOfferedAt: now }), now),
    ).toEqual({ kind: 'wait_for_transition', until: null });
  });
  it('waits until the exact published transition boundary', () => {
    const until = new Date(now.getTime() + 1);
    expect(
      nextOffboardingStep(
        facts({ state: 'in_transition', exportOfferedAt: now, transitionEndsAt: until }),
        now,
      ),
    ).toEqual({ kind: 'wait_for_transition', until });
    expect(
      nextOffboardingStep(
        facts({ state: 'in_transition', exportOfferedAt: now, transitionEndsAt: now }),
        now,
      ),
    ).toEqual({ kind: 'revoke_connections' });
  });
  it('ends scheduled work only after revocation is recorded', () => {
    expect(
      nextOffboardingStep(
        facts({
          state: 'winding_down',
          exportOfferedAt: now,
          transitionEndsAt: now,
          connectionsRevokedAt: now,
        }),
        now,
      ),
    ).toEqual({ kind: 'end_scheduled_work' });
  });
  it('waits for uncertain effects even if an earlier settlement receipt exists', () => {
    expect(
      nextOffboardingStep(
        facts({
          state: 'winding_down',
          exportOfferedAt: now,
          transitionEndsAt: now,
          connectionsRevokedAt: now,
          workEndedAt: now,
          actionsSettledAt: now,
          unsettledActions: 1,
        }),
        now,
      ),
    ).toEqual({ kind: 'settle_pending_actions' });
  });
  it('never automates erasure, and a hold blocks the operator stage', () => {
    const ready = facts({
      state: 'ready_for_erasure',
      exportOfferedAt: now,
      transitionEndsAt: now,
      connectionsRevokedAt: now,
      workEndedAt: now,
      actionsSettledAt: now,
    });
    expect(nextOffboardingStep(ready, now)).toEqual({ kind: 'await_operator_erasure' });
    expect(nextOffboardingStep({ ...ready, activeHolds: 1 }, now)).toEqual({
      kind: 'blocked_by_hold',
    });
  });
  it('reports only a verified erasure, leaving erasing to the operator', () => {
    expect(nextOffboardingStep(facts({ state: 'erasing' }), now)).toEqual({
      kind: 'await_operator_erasure',
    });
    expect(nextOffboardingStep(facts({ state: 'verified' }), now)).toEqual({
      kind: 'write_report',
    });
    for (const state of ['cancelled', 'reported'] as const)
      expect(nextOffboardingStep(facts({ state }), now)).toEqual({ kind: 'done' });
  });
});
