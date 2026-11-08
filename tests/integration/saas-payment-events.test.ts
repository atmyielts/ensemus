// Real native signature/broker/SQL receipts with a fictional generated TLS processor. No live provider claim.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  connections,
  inboxEvents,
  openAppDatabase,
  outboxEvents,
  paymentEvents,
  paymentWebhookEvents,
  webhookDeliveries,
  withTenantTx,
} from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { withVerifiedPaymentEventTx } from '@ensemus/database/payment-routing';
import { createWebhookEndpoint, pgCode } from '@ensemus/application';
import {
  applyPaymentFactInTx,
  listUnmatchedPaymentEvents,
  recordPaymentEventInTx,
  routePaymentEvent,
} from '@ensemus/application/saas/payment-events';
import { readPaymentOutcome } from '@ensemus/application/saas/payments';
import { getInvoice } from '@ensemus/application/saas/invoices';
import { runBoundCharge } from '@ensemus/connectors/payment';
import { storeSecret } from '@ensemus/secrets/seal';
import { SECRET_PURPOSE_PAYMENT_PROCESSOR } from '@ensemus/connectors/payment';
import { hashCustomerRef, type PaymentEventFact } from '@ensemus/saas/payment';
import { nativePaymentFixture } from '../helpers/native-payment';
import { nativePaymentWebhook } from '../helpers/native-payment-webhook';
import { seedTaxTreatment } from '../helpers/saas';
import { secret, urls } from '../helpers/stack';
import { paymentAgents } from './saas-payment-fixture';

