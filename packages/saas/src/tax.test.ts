import { describe, it, expect } from 'vitest';
import { treatmentFor, TaxRefused } from './tax';
import { createFakeTaxPort } from './testing/fake-tax';
describe('published adviser guidance', () => {
  const rows = [
    { countryCode: 'XX', regionCode: '', version: 10 },
    { countryCode: 'XX', regionCode: 'TEST', version: 1 },
    { countryCode: 'XX', regionCode: 'TEST', version: 2 },
    { countryCode: 'XY', regionCode: 'TEST', version: 20 },
  ];
  it('region takes precedence, then its highest published version', () =>
    expect(treatmentFor(rows, { countryCode: 'XX', regionCode: 'TEST' })).toEqual(rows[2]));
  it('country fallback is explicit and an absent country has no invented treatment', () => {
    expect(treatmentFor(rows, { countryCode: 'XX', regionCode: 'OTHER' })).toEqual(rows[0]);
    expect(treatmentFor(rows, { countryCode: 'XZ', regionCode: 'TEST' })).toBeNull();
  });
  it('does not mutate input order', () => {
    const before = structuredClone(rows);
    treatmentFor(rows, { countryCode: 'XX', regionCode: 'TEST' });
    expect(rows).toEqual(before);
  });
  it('fake tax captures independent calls, respects abort and invents no rate', async () => {
    const tax = createFakeTaxPort({
      onCompute: (input) => ({
        taxMicros: 123n,
        currency: input.currency,
        providerRef: 'test-reference',
      }),
    });
    const input = {
      idempotencyKey: 'test',
      currency: 'XTS',
      countryCode: 'XX',
      regionCode: '',
      postalCode: null,
      taxId: null,
      lines: [{ kind: 'platform_fee', amountMicros: 1000n }],
    };
    expect((await tax.compute(input, new AbortController().signal)).taxMicros).toBe(123n);
    input.lines[0]!.amountMicros = 1n;
    expect(tax.calls[0]!.lines[0]!.amountMicros).toBe(1000n);
    const abort = new AbortController();
    abort.abort();
    await expect(tax.compute(input, abort.signal)).rejects.toBeInstanceOf(TaxRefused);
    expect(tax.calls).toHaveLength(1);
  });
});
