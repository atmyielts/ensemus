// Hosted checkout under the actual roles (ADR-032 D4a, migration 0580). Generated values only; no provider
// is contacted. What matters here is what PostgreSQL refuses, whatever the application layer decided.
import { randomUUID } from 'node:crypto';
import {
  closeCheckout,
  getCheckoutStatus,
  recordCheckoutOpened,
  startCheckout,
  type CheckoutSettings,
} from '@ensemus/application/saas/checkout';
import { startSubscription } from '@ensemus/application/saas/subscriptions';
import {
  draftDuePeriodInvoices,
  issueInvoice,
  listInvoices,
} from '@ensemus/application/saas/invoices';
import { checkoutSessions, openAppDatabase, payments, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBillingAccount, seedPlan } from '../helpers/saas';
import { urls } from '../helpers/stack';
import { paymentAgents, paymentTenant } from './saas-payment-fixture';

const settings: CheckoutSettings = {
  providers: ['paddle'],
  payme: null,
  click: null,
  paddle: { environment: 'sandbox' },
  publicUrl: 'https://ensemus.example.invalid',
};

describe('hosted checkout is moved only by an attested provider word', () => {
  const database = openAppDatabase(urls.app()),
    auth = new pg.Client({ connectionString: urls.auth() });
  beforeAll(() => auth.connect());
  afterAll(async () => {
    await auth.end();
    await database.close();
  });

  async function openInvoice() {
    const owner = await paymentTenant(database.db, auth);
    const service = createServiceContext(owner.organizationId);
    await seedBillingAccount(database.db, owner, {});
    const plan = await seedPlan({ mode: 'byom', currency: 'USD' });
    await startSubscription(database.db, service, {
      planVersionId: plan.planVersionId,
      startsAt: new Date(Date.now() - 40 * 86400000),
    });
    await draftDuePeriodInvoices(
      database.db,
      service,
      {
        usage: {
          listSince: async () => ({ entries: [], nextCursor: null }),
          sumForPeriod: async () => [],
        },
        agents: paymentAgents,
      },
      new Date(),
    );
    const invoice = (await listInvoices(database.db, owner, {})).items[0]!;
    await issueInvoice(database.db, service, {
      invoiceId: invoice.id,
      tax: { taxMicros: 0n, providerRef: null },
    });
    return { owner, service, invoiceId: invoice.id };
  }

  it('opens one checkout per invoice, with its payment committed as sending', async () => {
    const { owner, invoiceId } = await openInvoice();
    const first = await startCheckout(
      database.db,
      owner,
      { invoiceId, provider: 'paddle', language: 'en' },
      settings,
    );
    const again = await startCheckout(
      database.db,
      owner,
      { invoiceId, provider: 'paddle', language: 'en' },
      settings,
    );
    expect(first.created).toBe(true);
    expect(again).toEqual({ sessionId: first.sessionId, created: false });
    const status = await getCheckoutStatus(database.db, owner, {
      invoiceId,
      sessionId: first.sessionId,
    });
    expect(status).toMatchObject({ state: 'opening', display: 'preparing', checkoutUrl: null });
  });

  it('refuses to mark a checkout or its payment paid without the provider, and to fail it while open', async () => {
    const { owner, service, invoiceId } = await openInvoice();
    const { sessionId } = await startCheckout(
      database.db,
      owner,
      { invoiceId, provider: 'paddle', language: 'en' },
      settings,
    );
    await recordCheckoutOpened(database.db, service, {
      sessionId,
      transactionId: 'txn_0test',
      checkoutUrl: 'https://pay.example.invalid/checkout?_ptxn=txn_0test',
      customerRef: 'ctm_0test',
    });
    const [row] = await withTenantTx(database.db, service, (tx) =>
      tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, sessionId)),
    );
    // The web tier and the worker share this role; neither can say what the money did by itself.
    await expect(
      withTenantTx(database.db, service, (tx) =>
        tx
          .update(checkoutSessions)
          .set({ state: 'paid', version: row!.version + 1 })
          .where(eq(checkoutSessions.id, sessionId)),
      ),
    ).rejects.toMatchObject({ cause: { code: 'EN860' } });
    await expect(
      withTenantTx(database.db, service, (tx) =>
        tx.update(payments).set({ status: 'succeeded' }).where(eq(payments.id, row!.paymentId)),
      ),
    ).rejects.toMatchObject({ cause: { code: 'EN803' } });
    await expect(
      withTenantTx(database.db, service, (tx) =>
        tx.update(payments).set({ status: 'failed' }).where(eq(payments.id, row!.paymentId)),
      ),
    ).rejects.toMatchObject({ cause: { code: 'EN862' } });
    await expect(
      withTenantTx(database.db, service, (tx) =>
        tx.execute(sql`select billing.apply_checkout_change(${'a'.repeat(64)}, ${sessionId}::uuid,
          'paddle.paid', 'paid', 'txn_0test', null, ${Date.now().toString()}::bigint, null, 0)`),
      ),
    ).rejects.toMatchObject({ cause: { code: 'EN861' } });
    // An open Paddle checkout is Paddle's to end: the customer cannot close it here.
    await expect(closeCheckout(database.db, owner, { invoiceId, sessionId })).rejects.toMatchObject(
      { code: 'INVOICE_NOT_PAYABLE' },
    );
  });

  it('closes a checkout no provider transaction exists for, and ends its payment unpaid', async () => {
    const { owner, invoiceId } = await openInvoice();
    const { sessionId } = await startCheckout(
      database.db,
      owner,
      { invoiceId, provider: 'paddle', language: 'en' },
      settings,
    );
    await closeCheckout(database.db, owner, { invoiceId, sessionId });
    const status = await getCheckoutStatus(database.db, owner, { invoiceId, sessionId });
    expect(status.display).toBe('not_paid');
    const next = await startCheckout(
      database.db,
      owner,
      { invoiceId, provider: 'paddle', language: 'en' },
      settings,
    );
    expect(next.sessionId).not.toBe(sessionId);
  });

  it('reaches a checkout from another tenant only by the hash of its exact order', async () => {
    const { owner, invoiceId } = await openInvoice();
    const { sessionId } = await startCheckout(
      database.db,
      owner,
      { invoiceId, provider: 'paddle', language: 'en' },
      settings,
    );
    const stranger = createServiceContext(randomUUID());
    const seen = await database.db.transaction(
      { 'app.organization_id': stranger.organizationId, 'app.actor_type': 'service' },
      async (tx) => {
        const none = await tx.select().from(checkoutSessions);
        await tx.execute(
          sql`select set_config('app.checkout_route_sha256', billing.checkout_route('order', 'paddle', ${sessionId}), true)`,
        );
        const one = await tx.select().from(checkoutSessions);
        return { none: none.length, one: one.map((r) => r.id) };
      },
    );
    expect(seen).toEqual({ none: 0, one: [sessionId] });
  });
});