describe('native verified payment events keep source, merchant and financial effects bound', () => {
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
  async function setup(options: Parameters<typeof nativePaymentFixture>[3] = {}) {
    const f = await nativePaymentFixture(database.db, auth, secretsDb, options);
    try {
      const q = await f.qualify(),
        customerRef = await f.register();
      if (!customerRef) throw new Error('TEST_EXPECTED_REAL_CUSTOMER');
      const webhook = nativePaymentWebhook(database.db, f);
      await webhook.qualifyEndpoint(q.binding.id);
      const attempt = await f.beginAttempt();
      if (attempt.kind !== 'attempt') throw new Error('TEST_EXPECTED_BOUND_ATTEMPT');
      const answer = await runBoundCharge(
        f.processor,
        f.call('charge', { attemptId: attempt.attemptId }),
        attempt.charge,
        q.authority.authoritySha256,
      );
      if (answer.outcome !== 'succeeded') throw new Error('TEST_EXPECTED_GENERATED_WIRE_ACK');
      const fact: PaymentEventFact = {
        processor: 'test_scripted',
        providerEventId: randomUUID(),
        kind: 'payment_succeeded',
        customerRefHash: hashCustomerRef('test_scripted', customerRef),
        processorPaymentRef: answer.processorPaymentRef,
        paymentId: f.payment.paymentId,
        amountMicros: attempt.charge.amountMicros.toString(),
        currency: attempt.charge.currency,
        occurredAtSeconds: Math.floor(Date.now() / 1000),
      };
      const binding = {
        billingOrganizationId: f.operator.organizationId,
        billingConnectionId: f.connection.id,
        connectionId: f.connection.id,
        processor: 'test_scripted',
      };
      return { f, q, webhook, fact, binding };
    } catch (error) {
      await f.close();
      throw error;
    }
  }
  type Fixture = Awaited<ReturnType<typeof setup>>;
  async function capture(who: Fixture, fact = who.fact, endpoint?: typeof who.f.endpoint) {
    const delivery = await who.webhook.post(fact, endpoint ? { endpoint } : {});
    expect(await who.webhook.process(delivery)).toBe('applied');
    const [receipt] = await withTenantTx(database.db, who.f.operatorContext, (tx) =>
      tx
        .select()
        .from(paymentWebhookEvents)
        .where(
          and(
            eq(paymentWebhookEvents.processor, fact.processor),
            eq(paymentWebhookEvents.providerEventId, fact.providerEventId),
            eq(paymentWebhookEvents.accountNamespaceSha256, who.q.binding.accountNamespaceSha256),
          ),
        ),
    );
    if (!receipt) throw new Error('TEST_EXPECTED_NATIVE_RECEIPT');
    return { delivery, receipt };
  }
  const route = (who: Fixture, id: string) =>
    routePaymentEvent(
      database.db,
      who.f.operatorContext,
      { paymentWebhookEventId: id },
      who.binding,
      paymentAgents,
    );
  const financialRows = (who: Fixture) =>
    withTenantTx(database.db, who.f.who.service, (tx) => tx.select().from(paymentEvents));
  it('actual app and agent SET ROLE app cannot invoke the secrets-only native webhook mint', async () => {
    const who = await setup(),
      agent = new pg.Client({ connectionString: urls.agent() });
    try {
      const denied = sql`select * from billing.attest_payment_webhook(null::uuid,null::text,null::uuid,null::uuid,null::uuid,
        null::text,null::text,null::text,null::text,null::text,null::text,null::text,null::text,null::text)`;
      // Permission denial is the assertion: no positive receipt or token is fabricated by this call.
      await expect(
        withTenantTx(database.db, who.f.operatorContext, (tx) => tx.execute(denied)),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
      await agent.connect();
      await agent.query('begin');
      await agent.query('set local role ensemus_app');
      await agent.query(
        "select set_config('app.organization_id',$1,true),set_config('app.actor_type','service',true),set_config('billing.payment_org',$1,true)",
        [who.f.operator.organizationId],
      );
      await expect(
        agent.query(`select * from billing.attest_payment_webhook(null::uuid,null::text,null::uuid,null::uuid,null::uuid,
        null::text,null::text,null::text,null::text,null::text,null::text,null::text,null::text,null::text)`),
      ).rejects.toMatchObject({ code: '42501' });
      await agent.query('rollback');
      expect(await financialRows(who)).toEqual([]);
    } finally {
      await agent.end();
      await who.f.close();
    }
  });
  it('app/person/foreign source metadata cannot mint verification, even with the right native binding IDs', async () => {
    const who = await setup();
    try {
      for (const context of [who.f.operator, who.f.who.service])
        await expect(
          withTenantTx(database.db, context, (tx) =>
            recordPaymentEventInTx(tx, context, who.fact, who.binding),
          ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        withTenantTx(database.db, who.f.operatorContext, (tx) =>
          recordPaymentEventInTx(tx, who.f.operatorContext, who.fact, who.binding),
        ),
      ).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
      await expect(
        withTenantTx(database.db, who.f.operatorContext, (tx) =>
          tx.execute(sql`select * from billing.payment_webhook_attestations`),
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
      const delivery = await who.webhook.post(who.fact);
      // These claims are app-owned text, not a native verifier token.
      await expect(
        withTenantTx(database.db, who.f.operatorContext, (tx) =>
          recordPaymentEventInTx(tx, who.f.operatorContext, who.fact, {
            ...who.binding,
            endpointId: who.f.endpoint.endpointId,
            deliveryId: delivery.id,
            observedAccountNamespaceSha256: who.q.binding.accountNamespaceSha256,
            observedExecutionIdentitySha256: who.q.binding.identitySha256,
            verificationToken: 'f'.repeat(64),
          }),
        ),
      ).rejects.toThrow('PAYMENT_WEBHOOK_VERIFICATION_UNAVAILABLE');
      expect(await financialRows(who)).toEqual([]);
      expect((await getInvoice(database.db, who.f.who.owner, who.f.who.invoice.id)).status).toBe(
        'open',
      );
    } finally {
      await who.f.close();
    }
  });
  it('matches actual signed amount, currency, customer and payment before financial effects', async () => {
    const who = await setup();
    try {
      for (const changed of [
        { amountMicros: (BigInt(who.fact.amountMicros!) + 1n).toString() },
        { currency: 'XXX' },
        { customerRefHash: hashCustomerRef('test_scripted', randomUUID()) },
        { paymentId: randomUUID() },
      ]) {
        const event = { ...who.fact, ...changed, providerEventId: randomUUID() };
        const { receipt } = await capture(who, event);
        expect(await route(who, receipt.id)).toBe('unmatched');
      }
      expect(await financialRows(who)).toEqual([]);
    } finally {
      await who.f.close();
    }
  });
  it.each([false, true])(
    'rejects a real token swapped onto another delivery (different endpoint: %s)',
    async (differentEndpoint) => {
      const who = await setup();
      try {
        const first = await who.webhook.post(who.fact),
          verified = await who.webhook.verify(first);
        const endpoint = differentEndpoint
          ? await createWebhookEndpoint(database.db, who.f.operator, {
              connectionId: who.f.connection.id,
              signingSecretId: who.f.signing.secretRef,
              signatureScheme: 'ensemus_hmac_sha256_v1',
            })
          : who.f.endpoint;
        const second = await who.webhook.post(
          { ...who.fact, providerEventId: randomUUID() },
          { endpoint },
        );
        await expect(who.webhook.apply({ ...verified, deliveryId: second.id })).rejects.toThrow();
        expect(await financialRows(who)).toEqual([]);
        expect(await who.webhook.apply(verified)).toBe('applied');
        const [receipt] = await withTenantTx(database.db, who.f.operatorContext, (tx) =>
          tx.select().from(paymentWebhookEvents),
        );
        expect(receipt?.sourceDeliveryId).toBe(first.id);
        expect(await route(who, receipt!.id)).toBe('applied');
      } finally {
        await who.f.close();
      }
    },
  );
  it('refuses a changed provider envelope after verification and never qualifies an invalid signature', async () => {
    const who = await setup();
    try {
      const bad = await who.webhook.post(
        { ...who.fact, providerEventId: randomUUID() },
        { signature: 'invalid-generated-signature' },
      );
      await expect(who.webhook.verify(bad)).rejects.toThrow('TEST_SIGNATURE_REFUSED');
      expect(await who.webhook.process(bad)).toBe('rejected');
      const source = await who.webhook.post(who.fact),
        verified = await who.webhook.verify(source);
      await expect(
        who.webhook.apply({ ...verified, providerEventId: randomUUID() }),
      ).rejects.toThrow();
      expect(await who.webhook.apply(verified)).toBe('applied');
      expect(await financialRows(who)).toEqual([]);
    } finally {
      await who.f.close();
    }
  });
  it('cannot consume another operator tenant native token even for its own genuinely signed delivery', async () => {
    const first = await setup();
    let second: Fixture | undefined;
    try {
      second = await setup();
      const a = await first.webhook.verify(await first.webhook.post(first.fact));
      const b = await second.webhook.verify(await second.webhook.post(second.fact));
      await expect(
        second.webhook.apply({ ...b, paymentVerificationToken: a.paymentVerificationToken }),
      ).rejects.toThrow();
      expect(await first.webhook.apply(a)).toBe('applied');
      expect(await second.webhook.apply(b)).toBe('applied');
      expect(await financialRows(first)).toEqual([]);
      expect(await financialRows(second)).toEqual([]);
    } finally {
      await second?.f.close();
      await first.f.close();
    }
  });
  it.each(['amount', 'merchant'] as const)(
    'rejects changed %s after native verification without burning the original proof',
    async (changed) => {
      const who = await setup();
      try {
        const delivery = await who.webhook.post(who.fact),
          verified = await who.webhook.verify(delivery);
        await expect(
          who.webhook.apply({
            ...verified,
            effects: verified.effects.map((effect) =>
              effect.kind === 'payment_event'
                ? changed === 'amount'
                  ? {
                      ...effect,
                      event: {
                        ...effect.event,
                        amountMicros: (BigInt(who.fact.amountMicros!) + 1n).toString(),
                      },
                    }
                  : { ...effect, accountNamespaceSha256: '0'.repeat(64) }
                : effect,
            ),
          }),
        ).rejects.toThrow();
        expect(
          await withTenantTx(database.db, who.f.operatorContext, (tx) =>
            tx.select().from(inboxEvents),
          ),
        ).toHaveLength(0);
        expect(await who.webhook.apply(verified)).toBe('applied');
      } finally {
        await who.f.close();
      }
    },
  );
  it('requires actual inbox+event+applied-delivery commit and restores all rows after effect rollback', async () => {
    const who = await setup();
    try {
      const delivery = await who.webhook.post(who.fact),
        verified = await who.webhook.verify(delivery);
      const before = await withTenantTx(database.db, who.f.operatorContext, (tx) =>
        tx.select({ eventId: outboxEvents.eventId }).from(outboxEvents),
      );
      await expect(
        who.webhook.apply(verified, {
          ...who.webhook.handlers,
          async recordPaymentEvent(...args) {
            await who.webhook.handlers.recordPaymentEvent(...args);
            throw new Error('TEST_AFTER_REAL_EVENT_WRITE');
          },
        }),
      ).rejects.toThrow('TEST_AFTER_REAL_EVENT_WRITE');
      const state = await withTenantTx(database.db, who.f.operatorContext, async (tx) => ({
        inbox: await tx.select().from(inboxEvents),
        events: await tx.select().from(paymentWebhookEvents),
        delivery: await tx
          .select({ state: webhookDeliveries.state, body: webhookDeliveries.body })
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, delivery.id)),
        outbox: await tx.select({ eventId: outboxEvents.eventId }).from(outboxEvents),
      }));
      expect(state.inbox).toEqual([]);
      expect(state.events).toEqual([]);
      expect(state.delivery[0]?.state).toBe('received');
      expect(state.delivery[0]?.body).not.toBeNull();
      expect(state.outbox).toEqual(before);
      expect(await who.webhook.apply(verified)).toBe('applied');
      expect(await who.webhook.apply(verified)).toBe('applied'); // Already-finished source; no second token consume.
      expect(
        await withTenantTx(database.db, who.f.operatorContext, (tx) =>
          tx.select().from(paymentWebhookEvents),
        ),
      ).toHaveLength(1);
    } finally {
      await who.f.close();
    }
  });
  it('a successful empty payment handler cannot commit an orphan native inbox witness', async () => {
    const who = await setup();
    try {
      const delivery = await who.webhook.post(who.fact),
        verified = await who.webhook.verify(delivery);
      await expect(
        who.webhook.apply(verified, {
          ...who.webhook.handlers,
          recordPaymentEvent: async () => undefined,
        }),
      ).rejects.toThrow();
      expect(await who.webhook.apply(verified)).toBe('applied');
    } finally {
      await who.f.close();
    }
  });
  it('tenant settlement committed before operator acknowledgement replays the original proof exactly once', async () => {
    const who = await setup();
    try {
      const { receipt } = await capture(who);
      expect(
        await withVerifiedPaymentEventTx(
          database.db,
          who.f.operatorContext,
          receipt.id,
          (tx, scope) =>
            applyPaymentFactInTx(tx, scope.context, who.fact, paymentAgents, scope.proof),
        ),
      ).toBe('applied');
      expect(await route(who, receipt.id)).toBe('already_done');
      expect(await route(who, receipt.id)).toBe('already_done');
      expect((await getInvoice(database.db, who.f.who.owner, who.f.who.invoice.id)).status).toBe(
        'paid',
      );
      expect(await financialRows(who)).toHaveLength(1);
      await expect(
        routePaymentEvent(
          database.db,
          who.f.who.service,
          { paymentWebhookEventId: receipt.id },
          who.binding,
          paymentAgents,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await who.f.close();
    }
  });
  it('rolls back a tenant financial write and can replay its genuine stored source', async () => {
    const who = await setup();
    try {
      const { receipt } = await capture(who);
      await expect(
        withVerifiedPaymentEventTx(
          database.db,
          who.f.operatorContext,
          receipt.id,
          async (tx, scope) => {
            expect(
              await applyPaymentFactInTx(tx, scope.context, who.fact, paymentAgents, scope.proof),
            ).toBe('applied');
            throw new Error('TEST_AFTER_REAL_TENANT_SETTLEMENT');
          },
        ),
      ).rejects.toThrow('TEST_AFTER_REAL_TENANT_SETTLEMENT');
      expect(await financialRows(who)).toEqual([]);
      expect((await getInvoice(database.db, who.f.who.owner, who.f.who.invoice.id)).status).toBe(
        'open',
      );
      expect(await route(who, receipt.id)).toBe('applied');
    } finally {
      await who.f.close();
    }
  });
  it('keeps the same provider event ID separate for two genuinely observed merchants', async () => {
    const first = await setup();
    let second: Fixture | undefined;
    try {
      second = await setup({ operator: first.f.operator });
      const eventId = randomUUID();
      const a = await capture(first, { ...first.fact, providerEventId: eventId });
      const b = await capture(second, { ...second.fact, providerEventId: eventId });
      expect(a.receipt.accountNamespaceSha256).not.toBe(b.receipt.accountNamespaceSha256);
      expect(a.receipt.id).not.toBe(b.receipt.id);
      expect(await route(first, a.receipt.id)).toBe('applied');
      expect(await route(second, b.receipt.id)).toBe('applied');
      expect(await financialRows(first)).toHaveLength(1);
      expect(await financialRows(second)).toHaveLength(1);
    } finally {
      await second?.f.close();
      await first.f.close();
    }
  });
  it('endpoint rotation and API-version replacement retain original signed receipts without duplicate settlement', async () => {
    const who = await setup();
    try {
      const first = await capture(who);
      expect(await route(who, first.receipt.id)).toBe('applied');
      const rotated = await createWebhookEndpoint(database.db, who.f.operator, {
        connectionId: who.f.connection.id,
        signingSecretId: who.f.signing.secretRef,
        signatureScheme: 'ensemus_hmac_sha256_v1',
      });
      await who.webhook.qualifyEndpoint(who.q.binding.id, rotated.endpointId);
      // Actual API version replacement is deliberately after endpoint qualification; only old signed receipt capture survives.
      await withTenantTx(database.db, who.f.operator, (tx) =>
        tx
          .update(connections)
          .set({ version: who.f.connection.version + 1 })
          .where(eq(connections.id, who.f.connection.id)),
      );
      const before = who.f.server.requests.length;
      const replay = await capture(who, who.fact, rotated);
      expect(replay.receipt.id).toBe(first.receipt.id);
      expect(await route(who, replay.receipt.id)).toBe('already_done');
      expect(await financialRows(who)).toHaveLength(1);
      expect(who.f.server.requests).toHaveLength(before);
      const changed = await who.webhook.post(
        { ...who.fact, amountMicros: '1' },
        { endpoint: rotated },
      );
      await expect(who.webhook.process(changed)).rejects.toThrow();
      expect(await financialRows(who)).toHaveLength(1);
    } finally {
      await who.f.close();
    }
  });
  it('API credential replacement cannot dispatch the original binding or discard an original signed ACK', async () => {
    const who = await setup();
    try {
      const replacement = await storeSecret(database.db, who.f.operator, {
        publicKeyPem: secret('sealing_public_key.pem'),
        purpose: SECRET_PURPOSE_PAYMENT_PROCESSOR,
        plaintext: randomUUID(),
      });
      await withTenantTx(database.db, who.f.operator, (tx) =>
        tx
          .update(connections)
          .set({
            credentialSecretId: replacement.secretRef,
            version: who.f.connection.version + 1,
          })
          .where(eq(connections.id, who.f.connection.id)),
      );
      await who.f.broker.revoke(who.f.operator.organizationId, who.f.credential.secretRef);
      const before = who.f.server.requests.length;
      await expect(who.f.refresh()).rejects.toSatisfy(
        (error: unknown) => pgCode(error) === 'EN850',
      );
      expect(who.f.server.requests).toHaveLength(before);
      const captured = await capture(who);
      expect(captured.receipt.sourceApiSecretId).toBe(who.f.credential.secretRef);
      expect(captured.receipt.sourceConnectionVersion).toBe(BigInt(who.f.connection.version));
      expect(await route(who, captured.receipt.id)).toBe('applied');
      expect(await route(who, captured.receipt.id)).toBe('already_done');
      expect(await financialRows(who)).toHaveLength(1);
      expect(who.f.server.requests).toHaveLength(before);
    } finally {
      await who.f.close();
    }
  });
  it('fresh signing revocation refuses unconsumed proofs while already committed receipts remain durable', async () => {
    const who = await setup();
    try {
      const committed = await capture(who);
      const source = await who.webhook.post({ ...who.fact, providerEventId: randomUUID() });
      const verified = await who.webhook.verify(source);
      await who.f.broker.revoke(who.f.operator.organizationId, who.f.signing.secretRef);
      await expect(who.webhook.apply(verified)).rejects.toThrow();
      expect(await route(who, committed.receipt.id)).toBe('applied');
      expect(await financialRows(who)).toHaveLength(1);
      expect(
        await withTenantTx(database.db, who.f.operatorContext, (tx) =>
          tx.select().from(paymentWebhookEvents),
        ),
      ).toHaveLength(1);
    } finally {
      await who.f.close();
    }
  });
  it('retains signed unmatched events and refund/dispute flags without reversing a paid invoice', async () => {
    const who = await setup();
    try {
      const unmatched = await capture(who, {
        ...who.fact,
        providerEventId: randomUUID(),
        customerRefHash: hashCustomerRef('test_scripted', randomUUID()),
      });
      expect(await route(who, unmatched.receipt.id)).toBe('unmatched');
      expect(
        await listUnmatchedPaymentEvents(database.db, who.f.operatorContext, who.binding),
      ).toHaveLength(1);
      const paid = await capture(who);
      expect(await route(who, paid.receipt.id)).toBe('applied');
      for (const kind of ['payment_refunded', 'payment_disputed'] as const) {
        const event = await capture(who, { ...who.fact, providerEventId: randomUUID(), kind });
        expect(await route(who, event.receipt.id)).toBe('applied');
      }
      expect((await getInvoice(database.db, who.f.who.owner, who.f.who.invoice.id)).status).toBe(
        'paid',
      );
      expect(
        await readPaymentOutcome(database.db, who.f.who.service, {
          paymentId: who.f.payment.paymentId,
        }),
      ).toBe('succeeded');
    } finally {
      await who.f.close();
    }
  });
});
