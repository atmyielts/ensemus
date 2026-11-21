// A hosted checkout provider's verified call, applied in the delivery's own transaction (ADR-032 D4a). The
// connector worker checked the signature and obtained a single-use attestation for exactly this call; here
// the one checkout row it names is found by the hash of our order or the provider's transaction, its
// tenant is bound from that row, and the pure rules decide. Any money move spends the attestation in SQL,
// which checks the move again. The protocol answer is stored in the same commit, for the web tier to send.
import {
  checkoutReplies,
  checkoutSessions,
  invoices,
  memberships,
  payments,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { checkoutRoute, withCheckoutRoute } from '@ensemus/database/payment-routing';
import type { CheckoutCallback, CheckoutState } from '@ensemus/domain/checkout';
import {
  decideClick,
  decidePaddle,
  decidePaddleLookup,
  decidePayme,
  paymeErrorReply,
  paymeStatementEntry,
  paymeStatementReply,
  PAYME_ERRORS,
  type CheckoutChange,
  type CheckoutSessionView,
  type PaddleDecision,
  type PaddleLookup,
} from '@ensemus/saas/checkout';
import {
  AGGREGATE_INVOICE,
  AGGREGATE_PAYMENT,
  INVOICE_PAID,
  NOTIFY_PAYMENT_FAILED,
  NOTIFY_PAYMENT_UNKNOWN,
  PAYMENT_FAILED,
  PAYMENT_SUCCEEDED,
  invoiceTargetRef,
  paymentTargetRef,
} from '@ensemus/saas/events';
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { emit } from '../events';
import { auditAction, notify } from '../work';
import { afterInvoicePaidInTx } from './payments';
import type { AgentHaltPort } from './ports';

export type CheckoutCallbackSource = Readonly<{
  deliveryId: string;
  /** The attestation for this exact call, or null for a call that can move nothing. */
  verificationToken: string | null;
}>;

/** What happened, in codes, for the worker's log. Never a reference, an amount or provider text. */
export type CheckoutCallbackOutcome =
  'answered' | 'applied' | 'unmatched' | 'mismatch' | 'paid_after_close' | 'flagged';

const nowMs = () => BigInt(Date.now());

function viewOf(
  row: typeof checkoutSessions.$inferSelect,
  invoiceOpen: boolean,
): CheckoutSessionView {
  return {
    id: row.id,
    processor: row.processor as CheckoutSessionView['processor'],
    state: row.state as CheckoutState,
    amountMinor: row.amountMinor,
    currency: row.currency,
    providerTxnRef: row.providerTxnRef,
    clickPrepareId: row.clickPrepareId,
    providerTimeMs: row.providerTimeMs,
    createdMs: row.createdMs,
    performedMs: row.performedMs,
    cancelledMs: row.cancelledMs,
    cancelReason: row.cancelReason,
    invoiceOpen,
  };
}

async function loadSession(tx: Tx, context: TenantContext, sessionId: string) {
  const [row] = await tx
    .select()
    .from(checkoutSessions)
    .where(
      and(
        eq(checkoutSessions.organizationId, context.organizationId),
        eq(checkoutSessions.id, sessionId),
      ),
    )
    .for('update');
  if (!row) throw new AppError('NOT_FOUND');
  const [invoice] = await tx
    .select({ status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.organizationId, context.organizationId), eq(invoices.id, row.invoiceId)))
    .for('update');
  return { row, view: viewOf(row, invoice?.status === 'open') };
}

async function owners(tx: Tx) {
  return (
    await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.role, 'owner'), eq(memberships.status, 'active')))
  ).map((row) => row.id);
}

