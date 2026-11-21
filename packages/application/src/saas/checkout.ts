// Hosted checkout for a customer (ADR-032 D4a). A billing manager chooses Paddle, Payme or Click for one
// open invoice and is sent to that provider's page; the provider tells the connector worker, which alone
// may say what the money did. Nothing here takes money or believes a provider. Uses withAccountTx, so a
// tenant in restricted standing can still pay.
import { randomUUID } from 'node:crypto';
import {
  billingAccounts,
  checkoutSessions,
  invoices,
  organizations,
  payments,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import {
  isCheckoutProvider,
  type CheckoutProvider,
  type CheckoutState,
} from '@ensemus/domain/checkout';
import { can } from '@ensemus/domain/policy';
import {
  checkoutDisplay,
  checkoutProvidersFor,
  clickCheckoutUrl,
  microsToMinor,
  paymeCheckoutUrl,
  type CheckoutDisplay,
} from '@ensemus/saas/checkout';
import { AGGREGATE_CHECKOUT, CHECKOUT_REQUESTED, paymentTargetRef } from '@ensemus/saas/events';
import { paymentIdempotencyKey } from '@ensemus/saas/payment';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { emit } from '../events';
import { idSchema } from '../ids';
import { auditAction } from '../work';
import { getInvoice } from './invoices';

/** What the web tier passes: plain public configuration and this server's own public address. */
export type CheckoutSettings = {
  providers: readonly CheckoutProvider[];
  payme: { environment: 'sandbox' | 'live'; merchantId: string } | null;
  click: { environment: 'sandbox' | 'live'; serviceId: string; merchantId: string } | null;
  paddle: { environment: 'sandbox' | 'live' } | null;
  publicUrl: string;
};

const idOf = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data;
};
const viewer = (context: TenantContext) => {
  if (context.actorType !== 'user' || !can(context.role, 'billing.view'))
    throw new AppError('NOT_FOUND');
};
const manager = (context: TenantContext) => {
  if (context.actorType !== 'user' || !can(context.role, 'billing.manage'))
    throw new AppError('NOT_FOUND');
};
const LIVE = ['opening', 'open', 'reserved'] as const;

export const checkoutReturnPath = (organizationId: string, invoiceId: string, sessionId: string) =>
  `/o/${organizationId}/account/invoices/${invoiceId}/checkout/${sessionId}`;

export type CheckoutOptions = {
  invoiceId: string;
  invoiceNumber: number | null;
  invoiceStatus: string;
  totalMicros: bigint;
  currency: string;
  minorUnitExponent: number | null;
  /** In the order the page offers them. Empty means none fits this invoice on this server. */
  providers: CheckoutProvider[];
  billingCountry: string | null;
  /** A checkout already under way for this invoice, which the page resumes rather than starting another. */
  current: { sessionId: string; processor: CheckoutProvider; state: CheckoutState } | null;
};

/** `billing.view`. What the choose page shows. */
export async function getCheckoutOptions(
  database: AppDatabase,
  context: TenantContext,
  input: { invoiceId: string },
  settings: Pick<CheckoutSettings, 'providers'>,
): Promise<CheckoutOptions> {
  viewer(context);
  const invoice = await getInvoice(database, context, input.invoiceId);
  return withAccountTx(database, context, async (tx) => {
    const [account] = await tx
      .select({ countryCode: billingAccounts.countryCode })
      .from(billingAccounts)
      .where(eq(billingAccounts.organizationId, context.organizationId));
    const [current] = await tx
      .select({
        id: checkoutSessions.id,
        processor: checkoutSessions.processor,
        state: checkoutSessions.state,
      })
      .from(checkoutSessions)
      .where(
        and(eq(checkoutSessions.invoiceId, invoice.id), inArray(checkoutSessions.state, [...LIVE])),
      )
      .orderBy(desc(checkoutSessions.createdAt))
      .limit(1);
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceStatus: invoice.status,
      totalMicros: invoice.totalMicros,
      currency: invoice.currency,
      minorUnitExponent: invoice.minorUnitExponent,
      providers:
        invoice.minorUnitExponent === null
          ? []
          : checkoutProvidersFor(
              { currency: invoice.currency, minorUnitExponent: invoice.minorUnitExponent },
              settings.providers,
            ),
      billingCountry: account?.countryCode ?? null,
      current: current
        ? {
            sessionId: current.id,
            processor: current.processor as CheckoutProvider,
            state: current.state as CheckoutState,
          }
        : null,
    };
  });
}

