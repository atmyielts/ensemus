// Generated identities/keys and a private fake processor, actual app/secrets roles and real signature
// broker. These cases prove inbox/receipt transaction composition, never external payment delivery.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyVerifiedDelivery,
  createWebhookEndpoint,
  ingestWebhookDelivery,
  type WebhookEffectHandlers,
} from '@ensemus/application';
import { routePaymentEvent } from '@ensemus/application/saas/payment-events';
import {
  domainEvents,
  inboxEvents,
  openAppDatabase,
  outboxEvents,
  paymentWebhookEvents,
  webhookDeliveries,
  withTenantTx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import {
  createPaymentConnector,
  SECRET_PURPOSE_PAYMENT_PROCESSOR,
} from '@ensemus/connectors/payment';
import { createConnectorRegistry, signWebhook } from '@ensemus/connectors/runtime';
import { createFakePaymentProcessor } from '@ensemus/saas/testing';
import type { PaymentEventFact } from '@ensemus/saas/payment';
import { PAYMENT_EVENT_RECEIVED } from '@ensemus/saas/events';
import { SECRET_PURPOSE_WEBHOOK_SIGNING } from '@ensemus/domain/connector';
import { webhookInboxConsumer, webhookInboxEventId } from '@ensemus/domain/webhook';
import { FileKeyProvider, SecretBroker } from '@ensemus/secrets/broker';
import { storeSecret } from '@ensemus/secrets/seal';
import {
  createWebhookActivities,
  createWebhookEffectHandlers,
} from '@ensemus/workflows/webhook-activities';
import type { ConnectorActivityDeps } from '@ensemus/workflows/connector-deps';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { seedConnection } from '../helpers/integrations';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { secret, urls } from '../helpers/stack';

describe('verified processor callbacks commit the real M8 receipt with the M3 inbox', () => {
  const app = openAppDatabase(urls.app()),
    secretsDb = openSecretsDatabase(urls.secrets());
  let people: Awaited<ReturnType<typeof makeTwoTenants>>;
  beforeAll(async () => {
    people = await makeTwoTenants(app.db);
    await proveSecondFactor(people.a.owner);
    await proveSecondFactor(people.b.owner);
  });
  afterAll(async () => {
    await secretsDb.close();
    await app.close();
  });

  async function fixture(configured = true) {
    const owner = people.a.owner.context,
      service = createServiceContext(owner.organizationId),
      key = randomBytes(32).toString('base64url');
    const baselineEvents = await withTenantTx(app.db, service, (tx) =>
      tx
        .select({ id: domainEvents.id })
        .from(domainEvents)
        .where(eq(domainEvents.eventType, PAYMENT_EVENT_RECEIVED)),
    );
    const seal = (purpose: string, plaintext: string) =>
      storeSecret(app.db, owner, {
        purpose,
        plaintext,
        publicKeyPem: secret('sealing_public_key.pem'),
      });
    const credential = await seal(
      SECRET_PURPOSE_PAYMENT_PROCESSOR,
      randomBytes(32).toString('base64url'),
    );
    const signing = await seal(SECRET_PURPOSE_WEBHOOK_SIGNING, key);
    const connectionId = await seedConnection(app.db, owner, {
      connectorType: 'payment_test_scripted',
      credentialSecretId: credential.secretRef,
      config: {},
    });
    const endpoint = await createWebhookEndpoint(app.db, owner, {
      connectionId,
      signingSecretId: signing.secretRef,
      signatureScheme: 'ensemus_hmac_sha256_v1',
    });
    const processor = createFakePaymentProcessor({
      lookup: 'authoritative',
      onCharge: () => {
        throw new Error('TEST_CALLBACK_MUST_NOT_CHARGE');
      },
      interpret: (_eventId, body) =>
        JSON.parse(Buffer.from(body).toString('utf8')) as PaymentEventFact,
    });
    const deps: ConnectorActivityDeps = {
      database: app.db,
      registry: createConnectorRegistry([createPaymentConnector(processor)]),
      secrets: new SecretBroker(
        secretsDb.db,
        new FileKeyProvider([secret('sealing_private_key.pem')]),
      ),
      network: {
        openRelay: async () => {
          throw new Error('TEST_CALLBACK_MUST_NOT_USE_NETWORK');
        },
      },
      ...(configured
        ? {
            paymentWebhook: {
              billingOrganizationId: owner.organizationId,
              billingConnectionId: connectionId,
              processor: 'test_scripted',
            },
          }
        : {}),
    };
    const fact: PaymentEventFact = {
      processor: 'test_scripted',
      providerEventId: randomUUID(),
      kind: 'payment_succeeded',
      customerRefHash: randomBytes(32).toString('hex'),
      processorPaymentRef: null,
      paymentId: null,
      amountMicros: null,
      currency: null,
      occurredAtSeconds: Math.floor(Date.now() / 1000),
    };
    async function post(event: PaymentEventFact = fact, padding = '') {
      const body = Buffer.from(JSON.stringify(event) + padding),
        timestampSeconds = Math.floor(Date.now() / 1000);
      expect(
        await ingestWebhookDelivery(app.db, {
          token: endpoint.token,
          body,
          headers: {
            'content-type': 'application/json',
            'x-ensemus-event-id': event.providerEventId,
            'x-ensemus-timestamp': String(timestampSeconds),
            'x-ensemus-signature': signWebhook(Buffer.from(key), {
              timestampSeconds,
              eventId: event.providerEventId,
              body,
            }),
          },
        }),
      ).toBe('accepted');
      const rows = await withTenantTx(app.db, service, (tx) =>
        tx
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.endpointId, endpoint.endpointId)),
      );
      const row = rows.find((value) => value.state === 'received');
      if (!row) throw new Error('TEST_EXPECTED_STORED_DELIVERY');
      return row.id;
    }
    async function counts(eventId = fact.providerEventId) {
      return withTenantTx(app.db, service, async (tx) => {
        const inbox = await tx
          .select()
          .from(inboxEvents)
          .where(
            and(
              eq(inboxEvents.consumerId, webhookInboxConsumer(endpoint.endpointId)),
              eq(inboxEvents.eventId, webhookInboxEventId(endpoint.endpointId, eventId)),
            ),
          );
        const receipts = await tx
          .select()
          .from(paymentWebhookEvents)
          .where(eq(paymentWebhookEvents.providerEventId, eventId));
        const events = await tx
          .select({ id: domainEvents.id, payload: domainEvents.payload })
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.eventType, PAYMENT_EVENT_RECEIVED),
              baselineEvents.length
                ? notInArray(
                    domainEvents.id,
                    baselineEvents.map((value) => value.id),
                  )
                : undefined,
            ),
          );
        const outbox = events.length
          ? await tx
              .select()
              .from(outboxEvents)
              .where(
                inArray(
                  outboxEvents.eventId,
                  events.map((value) => value.id),
                ),
              )
          : [];
        return {
          inbox: inbox.length,
          receipts: receipts.length,
          events: events.length,
          outbox: outbox.length,
          receipt: receipts[0],
        };
      });
    }
    return { owner, service, connectionId, endpoint, deps, fact, post, counts, processor };
  }

  it('records once, emits one routing outbox event, and never mistakes a payment for sync', async () => {
    const f = await fixture(),
      deliveryId = await f.post(),
      activities = createWebhookActivities(f.deps);
    expect(
      await activities.processWebhookDelivery({
        organizationId: f.owner.organizationId,
        deliveryId,
      }),
    ).toBe('applied');
    expect(
      await activities.processWebhookDelivery({
        organizationId: f.owner.organizationId,
        deliveryId,
      }),
    ).toBe('skipped');
    const repeated = await f.post(f.fact, ' ');
    expect(
      await activities.processWebhookDelivery({
        organizationId: f.owner.organizationId,
        deliveryId: repeated,
      }),
    ).toBe('duplicate');
    expect(await f.counts()).toMatchObject({ inbox: 1, receipts: 1, events: 1, outbox: 1 });
    expect(f.processor.requests).toEqual([]);
    const sync = await withTenantTx(app.db, f.service, (tx) =>
      tx
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.aggregateId, f.connectionId),
            eq(domainEvents.eventType, 'connector.sync_requested'),
          ),
        ),
    );
    expect(sync).toEqual([]);
    const rows = await withTenantTx(app.db, f.service, (tx) =>
      tx
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.endpointId, f.endpoint.endpointId)),
    );
    expect(
      rows.every((row) => row.body === null && row.headers === null && row.processedAt !== null),
    ).toBe(true);
  });

  it.each(['missing', 'connection', 'organization', 'processor'] as const)(
    'refuses %s deployment binding without consuming the inbox key',
    async (kind) => {
      const f = await fixture(kind !== 'missing');
      if (f.deps.paymentWebhook) {
        if (kind === 'connection') f.deps.paymentWebhook.billingConnectionId = randomUUID();
        if (kind === 'organization')
          f.deps.paymentWebhook.billingOrganizationId = people.b.organizationId;
        if (kind === 'processor') f.deps.paymentWebhook.processor = 'different_processor';
      }
      const deliveryId = await f.post();
      expect(
        await createWebhookActivities(f.deps).processWebhookDelivery({
          organizationId: f.owner.organizationId,
          deliveryId,
        }),
      ).toBe('rejected');
      expect(await f.counts()).toMatchObject({ inbox: 0, receipts: 0, events: 0, outbox: 0 });
    },
  );

  it('refuses a foreign tenant delivery lookup even with a real processor callback', async () => {
    const f = await fixture(),
      deliveryId = await f.post();
    expect(
      await createWebhookActivities(f.deps).processWebhookDelivery({
        organizationId: people.b.organizationId,
        deliveryId,
      }),
    ).toBe('skipped');
    expect(await f.counts()).toMatchObject({ inbox: 0, receipts: 0 });
  });

  it('rejects effect/envelope event ID mismatch in dispatch before any real effect or sync', async () => {
    const f = await fixture(),
      deliveryId = await f.post();
    expect(
      await applyVerifiedDelivery(
        app.db,
        f.service,
        {
          deliveryId,
          providerEventId: f.fact.providerEventId,
          effects: [{ kind: 'payment_event', event: { ...f.fact, providerEventId: randomUUID() } }],
        },
        createWebhookEffectHandlers(undefined, f.deps.paymentWebhook),
      ),
    ).toBe('rejected');
    expect(await f.counts()).toMatchObject({ inbox: 0, receipts: 0, events: 0, outbox: 0 });
  });

  it('rolls inbox, actual payment receipt and outbox back together and safely retries the original', async () => {
    const f = await fixture(),
      deliveryId = await f.post(),
      real = createWebhookEffectHandlers(undefined, f.deps.paymentWebhook);
    const failing: WebhookEffectHandlers = {
      ...real,
      async recordPaymentEvent(...args) {
        await real.recordPaymentEvent(...args);
        throw new Error('TEST_AFTER_REAL_RECEIPT');
      },
    };
    await expect(
      createWebhookActivities(f.deps, failing).processWebhookDelivery({
        organizationId: f.owner.organizationId,
        deliveryId,
      }),
    ).rejects.toThrow('TEST_AFTER_REAL_RECEIPT');
    expect(await f.counts()).toMatchObject({ inbox: 0, receipts: 0, events: 0, outbox: 0 });
    expect(
      await createWebhookActivities(f.deps).processWebhookDelivery({
        organizationId: f.owner.organizationId,
        deliveryId,
      }),
    ).toBe('applied');
    expect(await f.counts()).toMatchObject({ inbox: 1, receipts: 1, events: 1, outbox: 1 });
  });

  it('uses the actual stored endpoint envelope rather than a caller-provided connection', async () => {
    const f = await fixture();
    await expect(
      withTenantTx(app.db, f.service, (tx) =>
        createWebhookEffectHandlers(undefined, f.deps.paymentWebhook).recordPaymentEvent(
          tx,
          f.service,
          { kind: 'payment_event', event: f.fact },
          {
            endpointId: f.endpoint.endpointId,
            connectionId: randomUUID(),
            providerEventId: f.fact.providerEventId,
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await f.counts()).toMatchObject({ inbox: 0, receipts: 0 });
  });

  it('retains genuine unknown-customer events as unmatched instead of trusting a payload tenant claim', async () => {
    const f = await fixture(),
      event = { ...f.fact, organizationId: people.b.organizationId },
      deliveryId = await f.post(event);
    expect(
      await createWebhookActivities(f.deps).processWebhookDelivery({
        organizationId: f.owner.organizationId,
        deliveryId,
      }),
    ).toBe('applied');
    const receipt = (await f.counts()).receipt!;
    expect(receipt.organizationId).toBe(f.owner.organizationId);
    expect(
      await routePaymentEvent(
        app.db,
        f.service,
        { paymentWebhookEventId: receipt.id },
        { billingOrganizationId: f.owner.organizationId },
      ),
    ).toBe('unmatched');
    const foreign = await withTenantTx(
      app.db,
      createServiceContext(people.b.organizationId),
      (tx) => tx.select().from(paymentWebhookEvents),
    );
    expect(foreign).toEqual([]);
    expect(f.processor.requests).toEqual([]);
  });
});
