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
  card: RateCardFacts | null,
  usage: readonly { meter: string; unit: string; quantity: bigint }[],
  at: Date,
): Priced {
  if (!card) return { ok: false, code: 'RATE_CARD_MISSING' };
  if (card.status !== 'approved' && card.status !== 'retired') {
    return { ok: false, code: 'RATE_CARD_NOT_APPROVED' };
  }
  if (
    !card.effectiveFrom ||
    !Number.isFinite(card.effectiveFrom.getTime()) ||
    !Number.isFinite(at.getTime()) ||
    card.effectiveFrom > at
  ) {
    return { ok: false, code: 'RATE_CARD_NOT_EFFECTIVE' };
  }
  const meters: PricedMeter[] = [];
  for (const used of usage) {
    const line = card.lines.find((candidate) => candidate.meter === used.meter);
    if (!line) return { ok: false, code: 'METER_NOT_PRICED' };
    if (line.unit !== used.unit) return { ok: false, code: 'UNIT_MISMATCH' };
    meters.push({
      ...used,
      microcreditsPerUnit: line.microcreditsPerUnit,
      microcredits: used.quantity * line.microcreditsPerUnit,
    });
  }
  return { ok: true, meters };
}

export type PlanTerms = {
  planVersionId: string;
  commercialMode: 'cloud' | 'byom';
  status: PublishedStatus;
  currency: string;
  billingInterval: 'month' | 'year';
  paymentTermsDays: number;
  minorUnitExponent: number | null;
  platformFeeMicros: bigint;
  includedMicrocredits: Microcredits | null;
  rateCardId: string | null;
  overagePolicy: 'pause' | 'explicit_top_up' | null;
  features: readonly string[];
  maxActiveMembers: number | null;
};

/** Plan versions a tenant in this mode may start on: approved, and for its own commercial mode. */
export function canStartOn(plan: PlanTerms, mode: string): boolean {
  return (
    plan.status === 'approved' && plan.commercialMode === mode && plan.minorUnitExponent !== null
  );
}

/** The end of a period that starts at `start`, by calendar and in UTC, with no month ever skipped. */
export function periodEnd(start: Date, interval: 'month' | 'year'): Date {
  if (!Number.isFinite(start.getTime()) || (interval !== 'month' && interval !== 'year')) {
    throw new RangeError('INVALID_PERIOD');
  }
  const end = new Date(start);
  // Moving the first day cannot spill a short destination month into the month after it.
  end.setUTCDate(1);
  if (interval === 'month') end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCFullYear(end.getUTCFullYear() + 1);
  const lastDay = new Date(end);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  end.setUTCDate(Math.min(start.getUTCDate(), lastDay.getUTCDate()));
  if (!Number.isFinite(end.getTime())) throw new RangeError('INVALID_PERIOD');
  return end;
}
