// Owned by the payments slice (BILL-01). The same shape as ADR-027 D2: an intent, an attempt committed before
// any contact, and an honest `unknown`. See docs/06-delivery/m8-slices.md and ADR-032 D4.
import {
  billingAccounts,
  collectionCases,
  collectionPolicies,
  idempotencyKeys,
  invoices,
  memberships,
  organizations,
  paymentAttempts,
  payments,
  planVersions,
  rateCards,
  standingChanges,
  subscriptions,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { can } from '@ensemus/domain/policy';
import {
  checkBeforeCharge,
  decideAfterCharge,
  decideAfterLookup,
  hashCustomerRef,
  MAX_PAYMENT_ATTEMPTS,
  nextCollectionStep,
  PAYMENT_CODES,
  paymentIdempotencyKey,
  type CollectionStep,
} from '@ensemus/saas/payment';
import {
  AGGREGATE_INVOICE,
  AGGREGATE_PAYMENT,
  INVOICE_PAID,
  PAYMENT_REQUESTED,
  PAYMENT_FAILED,
  PAYMENT_SUCCEEDED,
  PAYMENT_UNKNOWN,
  NOTIFY_PAYMENT_FAILED,
  NOTIFY_PAYMENT_UNKNOWN,
  invoiceTargetRef,
  paymentTargetRef,
} from '@ensemus/saas/events';
import { and, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { requestHash } from '../idempotency';
import { emit } from '../events';
import { auditAction, notify } from '../work';
import { creditPaidTopUpInTx } from './top-ups';
import type { AgentHaltPort } from './ports';
import { setTenantStandingInTx } from './standing';
import { randomUUID } from 'node:crypto';
import type {
  ChargeRequest,
  ChargeResult,
  PaymentCode,
  PaymentLookupResult,
  PaymentStatus,
  ProcessorManifest,
} from '@ensemus/saas/payment';

const service = (context: TenantContext) => {
  if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
};
const manager = (context: TenantContext) => {
  if (context.actorType !== 'user' || !can(context.role, 'billing.manage'))
    throw new AppError('NOT_FOUND');
};
const idOf = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
};
const validRef = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value);
const knownCode = (value: unknown): PaymentCode =>
  typeof value === 'string' && PAYMENT_CODES.includes(value as PaymentCode)
    ? (value as PaymentCode)
    : 'PROCESSOR_ERROR';
const terminal = (status: string): status is 'succeeded' | 'failed' | 'cancelled' | 'unknown' =>
  ['succeeded', 'failed', 'cancelled', 'unknown'].includes(status);
