// AI credits and top-ups (BILL-05). Pure. A run pauses or asks for a top-up at the limit, and nothing is
// ever bought on anyone's behalf. Owned by the credits slice. See docs/06-delivery/m8-slices.md.
import { createHash } from 'node:crypto';
import type { Microcredits, Micros } from './money';
import { priceUsage, type PricingRefusal, type RateCardFacts } from './catalog';

/** Exact input AND output capacity at an explicitly approved credit card. No USD conversion or
 * observed-usage claim: callers retain this ceiling for an answer whose usage is unknown. */
export function priceModelCreditCeiling(
  card: RateCardFacts | null,
  at: Date,
  ceiling: { inputTokens: number; outputTokens: number },
):
  | { ok: true; inputMicrocredits: bigint; outputMicrocredits: bigint; totalMicrocredits: bigint }
  | { ok: false; code: PricingRefusal | 'INVALID_MODEL_CEILING' | 'CREDIT_AMOUNT_UNREPRESENTABLE' } {
  if (![ceiling.inputTokens, ceiling.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0))
    return { ok: false, code: 'INVALID_MODEL_CEILING' };
  const priced = priceUsage(card, [
    { meter: 'model_input_tokens', unit: 'token', quantity: BigInt(ceiling.inputTokens) },
    { meter: 'model_output_tokens', unit: 'token', quantity: BigInt(ceiling.outputTokens) },
  ], at);
  if (!priced.ok) return priced;
  const inputMicrocredits = priced.meters[0]!.microcredits;
  const outputMicrocredits = priced.meters[1]!.microcredits;
  const totalMicrocredits = inputMicrocredits + outputMicrocredits;
  if ([...priced.meters.map(value => value.microcreditsPerUnit), inputMicrocredits, outputMicrocredits, totalMicrocredits]
    .some(value => value < 0n || value > 9223372036854775807n))
    return { ok: false, code: 'CREDIT_AMOUNT_UNREPRESENTABLE' };
  return { ok: true, inputMicrocredits, outputMicrocredits, totalMicrocredits };
}

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
  balance: Microcredits,
  estimated: Microcredits,
  overagePolicy: 'pause' | 'explicit_top_up',
  warnBelow: Microcredits | null,
): ExhaustionDecision {
  const allowed = balance > 0n && estimated >= 0n && balance >= estimated;
  return {
    allowed,
    action: allowed ? 'continue' : overagePolicy === 'explicit_top_up' ? 'request_top_up' : 'pause',
    warn: warnBelow !== null && balance < warnBelow,
  };
}