async function lockOrg(tx: Tx, context: TenantContext) {
  const [org] = await tx
    .select({ lifecycle: organizations.lifecycle, commercialMode: organizations.commercialMode })
    .from(organizations)
    .where(eq(organizations.id, context.organizationId))
    .for('no key update');
  if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
  if (org.commercialMode === 'sovereign') throw new AppError('BILLING_NOT_ENABLED');
}

/**
 * `billing.manage`. Opens one checkout for an open invoice, or answers the one already under way. The
 * payment intent is committed as `sending` with the checkout in the same transaction, so no second
 * payment can start for this invoice while a provider might still take money for the first.
 */
export async function startCheckout(
  database: AppDatabase,
  context: TenantContext,
  input: { invoiceId: string; provider: string; language: 'ru' | 'uz' | 'en' },
  settings: CheckoutSettings,
): Promise<{ sessionId: string; created: boolean }> {
  manager(context);
  if (!isCheckoutProvider(input.provider)) throw new AppError('INVALID_INPUT');
  const provider = input.provider;
  const invoiceId = idOf(input.invoiceId);
  const detail = await getInvoice(database, context, invoiceId);
  if (detail.minorUnitExponent === null) throw new AppError('INVOICE_NOT_PAYABLE');
  const exponent = detail.minorUnitExponent;
  return withAccountTx(database, context, async (tx) => {
    await lockOrg(tx, context);
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.organizationId, context.organizationId), eq(invoices.id, invoiceId)))
      .for('update');
    if (!invoice) throw new AppError('NOT_FOUND');
    const [current] = await tx
      .select({ id: checkoutSessions.id })
      .from(checkoutSessions)
      .where(
        and(eq(checkoutSessions.invoiceId, invoiceId), inArray(checkoutSessions.state, [...LIVE])),
      )
      .for('update');
    if (current) return { sessionId: current.id, created: false };
    if (invoice.status !== 'open' || invoice.totalMicros <= 0n)
      throw new AppError('INVOICE_NOT_PAYABLE');
    if (
      !checkoutProvidersFor(
        { currency: invoice.currency, minorUnitExponent: exponent },
        settings.providers,
      ).includes(provider)
    )
      throw new AppError('PAYMENT_PROCESSOR_NOT_CONFIGURED');
    const amountMinor = microsToMinor(invoice.totalMicros, exponent);
    if (amountMinor === null) throw new AppError('INVOICE_NOT_PAYABLE');
    const [account] = await tx
      .select({ id: billingAccounts.id })
      .from(billingAccounts)
      .where(eq(billingAccounts.organizationId, context.organizationId));
    if (!account) throw new AppError('PREREQUISITES_INCOMPLETE');
    // A payment from the charge path still under way for this invoice would be a second payer.
    const [live] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.invoiceId, invoiceId),
          inArray(payments.status, ['ready', 'sending', 'reconciling', 'unknown', 'succeeded']),
        ),
      )
      .for('update');
    if (live) throw new AppError('INVOICE_NOT_PAYABLE');

    const paymentId = randomUUID();
    const sessionId = randomUUID();
    await tx.insert(payments).values({
      organizationId: context.organizationId,
      id: paymentId,
      invoiceId,
      amountMicros: invoice.totalMicros,
      currency: invoice.currency,
      idempotencyKey: paymentIdempotencyKey(context.organizationId, paymentId),
      processor: provider,
      requestedByRef: context.membershipId,
    });
    await tx
      .update(payments)
      .set({ status: 'sending', version: 2, updatedAt: new Date() })
      .where(eq(payments.id, paymentId));
    const returnUrl = `${settings.publicUrl}${checkoutReturnPath(context.organizationId, invoiceId, sessionId)}`;
    let checkoutUrl: string | null = null;
    let clickPrepareId: bigint | null = null;
    let environment: 'sandbox' | 'live';
    if (provider === 'payme') {
      if (!settings.payme) throw new AppError('PAYMENT_PROCESSOR_NOT_CONFIGURED');
      environment = settings.payme.environment;
      checkoutUrl = paymeCheckoutUrl({
        environment,
        merchantId: settings.payme.merchantId,
        orderRef: sessionId,
        amountTiyin: amountMinor,
        returnUrl,
        language: input.language,
      });
    } else if (provider === 'click') {
      if (!settings.click) throw new AppError('PAYMENT_PROCESSOR_NOT_CONFIGURED');
      environment = settings.click.environment;
      checkoutUrl = clickCheckoutUrl({
        serviceId: settings.click.serviceId,
        merchantId: settings.click.merchantId,
        orderRef: sessionId,
        amountTiyin: amountMinor,
        returnUrl,
      });
      const [next] = (
        await tx.execute<{ id: string }>(
          sql`select nextval('billing.checkout_click_prepare_seq')::text as id`,
        )
      ).rows;
      clickPrepareId = BigInt(next!.id);
    } else {
      if (!settings.paddle) throw new AppError('PAYMENT_PROCESSOR_NOT_CONFIGURED');
      environment = settings.paddle.environment;
    }
    await tx.insert(checkoutSessions).values({
      organizationId: context.organizationId,
      id: sessionId,
      paymentId,
      invoiceId,
      processor: provider,
      environment,
      amountMicros: invoice.totalMicros,
      currency: invoice.currency,
      minorUnitExponent: exponent,
      amountMinor,
      state: provider === 'paddle' ? 'opening' : 'open',
      // Replaced by the guard trigger with the digest of this exact row ID.
      orderRouteSha256: '0'.repeat(64),
      clickPrepareId,
      checkoutUrl,
      requestedByMembershipId: context.membershipId,
    });
    if (provider === 'paddle')
      await emit(tx, context, {
        eventType: CHECKOUT_REQUESTED,
        aggregateType: AGGREGATE_CHECKOUT,
        aggregateId: sessionId,
        aggregateVersion: 1,
        classification: 'internal',
        payload: { checkout_session_id: sessionId },
      });
    await auditAction(tx, context, 'checkout.started', paymentTargetRef(paymentId));
    return { sessionId, created: true };
  });
}

