// Owned by the payments slice (BILL-01). The same shape as ADR-027 D2: an intent, an attempt committed before
// any contact, and an honest `unknown`. See docs/06-delivery/m8-slices.md and ADR-032 D4.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type {
  ChargeRequest,
  ChargeResult,
  PaymentCode,
  PaymentLookupResult,
  PaymentStatus,
  ProcessorManifest,
} from '@ensemus/saas/payment';

/**
 * `billing.manage`, or the service context under a published collection policy. Refuses an invoice that is
 * not open, and any tenant in Sovereign. Writes the intent and PAYMENT_REQUESTED in one transaction. A live
 * payment for this invoice is returned, and no second one is made.
 */
export function requestInvoicePayment(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { invoiceId: string; processor: string },
): Promise<{ paymentId: string; status: PaymentStatus }> {
  throw new Error('NOT_IMPLEMENTED');
}

export type BeginPaymentResult =
  | { kind: 'attempt'; attemptId: string; charge: ChargeRequest }
  /** Refused before contact, or this run has nothing left to do. */
  | { kind: 'stop'; status: PaymentStatus; code: PaymentCode }
  /** An earlier attempt could have charged, so this goes to reconcile and does not try again. */
  | { kind: 'reconcile'; attemptId: string };

/** Locks the payment, rechecks everything through `checkBeforeCharge`, and commits the attempt. */
export function beginPaymentAttempt(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { paymentId: string; runId: string },
): Promise<BeginPaymentResult> {
  throw new Error('NOT_IMPLEMENTED');
}

export type PaymentStep =
  | { step: 'succeeded' | 'failed' | 'cancelled' | 'unknown' }
  | { step: 'retry'; afterMs: number }
  | { step: 'reconcile' };

/**
 * Records the answer. On success in one transaction: the attempt, the payment, the invoice to `paid`, the
 * top-up credited through `creditPaidTopUpInTx`, and a collection case resolved. Emits and notifies.
 */
export function finishPaymentAttempt(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { attemptId: string; result: ChargeResult },
): Promise<PaymentStep> {
  throw new Error('NOT_IMPLEMENTED');
}

export type InterruptedPayment = 'nothing_sent' | 'attempt_open' | 'settled';

export function inspectInterruptedPayment(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { paymentId: string },
): Promise<InterruptedPayment> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Marks an open attempt indeterminate and answers what a lookup needs. Null when it is settled. */
export function beginPaymentReconcile(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { paymentId: string; code: PaymentCode },
): Promise<{ attemptId: string; idempotencyKey: string; processor: string } | null> {
  throw new Error('NOT_IMPLEMENTED');
}

export function finishPaymentReconcile(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    attemptId: string;
    result: PaymentLookupResult;
    lookup: ProcessorManifest['lookup'];
  },
): Promise<'succeeded' | 'failed' | 'retry' | 'unknown'> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Nothing could be contacted, such as the connector worker not being there. Only with no open attempt. */
export function failUnsentPayment(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { paymentId: string; code: PaymentCode },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * `billing.manage`, and a person. Says what a processor's dashboard showed for an unknown payment. It moves no
 * money. Saying it succeeded needs a matching event or lookup, because the database wants evidence, and a
 * person's word is not that. Saying it failed lets a new payment be made.
 */
export function resolveUnknownPayment(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    paymentId: string;
    resolution: 'confirmed_not_charged';
    expectedVersion: number;
  },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Called in a tenant's transaction when an invoice falls paid another way. Keeps the case and top-up true. */
export function afterInvoicePaidInTx(
  _tx: Tx,
  _context: TenantContext,
  _input: { invoiceId: string },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}
