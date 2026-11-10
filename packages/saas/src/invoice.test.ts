import { randomInt } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { PlanTerms, PricedMeter } from './catalog';
import { buildPeriodInvoice, buildTopUpInvoice, invoiceAddsUp, withTax } from './invoice';
import { roundToMinorUnit } from './money';

const plan: PlanTerms = {
  planVersionId: 'test',
  commercialMode: 'cloud',
  status: 'approved',
  currency: 'XTS',
  billingInterval: 'month',
  paymentTermsDays: 0,
  minorUnitExponent: 2,
  platformFeeMicros: BigInt(randomInt(1, 1000000)),
  includedMicrocredits: 100n,
  rateCardId: 'test-card',
  overagePolicy: 'explicit_top_up',
  features: ['work'],
  maxActiveMembers: null,
};
const meter: PricedMeter = {
  meter: 'test.units',
  unit: 'unit',
  quantity: BigInt(randomInt(1, 100)),
  microcreditsPerUnit: BigInt(randomInt(1, 100)),
  microcredits: 0n,
};
meter.microcredits = meter.quantity * meter.microcreditsPerUnit;
describe('prepaid invoices keep credits apart from currency', () => {
  it('model usage is informational and cannot charge prepaid consumption twice', () => {
    const draft = buildPeriodInvoice(plan, [meter], 2);
    expect(draft.totalMicros).toBe(roundToMinorUnit(plan.platformFeeMicros, 2));
    expect(draft.lines.find((l) => l.kind === 'usage')).toMatchObject({
      meter: meter.meter,
      quantity: meter.quantity,
      amountMicros: 0n,
      unitPriceMicros: null,
    });
    expect(invoiceAddsUp(draft)).toBe(true);
  });
  it('BYOM invoice contains only the platform fee and refuses inference usage', () => {
    const byom = {
      ...plan,
      commercialMode: 'byom' as const,
      includedMicrocredits: null,
      rateCardId: null,
      overagePolicy: null,
    };
    expect(
      buildPeriodInvoice(byom, [], 2).lines.every(
        (l) => l.kind === 'platform_fee' || l.kind === 'rounding',
      ),
    ).toBe(true);
    expect(() => buildPeriodInvoice(byom, [meter], 2)).toThrow();
  });
  it('unknown postpaid policy cannot invent a credit-to-money conversion', () => {
    expect(() => buildPeriodInvoice({ ...plan, overagePolicy: null }, [meter], 2)).toThrow();
  });
  it.each([0, 1, 2, 3, 4])('line totals stay exact at explicit exponent %s', (exponent) => {
    for (let n = 0; n < 50; n++) {
      const fee = BigInt(randomInt(0, 1000000));
      const draft = buildPeriodInvoice({ ...plan, platformFeeMicros: fee }, [], exponent);
      expect(draft.totalMicros).toBe(roundToMinorUnit(fee, exponent));
      expect(invoiceAddsUp(draft)).toBe(true);
    }
  });
  it('a top-up uses exactly its approved monetary price and explicit rounding', () => {
    const priceMicros = 9007199254740993n;
    const draft = buildTopUpInvoice({ priceMicros, currency: 'XTS' }, 2);
    expect(draft.lines.find((l) => l.kind === 'top_up')!.amountMicros).toBe(priceMicros);
    expect(draft.totalMicros).toBe(roundToMinorUnit(priceMicros, 2));
    expect(invoiceAddsUp(draft)).toBe(true);
  });
  it('tax is exact and final rounding still adds up', () => {
    const draft = buildTopUpInvoice(
      { priceMicros: BigInt(randomInt(1, 1000000)), currency: 'XTS' },
      2,
    );
    const taxMicros = BigInt(randomInt(1, 1000000));
    const result = withTax(draft, { taxMicros, currency: 'XTS' }, 2);
    expect(result.taxMicros).toBe(taxMicros);
    expect(invoiceAddsUp(result)).toBe(true);
    expect(result.totalMicros).toBe(
      roundToMinorUnit(draft.lines.find((l) => l.kind === 'top_up')!.amountMicros + taxMicros, 2),
    );
    expect(withTax(result, { taxMicros, currency: 'XTS' }, 2)).toEqual(result);
  });
  it('negative tax and mismatched currency refuse, without mutating the draft', () => {
    const draft = buildTopUpInvoice({ priceMicros: 100n, currency: 'XTS' }, 2);
    const before = structuredClone(draft);
    expect(() => withTax(draft, { taxMicros: -1n, currency: 'XTS' })).toThrow();
    expect(() => withTax(draft, { taxMicros: 0n, currency: 'XXX' })).toThrow();
    expect(draft).toEqual(before);
  });
  it('a tampered amount or tax line cannot pass the sum check', () => {
    const draft = buildPeriodInvoice(plan, [], 2);
    expect(invoiceAddsUp({ ...draft, totalMicros: draft.totalMicros + 1n })).toBe(false);
    expect(invoiceAddsUp({ ...draft, taxMicros: 1n, totalMicros: draft.totalMicros + 1n })).toBe(
      false,
    );
  });
});
