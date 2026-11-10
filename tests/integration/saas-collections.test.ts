import {
  collectionCases,
  openAppDatabase,
  organizations,
  subscriptions,
  withTenantTx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { runCollections } from '@ensemus/application/saas/collections';
import {
  beginPaymentReconcile,
  finishPaymentAttempt,
  finishPaymentReconcile,
} from '@ensemus/application/saas/payments';
import { setTenantStandingInTx } from '@ensemus/application/saas/standing';
import { runBoundCharge, runBoundPaymentLookup } from '@ensemus/connectors/payment';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { nativePaymentFixture } from '../helpers/native-payment';
import { seedCollectionPolicy, seedTaxTreatment } from '../helpers/saas';
import { urls } from '../helpers/stack';
import { paymentAgents, paymentFixture } from './saas-payment-fixture';

describe('collections follows pinned published steps without deleting tenant content', () => {
  const database = openAppDatabase(urls.app()),
    secretsDb = openSecretsDatabase(urls.secrets()),
    auth = new pg.Client({ connectionString: urls.auth() });
  beforeAll(async () => {
    await auth.connect();
    await seedTaxTreatment();
  });
  afterAll(async () => {
    await auth.end();
    await secretsDb.close();
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
  // Since 0512 an attempt exists only on a broker-attested, bound and customer-confirmed execution,
  // and a positive outcome only after its transport was admitted, so both payments below go through
  // the native fixture and a generated local processor, as saas-payments does.
  it('each concurrent sweep takes the published step once and payment restores only collection standing', async () => {
    const policy = await seedCollectionPolicy([
        { afterDays: 0, action: 'notify' },
        { afterDays: 0, action: 'read_only' },
      ]),
      f = await nativePaymentFixture(database.db, auth, secretsDb),
      who = f.who;
    try {
      await withTenantTx(database.db, who.service, (tx) =>
        tx
          .update(subscriptions)
          .set({ collectionPolicyId: policy })
          .where(eq(subscriptions.id, who.subscription.subscriptionId)),
      );
      const q = await f.qualify();
      await f.register();
      const agents = {
        haltTenantAgents: vi.fn(paymentAgents.haltTenantAgents),
        releaseTenantAgents: vi.fn(paymentAgents.releaseTenantAgents),
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
      const attempt = await f.beginAttempt();
      if (attempt.kind !== 'attempt') throw new Error('TEST_EXPECTED_BOUND_ATTEMPT');
      const result = await runBoundCharge(
        f.processor,
        f.call('charge', { attemptId: attempt.attemptId }),
        attempt.charge,
        q.authority.authoritySha256,
      );
      expect(result.outcome).toBe('succeeded');
      await finishPaymentAttempt(
        database.db,
        who.service,
        { attemptId: attempt.attemptId, result },
        agents,
      );
      const [org] = await withAccountTx(database.db, who.service, (tx) =>
        tx.select().from(organizations),
      );
      expect(org!.lifecycle).toBe('active');
      expect(agents.releaseTenantAgents).toHaveBeenCalledTimes(1);
      expect(
        (
          await withAccountTx(database.db, who.service, (tx) => tx.select().from(collectionCases))
        )[0]!.status,
      ).toBe('resolved');
      expect((await counts()).rows).toEqual(before);
    } finally {
      await f.close();
    }
  });
  it('unknown payment stops subsequent collection steps, and an operator stop is never cleared', async () => {
    const policy = await seedCollectionPolicy([{ afterDays: 0, action: 'read_only' }]),
      f = await nativePaymentFixture(database.db, auth, secretsDb),
      who = f.who;
    try {
      await withTenantTx(database.db, who.service, (tx) =>
        tx
          .update(subscriptions)
          .set({ collectionPolicyId: policy })
          .where(eq(subscriptions.id, who.subscription.subscriptionId)),
      );
      const q = await f.qualify();
      await f.register();
      const attempt = await f.beginAttempt();
      if (attempt.kind !== 'attempt') throw new Error('TEST_EXPECTED_BOUND_ATTEMPT');
      // The processor accepts the charge and the answer is lost: the payment's outcome is unknown.
      f.nextCharge('drop_after_accept');
      const lost = await runBoundCharge(
        f.processor,
        f.call('charge', { attemptId: attempt.attemptId }),
        attempt.charge,
        q.authority.authoritySha256,
      );
      expect(lost.outcome).toBe('indeterminate');
      expect(
        await finishPaymentAttempt(database.db, who.service, {
          attemptId: attempt.attemptId,
          result: lost,
        }),
      ).toEqual({ step: 'reconcile' });
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
      // The later answer arrives the way production finds it: an authoritative lookup by the key.
      await beginPaymentReconcile(database.db, who.service, {
        paymentId: f.payment.paymentId,
        code: 'PROCESSOR_ERROR',
      });
      const lookup = await runBoundPaymentLookup(
        f.processor,
        f.call('lookup', { attemptId: attempt.attemptId }),
        attempt.charge.idempotencyKey,
        q.authority.authoritySha256,
      );
      expect(lookup.found).toBe('succeeded');
      const token = await f.attestLookupResult(lookup);
      expect(
        await finishPaymentReconcile(
          database.db,
          who.service,
          {
            attemptId: attempt.attemptId,
            result: lookup,
            lookup: 'authoritative',
            nativeLookupToken: token.token,
          },
          paymentAgents,
        ),
      ).toBe('succeeded');
      expect(
        (await withAccountTx(database.db, who.service, (tx) => tx.select().from(organizations)))[0]!
          .lifecycle,
      ).toBe('suspended');
    } finally {
      await f.close();
    }
  });
});
