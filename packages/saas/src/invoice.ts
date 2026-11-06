// Invoices (BILL-02). Pure: from a period's terms and its usage to the lines an invoice holds. An invoice
// matches the usage ledger and the subscription terms because it is computed from nothing else.
// Owned by the invoicing slice. See docs/06-delivery/m8-slices.md.
import type { PlanTerms, PricedMeter } from './catalog';
import type { Micros } from './money';

export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Matches `billing.check_invoice_change` in migration 0501, and a test holds the two together. */
export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  draft: ['open', 'void'],
  open: ['paid', 'void', 'uncollectible'],
  uncollectible: ['paid', 'void'],
  paid: [],
  void: [],
};

export type InvoiceLineKind = 'platform_fee' | 'usage' | 'top_up' | 'tax' | 'rounding';

export type DraftLine = {
  kind: InvoiceLineKind;
  meter: string | null;
  quantity: bigint | null;
  unit: string | null;
  unitPriceMicros: Micros | null;
  amountMicros: Micros;
  usageRef: string | null;
};

export type DraftInvoice = {
  currency: string;
  lines: readonly DraftLine[];
  subtotalMicros: Micros;
  taxMicros: Micros;
  totalMicros: Micros;
};

/**
 * One platform fee line, plus usage lines only for what the plan bills beyond its allowance and what the
 * card prices, plus one `rounding` line if the total needs one. Never bills BYOM inference (QA-027): a plan
 * in that mode refuses any usage. Lines keep exact micros and the total rounds to the card's minor unit.
 */
export function buildPeriodInvoice(
  _plan: PlanTerms,
  _overage: readonly PricedMeter[],
  _minorUnitExponent: number,
): DraftInvoice {
  throw new Error('NOT_IMPLEMENTED');
}

/** One line, for exactly the price the person agreed to, plus rounding if needed. */
export function buildTopUpInvoice(
  _quote: { priceMicros: Micros; currency: string },
  _minorUnitExponent: number,
): DraftInvoice {
  throw new Error('NOT_IMPLEMENTED');
}

/** Adds what the tax port said. A negative tax, or tax in another currency, refuses. */
export function withTax(
  _draft: DraftInvoice,
  _tax: { taxMicros: Micros; currency: string },
): DraftInvoice {
  throw new Error('NOT_IMPLEMENTED');
}

/** Every line adds up to its totals, to the micro. The database checks this again when one opens. */
export function invoiceAddsUp(_draft: DraftInvoice): boolean {
  throw new Error('NOT_IMPLEMENTED');
}