async function lockOrg(tx: Tx, context: TenantContext) {
  const [org] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, context.organizationId))
    .for('no key update');
  if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
  return org;
}
async function lockedPayment(tx: Tx, context: TenantContext, paymentId: string) {
  const org = await lockOrg(tx, context);
  const [payment] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.organizationId, context.organizationId), eq(payments.id, paymentId)))
    .for('update');
  if (!payment) throw new AppError('NOT_FOUND');
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, payment.invoiceId))
    .for('update');
  if (!invoice) throw new AppError('NOT_FOUND');
  return { org, payment, invoice };
}
async function paymentNotice(
  tx: Tx,
  context: TenantContext,
  payment: typeof payments.$inferSelect,
  status: 'succeeded' | 'failed' | 'unknown',
) {
  const type =
    status === 'succeeded'
      ? PAYMENT_SUCCEEDED
      : status === 'failed'
        ? PAYMENT_FAILED
        : PAYMENT_UNKNOWN;
  await emit(tx, context, {
    eventType: type,
    aggregateType: AGGREGATE_PAYMENT,
    aggregateId: payment.id,
    aggregateVersion: payment.version,
    classification: 'internal',
    payload: { payment_id: payment.id, invoice_id: payment.invoiceId },
  });
  const owners = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.role, 'owner'), eq(memberships.status, 'active')));
  await notify(
    tx,
    context,
    owners.map((row) => row.id),
    status === 'failed'
      ? NOTIFY_PAYMENT_FAILED
      : status === 'unknown'
        ? NOTIFY_PAYMENT_UNKNOWN
        : PAYMENT_SUCCEEDED,
    status === 'succeeded' ? invoiceTargetRef(payment.invoiceId) : paymentTargetRef(payment.id),
  );
}
async function settle(
  tx: Tx,
  context: TenantContext,
  payment: typeof payments.$inferSelect,
  invoice: typeof invoices.$inferSelect,
  code: PaymentCode,
  reference: string,
  agents?: AgentHaltPort,
) {
  if (payment.status === 'succeeded') return;
  await tx
    .update(payments)
    .set({
      status: 'succeeded',
      statusReason: code,
      processorPaymentRef: reference,
      settledAt: new Date(),
      version: payment.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(payments.id, payment.id));
  if (invoice.status !== 'paid') {
    if (
      !['open', 'uncollectible'].includes(invoice.status) ||
      invoice.totalMicros !== payment.amountMicros ||
      invoice.currency !== payment.currency
    )
      throw new AppError('INVOICE_NOT_PAYABLE');
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
  await paymentNotice(tx, context, { ...payment, version: payment.version + 1 }, 'succeeded');
}

/** Private Activity data, never a workflow result or a public API DTO. */
export async function getPaymentExecution(
  database: AppDatabase,
  context: TenantContext,
  input: { paymentId: string },
) {
  service(context);
  const id = idOf(input.paymentId);
  return withAccountTx(database, context, async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.organizationId, context.organizationId), eq(payments.id, id)));
    if (!payment) throw new AppError('NOT_FOUND');
    const [org] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, context.organizationId));
    if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, payment.invoiceId));
    if (!invoice) throw new AppError('NOT_FOUND');
    const [account] = await tx
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.organizationId, context.organizationId));
    if (!account) throw new AppError('PREREQUISITES_INCOMPLETE');
    const preflightCode: PaymentCode | null =
      org.commercialMode === 'sovereign'
        ? 'TENANT_NOT_BILLABLE'
        : invoice.status !== 'open' ||
            invoice.totalMicros !== payment.amountMicros ||
            invoice.currency !== payment.currency ||
            payment.amountMicros <= 0n
          ? 'INVOICE_NOT_OPEN'
          : account.processor && account.processor !== payment.processor
            ? 'PROCESSOR_NOT_CONFIGURED'
            : null;
    return {
      processor: payment.processor,
      status: payment.status as PaymentStatus,
      preflightCode,
      account: {
        id: account.id,
        billingName: account.billingName,
        billingEmail: account.billingEmail,
        processor: account.processor,
        customerRef: account.processorCustomerRef,
      },
    };
  });
}

/** A processor's idempotent customer registration is linked only by this trusted Activity service. */
export async function linkPaymentCustomer(
  database: AppDatabase,
  context: TenantContext,
  input: { accountId: string; processor: string; customerRef: string },
): Promise<string> {
  service(context);
  const id = idOf(input.accountId);
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(input.processor) || !validRef(input.customerRef))
    throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    await lockOrg(tx, context);
    const [account] = await tx
      .select()
      .from(billingAccounts)
      .where(
        and(eq(billingAccounts.organizationId, context.organizationId), eq(billingAccounts.id, id)),
      )
      .for('update');
    if (!account) throw new AppError('NOT_FOUND');
    if (account.processor && account.processor !== input.processor)
      throw new AppError('VERSION_CONFLICT');
    if (account.processorCustomerRef) return account.processorCustomerRef;
    await tx
      .update(billingAccounts)
      .set({
        processor: input.processor,
        processorCustomerRef: input.customerRef,
        customerRefHash: hashCustomerRef(input.processor, input.customerRef),
        version: account.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.id, id));
    return input.customerRef;
  });
}

/**
 * `billing.manage`, or the service context under a published collection policy. Refuses an invoice that is
 * not open, and any tenant in Sovereign. Writes the intent and PAYMENT_REQUESTED in one transaction. A live
 * payment for this invoice is returned, and no second one is made.
 */
export async function requestInvoicePayment(
  database: AppDatabase,
  context: TenantContext,
  input: { invoiceId: string; processor: string },
): Promise<{ paymentId: string; status: PaymentStatus }> {
  if (context.actorType !== 'service') manager(context);
  return withAccountTx(database, context, (tx) => requestInvoicePaymentInTx(tx, context, input));
}

