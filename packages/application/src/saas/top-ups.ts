// Owned by the credits slice (BILL-05). Explicit, or not at all: QA-026 is "pause or top up, no surprise
// bill". There is no auto top-up, and no code path buys credits without a person's quote hash.
import {
  creditLedger,
  invoices,
  organizations,
  subscriptions,
  topUpOffers,
  topUps,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { can } from '@ensemus/domain/policy';
import { creditKeys, quoteHash } from '@ensemus/saas/credits';
import { buildTopUpInvoice } from '@ensemus/saas/invoice';
import { AGGREGATE_TOP_UP, TOP_UP_REQUESTED, TOP_UP_CREDITED } from '@ensemus/saas/events';
import { requestTopUpSchema } from '@ensemus/contracts/saas';
import { and, desc, eq } from 'drizzle-orm';
import { AppError } from '../errors';
import { emit } from '../events';
import { idSchema } from '../ids';
import { loadPlanTerms, requirePublishedRateCard } from './catalog';
import { createTopUpInvoiceInTx } from './invoices';

/**
 * `billing.manage`, and a person: a service context is refused. Recomputes the quote from the approved offer
 * under lock, compares `quoteHash`, and answers QUOTE_CHANGED if it moved. BYOM, a `pause` plan and a
 * non-active tenant are refused. Repeating a `requestKey` returns the first. Emits TOP_UP_REQUESTED. It
 * creates the invoice through `createTopUpInvoiceInTx`, and the credits arrive only after payment succeeds.
 */
export async function requestTopUp(
  database: AppDatabase,
  context: TenantContext,
  input: { offerId: string; quoteHash: string; requestKey: string },
): Promise<{ topUpId: string; invoiceId: string }> {
  if (context.actorType !== 'user' || !can(context.role, 'billing.manage'))
    throw new AppError('NOT_FOUND');
  const parsed = requestTopUpSchema.safeParse({
    offer_id: input.offerId,
    quote_hash: input.quoteHash,
    request_key: input.requestKey,
  });
  if (!parsed.success || /[\r\n\0]/.test(input.requestKey)) throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    const [org] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .for('no key update');
    if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
    const [earlier] = await tx
      .select()
      .from(topUps)
      .where(
        and(
          eq(topUps.organizationId, context.organizationId),
          eq(topUps.requestKey, input.requestKey),
        ),
      );
    if (earlier) {
      if (
        earlier.offerId !== input.offerId ||
        earlier.quoteHash !== input.quoteHash ||
        earlier.requestedByMembershipId !== context.membershipId
      )
        throw new AppError('QUOTE_CHANGED');
      if (!earlier.invoiceId) throw new AppError('PREREQUISITES_INCOMPLETE');
      return { topUpId: earlier.id, invoiceId: earlier.invoiceId };
    }
    if (org.commercialMode !== 'cloud' || org.lifecycle !== 'active')
      throw new AppError('TOP_UP_NOT_ALLOWED');
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.organizationId, context.organizationId),
          eq(subscriptions.status, 'active'),
        ),
      )
      .for('update');
    const plan = sub ? await loadPlanTerms(tx, sub.planVersionId) : null;
    if (
      !plan ||
      plan.commercialMode !== 'cloud' ||
      plan.overagePolicy !== 'explicit_top_up' ||
      !plan.rateCardId
    )
      throw new AppError('TOP_UP_NOT_ALLOWED');
    const card = await requirePublishedRateCard(tx, plan.rateCardId);
    const [offer] = await tx
      .select()
      .from(topUpOffers)
      .where(
        and(eq(topUpOffers.id, parsed.data.offer_id), eq(topUpOffers.rateCardId, plan.rateCardId)),
      );
    if (!offer) throw new AppError('NOT_FOUND');
    if (!card.effectiveFrom || card.effectiveFrom > new Date() || card.currency !== plan.currency)
      throw new AppError('TOP_UP_NOT_ALLOWED');
    const quote = {
      offerId: offer.id,
      rateCardId: card.id,
      microcredits: offer.microcredits,
      priceMicros: offer.priceMicros,
      currency: card.currency,
    };
    if (quoteHash(quote) !== input.quoteHash) throw new AppError('QUOTE_CHANGED');
    const [topUp] = await tx
      .insert(topUps)
      .values({
        organizationId: context.organizationId,
        offerId: offer.id,
        microcredits: offer.microcredits,
        priceMicros: offer.priceMicros,
        currency: card.currency,
        quoteHash: input.quoteHash,
        requestKey: input.requestKey,
        requestedByMembershipId: context.membershipId,
      })
      .returning();
    const invoice = await createTopUpInvoiceInTx(tx, context, {
      topUpId: topUp!.id,
      rateCardId: card.id,
      draft: buildTopUpInvoice(quote, card.minorUnitExponent),
    });
    await tx
      .update(topUps)
      .set({
        status: 'invoiced',
        invoiceId: invoice.invoiceId,
        version: topUp!.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(topUps.id, topUp!.id));
    await emit(tx, context, {
      eventType: TOP_UP_REQUESTED,
      aggregateType: AGGREGATE_TOP_UP,
      aggregateId: topUp!.id,
      aggregateVersion: topUp!.version + 1,
      classification: 'internal',
      payload: { top_up_id: topUp!.id, invoice_id: invoice.invoiceId },
    });
    return { topUpId: topUp!.id, invoiceId: invoice.invoiceId };
  });
}

