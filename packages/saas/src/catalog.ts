// Rate cards and plans (BILL-04). Pure rules over data the operator entered. There is no price here and
// no fallback price: a meter with no line on an approved card has no price, and billing stops (ADR-032 D2).
// Owned by the catalog slice. See docs/06-delivery/m8-slices.md.
import type { Microcredits } from './money';

export const PUBLISHED_STATUSES = ['draft', 'approved', 'retired'] as const;
export type PublishedStatus = (typeof PUBLISHED_STATUSES)[number];

export type RateCardLine = { meter: string; unit: string; microcreditsPerUnit: Microcredits };

export type RateCardFacts = {
  id: string;
  status: PublishedStatus;
  currency: string;
  minorUnitExponent: number;
  effectiveFrom: Date | null;
  lines: readonly RateCardLine[];
};

export type PricedMeter = {
  meter: string;
  unit: string;
  quantity: bigint;
  microcreditsPerUnit: Microcredits;
  microcredits: Microcredits;
};

export type PricingRefusal =
  | 'RATE_CARD_MISSING'
  | 'RATE_CARD_NOT_APPROVED'
  | 'RATE_CARD_NOT_EFFECTIVE'
  | 'METER_NOT_PRICED'
  | 'UNIT_MISMATCH';

export type Priced =
  { ok: true; meters: readonly PricedMeter[] } | { ok: false; code: PricingRefusal };

/**
 * Prices usage. Refuses, and never guesses, when the card is missing, is a draft, is not yet effective at
 * `at`, has no line for a meter, or names a different unit for it. A retired card still prices the time it
 * was in force, since old usage keeps the price it had.
 */
export function priceUsage(
  _card: RateCardFacts | null,
  _usage: readonly { meter: string; unit: string; quantity: bigint }[],
  _at: Date,
): Priced {
  throw new Error('NOT_IMPLEMENTED');
}

export type PlanTerms = {
  planVersionId: string;
  commercialMode: 'cloud' | 'byom';
  status: PublishedStatus;
  currency: string;
  billingInterval: 'month' | 'year';
  paymentTermsDays: number;
  platformFeeMicros: bigint;
  includedMicrocredits: Microcredits | null;
  rateCardId: string | null;
  overagePolicy: 'pause' | 'explicit_top_up' | null;
  features: readonly string[];
  maxActiveMembers: number | null;
};

/** Plan versions a tenant in this mode may start on: approved, and for its own commercial mode. */
export function canStartOn(_plan: PlanTerms, _mode: string): boolean {
  throw new Error('NOT_IMPLEMENTED');
}

/** The end of a period that starts at `start`, by calendar and in UTC, with no month ever skipped. */
export function periodEnd(_start: Date, _interval: 'month' | 'year'): Date {
  throw new Error('NOT_IMPLEMENTED');
}