export type CheckoutStatus = {
  sessionId: string;
  invoiceId: string;
  processor: CheckoutProvider;
  state: CheckoutState;
  display: CheckoutDisplay;
  /** Only while the customer can still pay there, so the page can send them back. */
  checkoutUrl: string | null;
  /** Whether the customer may close it here: true only when no provider transaction could exist. */
  closable: boolean;
  amountMicros: bigint;
  currency: string;
  minorUnitExponent: number;
  updatedAt: Date;
};

/** `billing.view`. What the status page shows. */
export async function getCheckoutStatus(
  database: AppDatabase,
  context: TenantContext,
  input: { invoiceId: string; sessionId: string },
): Promise<CheckoutStatus> {
  viewer(context);
  const invoiceId = idOf(input.invoiceId);
  const sessionId = idOf(input.sessionId);
  return withAccountTx(database, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(checkoutSessions)
      .where(and(eq(checkoutSessions.id, sessionId), eq(checkoutSessions.invoiceId, invoiceId)));
    if (!row) throw new AppError('NOT_FOUND');
    const state = row.state as CheckoutState;
    return {
      sessionId: row.id,
      invoiceId: row.invoiceId,
      processor: row.processor as CheckoutProvider,
      state,
      display: checkoutDisplay(state),
      checkoutUrl: state === 'open' ? row.checkoutUrl : null,
      closable: closable(row),
      amountMicros: row.amountMicros,
      currency: row.currency,
      minorUnitExponent: row.minorUnitExponent,
      updatedAt: row.updatedAt,
    };
  });
}

const closable = (row: typeof checkoutSessions.$inferSelect) =>
  row.providerTxnRef === null &&
  (row.state === 'opening' || (row.state === 'open' && row.processor !== 'paddle'));

/**
 * `billing.manage`. Closes a checkout no provider transaction exists for, so nothing could have been paid
 * through it, and ends its payment as unpaid. A Payme or Click call for it afterwards is refused. Anything
 * a provider may still settle is left alone and answers INVOICE_NOT_PAYABLE.
 */
export async function closeCheckout(
  database: AppDatabase,
  context: TenantContext,
  input: { invoiceId: string; sessionId: string },
): Promise<void> {
  manager(context);
  const invoiceId = idOf(input.invoiceId);
  const sessionId = idOf(input.sessionId);
  await withAccountTx(database, context, async (tx) => {
    await lockOrg(tx, context);
    const [row] = await tx
      .select()
      .from(checkoutSessions)
      .where(and(eq(checkoutSessions.id, sessionId), eq(checkoutSessions.invoiceId, invoiceId)))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (row.state === 'cancelled') return;
    if (!closable(row)) throw new AppError('INVOICE_NOT_PAYABLE');
    await tx
      .update(checkoutSessions)
      .set({ state: 'cancelled', version: row.version + 1, updatedAt: new Date() })
      .where(eq(checkoutSessions.id, row.id));
    const [payment] = await tx
      .select({ version: payments.version, status: payments.status })
      .from(payments)
      .where(eq(payments.id, row.paymentId))
      .for('update');
    if (payment?.status === 'sending')
      await tx
        .update(payments)
        .set({
          status: 'failed',
          statusReason: 'CHECKOUT_CLOSED',
          settledAt: new Date(),
          version: payment.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, row.paymentId));
    await auditAction(tx, context, 'checkout.closed', paymentTargetRef(row.paymentId));
  });
}

