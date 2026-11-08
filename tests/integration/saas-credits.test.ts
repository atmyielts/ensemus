import { randomUUID } from 'node:crypto';
import {
  billingPeriods,
  creditLedger,
  createOrganization,
  memberships,
  organizations,
  invoices,
  payments,
  paymentAttempts,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  allocatePeriodCreditsInTx,
  consumeUsage,
  getCreditSummary,
  loadCreditBalanceInTx,
} from '@ensemus/application/saas/credits';
import { requestTopUp, creditPaidTopUpInTx } from '@ensemus/application/saas/top-ups';
import { startSubscription } from '@ensemus/application/saas/subscriptions';
import { listTopUpOffers } from '@ensemus/application/saas/catalog';
import { issueInvoice } from '@ensemus/application/saas/invoices';
import { UsageUnavailable, type UsageLedgerPort } from '@ensemus/application/saas/ports';
import { quoteHash } from '@ensemus/saas/credits';
import type { UsageEntry } from '@ensemus/saas/usage';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBillingAccount, seedPlan, seedRateCard, seedTaxTreatment } from '../helpers/saas';
import { urls } from '../helpers/stack';

describe('prepaid credit ledger through actual tenant roles', () => {
  const db = openAppDatabase(urls.app());
  const auth = new pg.Client({ connectionString: urls.auth() });
  let owner: TenantContext;
  let member: TenantContext;
  let other: TenantContext;
  async function tenant(mode: 'cloud' | 'byom' = 'cloud') {
    const userId = randomUUID();
    await auth.query('insert into identity.users(id,name,email) values ($1,$2,$3)', [
      userId,
      'Same credit name',
      `${userId}@example.invalid`,
    ]);
    const row = await createOrganization(db.db, {
      userId,
      name: 'Same credit name',
      commercialMode: mode,
    });
    return resolveTenantContext(db.db, userId, row.organizationId);
  }
  beforeAll(async () => {
    await auth.connect();
    owner = await tenant();
    other = await tenant();
    await withTenantTx(db.db, owner, (tx) =>
      tx
        .insert(memberships)
        .values({ organizationId: owner.organizationId, userId: other.userId, role: 'member' }),
    );
    member = await resolveTenantContext(db.db, other.userId, owner.organizationId);
  });
  afterAll(async () => {
    await auth.end();
    await db.close();
  });
  it('members and services cannot buy or read person-only billing', async () => {
    await expect(getCreditSummary(db.db, member)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const context of [member, createServiceContext(owner.organizationId)])
      await expect(
        requestTopUp(db.db, context, {
          offerId: randomUUID(),
          quoteHash: '0'.repeat(64),
          requestKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('allocation, duplicate usage and signed correction preserve balance equal to the actual ledger sum', async () => {
    const card = await seedRateCard();
    const plan = await seedPlan({ mode: 'cloud', rateCard: card });
    await startSubscription(db.db, owner, { planVersionId: plan.planVersionId });
    const service = createServiceContext(owner.organizationId);
    const [period] = await withTenantTx(db.db, service, (tx) => tx.select().from(billingPeriods));
    for (let attempt = 0; attempt < 2; attempt++)
      await withTenantTx(db.db, service, (tx) =>
        allocatePeriodCreditsInTx(tx, service, {
          billingPeriodId: period!.id,
          includedMicrocredits: plan.includedMicrocredits!,
          rateCardId: card.rateCardId,
        }),
      );
    const quantity = plan.includedMicrocredits! / card.microcreditsPerUnit + 1n;
    const original: UsageEntry = {
      id: randomUUID(),
      meter: card.meter,
      unit: 'unit',
      quantity,
      costMicros: null,
      status: 'estimated',
      billable: true,
      occurredAt: new Date(),
    };
    const ignored: UsageEntry = { ...original, id: randomUUID(), billable: false };
    const entries: UsageEntry[] = [ignored, original];
    const usage: UsageLedgerPort = {
      listSince: async (_tx, _ctx, { after, limit }) => {
        const start = Number(after ?? 0);
        const end = Math.min(entries.length, start + limit);
        return {
          entries: entries.slice(start, end),
          nextCursor: end > start ? String(end) : null,
          more: end < entries.length,
        };
      },
      sumForPeriod: async () => [],
    };
    const first = await consumeUsage(db.db, service, usage, { limit: 10 });
    expect(first).toMatchObject({ entries: 1, exhausted: true });
    expect(await consumeUsage(db.db, service, usage, { limit: 10 })).toMatchObject({
      entries: 0,
      microcredits: 0n,
    });
    entries.push({
      ...original,
      id: randomUUID(),
      quantity: -quantity,
      status: 'correction',
      correctsUsageId: original.id,
    });
    expect((await consumeUsage(db.db, service, usage, { limit: 10 })).microcredits).toBe(
      -quantity * card.microcreditsPerUnit,
    );
    const verification = await withTenantTx(db.db, service, (tx) =>
      tx.execute(
        sql`select (select balance_microcredits::text from billing.credit_accounts) as balance,(select sum(amount_microcredits)::text from billing.credit_ledger) as summed,(select count(*)::int from billing.credit_ledger where kind='allocation') as allocations,(select count(*)::int from platform.domain_events where event_type='credits.exhausted') as alerts,(select count(*)::int from billing.invoices) as invoices`,
      ),
    );
    expect(verification.rows[0]).toMatchObject({
      balance: plan.includedMicrocredits!.toString(),
      summed: plan.includedMicrocredits!.toString(),
      allocations: 1,
      alerts: 1,
      invoices: 0,
    });
    await expect(
      withTenantTx(db.db, service, (tx) => tx.update(creditLedger).set({ amountMicrocredits: 0n })),
    ).rejects.toThrow();
    await expect(withTenantTx(db.db, service, (tx) => tx.delete(creditLedger))).rejects.toThrow();
    await expect(
      withTenantTx(db.db, createServiceContext(other.organizationId), (tx) =>
        allocatePeriodCreditsInTx(tx, createServiceContext(other.organizationId), {
          billingPeriodId: period!.id,
          includedMicrocredits: plan.includedMicrocredits!,
          rateCardId: card.rateCardId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('unavailable usage rolls back the cursor and is never zero usage', async () => {
    const service = createServiceContext(owner.organizationId);
    const before = await withTenantTx(db.db, service, (tx) => loadCreditBalanceInTx(tx, service));
    await expect(
      consumeUsage(
        db.db,
        service,
        {
          listSince: async () => {
            throw new UsageUnavailable();
          },
          sumForPeriod: async () => [],
        },
        { limit: 10 },
      ),
    ).rejects.toBeInstanceOf(UsageUnavailable);
    expect(await withTenantTx(db.db, service, (tx) => loadCreditBalanceInTx(tx, service))).toBe(
      before,
    );
  });
  it('a changed quote or another tenant offer buys nothing; a repeated approved order is one invoice', async () => {
    await seedBillingAccount(db.db, owner);
    await seedTaxTreatment();
    const offers = await listTopUpOffers(db.db, owner);
    const offer = offers[0]!;
    await expect(
      requestTopUp(db.db, owner, {
        offerId: offer.offerId,
        quoteHash: '0'.repeat(64),
        requestKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'QUOTE_CHANGED' });
    const foreignCard = await seedRateCard();
    await expect(
      requestTopUp(db.db, owner, {
        offerId: foreignCard.topUpOfferId,
        quoteHash: '0'.repeat(64),
        requestKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const input = { offerId: offer.offerId, quoteHash: quoteHash(offer), requestKey: randomUUID() };
    const attempts = await Promise.all([
      requestTopUp(db.db, owner, input),
      requestTopUp(db.db, owner, input),
    ]);
    expect(attempts[0]).toEqual(attempts[1]);
    const service = createServiceContext(owner.organizationId);
    await expect(
      withTenantTx(db.db, service, (tx) =>
        creditPaidTopUpInTx(tx, service, { invoiceId: attempts[0]!.invoiceId }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(
      withTenantTx(db.db, service, (tx) =>
        tx.insert(creditLedger).values({
          organizationId: owner.organizationId,
          idempotencyKey: randomUUID(),
          kind: 'top_up',
          amountMicrocredits: offer.microcredits,
          topUpId: attempts[0]!.topUpId,
          rateCardId: offer.rateCardId,
        }),
      ),
    ).rejects.toThrow();
    await issueInvoice(db.db, service, {
      invoiceId: attempts[0]!.invoiceId,
      tax: { taxMicros: 0n, providerRef: null },
    });
    const before = await withTenantTx(db.db, service, (tx) => loadCreditBalanceInTx(tx, service));
    // Synthetic evidence is seeded through the real payment states and triggers. No provider is contacted.
    await withTenantTx(db.db, service, async (tx) => {
      await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, owner.organizationId))
        .for('no key update');
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, attempts[0]!.invoiceId));
      const key = randomUUID();
      const [payment] = await tx
        .insert(payments)
        .values({
          organizationId: owner.organizationId,
          invoiceId: invoice!.id,
          amountMicros: invoice!.totalMicros,
          currency: invoice!.currency,
          idempotencyKey: key,
          processor: 'test-scripted',
          requestedByRef: owner.membershipId,
        })
        .returning();
      const [attempt] = await tx
        .insert(paymentAttempts)
        .values({
          organizationId: owner.organizationId,
          paymentId: payment!.id,
          attemptNo: 1,
          idempotencyKey: key,
          runId: randomUUID(),
        })
        .returning();
      await tx
        .update(payments)
        .set({ status: 'sending', version: 2 })
        .where(eq(payments.id, payment!.id));
      await tx
        .update(paymentAttempts)
        .set({ outcome: 'succeeded', processorPaymentRef: randomUUID(), finishedAt: new Date() })
        .where(eq(paymentAttempts.id, attempt!.id));
      await tx
        .update(payments)
        .set({ status: 'succeeded', version: 3, settledAt: new Date() })
        .where(eq(payments.id, payment!.id));
      await tx
        .update(invoices)
        .set({ status: 'paid', paidAt: new Date(), version: invoice!.version + 1 })
        .where(eq(invoices.id, invoice!.id));
      expect(await creditPaidTopUpInTx(tx, service, { invoiceId: invoice!.id })).toBe('credited');
    });
    expect(
      await withTenantTx(db.db, service, (tx) =>
        creditPaidTopUpInTx(tx, service, { invoiceId: attempts[0]!.invoiceId }),
      ),
    ).toBe('already_credited');
    expect(await withTenantTx(db.db, service, (tx) => loadCreditBalanceInTx(tx, service))).toBe(
      before + offer.microcredits,
    );
  });
  it('BYOM has no model credit balance and no top-up offer or inference charge', async () => {
    const byom = await tenant('byom');
    await startSubscription(db.db, byom, await seedPlan({ mode: 'byom' }));
    expect((await getCreditSummary(db.db, byom)).balanceMicrocredits).toBeNull();
    expect(await listTopUpOffers(db.db, byom)).toEqual([]);
    const service = createServiceContext(byom.organizationId);
    expect(
      await consumeUsage(
        db.db,
        service,
        {
          listSince: async () => {
            throw new Error('MUST_NOT_CONTACT');
          },
          sumForPeriod: async () => [],
        },
        { limit: 1 },
      ),
    ).toEqual({ entries: 0, microcredits: 0n, exhausted: false, more: false });
  });
});
