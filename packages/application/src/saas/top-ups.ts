// Owned by the credits slice (BILL-05). Explicit, or not at all: QA-026 is "pause or top up, no surprise
// bill". There is no auto top-up, and no code path buys credits without a person's quote hash.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';

/**
 * `billing.manage`, and a person: a service context is refused. Recomputes the quote from the approved offer
 * under lock, compares `quoteHash`, and answers QUOTE_CHANGED if it moved. BYOM, a `pause` plan and a
 * non-active tenant are refused. Repeating a `requestKey` returns the first. Emits TOP_UP_REQUESTED. It
 * creates the invoice through `createTopUpInvoiceInTx`, and the credits arrive only after payment succeeds.
 */
export function requestTopUp(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { offerId: string; quoteHash: string; requestKey: string },
): Promise<{ topUpId: string; invoiceId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Service only, in the transaction that marked the invoice paid. Credits once, by key. Called by payments. */
export function creditPaidTopUpInTx(
  _tx: Tx,
  _context: TenantContext,
  _input: { invoiceId: string },
): Promise<'credited' | 'not_a_top_up' | 'already_credited'> {
  throw new Error('NOT_IMPLEMENTED');
}

/** `billing.view`. */
export function listTopUps(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<
  readonly { id: string; status: string; priceMicros: bigint; currency: string; createdAt: Date }[]
> {
  throw new Error('NOT_IMPLEMENTED');
}