/** Collections joins the intent to its own policy step transaction, rather than nesting a connection. */
export async function requestInvoicePaymentInTx(
  tx: Tx,
  context: TenantContext,
  input: { invoiceId: string; processor: string; now?: Date },
): Promise<{ paymentId: string; status: PaymentStatus }> {
  if (context.actorType !== 'service') manager(context);
  const invoiceId = idOf(input.invoiceId);
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(input.processor)) throw new AppError('INVALID_INPUT');
  const org = await lockOrg(tx, context);
  if (org.commercialMode === 'sovereign') throw new AppError('BILLING_NOT_ENABLED');
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.organizationId, context.organizationId), eq(invoices.id, invoiceId)))
    .for('update');
  if (!invoice) throw new AppError('NOT_FOUND');
  if (invoice.status !== 'open' || invoice.totalMicros <= 0n)
    throw new AppError('INVOICE_NOT_PAYABLE');
  if (context.actorType === 'service') {
    const [collection] = await tx
      .select({
        stepNo: collectionCases.stepNo,
        steps: collectionPolicies.steps,
        status: collectionPolicies.status,
      })
      .from(collectionCases)
      .innerJoin(collectionPolicies, eq(collectionPolicies.id, collectionCases.collectionPolicyId))
      .where(and(eq(collectionCases.invoiceId, invoiceId), eq(collectionCases.status, 'open')));
    if (!collection || collection.status === 'draft' || !invoice.dueAt)
      throw new AppError('NOT_FOUND');
    const decision = nextCollectionStep(
      collection.steps as CollectionStep[],
      invoice.dueAt,
      collection.stepNo,
      input.now ?? new Date(),
    );
    if (decision.kind !== 'act' || decision.action !== 'retry') throw new AppError('NOT_FOUND');
  } else if (input.now !== undefined) throw new AppError('INVALID_INPUT');
  const [account] = await tx
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.organizationId, context.organizationId));
  if (!account) throw new AppError('PREREQUISITES_INCOMPLETE');
  if (account.processor && account.processor !== input.processor)
    throw new AppError('PAYMENT_PROCESSOR_NOT_CONFIGURED');
  const [live] = await tx
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.invoiceId, invoiceId),
        inArray(payments.status, ['ready', 'sending', 'reconciling', 'unknown', 'succeeded']),
      ),
    )
    .for('update');
  if (live) return { paymentId: live.id, status: live.status as PaymentStatus };
  const paymentId = randomUUID();
  await tx.insert(payments).values({
    organizationId: context.organizationId,
    id: paymentId,
    invoiceId,
    amountMicros: invoice.totalMicros,
    currency: invoice.currency,
    idempotencyKey: paymentIdempotencyKey(context.organizationId, paymentId),
    processor: input.processor,
    requestedByRef: context.actorType === 'service' ? 'system:collections' : context.membershipId,
  });
  await emit(tx, context, {
    eventType: PAYMENT_REQUESTED,
    aggregateType: AGGREGATE_PAYMENT,
    aggregateId: paymentId,
    aggregateVersion: 1,
    classification: 'internal',
    payload: { payment_id: paymentId, invoice_id: invoiceId },
  });
  return { paymentId, status: 'ready' };
}

/** A caller's key is checked before invoice state, so a retry still replays after quick settlement. */
export async function requestInvoicePaymentOnce(
  database: AppDatabase,
  context: TenantContext,
  input: { invoiceId: string; processor: string; requestKey: string },
): Promise<
  { kind: 'fresh' | 'replayed'; paymentId: string; status: PaymentStatus } | { kind: 'conflict' }
