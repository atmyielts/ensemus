// AI credits and top-ups (BILL-05). Pure. A run pauses or asks for a top-up at the limit, and nothing is
// ever bought on anyone's behalf. Owned by the credits slice. See docs/06-delivery/m8-slices.md.
import { createHash } from 'node:crypto';
import type { Microcredits, Micros } from './money';

export const CREDIT_KINDS = [
  'allocation',
  'top_up',
  'consumption',
  'expiry',
  'correction',
] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];

export const TOP_UP_STATUSES = [
  'requested',
  'invoiced',
  'paid',
  'credited',
  'failed',
  'cancelled',
] as const;
export type TopUpStatus = (typeof TOP_UP_STATUSES)[number];

/** Each key is fixed by what it stands for, so doing any of these twice writes one row. */
export const creditKeys = {
  allocation: (billingPeriodId: string) => `allocation:${billingPeriodId}`,
  topUp: (topUpId: string) => `top_up:${topUpId}`,
  consumption: (usageLedgerId: string) => `usage:${usageLedgerId}`,
  expiry: (billingPeriodId: string) => `expiry:${billingPeriodId}`,
};

export type TopUpQuote = {
  offerId: string;
  rateCardId: string;
  microcredits: Microcredits;
  priceMicros: Micros;
  currency: string;
};

/**
 * What a person saw when they said yes. A top-up request carries this, and a price that has changed since
 * then no longer matches, so nobody pays anything other than what they were shown (no surprise charges).
 */
export function quoteHash(quote: TopUpQuote): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        quote.offerId,
        quote.rateCardId,
        quote.microcredits.toString(),
        quote.priceMicros.toString(),
        quote.currency,
      ]),
    )
    .digest('hex');
}

export type ExhaustionDecision = {
  /** Whether a new model call may start. */
  allowed: boolean;
  action: 'continue' | 'pause' | 'request_top_up';
  /** Below this share of what was allocated, an admin is warned, ahead of any hard stop. */
  warn: boolean;
};

/**
 * What happens at the limit, by the plan's `overagePolicy`. `warnBelow` comes from the plan or the operator,
 * and there is no number here. A negative balance always stops the next call and never bills anyone.
 */
export function exhaustionDecision(
  _balance: Microcredits,
  _estimated: Microcredits,
  _overagePolicy: 'pause' | 'explicit_top_up',
  _warnBelow: Microcredits | null,
): ExhaustionDecision {
  throw new Error('NOT_IMPLEMENTED');
}