/** Spends the attestation on one move, then does what the move means for the payment and the invoice. */
async function applyChange(
  tx: Tx,
  context: TenantContext,
  row: typeof checkoutSessions.$inferSelect,
  change: CheckoutChange,
  token: string | null,
  agents: AgentHaltPort | undefined,
): Promise<void> {
  if (!token) throw new AppError('PREREQUISITES_INCOMPLETE');
  const txnRef = change.to === 'reserved' ? change.providerTxnRef : row.providerTxnRef;
  await tx.execute(sql`select billing.apply_checkout_change(${token}, ${row.id}::uuid, ${change.action}, ${change.to},
    ${txnRef}, ${change.to === 'reserved' && change.providerTimeMs !== null ? change.providerTimeMs.toString() : null}::bigint,
    ${change.atMs.toString()}::bigint,
    ${change.to === 'cancelled' || change.to === 'refunded' ? change.reason : null}::integer,
    ${change.to === 'paid' && change.taxMinor !== undefined ? change.taxMinor.toString() : null}::bigint)`);
  if (change.to === 'reserved') return;
  const [payment] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.organizationId, context.organizationId), eq(payments.id, row.paymentId)))
    .for('update');
  if (!payment) throw new AppError('NOT_FOUND');
  if (change.to === 'refunded') {
    // Recorded and shown to a person. It takes no credits and no access away by itself (ADR-032 D4).
    await auditAction(
      tx,
      context,
      'payment.flagged',
      paymentTargetRef(payment.id),
      'PROCESSOR_REFUND_REPORTED',
    );
    await notify(
      tx,
      context,
      await owners(tx),
      NOTIFY_PAYMENT_UNKNOWN,
      paymentTargetRef(payment.id),
    );
    return;
  }
  if (change.to === 'cancelled') {
    if (payment.status !== 'sending') return;
    await tx
      .update(payments)
      .set({
        status: 'failed',
        statusReason: 'CHECKOUT_CANCELLED',
        settledAt: new Date(),
        version: payment.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));
    await emit(tx, context, {
      eventType: PAYMENT_FAILED,
      aggregateType: AGGREGATE_PAYMENT,
      aggregateId: payment.id,
      aggregateVersion: payment.version + 1,
      classification: 'internal',
      payload: { payment_id: payment.id, invoice_id: payment.invoiceId },
    });
    await notify(
      tx,
      context,
      await owners(tx),
      NOTIFY_PAYMENT_FAILED,
      paymentTargetRef(payment.id),
    );
    return;
  }
  // paid
  if (payment.status === 'succeeded') return;
  await tx
    .update(payments)
    .set({
      status: 'succeeded',
      statusReason: 'CHECKOUT_PAID',
      processorPaymentRef: row.providerTxnRef,
      settledAt: new Date(),
      version: payment.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(payments.id, payment.id));
  await emit(tx, context, {
    eventType: PAYMENT_SUCCEEDED,
    aggregateType: AGGREGATE_PAYMENT,
    aggregateId: payment.id,
    aggregateVersion: payment.version + 1,
    classification: 'internal',
    payload: { payment_id: payment.id, invoice_id: payment.invoiceId },
  });
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, context.organizationId), eq(invoices.id, payment.invoiceId)),
    )
    .for('update');
  if (
    !invoice ||
    !['open', 'uncollectible'].includes(invoice.status) ||
    invoice.totalMicros !== payment.amountMicros ||
    invoice.currency !== payment.currency
  ) {
    // The money arrived for an invoice that can no longer take it. A person decides what to do with it.
    await auditAction(
      tx,
      context,
      'payment.flagged',
      paymentTargetRef(payment.id),
      'CHECKOUT_PAID_INVOICE_CLOSED',
    );
    await notify(
      tx,
      context,
      await owners(tx),
      NOTIFY_PAYMENT_UNKNOWN,
      paymentTargetRef(payment.id),
    );
    return;
  }
  await tx
    .update(invoices)
    .set({
      status: 'paid',
      paidAt: new Date(),
      version: invoice.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, invoice.id));
  await emit(tx, context, {
    eventType: INVOICE_PAID,
    aggregateType: AGGREGATE_INVOICE,
    aggregateId: invoice.id,
    aggregateVersion: invoice.version + 1,
    classification: 'internal',
    payload: { invoice_id: invoice.id },
  });
  await afterInvoicePaidInTx(tx, context, { invoiceId: invoice.id }, agents);
  await notify(tx, context, await owners(tx), PAYMENT_SUCCEEDED, invoiceTargetRef(invoice.id));
}

