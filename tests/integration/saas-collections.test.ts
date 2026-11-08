import { randomUUID } from 'node:crypto';
import {
  collectionCases,
  openAppDatabase,
  organizations,
  subscriptions,
  withTenantTx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { runCollections } from '@ensemus/application/saas/collections';
import {
  beginPaymentAttempt,
  finishPaymentAttempt,
  requestInvoicePayment,
} from '@ensemus/application/saas/payments';
import { setTenantStandingInTx } from '@ensemus/application/saas/standing';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedCollectionPolicy, seedTaxTreatment } from '../helpers/saas';
import { urls } from '../helpers/stack';
import { paymentAgents, paymentFixture } from './saas-payment-fixture';

describe('collections follows pinned published steps without deleting tenant content', () => {
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
  const clock = () => new Date(Date.now() + 1000);
  it('denies a person and leaves an overdue invoice alone when no policy is bound', async () => {
    const who = await paymentFixture(database.db, auth);
    await withTenantTx(database.db, who.service, (tx) =>
      tx
        .update(subscriptions)
        .set({ collectionPolicyId: null })
        .where(eq(subscriptions.id, who.subscription.subscriptionId)),
    );
    await expect(
      runCollections(database.db, who.owner, { agents: paymentAgents }, clock()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      await runCollections(database.db, who.service, { agents: paymentAgents }, clock()),
    ).toEqual({ opened: 0, stepsTaken: 0, noPolicy: 1 });
    expect(
      await withTenantTx(database.db, who.service, (tx) => tx.select().from(collectionCases)),
    ).toHaveLength(0);
  });
  it('each concurrent sweep takes the published step once and payment restores only collection standing', async () => {
    const policy = await seedCollectionPolicy([
        { afterDays: 0, action: 'notify' },
        { afterDays: 0, action: 'read_only' },
      ]),
      who = await paymentFixture(database.db, auth);
    await withTenantTx(database.db, who.service, (tx) =>
      tx
        .update(subscriptions)
        .set({ collectionPolicyId: policy })
        .where(eq(subscriptions.id, who.subscription.subscriptionId)),
    );
    const agents = {
      haltTenantAgents: vi.fn().mockResolvedValue(undefined),
      releaseTenantAgents: vi.fn().mockResolvedValue(undefined),
    };
    const counts = () =>
      withAccountTx(database.db, who.service, (tx) =>
        tx.execute(
          sql`select (select count(*)::int from org.memberships) as members,(select count(*)::int from billing.invoices) as invoices,(select count(*)::int from billing.subscriptions) as subscriptions`,
        ),
      );
    const before = (await counts()).rows;
    const sweeps = await Promise.all([
      runCollections(database.db, who.service, { agents }, clock()),
      runCollections(database.db, who.service, { agents }, clock()),
    ]);
    expect(sweeps.reduce((sum, row) => sum + row.stepsTaken, 0)).toBe(2);
    expect(agents.haltTenantAgents).toHaveBeenCalledTimes(1);
    expect((await counts()).rows).toEqual(before);
    const intent = await requestInvoicePayment(database.db, who.owner, {
        invoiceId: who.invoice.id,
        processor: 'test_scripted',
      }),
      attempt = await beginPaymentAttempt(database.db, who.service, {
        paymentId: intent.paymentId,
        runId: randomUUID(),
      });
    if (attempt.kind !== 'attempt') throw new Error('no attempt');
    await finishPaymentAttempt(
      database.db,
      who.service,
      {
        attemptId: attempt.attemptId,
        result: { outcome: 'succeeded', code: 'CHARGED', processorPaymentRef: randomUUID() },
      },
      agents,
    );
    const [org] = await withAccountTx(database.db, who.service, (tx) =>
      tx.select().from(organizations),
    );
    expect(org!.lifecycle).toBe('active');
    expect(agents.releaseTenantAgents).toHaveBeenCalledTimes(1);
    expect(
      (await withAccountTx(database.db, who.service, (tx) => tx.select().from(collectionCases)))[0]!
        .status,
    ).toBe('resolved');
    expect((await counts()).rows).toEqual(before);
  });
  it('unknown payment stops subsequent collection steps, and an operator stop is never cleared', async () => {
    const policy = await seedCollectionPolicy([{ afterDays: 0, action: 'read_only' }]),
      who = await paymentFixture(database.db, auth);
    await withTenantTx(database.db, who.service, (tx) =>
      tx
        .update(subscriptions)
        .set({ collectionPolicyId: policy })
        .where(eq(subscriptions.id, who.subscription.subscriptionId)),
    );
    const intent = await requestInvoicePayment(database.db, who.owner, {
        invoiceId: who.invoice.id,
        processor: 'test_scripted',
      }),
      attempt = await beginPaymentAttempt(database.db, who.service, {
        paymentId: intent.paymentId,
        runId: randomUUID(),
      });
    if (attempt.kind !== 'attempt') throw new Error('no attempt');
    await finishPaymentAttempt(database.db, who.service, {
      attemptId: attempt.attemptId,
      result: { outcome: 'indeterminate', code: 'TIMEOUT_AFTER_SEND' },
    });
    expect(
      (await runCollections(database.db, who.service, { agents: paymentAgents }, clock()))
        .stepsTaken,
    ).toBe(0);
    await withAccountTx(database.db, who.service, (tx) =>
      setTenantStandingInTx(
        tx,
        who.service,
        {
          to: 'suspended',
          reasonCode: 'TEST_OPERATOR_STOP',
          actor: { type: 'operator', ref: 'test-operator@example.invalid' },
        },
        paymentAgents,
      ),
    );
    await finishPaymentAttempt(
      database.db,
      who.service,
      {
        attemptId: attempt.attemptId,
        result: { outcome: 'succeeded', code: 'CHARGED', processorPaymentRef: randomUUID() },
      },
      paymentAgents,
    );
    expect(
      (await withAccountTx(database.db, who.service, (tx) => tx.select().from(organizations)))[0]!
        .lifecycle,
    ).toBe('suspended');
  });
});
