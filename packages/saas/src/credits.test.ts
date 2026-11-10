import { describe, expect, it } from 'vitest';
import { creditKeys, exhaustionDecision, quoteHash } from './credits';

describe('explicit prepaid capacity', () => {
  it.each([-1n, 0n, 9n])('balance %s pauses, without buying anything', (balance) => {
    expect(exhaustionDecision(balance, 10n, 'pause', null)).toEqual({
      allowed: false,
      action: 'pause',
      warn: false,
    });
    expect(exhaustionDecision(balance, 10n, 'explicit_top_up', null)).toEqual({
      allowed: false,
      action: 'request_top_up',
      warn: false,
    });
  });
  it('exact capacity allows and an absent threshold never invents a warning', () => {
    expect(exhaustionDecision(10n, 10n, 'pause', null)).toEqual({
      allowed: true,
      action: 'continue',
      warn: false,
    });
  });
  it('warnings follow only the explicit threshold', () => {
    expect(exhaustionDecision(10n, 1n, 'pause', 11n).warn).toBe(true);
    expect(exhaustionDecision(11n, 1n, 'pause', 11n).warn).toBe(false);
  });
  it('zero forecast cannot start at zero and a negative forecast never grants spend', () => {
    expect(exhaustionDecision(0n, 0n, 'pause', null).allowed).toBe(false);
    expect(exhaustionDecision(10n, -1n, 'pause', null).allowed).toBe(false);
  });
  it('keys repeat exactly and different sources never collide', () => {
    for (const id of ['a', 'b', 'c']) {
      const keys = Object.values(creditKeys).map((key) => key(id));
      expect(new Set(keys).size).toBe(keys.length);
      expect(creditKeys.consumption(id)).toBe(creditKeys.consumption(id));
    }
  });
  it('a quote binds every amount and currency without bigint precision loss', () => {
    const quote = {
      offerId: 'test-offer',
      rateCardId: 'test-card',
      microcredits: 9007199254740993n,
      priceMicros: 9007199254740995n,
      currency: 'XTS',
    };
    const hash = quoteHash(quote);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    for (const changed of [
      { offerId: 'other' },
      { rateCardId: 'other' },
      { microcredits: quote.microcredits + 1n },
      { priceMicros: quote.priceMicros + 1n },
      { currency: 'XXX' },
    ])
      expect(quoteHash({ ...quote, ...changed })).not.toBe(hash);
  });
});