async function flag(tx: Tx, context: TenantContext, paymentId: string, reason: string) {
  await auditAction(tx, context, 'payment.flagged', paymentTargetRef(paymentId), reason);
  await notify(tx, context, await owners(tx), NOTIFY_PAYMENT_UNKNOWN, paymentTargetRef(paymentId));
}

function routeOf(callback: CheckoutCallback): string | null {
  if (callback.provider === 'payme') {
    if (callback.method === 'CheckPerformTransaction' || callback.method === 'CreateTransaction')
      return callback.orderRef ? checkoutRoute('order', 'payme', callback.orderRef) : null;
    if (
      callback.method === 'PerformTransaction' ||
      callback.method === 'CancelTransaction' ||
      callback.method === 'CheckTransaction'
    )
      return checkoutRoute('txn', 'payme', callback.paymeTxnId);
    return null;
  }
  if (callback.provider === 'click') return checkoutRoute('order', 'click', callback.orderRef);
  return checkoutRoute('txn', 'paddle', callback.transactionId);
}

/**
 * `WebhookEffectHandlers.applyCheckoutCallback`, in the delivery's transaction in the deployment's own
 * organization. Every Payme or Click call gets an answer stored, including a refusal; nothing here throws
 * for a provider's mistake, because a throw would leave the provider waiting with no answer at all.
 */
export async function applyCheckoutCallbackInTx(
  tx: Tx,
  operator: TenantContext,
  callback: CheckoutCallback,
  source: CheckoutCallbackSource,
  agents?: AgentHaltPort,
): Promise<CheckoutCallbackOutcome> {
  if (operator.actorType !== 'service') throw new AppError('NOT_FOUND');
  if (source.verificationToken !== null && !/^[0-9a-f]{64}$/.test(source.verificationToken))
    throw new AppError('INVALID_INPUT');
  let reply: string | null = null;
  let outcome: CheckoutCallbackOutcome = 'answered';

  if (callback.provider === 'payme' && callback.method === 'GetStatement') {
    if (!source.verificationToken) throw new AppError('PREREQUISITES_INCOMPLETE');
    const rows = (
      await tx.execute<{
        id: string;
        provider_txn_ref: string;
        provider_time_ms: string;
        amount_minor: string;
        created_ms: string | null;
        performed_ms: string | null;
        cancelled_ms: string | null;
        cancel_reason: number | null;
        state: CheckoutState;
      }>(
        sql`select * from billing.checkout_payme_statement(${source.verificationToken}, ${callback.fromMs}::bigint, ${callback.toMs}::bigint)`,
      )
    ).rows;
    const big = (value: string | null) => (value === null ? null : BigInt(value));
    reply = paymeStatementReply(
      callback.rpcId,
      rows
        .map((row) =>
          paymeStatementEntry({
            id: row.id,
            processor: 'payme',
            state: row.state,
            amountMinor: BigInt(row.amount_minor),
            currency: 'UZS',
            providerTxnRef: row.provider_txn_ref,
            clickPrepareId: null,
            providerTimeMs: big(row.provider_time_ms),
            createdMs: big(row.created_ms),
            performedMs: big(row.performed_ms),
            cancelledMs: big(row.cancelled_ms),
            cancelReason: row.cancel_reason,
            invoiceOpen: false,
          }),
        )
        .filter((entry): entry is string => entry !== null),
    );
  } else {
    const route = routeOf(callback);
    const routed = route
      ? await withCheckoutRoute(tx, operator, route, async (tenantTx, scope) => {
          const { row, view } = await loadSession(tenantTx, scope.context, scope.sessionId);
          const now = nowMs();
          if (callback.provider === 'paddle') {
            const decision = decidePaddle(callback, view, now);
            return {
              reply: null,
              outcome: await paddleEffect(
                tenantTx,
                scope.context,
                row,
                decision,
                callback.kind,
                source,
                agents,
              ),
            };
          }
          const decision =
            callback.provider === 'payme'
              ? decidePayme(callback, view, now)
              : decideClick(callback, view, now);
          if (decision.change)
            await applyChange(
              tenantTx,
              scope.context,
              row,
              decision.change,
              source.verificationToken,
              agents,
            );
          return {
            reply: decision.reply,
            outcome: (decision.change ? 'applied' : 'answered') as CheckoutCallbackOutcome,
          };
        })
      : ({ found: false } as const);
    if (routed.found) {
      reply = routed.value.reply;
      outcome = routed.value.outcome;
    } else if (callback.provider === 'payme') {
      reply = decidePayme(callback, null, nowMs()).reply;
    } else if (callback.provider === 'click') {
      reply = decideClick(callback, null, nowMs()).reply;
    } else outcome = 'unmatched';
  }

  if (callback.provider !== 'paddle')
    await tx.insert(checkoutReplies).values({
      organizationId: operator.organizationId,
      deliveryId: source.deliveryId,
      processor: callback.provider,
      body: reply ?? paymeErrorReply(null, PAYME_ERRORS.system),
    });
  return outcome;
}

