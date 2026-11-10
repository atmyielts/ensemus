// Invoices (BILL-02). Pure: from a period's terms and its usage to the lines an invoice holds. An invoice
// matches the usage ledger and the subscription terms because it is computed from nothing else.
// Owned by the invoicing slice. See docs/06-delivery/m8-slices.md.
import type { PlanTerms, PricedMeter } from './catalog';
import type { Micros } from './money';
import { roundToMinorUnit } from './money';

const line = (kind: InvoiceLineKind, amountMicros: bigint): DraftLine => ({
  kind,
  amountMicros,
  meter: null,
  quantity: null,
  unit: null,
  unitPriceMicros: null,
  usageRef: null,
});
function rounded(currency: string, lines: readonly DraftLine[], exponent: number): DraftInvoice {
  if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError('INVALID_CURRENCY');
  const exact = lines.reduce((sum, l) => sum + l.amountMicros, 0n);
  const total = roundToMinorUnit(exact, exponent);
  return {
    currency,
    lines: total === exact ? [...lines] : [...lines, line('rounding', total - exact)],
    subtotalMicros: total,
    taxMicros: 0n,
    totalMicros: total,
  };
}

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
 * One platform fee line, plus informational prepaid usage and explicit currency rounding. These plans
 * pause or require an explicit top-up, so consumed credits are never charged again as money. A BYOM
 * plan refuses all inference usage (QA-027). Currency precision comes from approved pinned terms.
 */
export function buildPeriodInvoice(
  plan: PlanTerms,
  overage: readonly PricedMeter[],
  minorUnitExponent: number,
): DraftInvoice {
  if (plan.platformFeeMicros < 0n) throw new RangeError('INVALID_AMOUNT');
  if (plan.commercialMode === 'byom' && overage.length)
    throw new RangeError('BYOM_BILLS_NO_INFERENCE');
  if (
    plan.commercialMode === 'cloud' &&
    plan.overagePolicy !== 'pause' &&
    plan.overagePolicy !== 'explicit_top_up'
  )
    throw new RangeError('UNCONFIGURED_BILLING_POLICY');
  // These are prepaid plans. Credit usage is a statement, never another currency charge. Money for
  // additional capacity appears only on the explicit top-up order's invoice, at its approved price.
  const usage: DraftLine[] = overage.map((m) => ({
    kind: 'usage',
    meter: m.meter,
    quantity: m.quantity,
    unit: m.unit,
    unitPriceMicros: null,
    amountMicros: 0n,
    usageRef: null,
  }));
  return rounded(
    plan.currency,
    [line('platform_fee', plan.platformFeeMicros), ...usage],
    minorUnitExponent,
  );
}

/** One line, for exactly the price the person agreed to, plus rounding if needed. */
export function buildTopUpInvoice(
  quote: { priceMicros: Micros; currency: string },
  minorUnitExponent: number,
): DraftInvoice {
  if (quote.priceMicros < 0n) throw new RangeError('INVALID_AMOUNT');
  return rounded(quote.currency, [line('top_up', quote.priceMicros)], minorUnitExponent);
}

/** Adds what the tax port said. A negative tax, or tax in another currency, refuses. */
export function withTax(
  draft: DraftInvoice,
  tax: { taxMicros: Micros; currency: string },
  minorUnitExponent?: number,
): DraftInvoice {
  if (tax.taxMicros < 0n || tax.currency !== draft.currency || !invoiceAddsUp(draft))
    throw new RangeError('INVALID_TAX');
  const base = draft.lines.filter(
    (l) => l.kind !== 'tax' && (minorUnitExponent === undefined || l.kind !== 'rounding'),
  );
  const exact = base.reduce((sum, l) => sum + l.amountMicros, 0n);
  const total =
    minorUnitExponent === undefined
      ? exact + tax.taxMicros
      : roundToMinorUnit(exact + tax.taxMicros, minorUnitExponent);
  const adjustment = total - exact - tax.taxMicros;
  const lines = [
    ...base,
    line('tax', tax.taxMicros),
    ...(adjustment !== 0n ? [line('rounding', adjustment)] : []),
  ];
  return {
    currency: draft.currency,
    lines,
    subtotalMicros: exact + adjustment,
    taxMicros: tax.taxMicros,
    totalMicros: total,
  };
}

/** Every line adds up to its totals, to the micro. The database checks this again when one opens. */
export function invoiceAddsUp(draft: DraftInvoice): boolean {
  const sum = draft.lines.reduce(
    (totals, l) => {
      if (l.kind === 'tax') totals.tax += l.amountMicros;
      else totals.subtotal += l.amountMicros;
      return totals;
    },
    { tax: 0n, subtotal: 0n },
  );
  return (
    draft.taxMicros >= 0n &&
    draft.totalMicros >= 0n &&
    sum.tax === draft.taxMicros &&
    sum.subtotal === draft.subtotalMicros &&
    draft.totalMicros === draft.subtotalMicros + draft.taxMicros
  );
}
