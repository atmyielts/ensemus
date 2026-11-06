import { randomUUID } from 'node:crypto';
import {
  openAppDatabase,
  paymentEvents,
  paymentWebhookEvents,
  withTenantTx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  applyPaymentFactInTx,
  listUnmatchedPaymentEvents,
  recordPaymentEventInTx,
  routePaymentEvent,
} from '@ensemus/application/saas/payment-events';
import { beginPaymentAttempt, requestInvoicePayment } from '@ensemus/application/saas/payments';
import { getInvoice } from '@ensemus/application/saas/invoices';
import { hashCustomerRef, type PaymentEventFact } from '@ensemus/saas/payment';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedTaxTreatment } from '../helpers/saas';
import { urls } from '../helpers/stack';
import { paymentFixture, paymentTenant } from './saas-payment-fixture';

describe('verified payment facts route only from the deployment billing endpoint', () => {
  const database = openAppDatabase(urls.app()),
    auth = new pg.Client({ connectionString: urls.auth() });
  beforeAll(async () => {
    await auth.connect();
    await seedTaxTreatment();
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });
  async function setup() {
    const who = await paymentFixture(database.db, auth),
      operator = await paymentTenant(database.db, auth),
      operatorContext = createServiceContext(operator.organizationId),
      connectionId = randomUUID();
    const intent = await requestInvoicePayment(database.db, who.owner, {
      invoiceId: who.invoice.id,
      processor: 'test_scripted',
    });
    await beginPaymentAttempt(database.db, who.service, {
      paymentId: intent.paymentId,
      runId: randomUUID(),
    });
    const fact: PaymentEventFact = {
      processor: 'test_scripted',
      providerEventId: randomUUID(),
      kind: 'payment_succeeded',
      customerRefHash: hashCustomerRef('test_scripted', who.customerRef),
      processorPaymentRef: randomUUID(),
      paymentId: intent.paymentId,
      amountMicros: who.invoice.totalMicros.toString(),
      currency: who.invoice.currency,
      occurredAtSeconds: Math.floor(Date.now() / 1000),
    };
    return {
      ...who,
      operator,
      operatorContext,
      connectionId,
      intent,
      fact,
      binding: {
        billingOrganizationId: operator.organizationId,
        billingConnectionId: connectionId,
        processor: 'test_scripted',
        connectionId,
      },
    };
  }
  it('a person or an independently registered tenant endpoint cannot mint settlement evidence', async () => {
    const who = await setup();
    await expect(
      withTenantTx(database.db, who.owner, (tx) =>
        recordPaymentEventInTx(tx, who.owner, who.fact, who.binding),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      withTenantTx(database.db, who.service, (tx) =>
        recordPaymentEventInTx(tx, who.service, who.fact, who.binding),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      withTenantTx(database.db, who.operatorContext, (tx) =>
        recordPaymentEventInTx(tx, who.operatorContext, who.fact, {
          ...who.binding,
          connectionId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      withTenantTx(database.db, who.operatorContext, (tx) =>
        recordPaymentEventInTx(tx, who.operatorContext, who.fact),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await getInvoice(database.db, who.owner, who.invoice.id)).status).toBe('open');
  });
  it('matches exact amount, currency and customer before writing evidence', async () => {
    const who = await setup();
    for (const fact of [
      { ...who.fact, amountMicros: (who.invoice.totalMicros + 1n).toString() },
      { ...who.fact, currency: 'XXX' },
      { ...who.fact, customerRefHash: hashCustomerRef('test_scripted', randomUUID()) },
      { ...who.fact, paymentId: randomUUID() },
    ])
      expect(
        await withTenantTx(database.db, who.service, (tx) =>
          applyPaymentFactInTx(tx, who.service, fact),
        ),
      ).toBe('no_matching_payment');
    expect(
      await withTenantTx(database.db, who.service, (tx) => tx.select().from(paymentEvents)),
    ).toHaveLength(0);
  });
  it('a crash after tenant settlement replays the unique fact before marking the operator inbox', async () => {
    const who = await setup();
    for (let i = 0; i < 2; i++)
      await withTenantTx(database.db, who.operatorContext, (tx) =>
        recordPaymentEventInTx(tx, who.operatorContext, who.fact, who.binding),
      );
    const rows = await withTenantTx(database.db, who.operatorContext, (tx) =>
      tx.select().from(paymentWebhookEvents),
    );
    expect(rows).toHaveLength(1);
    expect(
      await withTenantTx(database.db, who.service, (tx) =>
        applyPaymentFactInTx(tx, who.service, who.fact),
      ),
    ).toBe('applied');
    expect(
      await routePaymentEvent(
        database.db,
        who.operatorContext,
        { paymentWebhookEventId: rows[0]!.id },
        who.binding,
      ),
    ).toBe('already_done');
    expect(
      await routePaymentEvent(
        database.db,
        who.operatorContext,
        { paymentWebhookEventId: rows[0]!.id },
        who.binding,
      ),
    ).toBe('already_done');
    expect((await getInvoice(database.db, who.owner, who.invoice.id)).status).toBe('paid');
    expect(
      await withTenantTx(database.db, who.service, (tx) => tx.select().from(paymentEvents)),
    ).toHaveLength(1);
    await expect(
      routePaymentEvent(
        database.db,
        who.service,
        { paymentWebhookEventId: rows[0]!.id },
        who.binding,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('retains an unmatched event and flags refunds without reversing a paid invoice', async () => {
    const who = await setup();
    const unmatched = {
      ...who.fact,
      providerEventId: randomUUID(),
      customerRefHash: hashCustomerRef('test_scripted', randomUUID()),
    };
    await withTenantTx(database.db, who.operatorContext, (tx) =>
      recordPaymentEventInTx(tx, who.operatorContext, unmatched, who.binding),
    );
    const [row] = await withTenantTx(database.db, who.operatorContext, (tx) =>
      tx.select().from(paymentWebhookEvents),
    );
    expect(
      await routePaymentEvent(
        database.db,
        who.operatorContext,
        { paymentWebhookEventId: row!.id },
        who.binding,
      ),
    ).toBe('unmatched');
    expect(
      await listUnmatchedPaymentEvents(database.db, who.operatorContext, who.binding),
    ).toHaveLength(1);
    await withTenantTx(database.db, who.service, (tx) =>
      applyPaymentFactInTx(tx, who.service, who.fact),
    );
    for (const kind of ['payment_refunded', 'payment_disputed'] as const)
      expect(
        await withTenantTx(database.db, who.service, (tx) =>
          applyPaymentFactInTx(tx, who.service, {
            ...who.fact,
            providerEventId: randomUUID(),
            kind,
          }),
        ),
      ).toBe('applied');
    expect((await getInvoice(database.db, who.owner, who.invoice.id)).status).toBe('paid');
  });
});
