// Tax (BILL-03). The provider is the owner's decision, and there is no rate here. `TaxPort` is implemented
// by whichever provider's adapter they choose, and until then a place whose treatment is
// `provider_computed` does not get an invoice. Owned by the invoicing slice.
import type { Micros } from './money';

export const TAX_TREATMENTS = ['provider_computed', 'not_collected'] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

export type TaxInput = {
  /** Lets a provider dedupe a repeat. Fixed by the invoice. */
  idempotencyKey: string;
  currency: string;
  countryCode: string;
  regionCode: string;
  postalCode: string | null;
  taxId: string | null;
  lines: readonly { kind: string; amountMicros: Micros }[];
};

export type TaxResult = { taxMicros: Micros; currency: string; providerRef: string };

export type TaxCode =
  | 'TAX_PROVIDER_NOT_CONFIGURED'
  | 'TAX_PROVIDER_UNAVAILABLE'
  | 'TAX_ADDRESS_REJECTED'
  | 'TAX_TREATMENT_MISSING';

/** Thrown with a code and no provider text, so it is safe to log and to cross Temporal. */
export class TaxRefused extends Error {
  override name = 'TaxRefused';
  constructor(readonly code: TaxCode) {
    super(code);
  }
}

/**
 * The adapter contract. It runs on the connector queue, since it is an outside call. It computes and stores
 * nothing, so a repeat with the same key is safe, and a failure means the invoice stays a draft.
 */
export interface TaxPort {
  readonly provider: string;
  compute(input: TaxInput, signal: AbortSignal): Promise<TaxResult>;
}

/** Which treatment applies to a place: the most specific approved row, region before country. */
export function treatmentFor<
  T extends { countryCode: string; regionCode: string; version: number },
>(_approved: readonly T[], _place: { countryCode: string; regionCode: string }): T | null {
  throw new Error('NOT_IMPLEMENTED');
}