// --- The connector worker's side, for a Paddle checkout. Service only; the tenant comes from the outbox
// event that started the workflow, never from Paddle.

const service = (context: TenantContext) => {
  if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
};

export type CheckoutToOpen = {
  sessionId: string;
  state: CheckoutState;
  processor: CheckoutProvider;
  currency: string;
  amountMinor: bigint;
  providerTxnRef: string | null;
  invoiceNumber: number | null;
  /** Read with the row, so an attestation made from it is refused after a restore. */
  restoreGeneration: string;
  account: {
    email: string;
    name: string;
    countryCode: string;
    regionCode: string;
    postalCode: string | null;
  } | null;
};

export async function loadCheckoutForWorker(
  database: AppDatabase,
  context: TenantContext,
  input: { sessionId: string },
): Promise<CheckoutToOpen> {
  service(context);
  const sessionId = idOf(input.sessionId);
  return withAccountTx(database, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, sessionId));
    if (!row) throw new AppError('NOT_FOUND');
    const [invoice] = await tx
      .select({ invoiceNumber: invoices.invoiceNumber })
      .from(invoices)
      .where(eq(invoices.id, row.invoiceId));
    const [account] = await tx
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.organizationId, context.organizationId));
    const [generation] = (
      await tx.execute<{ value: string }>(
        sql`select app.current_auth_restore_generation()::text as value`,
      )
    ).rows;
    if (!generation?.value) throw new AppError('PREREQUISITES_INCOMPLETE');
    return {
      restoreGeneration: generation.value,
      sessionId: row.id,
      state: row.state as CheckoutState,
      processor: row.processor as CheckoutProvider,
      currency: row.currency,
      amountMinor: row.amountMinor,
      providerTxnRef: row.providerTxnRef,
      invoiceNumber: invoice?.invoiceNumber ?? null,
      account: account
        ? {
            email: account.billingEmail,
            name: account.billingName,
            countryCode: account.countryCode,
            regionCode: account.regionCode,
            postalCode: account.postalCode,
          }
        : null,
    };
  });
}

/** Paddle made the transaction. Its link is the customer's way to pay. */
export async function recordCheckoutOpened(
  database: AppDatabase,
  context: TenantContext,
  input: { sessionId: string; transactionId: string; checkoutUrl: string; customerRef: string },
): Promise<'open' | 'not_opening'> {
  service(context);
  const sessionId = idOf(input.sessionId);
  return withAccountTx(database, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, sessionId))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (row.state !== 'opening') return 'not_opening';
    await tx
      .update(checkoutSessions)
      .set({
        state: 'open',
        providerTxnRef: input.transactionId,
        providerAuxRef: input.customerRef,
        checkoutUrl: input.checkoutUrl,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(checkoutSessions.id, row.id));
    return 'open';
  });
}

/**
 * Paddle refused, or never answered. No link reached anyone, so nothing can be paid through it: the
 * checkout closes and its payment ends unpaid, and the customer can start again.
 */
export async function recordCheckoutNotOpened(
  database: AppDatabase,
  context: TenantContext,
  input: { sessionId: string },
): Promise<void> {
  service(context);
  const sessionId = idOf(input.sessionId);
  await withAccountTx(database, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, sessionId))
      .for('update');
    if (!row || row.state !== 'opening') return;
    await tx
      .update(checkoutSessions)
      .set({ state: 'cancelled', version: row.version + 1, updatedAt: new Date() })
      .where(eq(checkoutSessions.id, row.id));
    const [payment] = await tx
      .select({ version: payments.version, status: payments.status })
      .from(payments)
      .where(eq(payments.id, row.paymentId))
      .for('update');
    if (payment?.status === 'sending')
      await tx
        .update(payments)
        .set({
          status: 'failed',
          statusReason: 'CHECKOUT_CANCELLED',
          settledAt: new Date(),
          version: payment.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, row.paymentId));
  });
}
