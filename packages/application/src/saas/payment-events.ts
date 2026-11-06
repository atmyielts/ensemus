// Owned by the payments slice (BILL-01). A processor's webhook arrives once for the whole deployment, down
// M3's path, into the operator's own organization, and goes from there to its tenant. See ADR-032 D4.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type { PaymentEventFact } from '@ensemus/saas/payment';

/**
 * `WebhookEffectHandlers.recordPaymentEvent`, in the delivery's transaction. M3's inbox row already dedupes
 * the delivery, and the unique key on this table dedupes the processor's event ID. Emits PAYMENT_EVENT_RECEIVED.
 */
export function recordPaymentEventInTx(
  _tx: Tx,
  _context: TenantContext,
  _event: PaymentEventFact,
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export type RouteOutcome = 'applied' | 'unmatched' | 'ignored' | 'already_done';

/**
 * Service only, in two transactions, safe to run again. Finds the tenant with `withPaymentCustomerTx`, from
 * the hash alone, applies the fact there with `applyPaymentFactInTx`, then marks the row in the operator's
 * organization. No match is `unmatched`, kept for a person and alerted on: it never guesses. A forged or
 * misrouted fact changes nothing, since only a matching payment ID and exact amount move a payment.
 */
export function routePaymentEvent(
  _database: AppDatabase,
  _operatorContext: TenantContext,
  _input: { paymentWebhookEventId: string },
): Promise<RouteOutcome> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Writes `billing.payment_events` by its unique key, and only the first write acts. `payment_succeeded`
 * settles a payment whose reference, amount and currency match exactly, and what a person was told. A refund
 * or a dispute is recorded and flagged for a person, and takes no credits and no access away by itself.
 */
export function applyPaymentFactInTx(
  _tx: Tx,
  _context: TenantContext,
  _fact: PaymentEventFact,
): Promise<'applied' | 'already_applied' | 'no_matching_payment'> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Operator's view, from the command line: unmatched events, IDs and kinds, nothing else. */
export function listUnmatchedPaymentEvents(
  _database: AppDatabase,
  _operatorContext: TenantContext,
): Promise<readonly { id: string; kind: string; providerEventId: string; receivedAt: Date }[]> {
  throw new Error('NOT_IMPLEMENTED');
}