async function paddleEffect(
  tx: Tx,
  context: TenantContext,
  row: typeof checkoutSessions.$inferSelect,
  decision: PaddleDecision,
  kind: string,
  source: CheckoutCallbackSource,
  agents: AgentHaltPort | undefined,
): Promise<CheckoutCallbackOutcome> {
  switch (decision.outcome) {
    case 'apply':
      await applyChange(tx, context, row, decision.change, source.verificationToken, agents);
      return 'applied';
    case 'mismatch':
      await flag(tx, context, row.paymentId, 'CHECKOUT_MISMATCH_REPORTED');
      return 'mismatch';
    case 'paid_after_close':
      await flag(tx, context, row.paymentId, 'CHECKOUT_PAID_AFTER_CLOSE');
      return 'paid_after_close';
    case 'nothing':
      if (kind === 'disputed') {
        await flag(tx, context, row.paymentId, 'PROCESSOR_DISPUTE_REPORTED');
        return 'flagged';
      }
      return 'answered';
  }
}

/**
 * Paddle's own transaction, read by the connector worker for one open checkout and attested there. Service
 * only, in the checkout's own tenant. Answers what it did, for the reconcile loop to decide whether to stop.
 */
export async function applyPaddleLookupInTx(
  tx: Tx,
  context: TenantContext,
  input: { sessionId: string; lookup: PaddleLookup; verificationToken: string | null },
  agents?: AgentHaltPort,
): Promise<'applied' | 'still_open' | 'settled' | 'mismatch' | 'paid_after_close'> {
  if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
  const { row, view } = await loadSession(tx, context, input.sessionId);
  if (row.state !== 'open') return 'settled';
  const decision = decidePaddleLookup(input.lookup, view, nowMs());
  if (decision.outcome === 'apply') {
    await applyChange(tx, context, row, decision.change, input.verificationToken, agents);
    return 'applied';
  }
  if (decision.outcome === 'mismatch' || decision.outcome === 'paid_after_close') {
    await flag(
      tx,
      context,
      row.paymentId,
      decision.outcome === 'mismatch' ? 'CHECKOUT_MISMATCH_REPORTED' : 'CHECKOUT_PAID_AFTER_CLOSE',
    );
    return decision.outcome;
  }
  return 'still_open';
}

/** The reconcile loop's write, in the checkout's own tenant, after the worker attested Paddle's answer. */
export function applyPaddleLookup(
  database: AppDatabase,
  context: TenantContext,
  input: { sessionId: string; lookup: PaddleLookup; verificationToken: string | null },
  agents?: AgentHaltPort,
) {
  return withAccountTx(database, context, (tx) =>
    applyPaddleLookupInTx(tx, context, input, agents),
  );
}
