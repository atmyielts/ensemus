import { describe, expect, it } from 'vitest';
import { canStartOn, periodEnd, priceUsage, type PlanTerms, type RateCardFacts } from './catalog';

const at = new Date('2032-06-17T09:14:37.123Z');
const card: RateCardFacts = {
  id: 'test-card',
  status: 'approved',
  currency: 'XTS',
  minorUnitExponent: 2,
  effectiveFrom: new Date('2032-06-01T00:00:00Z'),
  lines: [{ meter: 'test.tokens', unit: 'token', microcreditsPerUnit: 7n }],
};
const usage = [{ meter: 'test.tokens', unit: 'token', quantity: 13n }];
const plan: PlanTerms = {
  planVersionId: 'test-plan',
  commercialMode: 'cloud',
  status: 'approved',
  currency: 'XTS',
  billingInterval: 'month',
  paymentTermsDays: 0,
  minorUnitExponent: 2,
  platformFeeMicros: 0n,
  includedMicrocredits: 0n,
  rateCardId: card.id,
  overagePolicy: 'pause',
  features: [],
  maxActiveMembers: null,
};

describe('pricing only from a published card', () => {
  it('refuses an absent card rather than guessing a price', () => {
    expect(priceUsage(null, usage, at)).toEqual({ ok: false, code: 'RATE_CARD_MISSING' });
  });

  it('refuses a draft', () => {
    expect(priceUsage({ ...card, status: 'draft' }, usage, at)).toEqual({
      ok: false,
      code: 'RATE_CARD_NOT_APPROVED',
    });
  });

  it.each([null, new Date(at.getTime() + 1), new Date(Number.NaN)])(
    'refuses a card that has not become effective',
    (effectiveFrom) => {
      expect(priceUsage({ ...card, effectiveFrom }, usage, at)).toEqual({
        ok: false,
        code: 'RATE_CARD_NOT_EFFECTIVE',
      });
    },
  );

  it('does not borrow another meter or unit', () => {
    expect(priceUsage(card, [{ ...usage[0]!, meter: 'test.other' }], at)).toEqual({
      ok: false,
      code: 'METER_NOT_PRICED',
    });
    expect(priceUsage(card, [{ ...usage[0]!, unit: 'call' }], at)).toEqual({
      ok: false,
      code: 'UNIT_MISMATCH',
    });
  });

  it('prices exact bigint quantities without changing either input', () => {
    const quantity = 9_007_199_254_740_993n;
    const immutableCard = Object.freeze({ ...card, lines: Object.freeze(card.lines) });
    const used = Object.freeze([{ ...usage[0]!, quantity }]);
    expect(priceUsage(immutableCard, used, at)).toEqual({
      ok: true,
      meters: [{ ...used[0], microcreditsPerUnit: 7n, microcredits: quantity * 7n }],
    });
  });

  it('keeps the price of a retired card for usage bound to it', () => {
    expect(priceUsage({ ...card, status: 'retired' }, usage, at)).toEqual({
      ok: true,
      meters: [{ ...usage[0], microcreditsPerUnit: 7n, microcredits: 91n }],
    });
    expect(priceUsage(card, [], at)).toEqual({ ok: true, meters: [] });
  });

  it('becomes effective at its exact boundary', () => {
    expect(priceUsage(card, usage, card.effectiveFrom!).ok).toBe(true);
    expect(priceUsage(card, usage, new Date(card.effectiveFrom!.getTime() - 1))).toEqual({
      ok: false,
      code: 'RATE_CARD_NOT_EFFECTIVE',
    });
  });
});

describe('starting a plan', () => {
  it('refuses legacy terms whose currency precision still needs operator review', () => {
    expect(canStartOn({ ...plan, minorUnitExponent: null }, 'cloud')).toBe(false);
  });
  it.each(['draft', 'retired'] as const)('refuses %s versions', (status) => {
    expect(canStartOn({ ...plan, status }, 'cloud')).toBe(false);
  });

  it('requires the approved version to belong to this mode', () => {
    expect(canStartOn(plan, 'cloud')).toBe(true);
    expect(canStartOn(plan, 'byom')).toBe(false);
    expect(canStartOn(plan, 'sovereign')).toBe(false);
    expect(canStartOn(plan, 'unknown')).toBe(false);
    expect(canStartOn({ ...plan, commercialMode: 'byom' }, 'byom')).toBe(true);
  });
});

describe('calendar periods in UTC', () => {
  it.each([
    ['2031-01-31T23:44:18.123Z', 'month', '2031-02-28T23:44:18.123Z'],
    ['2032-01-31T23:44:18.123Z', 'month', '2032-02-29T23:44:18.123Z'],
    ['2032-02-29T23:44:18.123Z', 'year', '2033-02-28T23:44:18.123Z'],
    ['2031-12-31T23:44:18.123Z', 'month', '2032-01-31T23:44:18.123Z'],
  ] as const)('ends %s after one %s at %s', (start, interval, expected) => {
    const input = new Date(start);
    expect(periodEnd(input, interval).toISOString()).toBe(expected);
    expect(input.toISOString()).toBe(start);
  });

  it('covers consecutive monthly periods without skipping a month or changing the clock', () => {
    for (let month = 0; month < 12; month += 1) {
      for (let day = 1; day <= 31; day += 1) {
        let cursor = new Date(Date.UTC(2032, month, day, 13, 27, 8, 321));
        for (let count = 0; count < 36; count += 1) {
          const next = periodEnd(cursor, 'month');
          expect(next.getTime()).toBeGreaterThan(cursor.getTime());
          expect(next.getUTCFullYear() * 12 + next.getUTCMonth()).toBe(
            cursor.getUTCFullYear() * 12 + cursor.getUTCMonth() + 1,
          );
          expect(next.getUTCHours()).toBe(13);
          expect(next.getUTCMinutes()).toBe(27);
          expect(next.getUTCSeconds()).toBe(8);
          expect(next.getUTCMilliseconds()).toBe(321);
          cursor = next;
        }
      }
    }
  });

  it('refuses an invalid date', () => {
    expect(() => periodEnd(new Date(Number.NaN), 'month')).toThrow('INVALID_PERIOD');
  });
});
