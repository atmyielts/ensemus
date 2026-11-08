import { describe, expect, it } from 'vitest';
import { creditKeys, exhaustionDecision, priceModelCreditCeiling, quoteHash } from './credits';
import type { RateCardFacts } from './catalog';

describe('explicit prepaid capacity', () => {
  const at = new Date('2026-01-01T00:00:00Z');
  const card = (overrides: Partial<RateCardFacts> = {}): RateCardFacts => ({
    id: 'generated-card', status: 'approved', currency: 'XTS', minorUnitExponent: 2,
    effectiveFrom: at,
    lines: [
      { meter: 'model_input_tokens', unit: 'token', microcreditsPerUnit: 3n },
      { meter: 'model_output_tokens', unit: 'token', microcreditsPerUnit: 7n },
    ], ...overrides,
  });
  it('retains full input plus output credit debt without converting a USD ceiling', () => {
    expect(priceModelCreditCeiling(card(), at, { inputTokens: 11, outputTokens: 13 }))
      .toEqual({ ok: true, inputMicrocredits: 33n, outputMicrocredits: 91n, totalMicrocredits: 124n });
  });
  it('does not confuse an absent output price with a free zero-output operation', () => {
    expect(priceModelCreditCeiling(card({ lines: [card().lines[0]!] }), at, { inputTokens: 1, outputTokens: 0 }))
      .toEqual({ ok: false, code: 'METER_NOT_PRICED' });
    expect(priceModelCreditCeiling(card({ lines: card().lines.map(value => ({ ...value, unit: 'million_token' })) }), at, { inputTokens: 1, outputTokens: 1 }))
      .toEqual({ ok: false, code: 'UNIT_MISMATCH' });
  });
  it('requires an actual published and effective card', () => {
    const ceiling = { inputTokens: 1, outputTokens: 1 };
    expect(priceModelCreditCeiling(null, at, ceiling)).toMatchObject({ ok: false, code: 'RATE_CARD_MISSING' });
    expect(priceModelCreditCeiling(card({ status: 'draft' }), at, ceiling)).toMatchObject({ ok: false, code: 'RATE_CARD_NOT_APPROVED' });
    expect(priceModelCreditCeiling(card({ effectiveFrom: new Date(at.getTime() + 1) }), at, ceiling)).toMatchObject({ ok: false, code: 'RATE_CARD_NOT_EFFECTIVE' });
  });
  it('keeps values beyond JSON integer precision exact and refuses database overflow', () => {
    const precise = card({ lines: card().lines.map(value => ({ ...value, microcreditsPerUnit: 9007199254740993n })) });
    expect(priceModelCreditCeiling(precise, at, { inputTokens: 1, outputTokens: 1 }))
      .toMatchObject({ ok: true, totalMicrocredits: 18014398509481986n });
    expect(priceModelCreditCeiling(precise, at, { inputTokens: 1024, outputTokens: 1024 }))
      .toEqual({ ok: false, code: 'CREDIT_AMOUNT_UNREPRESENTABLE' });
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])('refuses an invalid native token ceiling %s', inputTokens => {
    expect(priceModelCreditCeiling(card(), at, { inputTokens, outputTokens: 0 }))
      .toEqual({ ok: false, code: 'INVALID_MODEL_CEILING' });
  });
  it('permits an explicitly approved zero rate without inventing an absent price', () => {
    expect(priceModelCreditCeiling(card({ lines: card().lines.map(value => ({ ...value, microcreditsPerUnit: 0n })) }), at, { inputTokens: 10, outputTokens: 20 }))
      .toEqual({ ok: true, inputMicrocredits: 0n, outputMicrocredits: 0n, totalMicrocredits: 0n });
  });
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