/** Service only, in the transaction that marked the invoice paid. Credits once, by key. Called by payments. */
export async function creditPaidTopUpInTx(
  tx: Tx,
  context: TenantContext,
  input: { invoiceId: string },
): Promise<'credited' | 'not_a_top_up' | 'already_credited'> {
  if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
  const id = idSchema.safeParse(input.invoiceId);
  if (!id.success) throw new AppError('INVALID_INPUT');
  // Match the same lock order as account operations before taking a payment's invoice/top-up rows.
  const [org] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, context.organizationId))
    .for('no key update');
  if (!org) throw new AppError('NOT_FOUND');
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.organizationId, context.organizationId), eq(invoices.id, id.data)))
    .for('update');
  if (!invoice) throw new AppError('NOT_FOUND');
  if (invoice.kind !== 'top_up' || !invoice.topUpId) return 'not_a_top_up';
  const [topUp] = await tx
    .select()
    .from(topUps)
    .where(and(eq(topUps.organizationId, context.organizationId), eq(topUps.id, invoice.topUpId)))
    .for('update');
  if (!topUp || topUp.invoiceId !== invoice.id) throw new AppError('NOT_FOUND');
  if (invoice.status !== 'paid') throw new AppError('INVALID_TRANSITION');
  if (topUp.status === 'credited') return 'already_credited';
  if (topUp.status === 'invoiced')
    await tx
      .update(topUps)
      .set({ status: 'paid', version: topUp.version + 1, updatedAt: new Date() })
      .where(eq(topUps.id, topUp.id));
  else if (topUp.status !== 'paid') throw new AppError('INVALID_TRANSITION');
  const [offer] = await tx
    .select({ rateCardId: topUpOffers.rateCardId })
    .from(topUpOffers)
    .where(eq(topUpOffers.id, topUp.offerId));
  if (!offer) throw new AppError('NOT_FOUND');
  const written = await tx
    .insert(creditLedger)
    .values({
      organizationId: context.organizationId,
      idempotencyKey: creditKeys.topUp(topUp.id),
      kind: 'top_up',
      amountMicrocredits: topUp.microcredits,
      topUpId: topUp.id,
      rateCardId: offer.rateCardId,
    })
    .onConflictDoNothing()
    .returning({ id: creditLedger.id });
  await tx
    .update(topUps)
    .set({
      status: 'credited',
      version: topUp.version + (topUp.status === 'invoiced' ? 2 : 1),
      updatedAt: new Date(),
    })
    .where(eq(topUps.id, topUp.id));
  if (written.length)
    await emit(tx, context, {
      eventType: TOP_UP_CREDITED,
      aggregateType: AGGREGATE_TOP_UP,
      aggregateId: topUp.id,
      aggregateVersion: topUp.version + (topUp.status === 'invoiced' ? 2 : 1),
      classification: 'internal',
      payload: { top_up_id: topUp.id, invoice_id: invoice.id },
    });
  return written.length ? 'credited' : 'already_credited';
}

/** `billing.view`. */
export async function listTopUps(
  database: AppDatabase,
  context: TenantContext,
): Promise<
  readonly { id: string; status: string; priceMicros: bigint; currency: string; createdAt: Date }[]
> {
  if (context.actorType !== 'user' || !can(context.role, 'billing.view'))
    throw new AppError('NOT_FOUND');
  return withAccountTx(database, context, (tx) =>
    tx
      .select({
        id: topUps.id,
        status: topUps.status,
        priceMicros: topUps.priceMicros,
        currency: topUps.currency,
        createdAt: topUps.createdAt,
      })
      .from(topUps)
      .where(eq(topUps.organizationId, context.organizationId))
      .orderBy(desc(topUps.createdAt), desc(topUps.id))
      .limit(100),
  );
}
