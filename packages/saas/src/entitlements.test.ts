import { describe, expect, it } from 'vitest';
import type { PlanTerms } from './catalog';
import { evaluateEntitlement, planChangeEffect, type EntitlementFacts } from './entitlements';

const plan: PlanTerms = {
  planVersionId: 'test-plan',
  commercialMode: 'cloud',
  status: 'approved',
  currency: 'XTS',
  billingInterval: 'month',
  paymentTermsDays: 0,
  minorUnitExponent: 2,
  platformFeeMicros: 0n,
  includedMicrocredits: 100n,
  rateCardId: 'test-card',
  overagePolicy: 'explicit_top_up',
  features: ['work', 'model.call'],
  maxActiveMembers: 5,
};
const facts: EntitlementFacts = {
  billingEnabled: true,
  commercialMode: 'cloud',
  lifecycle: 'active',
  plan,
  subscriptionStatus: 'active',
  balanceMicrocredits: 100n,
};
const capacity = { kind: 'model_capacity', estimatedMicrocredits: 10n } as const;

describe('entitlements refuse in deployment, standing, subscription and capacity order', () => {
  it('Sovereign leaves licensing to its offline license, even without hosted billing', () => {
    expect(
      evaluateEntitlement(
        {
          ...facts,
          commercialMode: 'sovereign',
          billingEnabled: false,
          lifecycle: 'suspended',
          plan: null,
          subscriptionStatus: null,
        },
        capacity,
      ),
    ).toEqual({ allowed: true, code: 'ALLOWED', remedy: 'none' });
  });
  it('disabled hosted billing refuses before tenant or payment facts', () => {
    expect(
      evaluateEntitlement(
        { ...facts, billingEnabled: false, lifecycle: 'suspended', plan: null },
        capacity,
      ).code,
    ).toBe('BILLING_NOT_ENABLED');
  });
  it.each(['read_only', 'suspended', 'offboarding', 'deleted'] as const)(
    'refuses %s before subscription',
    (lifecycle) => {
      expect(evaluateEntitlement({ ...facts, lifecycle, plan: null }, capacity).code).toBe(
        'TENANT_NOT_ACTIVE',
      );
    },
  );
  it('missing subscription fails closed', () => {
    expect(
      evaluateEntitlement({ ...facts, plan: null, subscriptionStatus: null }, capacity).code,
    ).toBe('NO_SUBSCRIPTION');
  });
  it('cancellation is distinct from absence', () => {
    expect(evaluateEntitlement({ ...facts, subscriptionStatus: 'canceled' }, capacity).code).toBe(
      'SUBSCRIPTION_CANCELED',
    );
  });
  it('past due does not invent a grace policy before standing changes', () => {
    expect(
      evaluateEntitlement({ ...facts, subscriptionStatus: 'past_due' }, capacity).allowed,
    ).toBe(true);
  });
  it('an absent feature cannot be bought with credits', () => {
    expect(evaluateEntitlement(facts, { kind: 'feature', feature: 'unlicensed' })).toEqual({
      allowed: false,
      code: 'FEATURE_NOT_LICENSED',
      remedy: 'upgrade',
    });
  });
  it('feature licensing does not consume model capacity', () => {
    expect(
      evaluateEntitlement(
        { ...facts, balanceMicrocredits: 0n },
        { kind: 'feature', feature: 'work' },
      ).allowed,
    ).toBe(true);
  });
  it('BYOM capacity never charges the platform allowance', () => {
    expect(
      evaluateEntitlement(
        {
          ...facts,
          commercialMode: 'byom',
          plan: {
            ...plan,
            commercialMode: 'byom',
            includedMicrocredits: null,
            rateCardId: null,
            overagePolicy: null,
          },
          balanceMicrocredits: null,
        },
        capacity,
      ),
    ).toEqual({ allowed: true, code: 'CUSTOMER_BILLED', remedy: 'none' });
  });
  it.each([null, -1n, 0n, 9n])(
    'refuses unavailable or insufficient capacity %s',
    (balanceMicrocredits) => {
      expect(evaluateEntitlement({ ...facts, balanceMicrocredits }, capacity)).toEqual({
        allowed: false,
        code: 'CREDITS_EXHAUSTED',
        remedy: 'top_up',
      });
    },
  );
  it('a pause plan offers upgrade, never an automatic top-up', () => {
    expect(
      evaluateEntitlement(
        { ...facts, balanceMicrocredits: 0n, plan: { ...plan, overagePolicy: 'pause' } },
        capacity,
      ).remedy,
    ).toBe('upgrade');
  });
  it('an exact balance covers the request with bigint precision', () => {
    const amount = 9_007_199_254_740_993n;
    expect(
      evaluateEntitlement(
        { ...facts, balanceMicrocredits: amount },
        { kind: 'model_capacity', estimatedMicrocredits: amount },
      ).allowed,
    ).toBe(true);
  });
  it('zero forecast cannot permit a call at zero balance, and negative forecast is refused', () => {
    expect(
      evaluateEntitlement(
        { ...facts, balanceMicrocredits: 0n },
        { kind: 'model_capacity', estimatedMicrocredits: 0n },
      ).allowed,
    ).toBe(false);
    expect(
      evaluateEntitlement(facts, { kind: 'model_capacity', estimatedMicrocredits: -1n }).allowed,
    ).toBe(false);
  });
});

describe('plan changes preserve paid access and every excess row', () => {
  it.each([{ features: ['work'] }, { includedMicrocredits: 99n }, { maxActiveMembers: 4 }])(
    'defers any lost entitlement until the boundary: $maxActiveMembers',
    (reduction) => {
      expect(planChangeEffect(plan, { ...plan, ...reduction }, { activeMembers: 7 })).toEqual({
        effective: 'period_end',
        excess: { activeMembers: 7 - (reduction.maxActiveMembers ?? 5) },
      });
    },
  );
  it('an unlimited cap becoming finite is a downgrade', () => {
    expect(
      planChangeEffect({ ...plan, maxActiveMembers: null }, plan, { activeMembers: 2 }).effective,
    ).toBe('period_end');
  });
  it('mixed changes with a lost grant remain a downgrade', () => {
    expect(
      planChangeEffect(
        plan,
        { ...plan, features: ['work'], maxActiveMembers: null },
        { activeMembers: 7 },
      ).effective,
    ).toBe('period_end');
  });
  it('an upgrade applies now, without pricing-based ranking or mutation', () => {
    const before = structuredClone(plan);
    expect(
      planChangeEffect(
        plan,
        { ...plan, maxActiveMembers: null, includedMicrocredits: 101n },
        { activeMembers: 7 },
      ),
    ).toEqual({ effective: 'now', excess: {} });
    expect(plan).toEqual(before);
  });
});
