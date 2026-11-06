// Owned by the payments slice (BILL-01). A processor's webhook arrives once for the whole deployment, down
// M3's path, into the operator's own organization, and goes from there to its tenant. See ADR-032 D4.
import {
  billingAccounts,
  invoices,
  memberships,
  organizations,
  paymentEvents,
  payments,
  paymentWebhookEvents,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { withPaymentCustomerTx } from '@ensemus/database/payment-routing';
import { PAYMENT_EVENT_KINDS } from '@ensemus/domain/webhook';
import {
  AGGREGATE_INVOICE,
  AGGREGATE_PAYMENT,
  AGGREGATE_PAYMENT_WEBHOOK_EVENT,
  INVOICE_PAID,
  NOTIFY_PAYMENT_FAILED,
  NOTIFY_PAYMENT_UNKNOWN,
  PAYMENT_EVENT_RECEIVED,
  PAYMENT_FAILED,
  PAYMENT_SUCCEEDED,
  invoiceTargetRef,
  paymentTargetRef,
} from '@ensemus/saas/events';
import { and, desc, eq } from 'drizzle-orm';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { emit } from '../events';
import { auditAction, notify } from '../work';
import { afterInvoicePaidInTx } from './payments';
import type { AgentHaltPort } from './ports';
import type { PaymentEventFact } from '@ensemus/saas/payment';

export type PaymentWebhookBinding = {
  billingOrganizationId: string;
  billingConnectionId: string;
  processor: string;
  connectionId: string;
};
export type PaymentRoutingBinding = { billingOrganizationId: string };
const ref = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value);
const requireService = (context: TenantContext) => {
  if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
};
const canonicalId = (value: string) => {
  const parsed = idSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
function validate(fact: PaymentEventFact) {
  if (
    !/^[a-z][a-z0-9_]{1,63}$/.test(fact.processor) ||
    !ref(fact.providerEventId) ||
    !PAYMENT_EVENT_KINDS.includes(fact.kind) ||
    !/^[a-f0-9]{64}$/.test(fact.customerRefHash) ||
    !Number.isSafeInteger(fact.occurredAtSeconds) ||
    fact.occurredAtSeconds < 0 ||
    !Number.isFinite(new Date(fact.occurredAtSeconds * 1000).getTime()) ||
    (fact.processorPaymentRef !== null && !ref(fact.processorPaymentRef)) ||
    (fact.paymentId !== null && !idSchema.safeParse(fact.paymentId).success) ||
    (fact.currency !== null && !/^[A-Z]{3}$/.test(fact.currency)) ||
    (fact.amountMicros !== null && !/^-?(0|[1-9][0-9]{0,18})$/.test(fact.amountMicros))
  )
    throw new AppError('INVALID_INPUT');
  if (
    fact.amountMicros !== null &&
    (BigInt(fact.amountMicros) < -9223372036854775808n ||
      BigInt(fact.amountMicros) > 9223372036854775807n)
  )
    throw new AppError('INVALID_INPUT');
}
const routing = (context: TenantContext, binding: PaymentRoutingBinding | undefined) => {
  requireService(context);
  if (!binding || canonicalId(binding.billingOrganizationId) !== context.organizationId)
    throw new AppError('NOT_FOUND');
};

/**
 * `WebhookEffectHandlers.recordPaymentEvent`, in the delivery's transaction. M3's inbox row already dedupes
 * the delivery, and the unique key on this table dedupes the processor's event ID. Emits PAYMENT_EVENT_RECEIVED.
 */
export async function recordPaymentEventInTx(
  tx: Tx,
  context: TenantContext,
  event: PaymentEventFact,
  binding?: PaymentWebhookBinding,
): Promise<void> {
  routing(context, binding);
  validate(event);
  if (
    !binding ||
    canonicalId(binding.billingConnectionId) !== canonicalId(binding.connectionId) ||
    !idSchema.safeParse(binding.connectionId).success ||
    binding.processor !== event.processor
  )
    throw new AppError('NOT_FOUND');
  const [row] = await tx
    .insert(paymentWebhookEvents)
    .values({
      organizationId: context.organizationId,
      processor: event.processor,
      providerEventId: event.providerEventId,
      kind: event.kind,
      customerRefHash: event.customerRefHash,
      processorPaymentRef: event.processorPaymentRef,
      paymentId: event.paymentId,
      amountMicros: event.amountMicros === null ? null : BigInt(event.amountMicros),
      currency: event.currency,
      providerOccurredAt: new Date(event.occurredAtSeconds * 1000),
    })
    .onConflictDoNothing()
    .returning({ id: paymentWebhookEvents.id });
  if (row)
    await emit(tx, context, {
      eventType: PAYMENT_EVENT_RECEIVED,
      aggregateType: AGGREGATE_PAYMENT_WEBHOOK_EVENT,
      aggregateId: row.id,
      aggregateVersion: 1,
      classification: 'internal',
      payload: { payment_webhook_event_id: row.id },
    });
}

export type RouteOutcome = 'applied' | 'unmatched' | 'ignored' | 'already_done';

/**
 * Service only, in two transactions, safe to run again. Finds the tenant with `withPaymentCustomerTx`, from
 * the hash alone, applies the fact there with `applyPaymentFactInTx`, then marks the row in the operator's
 * organization. No match is `unmatched`, kept for a person and alerted on: it never guesses. A forged or
 * misrouted fact changes nothing, since only a matching payment ID and exact amount move a payment.
 */
export async function routePaymentEvent(
  database: AppDatabase,
  operatorContext: TenantContext,
  input: { paymentWebhookEventId: string },
  binding?: PaymentRoutingBinding,
  agents?: AgentHaltPort,
): Promise<RouteOutcome> {
  routing(operatorContext, binding);
  const id = idSchema.safeParse(input.paymentWebhookEventId);
  if (!id.success) throw new AppError('INVALID_INPUT');
  const [row] = await withAccountTx(database, operatorContext, (tx) =>
    tx
      .select()
      .from(paymentWebhookEvents)
      .where(
        and(
          eq(paymentWebhookEvents.organizationId, operatorContext.organizationId),
          eq(paymentWebhookEvents.id, id.data),
        ),
      ),
  );
  if (!row) throw new AppError('NOT_FOUND');
  if (row.state === 'applied' || row.state === 'ignored') return 'already_done';
  const fact: PaymentEventFact = {
    processor: row.processor,
    providerEventId: row.providerEventId,
    kind: row.kind as PaymentEventFact['kind'],
    customerRefHash: row.customerRefHash,
    processorPaymentRef: row.processorPaymentRef,
    paymentId: row.paymentId,
    amountMicros: row.amountMicros?.toString() ?? null,
    currency: row.currency,
    occurredAtSeconds: Math.floor(row.providerOccurredAt.getTime() / 1000),
  };
  validate(fact);
  let outcome: RouteOutcome = 'unmatched';
  let organizationId: string | null = null;
  if (fact.kind === 'customer_updated') outcome = 'ignored';
  else {
    const applied = await withPaymentCustomerTx(
      database,
      fact.customerRefHash,
      async (tx, scope) => {
        if (scope.account.processor !== fact.processor) return null;
        const result = await applyPaymentFactInTx(tx, scope.context, fact, agents);
        return { organizationId: scope.context.organizationId, result };
      },
    );
    if (applied && applied.result !== 'no_matching_payment') {
      organizationId = applied.organizationId;
      outcome = applied.result === 'already_applied' ? 'already_done' : 'applied';
    }
  }
  // The two durable writes are separate. The initial read holds no connection across tenant routing,
  // so a one-connection pool works too. A crash after the tenant commit replays its unique event key.
  return withAccountTx(database, operatorContext, async (tx) => {
    const [current] = await tx
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.id, id.data))
      .for('update');
    if (!current) throw new AppError('NOT_FOUND');
    if (current.state === 'applied' || current.state === 'ignored') return 'already_done';
    await tx
      .update(paymentWebhookEvents)
      .set({
        state:
          outcome === 'ignored' ? 'ignored' : outcome === 'unmatched' ? 'unmatched' : 'applied',
        targetOrganizationId: organizationId,
        processedAt: new Date(),
      })
      .where(eq(paymentWebhookEvents.id, id.data));
    return outcome;
  });
}

