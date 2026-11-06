// Owned by the invoicing slice. See docs/06-delivery/m8-slices.md.
import type { TaxInput, TaxPort, TaxResult } from '../tax';

export type FakeTaxScript = { onCompute: (input: TaxInput) => TaxResult | Promise<TaxResult> };

/** Answers what the test says. A rate in a test is a test value, and never reaches shipped code. */
export function createFakeTaxPort(_script: FakeTaxScript): TaxPort & {
  readonly calls: readonly TaxInput[];
} {
  throw new Error('NOT_IMPLEMENTED');
}
