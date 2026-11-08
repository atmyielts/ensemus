// Test-only signed fixture. Every token comes from the real native verifier/secrets broker; none is seeded.
import { and, eq } from 'drizzle-orm';
import { webhookDeliveries, withTenantTx, type AppDatabase } from '@ensemus/database';
import {
  applyVerifiedDelivery,
  ingestWebhookDelivery,
  loadStoredDelivery,
  type WebhookEffectHandlers,
} from '@ensemus/application';
import { qualifyPaymentWebhookExecution } from '@ensemus/application/saas/payment-execution';
import { createConnectorRegistry, signWebhook } from '@ensemus/connectors/runtime';
import { webhookRequestDigest } from '@ensemus/domain/webhook';
import type { PaymentEventFact, PaymentExecutionIdentity } from '@ensemus/saas/payment';
import {
  createWebhookActivities,
  createWebhookEffectHandlers,
  createWebhookVerifier,
} from '@ensemus/workflows/webhook-activities';
import type { nativePaymentFixture } from './native-payment';

export function nativePaymentWebhook(
  database: AppDatabase,
  f: Awaited<ReturnType<typeof nativePaymentFixture>>,
) {
  const deps = {
    database,
    registry: createConnectorRegistry([f.connector]),
    secrets: f.broker,
    attestPaymentWebhook: f.attestWebhook,
    network: {
      openRelay: async (): Promise<never> => {
        throw new Error('TEST_WEBHOOK_HAS_NO_NETWORK');
      },
    },
    paymentWebhook: {
      billingOrganizationId: f.operator.organizationId,
      billingConnectionId: f.connection.id,
      processor: f.processor.manifest.processor,
    },
  };
  const handlers = createWebhookEffectHandlers(undefined, deps.paymentWebhook);
  const verifier = createWebhookVerifier(deps);
  async function post(
    event: PaymentEventFact,
    options: {
      endpoint?: typeof f.endpoint;
      identity?: PaymentExecutionIdentity;
      signature?: string;
    } = {},
  ) {
    const endpoint = options.endpoint ?? f.endpoint;
    const body = Buffer.from(
      JSON.stringify({ event, identity: options.identity ?? f.currentIdentity }),
    );
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const headers = {
      'content-type': 'application/json',
      'x-ensemus-event-id': event.providerEventId,
      'x-ensemus-timestamp': String(timestampSeconds),
      'x-ensemus-signature':
        options.signature ??
        signWebhook(Buffer.from(f.signingKey), {
          timestampSeconds,
          eventId: event.providerEventId,
          body,
        }),
    };
    if (
      (await ingestWebhookDelivery(database, { token: endpoint.token, body, headers })) !==
      'accepted'
    )
      throw new Error('TEST_EXPECTED_ACTUAL_WEBHOOK_INGRESS');
    const [row] = await withTenantTx(database, f.operatorContext, (tx) =>
      tx
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.endpointId, endpoint.endpointId),
            eq(webhookDeliveries.requestDigest, webhookRequestDigest(body, headers)),
          ),
        ),
    );
    if (!row) throw new Error('TEST_EXPECTED_ACTUAL_STORED_DELIVERY');
    return row;
  }
  async function verify(delivery: { id: string }) {
    const stored = await loadStoredDelivery(database, f.operatorContext, {
      deliveryId: delivery.id,
    });
    if (!stored) throw new Error('TEST_EXPECTED_LIVE_DELIVERY');
    const verdict = await verifier.verify(f.operator.organizationId, stored, stored.receivedAtMs);
    if (!verdict.ok) throw new Error(`TEST_SIGNATURE_REFUSED:${verdict.code}`);
    if (!verdict.paymentVerificationToken) throw new Error('TEST_EXPECTED_NATIVE_ATTESTATION');
    return {
      deliveryId: delivery.id,
      providerEventId: verdict.providerEventId,
      effects: verdict.effects,
      paymentVerificationToken: verdict.paymentVerificationToken,
    };
  }
  return {
    post,
    verify,
    handlers,
    qualifyEndpoint: (bindingId: string, endpointId = f.endpoint.endpointId) =>
      qualifyPaymentWebhookExecution(database, f.operatorContext, {
        originOrganizationId: f.who.owner.organizationId,
        paymentId: f.payment.paymentId,
        bindingId,
        endpointId,
      }),
    apply: (
      input: Awaited<ReturnType<typeof verify>>,
      effectHandlers: WebhookEffectHandlers = handlers,
    ) => applyVerifiedDelivery(database, f.operatorContext, input, effectHandlers),
    process: (delivery: { id: string }) =>
      createWebhookActivities(deps).processWebhookDelivery({
        organizationId: f.operator.organizationId,
        deliveryId: delivery.id,
      }),
  };
}
