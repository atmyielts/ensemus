// The entitlement seam, pure parts and refusals. As the real roles: tests/integration/ai-usage.test.ts.
import { randomUUID } from 'node:crypto';
import { AppError } from '@ensemus/application';
import type { EntitlementResult } from '@ensemus/application/ai-ports';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  capacitiesOf,
  decideEntitlement,
  entitledFeatures,
  FEATURE_AGENT_RUN,
  FEATURE_MODEL_CALL,
  formatMicrosUsd,
  getEntitlementsView,
  type EntitlementGrant,
} from './index';

const PERIOD = '2026-11';
const cloudGrant = (over: Partial<EntitlementGrant> = {}): EntitlementGrant => ({
  mode: 'cloud',
  period: PERIOD,
  features: [FEATURE_MODEL_CALL],
  capacities: {},
  ...over,
});

describe('decideEntitlement', () => {
  it.each(['byom', 'sovereign'] as const)(
    'entitles %s with nothing billable, with no row needed',
    (mode) => {
      expect(decideEntitlement(mode, null, FEATURE_MODEL_CALL, PERIOD)).toEqual({
        ok: true,
        billable: false,
        commercialMode: mode,
      });
      expect(decideEntitlement(mode, null, FEATURE_AGENT_RUN, PERIOD)).toMatchObject({ ok: true });
    },
  );

  it('gives Cloud no included allowance until a row says so', () => {
    expect(decideEntitlement('cloud', null, FEATURE_MODEL_CALL, PERIOD)).toEqual({
      ok: false,
      code: 'ENTITLEMENT_DENIED',
    });
    expect(decideEntitlement('cloud', cloudGrant(), FEATURE_MODEL_CALL, PERIOD)).toEqual({
      ok: true,
      billable: true,
      commercialMode: 'cloud',
    });
  });

  it('denies a Cloud feature the row does not list, and a row from another month or mode', () => {
    expect(decideEntitlement('cloud', cloudGrant(), FEATURE_AGENT_RUN, PERIOD).ok).toBe(false);
    expect(
      decideEntitlement('cloud', cloudGrant({ period: '2026-10' }), FEATURE_MODEL_CALL, PERIOD).ok,
    ).toBe(false);
    expect(
      decideEntitlement('cloud', cloudGrant({ mode: 'byom' }), FEATURE_MODEL_CALL, PERIOD).ok,
    ).toBe(false);
  });

  it('has no wildcard', () => {
    expect(
      decideEntitlement('cloud', cloudGrant({ features: ['*'] }), FEATURE_MODEL_CALL, PERIOD).ok,
    ).toBe(false);
  });

  it('denies a feature nobody has heard of, and a mode nobody has heard of', () => {
    expect(decideEntitlement('byom', null, 'secrets.read', PERIOD).ok).toBe(false);
    expect(decideEntitlement('sovereign', null, '', PERIOD).ok).toBe(false);
    expect(
      decideEntitlement(
        'other' as 'cloud',
        cloudGrant({ mode: 'other' }),
        FEATURE_MODEL_CALL,
        PERIOD,
      ).ok,
    ).toBe(false);
  });

  it('cannot say anything that would override a policy', () => {
    // The whole of what an entitlement can answer. No field says "allow this provider" or "skip a check",
    // so even a grant of everything leaves the gateway's policy check to run, and to deny.
    expectTypeOf<keyof Extract<EntitlementResult, { ok: true }>>().toEqualTypeOf<
      'ok' | 'billable' | 'commercialMode'
    >();
    const answer = decideEntitlement('cloud', cloudGrant(), FEATURE_MODEL_CALL, PERIOD);
    expect(Object.keys(answer).sort()).toEqual(['billable', 'commercialMode', 'ok']);
  });

  it('uses a code of its own, which policy never uses', () => {
    expect(decideEntitlement('cloud', null, FEATURE_MODEL_CALL, PERIOD)).toMatchObject({
      code: 'ENTITLEMENT_DENIED',
    });
    expect(new AppError('ENTITLEMENT_DENIED').code).not.toBe(new AppError('POLICY_DENIED').code);
  });
});

describe('what a tenant is shown', () => {
  it('lists the mode features, or what the row grants', () => {
    expect(entitledFeatures('byom', null, PERIOD)).toEqual([FEATURE_AGENT_RUN, FEATURE_MODEL_CALL]);
    expect(entitledFeatures('cloud', null, PERIOD)).toEqual([]);
    expect(entitledFeatures('cloud', cloudGrant(), PERIOD)).toEqual([FEATURE_MODEL_CALL]);
  });

  it('shows only whole numbers as capacities, and nothing from another month', () => {
    const grant = cloudGrant({
      capacities: { tokens: 5, ratio: 0.5, name: 'x', nested: {}, none: null },
    });
    expect(capacitiesOf(grant, PERIOD, 'cloud')).toEqual({ tokens: 5 });
    expect(capacitiesOf(grant, '2026-12', 'cloud')).toEqual({});
    expect(capacitiesOf(cloudGrant({ capacities: [1, 2] }), PERIOD, 'cloud')).toEqual({});
    expect(capacitiesOf(null, PERIOD, 'cloud')).toEqual({});
  });

  it('refuses a member and an agent before reading anything', async () => {
    const unreachable = new Proxy(
      {},
      {
        get() {
          throw new Error('a refusal must not reach the database');
        },
      },
    ) as AppDatabase;
    const who = (role: string, actorType: string) =>
      ({
        organizationId: randomUUID(),
        userId: randomUUID(),
        membershipId: randomUUID(),
        role,
        actorType,
      }) as unknown as TenantContext;
    for (const context of [who('member', 'user'), who('owner', 'agent')]) {
      await expect(getEntitlementsView(unreachable, context)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
  });
});

describe('formatMicrosUsd', () => {
  it.each([
    [0, '$0.00'],
    [1, '$0.000001'],
    [10_000, '$0.01'],
    [1_500_000, '$1.50'],
    [1_234_567, '$1.234567'],
    [2_000_000_000, '$2,000.00'],
    [-500_000, '-$0.50'],
    [Number.MAX_SAFE_INTEGER, '$9,007,199,254.740991'],
  ])('shows %i as %s', (micros, text) => {
    expect(formatMicrosUsd(micros)).toBe(text);
  });

  it('refuses a fraction of a micro', () => {
    expect(() => formatMicrosUsd(0.5)).toThrow(RangeError);
  });
});