> {
  manager(context);
  const invoiceId = idOf(input.invoiceId);
  if (
    input.requestKey.length < 8 ||
    input.requestKey.length > 128 ||
    /[\r\n\0]/.test(input.requestKey)
  )
    throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`payment:${context.organizationId}:${context.membershipId}:${input.requestKey}`},0))`,
    );
    const hash = requestHash(['POST', 'invoice/payment', invoiceId, input.processor]);
    const [stored] = await tx
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.organizationId, context.organizationId),
          eq(idempotencyKeys.membershipId, context.membershipId),
          eq(idempotencyKeys.key, input.requestKey),
        ),
      );
    if (stored) {
      if (stored.requestHash !== hash) return { kind: 'conflict' as const };
      const body = stored.responseBody as { payment_id?: unknown; status?: unknown };
      if (
        typeof body.payment_id !== 'string' ||
        typeof body.status !== 'string' ||
        ![
          'ready',
          'sending',
          'reconciling',
          'succeeded',
          'failed',
          'unknown',
          'cancelled',
        ].includes(body.status)
      )
        throw new AppError('VERSION_CONFLICT');
      return {
        kind: 'replayed' as const,
        paymentId: body.payment_id,
        status: body.status as PaymentStatus,
      };
    }
    const result = await requestInvoicePaymentInTx(tx, context, {
      invoiceId,
      processor: input.processor,
    });
    await tx.insert(idempotencyKeys).values({
      organizationId: context.organizationId,
      membershipId: context.membershipId,
      key: input.requestKey,
      requestHash: hash,
      responseStatus: 202,
      responseBody: { payment_id: result.paymentId, status: result.status },
    });
    return { kind: 'fresh' as const, ...result };
  });
}

/** Billing detail for a person; credentials, customer references and provider text never leave here. */
export async function listInvoicePayments(
  database: AppDatabase,
  context: TenantContext,
  input: { invoiceId: string },
) {
  if (context.actorType !== 'user' || !can(context.role, 'billing.view'))
    throw new AppError('NOT_FOUND');
  const id = idOf(input.invoiceId);
  return withAccountTx(database, context, async (tx) => {
    const [invoice] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.id, id));
    if (!invoice) throw new AppError('NOT_FOUND');
    return (
      await tx
        .select({
          id: payments.id,
          status: payments.status,
          statusReason: payments.statusReason,
          version: payments.version,
          createdAt: payments.createdAt,
        })
        .from(payments)
        .where(eq(payments.invoiceId, id))
        .orderBy(desc(payments.createdAt), desc(payments.id))
    ).map((row) => ({
      ...row,
      status: row.status as PaymentStatus,
      statusReason: knownCode(row.statusReason),
    }));
  });
}

export type BeginPaymentResult =
  | { kind: 'attempt'; attemptId: string; processor: string; charge: ChargeRequest }
  /** Refused before contact, or this run has nothing left to do. */
  | { kind: 'stop'; status: PaymentStatus; code: PaymentCode }
  /** An earlier attempt could have charged, so this goes to reconcile and does not try again. */
  | { kind: 'reconcile'; attemptId: string };

/** Locks the payment, rechecks everything through `checkBeforeCharge`, and commits the attempt. */
export async function beginPaymentAttempt(
  database: AppDatabase,
  context: TenantContext,
  input: { paymentId: string; runId: string },
): Promise<BeginPaymentResult> {
  service(context);
  const id = idOf(input.paymentId);
  if (!validRef(input.runId)) throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    const { org, payment, invoice } = await lockedPayment(tx, context, id);
    if (terminal(payment.status))
      return { kind: 'stop', status: payment.status, code: knownCode(payment.statusReason) };
    const [prior] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.paymentId, id))
      .orderBy(desc(paymentAttempts.attemptNo))
      .limit(1)
      .for('update');
    if (
      payment.status === 'sending' ||
      payment.status === 'reconciling' ||
      (prior && prior.outcome !== 'not_sent')
    ) {
      if (!prior) throw new AppError('INVALID_STATE');
      return { kind: 'reconcile', attemptId: prior.id };
    }
    const [account] = await tx
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.organizationId, context.organizationId));
    const check = checkBeforeCharge({
      status: payment.status as PaymentStatus,
      invoiceStatus: invoice.status,
      invoiceTotalMicros: invoice.totalMicros,
      amountMicros: payment.amountMicros,
      lifecycle: org.commercialMode === 'sovereign' ? 'deleted' : org.lifecycle,
      processorConfigured: account?.processor === payment.processor,
      customerRef: account?.processorCustomerRef ?? null,
    });
    const number = (prior?.attemptNo ?? 0) + 1;
    let minorUnitExponent: number | null = null;
    if (invoice.planVersionId) {
      const [plan] = await tx
        .select({ precision: planVersions.minorUnitExponent })
        .from(planVersions)
        .where(eq(planVersions.id, invoice.planVersionId));
      minorUnitExponent = plan?.precision ?? null;
    } else if (invoice.rateCardId) {
      const [card] = await tx
        .select({ precision: rateCards.minorUnitExponent })
        .from(rateCards)
        .where(eq(rateCards.id, invoice.rateCardId));
      minorUnitExponent = card?.precision ?? null;
    }
    const refusal = !check.ok
      ? check.code
      : number > MAX_PAYMENT_ATTEMPTS
        ? 'ATTEMPTS_EXHAUSTED'
        : minorUnitExponent === null
          ? 'PROCESSOR_ERROR'
          : null;
    if (refusal) {
      await tx
        .update(payments)
        .set({
          status: 'failed',
          statusReason: refusal,
          settledAt: new Date(),
          version: payment.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, id));
      await paymentNotice(tx, context, { ...payment, version: payment.version + 1 }, 'failed');
      return { kind: 'stop', status: 'failed', code: refusal };
    }
    const [attempt] = await tx
      .insert(paymentAttempts)
      .values({
        organizationId: context.organizationId,
        paymentId: id,
        attemptNo: number,
        idempotencyKey: payment.idempotencyKey,
        runId: input.runId,
      })
      .returning();
    await tx
      .update(payments)
      .set({ status: 'sending', version: payment.version + 1, updatedAt: new Date() })
      .where(eq(payments.id, id));
    return {
      kind: 'attempt',
      attemptId: attempt!.id,
      processor: payment.processor,
      charge: {
        paymentId: id,
        attemptNo: number,
        idempotencyKey: payment.idempotencyKey,
        amountMicros: payment.amountMicros,
        currency: payment.currency,
        minorUnitExponent: minorUnitExponent!,
        customerRef: account!.processorCustomerRef!,
      },
    };
  });
}

export type PaymentStep =
  | { step: 'succeeded' | 'failed' | 'cancelled' | 'unknown' }
  | { step: 'retry'; afterMs: number }
  | { step: 'reconcile' };

/**
 * Records the answer. On success in one transaction: the attempt, the payment, the invoice to `paid`, the
 * top-up credited through `creditPaidTopUpInTx`, and a collection case resolved. Emits and notifies.
 */
export async function finishPaymentAttempt(
  database: AppDatabase,
  context: TenantContext,
  input: { attemptId: string; result: ChargeResult },
  agents?: AgentHaltPort,
): Promise<PaymentStep> {
  service(context);
  const id = idOf(input.attemptId);
  const result = input.result;
  if (
    !PAYMENT_CODES.includes(result.code) ||
    !['succeeded', 'declined', 'not_sent', 'indeterminate'].includes(result.outcome) ||
    (result.outcome === 'succeeded' &&
      (!validRef(result.processorPaymentRef) || result.code !== 'CHARGED')) ||
    (result.outcome === 'declined' &&
      result.processorPaymentRef !== null &&
      !validRef(result.processorPaymentRef)) ||
    (result.outcome === 'not_sent' && typeof result.retryable !== 'boolean')
  )
    throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    await lockOrg(tx, context);
    const [found] = await tx
      .select()
      .from(paymentAttempts)
      .where(
        and(eq(paymentAttempts.organizationId, context.organizationId), eq(paymentAttempts.id, id)),
      );
    if (!found) throw new AppError('NOT_FOUND');
    const { payment, invoice } = await lockedPayment(tx, context, found.paymentId);
    const [attempt] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, id))
      .for('update');
    if (!attempt) throw new AppError('NOT_FOUND');
    if (attempt.outcome !== null && attempt.outcome !== 'indeterminate') {
      if (terminal(payment.status)) return { step: payment.status };
      if (payment.status === 'ready' && attempt.outcome === 'not_sent')
        return {
          step: 'retry',
          afterMs: Math.min(30_000 * 2 ** (attempt.attemptNo - 1), 5 * 60_000),
        };
      return { step: 'reconcile' };
    }
    await tx
      .update(paymentAttempts)
      .set({
        outcome: result.outcome,
        outcomeCode: result.code,
        processorPaymentRef:
          result.outcome === 'succeeded' || result.outcome === 'declined'
            ? result.processorPaymentRef
            : null,
        finishedAt: new Date(),
      })
      .where(eq(paymentAttempts.id, id));
    if (['succeeded', 'failed', 'cancelled'].includes(payment.status))
      return { step: payment.status as 'succeeded' | 'failed' | 'cancelled' };
    if (result.outcome === 'succeeded') {
      await settle(tx, context, payment, invoice, result.code, result.processorPaymentRef, agents);
      return { step: 'succeeded' };
    }
    const decision = decideAfterCharge(result, attempt.attemptNo);
    const status =
      payment.status === 'unknown' && decision.status === 'ready' ? 'failed' : decision.status;
    if (payment.status === 'unknown' && status === 'reconciling') return { step: 'unknown' };
    await tx
      .update(payments)
      .set({
        status,
        statusReason: decision.code,
        ...(status === 'failed' ? { settledAt: new Date() } : {}),
        version: payment.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));
    if (status === 'failed') {
      await paymentNotice(tx, context, { ...payment, version: payment.version + 1 }, 'failed');
      return { step: 'failed' };
    }
    if (status === 'ready')
      return { step: 'retry', afterMs: 'afterMs' in decision ? decision.afterMs : 30_000 };
    return { step: 'reconcile' };
  });
}

export type InterruptedPayment = 'nothing_sent' | 'attempt_open' | 'settled';

export async function inspectInterruptedPayment(
  database: AppDatabase,
  context: TenantContext,
  input: { paymentId: string },
): Promise<InterruptedPayment> {
  service(context);
  const id = idOf(input.paymentId);
  return withAccountTx(database, context, async (tx) => {
    const { payment } = await lockedPayment(tx, context, id);
    if (terminal(payment.status)) return 'settled';
    const [attempt] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.paymentId, id))
      .orderBy(desc(paymentAttempts.attemptNo))
      .limit(1);
    return payment.status === 'ready' && (!attempt || attempt.outcome === 'not_sent')
      ? 'nothing_sent'
      : 'attempt_open';
  });
}

/** Reads only a terminal outcome. A pending state is not relabeled as an honest unknown. */
export async function readPaymentOutcome(
  database: AppDatabase,
  context: TenantContext,
  input: { paymentId: string },
): Promise<'succeeded' | 'failed' | 'cancelled' | 'unknown'> {
  service(context);
  const id = idOf(input.paymentId);
  return withAccountTx(database, context, async (tx) => {
    const { payment } = await lockedPayment(tx, context, id);
    if (!terminal(payment.status)) throw new AppError('INVALID_STATE');
    return payment.status;
  });
}

/** Marks an open attempt indeterminate and answers what a lookup needs. Null when it is settled. */
export async function beginPaymentReconcile(
  database: AppDatabase,
  context: TenantContext,
  input: { paymentId: string; code: PaymentCode },
): Promise<{ attemptId: string; idempotencyKey: string; processor: string } | null> {
  service(context);
  const id = idOf(input.paymentId);
  if (!PAYMENT_CODES.includes(input.code)) throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    const { payment } = await lockedPayment(tx, context, id);
    if (terminal(payment.status)) return null;
    const [attempt] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.paymentId, id))
      .orderBy(desc(paymentAttempts.attemptNo))
      .limit(1)
      .for('update');
    if (payment.status === 'ready' && (!attempt || attempt.outcome === 'not_sent')) return null;
    if (!attempt || !['sending', 'reconciling'].includes(payment.status))
      throw new AppError('INVALID_STATE');
    if (attempt.outcome === null)
      await tx
        .update(paymentAttempts)
        .set({ outcome: 'indeterminate', outcomeCode: input.code, finishedAt: new Date() })
        .where(eq(paymentAttempts.id, attempt.id));
    if (payment.status === 'sending')
      await tx
        .update(payments)
        .set({
          status: 'reconciling',
          statusReason: input.code,
          version: payment.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, id));
    return {
      attemptId: attempt.id,
      idempotencyKey: payment.idempotencyKey,
      processor: payment.processor,
    };
  });
}

export async function finishPaymentReconcile(
  database: AppDatabase,
  context: TenantContext,
  input: {
    attemptId: string;
    result: PaymentLookupResult;
    lookup: ProcessorManifest['lookup'];
  },
  agents?: AgentHaltPort,
): Promise<'succeeded' | 'failed' | 'retry' | 'unknown'> {
  service(context);
  const id = idOf(input.attemptId);
  const result = input.result;
  if (
    !['none', 'best_effort', 'authoritative'].includes(input.lookup) ||
    !['succeeded', 'declined', 'not_found', 'cannot_answer'].includes(result.found) ||
    (result.found === 'succeeded' && !validRef(result.processorPaymentRef)) ||
    (result.found === 'declined' &&
      result.processorPaymentRef !== null &&
      !validRef(result.processorPaymentRef))
  )
    throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    await lockOrg(tx, context);
    const [found] = await tx
      .select()
      .from(paymentAttempts)
      .where(
        and(eq(paymentAttempts.organizationId, context.organizationId), eq(paymentAttempts.id, id)),
      );
    if (!found) throw new AppError('NOT_FOUND');
    const { payment, invoice } = await lockedPayment(tx, context, found.paymentId);
    const [attempt] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, id))
      .for('update');
    if (!attempt) throw new AppError('NOT_FOUND');
    if (['succeeded', 'failed', 'cancelled'].includes(payment.status))
      return payment.status === 'cancelled' ? 'failed' : (payment.status as 'succeeded' | 'failed');
    if (payment.status === 'ready') return 'retry';
    if (attempt.outcome !== 'indeterminate') throw new AppError('INVALID_STATE');
    if (result.found === 'succeeded') {
      if (payment.processorPaymentRef && payment.processorPaymentRef !== result.processorPaymentRef)
        throw new AppError('INVALID_INPUT');
      await tx
        .update(paymentAttempts)
        .set({
          outcome: 'succeeded',
          outcomeCode: 'FOUND_BY_LOOKUP',
          processorPaymentRef: result.processorPaymentRef,
          finishedAt: new Date(),
        })
        .where(eq(paymentAttempts.id, id));
      await settle(
        tx,
        context,
        payment,
        invoice,
        'FOUND_BY_LOOKUP',
        result.processorPaymentRef,
        agents,
      );
      return 'succeeded';
    }
    const decision = decideAfterLookup(result, input.lookup);
    if (payment.status === 'unknown' && decision.status === 'ready') return 'unknown';
    const exhausted = decision.status === 'ready' && attempt.attemptNo >= MAX_PAYMENT_ATTEMPTS;
    const status = exhausted ? 'failed' : decision.status;
    const code = exhausted ? 'ATTEMPTS_EXHAUSTED' : decision.code;
    if (decision.status === 'ready')
      await tx
        .update(paymentAttempts)
        .set({ outcome: 'not_sent', outcomeCode: decision.code, finishedAt: new Date() })
        .where(eq(paymentAttempts.id, id));
    if (result.found === 'declined')
      await tx
        .update(paymentAttempts)
        .set({
          outcome: 'declined',
          outcomeCode: code,
          processorPaymentRef: result.processorPaymentRef,
          finishedAt: new Date(),
        })
        .where(eq(paymentAttempts.id, id));
    if (payment.status !== status) {
      await tx
        .update(payments)
        .set({
          status,
          statusReason: code,
          ...(status === 'failed' || status === 'unknown' ? { settledAt: new Date() } : {}),
          version: payment.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));
      if (status === 'unknown' || status === 'failed')
        await paymentNotice(tx, context, { ...payment, version: payment.version + 1 }, status);
    }
    return status === 'ready' ? 'retry' : status;
  });
}

/** Nothing could be contacted, such as the connector worker not being there. Only with no open attempt. */
export async function failUnsentPayment(
  database: AppDatabase,
  context: TenantContext,
  input: { paymentId: string; code: PaymentCode },
): Promise<void> {
  service(context);
  const id = idOf(input.paymentId);
  if (!PAYMENT_CODES.includes(input.code)) throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    const { payment } = await lockedPayment(tx, context, id);
    if (terminal(payment.status)) return;
    const prior = await tx
      .select({ outcome: paymentAttempts.outcome })
      .from(paymentAttempts)
      .where(eq(paymentAttempts.paymentId, id));
    // A worker can win the race after inspection. Its claim wins and must be reconciled, not failed.
    if (payment.status !== 'ready' || prior.some((row) => row.outcome !== 'not_sent')) return;
    await tx
      .update(payments)
      .set({
        status: 'failed',
        statusReason: input.code,
        settledAt: new Date(),
        version: payment.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, id));
    await paymentNotice(tx, context, { ...payment, version: payment.version + 1 }, 'failed');
  });
}

/**
 * `billing.manage`, and a person. Says what a processor's dashboard showed for an unknown payment. It moves no
 * money. Saying it succeeded needs a matching event or lookup, because the database wants evidence, and a
 * person's word is not that. Saying it failed lets a new payment be made.
 */
export async function resolveUnknownPayment(
  database: AppDatabase,
  context: TenantContext,
  input: {
    paymentId: string;
    resolution: 'confirmed_not_charged';
    expectedVersion: number;
  },
): Promise<void> {
  manager(context);
  const id = idOf(input.paymentId);
  if (
    input.resolution !== 'confirmed_not_charged' ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  )
    throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    const { payment } = await lockedPayment(tx, context, id);
    if (payment.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (payment.status !== 'unknown') throw new AppError('PAYMENT_NOT_RESOLVABLE');
    await tx
      .update(payments)
      .set({
        status: 'failed',
        statusReason: 'CONFIRMED_BY_PERSON',
        settledAt: new Date(),
        version: payment.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, id));
    await auditAction(
      tx,
      context,
      'payment.confirmed_not_charged',
      paymentTargetRef(id),
      'CONFIRMED_BY_PERSON',
    );
    await paymentNotice(tx, context, { ...payment, version: payment.version + 1 }, 'failed');
  });
}

/** Called in a tenant's transaction when an invoice falls paid another way. Keeps the case and top-up true. */
export async function afterInvoicePaidInTx(
  tx: Tx,
  context: TenantContext,
  input: { invoiceId: string },
  agents?: AgentHaltPort,
): Promise<void> {
  service(context);
  const id = idOf(input.invoiceId);
  await lockOrg(tx, context);
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.organizationId, context.organizationId), eq(invoices.id, id)))
    .for('update');
  if (!invoice) throw new AppError('NOT_FOUND');
  if (invoice.status !== 'paid') throw new AppError('INVOICE_NOT_PAYABLE');
  await creditPaidTopUpInTx(tx, context, { invoiceId: id });
  if (!(await recoverCollectedStandingInTx(tx, context, agents))) return;
  await tx
    .update(collectionCases)
    .set({
      status: 'resolved',
      resolvedAt: new Date(),
      version: sqlVersionIncrement(),
      nextStepAt: null,
    })
    .where(and(eq(collectionCases.invoiceId, id), eq(collectionCases.status, 'open')));
}

/** Only collection-caused standing can recover automatically; quotas, operator stops and leaving stay. */
export async function recoverCollectedStandingInTx(
  tx: Tx,
  context: TenantContext,
  agents?: AgentHaltPort,
): Promise<boolean> {
  service(context);
  const org = await lockOrg(tx, context);
  const [latest] = await tx
    .select()
    .from(standingChanges)
    .where(eq(standingChanges.organizationId, context.organizationId))
    .orderBy(desc(standingChanges.occurredAt), desc(standingChanges.id))
    .limit(1);
  const [overdue] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.kind, 'subscription'),
        inArray(invoices.status, ['open', 'uncollectible']),
        gt(invoices.totalMicros, 0n),
        lte(invoices.dueAt, new Date()),
      ),
    )
    .limit(1);
  if (!overdue)
    await tx
      .update(subscriptions)
      .set({ status: 'active', version: sql`${subscriptions.version}+1`, updatedAt: new Date() })
      .where(eq(subscriptions.status, 'past_due'));
  const recovery =
    !overdue &&
    latest?.actorType === 'system' &&
    latest.collectionPolicyId !== null &&
    ['COLLECTION_READ_ONLY', 'COLLECTION_SUSPEND'].includes(latest.reasonCode) &&
    ['read_only', 'suspended'].includes(org.lifecycle);
  // Preserve the paid financial fact even when resumption has no binding yet. Its open case remains
  // pending for runCollections, which retries restoration through the real halt/release port.
  if (recovery && !agents) return false;
  if (recovery)
    await setTenantStandingInTx(
      tx,
      context,
      {
        to: 'active',
        reasonCode: 'COLLECTION_CLEARED',
        actor: {
          type: 'system',
          ref: 'system:collections',
          collectionPolicyId: latest!.collectionPolicyId!,
        },
      },
      agents!,
    );
  return true;
}

function sqlVersionIncrement() {
  return sql`version + 1`;
}