/**
 * Writes `billing.payment_events` by its unique key, and only the first write acts. `payment_succeeded`
 * settles a payment whose reference, amount and currency match exactly, and what a person was told. A refund
 * or a dispute is recorded and flagged for a person, and takes no credits and no access away by itself.
 */
export async function applyPaymentFactInTx(
  tx: Tx,
  context: TenantContext,
  fact: PaymentEventFact,
  agents?: AgentHaltPort,
): Promise<'applied' | 'already_applied' | 'no_matching_payment'> {
  requireService(context);
  validate(fact);
  // Serialize all financial mutations before choosing a payment or accepting evidence for it.
  const [org] = await tx
    .select({ id: organizations.id, lifecycle: organizations.lifecycle })
    .from(organizations)
    .where(eq(organizations.id, context.organizationId))
    .for('no key update');
  if (!org || org.lifecycle === 'deleted') return 'no_matching_payment';
  const [account] = await tx
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.organizationId, context.organizationId));
  if (
    !account ||
    account.processor !== fact.processor ||
    account.customerRefHash !== fact.customerRefHash
  )
    return 'no_matching_payment';
  const [prior] = await tx
    .select({ id: paymentEvents.id })
    .from(paymentEvents)
    .where(
      and(
        eq(paymentEvents.processor, fact.processor),
        eq(paymentEvents.providerEventId, fact.providerEventId),
      ),
    );
  if (prior) return 'already_applied';
  const candidates = fact.paymentId
    ? await tx
        .select()
        .from(payments)
        .where(and(eq(payments.id, fact.paymentId), eq(payments.processor, fact.processor)))
        .for('update')
    : fact.processorPaymentRef
      ? await tx
          .select()
          .from(payments)
          .where(
            and(
              eq(payments.processorPaymentRef, fact.processorPaymentRef),
              eq(payments.processor, fact.processor),
            ),
          )
          .for('update')
      : [];
  const payment = candidates[0];
  if (!payment || candidates.length !== 1) return 'no_matching_payment';
  if (
    payment.processorPaymentRef &&
    fact.processorPaymentRef &&
    payment.processorPaymentRef !== fact.processorPaymentRef
  )
    return 'no_matching_payment';
  if (fact.processorPaymentRef) {
    const [other] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.processor, fact.processor),
          eq(payments.processorPaymentRef, fact.processorPaymentRef),
        ),
      );
    if (other && other.id !== payment.id) return 'no_matching_payment';
  }
  if (fact.currency !== payment.currency || fact.amountMicros === null)
    return 'no_matching_payment';
  const money = BigInt(fact.amountMicros);
  const settlement = fact.kind === 'payment_succeeded' || fact.kind === 'payment_failed';
  if (
    settlement &&
    (money !== payment.amountMicros ||
      !['sending', 'reconciling', 'unknown', 'succeeded'].includes(payment.status))
  )
    return 'no_matching_payment';
  if (fact.kind === 'payment_succeeded' && !fact.processorPaymentRef) return 'no_matching_payment';
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, payment.invoiceId))
    .for('update');
  if (!invoice) return 'no_matching_payment';
  if (
    fact.kind === 'payment_succeeded' &&
    (!['open', 'uncollectible', 'paid'].includes(invoice.status) ||
      invoice.totalMicros !== money ||
      invoice.currency !== fact.currency)
  )
    return 'no_matching_payment';
  const [inserted] = await tx
    .insert(paymentEvents)
    .values({
      organizationId: context.organizationId,
      processor: fact.processor,
      providerEventId: fact.providerEventId,
      kind: fact.kind,
      paymentId: payment.id,
      invoiceId: payment.invoiceId,
      amountMicros: money,
      currency: fact.currency,
      providerOccurredAt: new Date(fact.occurredAtSeconds * 1000),
    })
    .onConflictDoNothing()
    .returning({ id: paymentEvents.id });
  if (!inserted) return 'already_applied';
  if (fact.kind === 'payment_refunded' || fact.kind === 'payment_disputed') {
    await auditAction(
      tx,
      context,
      'payment.flagged',
      paymentTargetRef(payment.id),
      fact.kind === 'payment_refunded' ? 'PROCESSOR_REFUND_REPORTED' : 'PROCESSOR_DISPUTE_REPORTED',
    );
    const owners = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.role, 'owner'), eq(memberships.status, 'active')));
    await notify(
      tx,
      context,
      owners.map((row) => row.id),
      NOTIFY_PAYMENT_UNKNOWN,
      paymentTargetRef(payment.id),
    );
    return 'applied';
  }
  if (payment.status === 'succeeded') return 'applied';
  if (fact.kind === 'payment_succeeded') {
    if (
      !['open', 'uncollectible', 'paid'].includes(invoice.status) ||
      invoice.totalMicros !== money ||
      invoice.currency !== fact.currency
    )
      return 'no_matching_payment';
    await tx
      .update(payments)
      .set({
        status: 'succeeded',
        statusReason: 'CONFIRMED_BY_EVENT',
        processorPaymentRef: fact.processorPaymentRef,
        settledAt: new Date(),
        version: payment.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));
    if (invoice.status !== 'paid') {
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
    }
    await afterInvoicePaidInTx(tx, context, { invoiceId: invoice.id }, agents);
    await emit(tx, context, {
      eventType: PAYMENT_SUCCEEDED,
      aggregateType: AGGREGATE_PAYMENT,
      aggregateId: payment.id,
      aggregateVersion: payment.version + 1,
      classification: 'internal',
      payload: { payment_id: payment.id, invoice_id: invoice.id },
    });
    const owners = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.role, 'owner'), eq(memberships.status, 'active')));
    await notify(
      tx,
      context,
      owners.map((row) => row.id),
      PAYMENT_SUCCEEDED,
      invoiceTargetRef(invoice.id),
    );
  } else if (fact.kind === 'payment_failed') {
    await tx
      .update(payments)
      .set({
        status: 'failed',
        statusReason: 'REFUSED_BY_EVENT',
        processorPaymentRef: fact.processorPaymentRef ?? payment.processorPaymentRef,
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
      payload: { payment_id: payment.id, invoice_id: invoice.id },
    });
    const owners = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.role, 'owner'), eq(memberships.status, 'active')));
    await notify(
      tx,
      context,
      owners.map((row) => row.id),
      NOTIFY_PAYMENT_FAILED,
      paymentTargetRef(payment.id),
    );
  }
  return 'applied';
}

/** Operator's view, from the command line: unmatched events, IDs and kinds, nothing else. */
export async function listUnmatchedPaymentEvents(
  database: AppDatabase,
  operatorContext: TenantContext,
  binding?: PaymentRoutingBinding,
): Promise<readonly { id: string; kind: string; providerEventId: string; receivedAt: Date }[]> {
  routing(operatorContext, binding);
  return withAccountTx(database, operatorContext, (tx) =>
    tx
      .select({
        id: paymentWebhookEvents.id,
        kind: paymentWebhookEvents.kind,
        providerEventId: paymentWebhookEvents.providerEventId,
        receivedAt: paymentWebhookEvents.receivedAt,
      })
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.state, 'unmatched'))
      .orderBy(desc(paymentWebhookEvents.receivedAt), desc(paymentWebhookEvents.id))
      .limit(100),
  );
}
