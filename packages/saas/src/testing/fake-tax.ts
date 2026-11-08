// Owned by the invoicing slice. See docs/06-delivery/m8-slices.md.
import type { TaxInput, TaxPort, TaxResult } from '../tax';
import { TaxRefused } from '../tax';

export type FakeTaxScript = { onCompute: (input: TaxInput) => TaxResult | Promise<TaxResult> };

/** Answers what the test says. A rate in a test is a test value, and never reaches shipped code. */
export function createFakeTaxPort(script: FakeTaxScript): TaxPort & {
  readonly calls: readonly TaxInput[];
} {
  const calls: TaxInput[] = [];
  return {
    provider: 'test-scripted-tax',
    get calls() {
      return structuredClone(calls);
    },
    async compute(input, signal) {
      if (signal.aborted) throw new TaxRefused('TAX_PROVIDER_UNAVAILABLE');
      calls.push(structuredClone(input));
      return script.onCompute(structuredClone(input));
    },
  };
}
