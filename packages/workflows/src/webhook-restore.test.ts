// Generated HMAC + explicit SQL/broker control doubles. No actual role/provider/restore acceptance.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '@ensemus/database';
import type { StoredDelivery } from '@ensemus/application';
import { createPaymentConnector } from '@ensemus/connectors/payment';
import { createConnectorRegistry, signWebhook } from '@ensemus/connectors/runtime';
import type {
  PaymentEventFact,
  PaymentExecutionIdentity,
  PaymentProcessor,
} from '@ensemus/saas/payment';
import { webhookRequestDigest } from '@ensemus/domain/webhook';
import type { ConnectorActivityDeps } from './connector-deps';
import {
  createWebhookVerifier,
  isVerifiedPaymentWebhook,
  type VerifiedPaymentWebhook,
} from './webhook-activities';

vi.mock('@ensemus/database', async (original) => ({
  ...(await original<object>()),
  withTenantTx: async (_db: unknown, _context: unknown, use: (tx: unknown) => Promise<unknown>) =>
    use({
      select: () => ({ from: () => ({ where: async () => [{ config: {} }] }) }),
    }),
}));

describe('native webhook envelope generation snapshot', () => {
  it('never refresh-stamps the loaded envelope during the signature secret await', async () => {
    const generation = randomUUID(),
      replacement = randomUUID(),
      key = randomBytes(32);
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const event: PaymentEventFact = {
      processor: 'test_scripted',
      providerEventId: randomUUID(),
      kind: 'payment_succeeded',
      customerRefHash: 'a'.repeat(64),
      processorPaymentRef: null,
      paymentId: null,
      amountMicros: null,
      currency: null,
      occurredAtSeconds: timestampSeconds,
    };
    const identity: PaymentExecutionIdentity = {
      version: 'ensemus.payment-execution/v1',
      processor: 'test_scripted',
      adapterVersion: '1.0.0',
      environment: 'generated_test',
      merchantAccountSha256: 'b'.repeat(64),
      apiOrigins: ['https://generated.mcp.invalid'],
    };
    const body = Buffer.from(JSON.stringify({ event, identity }));
    const headers = {
      'content-type': 'application/json',
      'x-ensemus-event-id': event.providerEventId,
      'x-ensemus-timestamp': String(timestampSeconds),
      'x-ensemus-signature': signWebhook(key, {
        timestampSeconds,
        eventId: event.providerEventId,
        body,
      }),
    };
    const loaded: StoredDelivery = {
      id: randomUUID(),
      endpointId: randomUUID(),
      connectionId: randomUUID(),
      connectorType: 'payment_test_scripted',
      scheme: 'ensemus_hmac_sha256_v1',
      body,
      headers,
      sizeBytes: body.length,
      toleranceSeconds: 60,
      signingSecretId: randomUUID(),
      previousSigningSecretId: null,
      rowVersion: '123',
      restoreGeneration: generation,
      bodySha256: createHash('sha256').update(body).digest('hex'),
      requestDigest: webhookRequestDigest(body, headers),
    };
    const processor: PaymentProcessor = {
      manifest: {
        processor: 'test_scripted',
        version: '1.0.0',
        lookup: 'none',
        nativeIdempotency: true,
        webhookScheme: 'ensemus_hmac_sha256_v1',
      },
      createCustomer: async () => {
        throw new Error('TEST_NO_CUSTOMER');
      },
      charge: async () => {
        throw new Error('TEST_NO_CHARGE');
      },
      lookup: async () => {
        throw new Error('TEST_NO_LOOKUP');
      },
      interpretWebhook: () => null,
      interpretExecutionWebhook: (_id: string, bytes: Uint8Array) =>
        JSON.parse(Buffer.from(bytes).toString('utf8')) as {
          event: PaymentEventFact;
          identity: PaymentExecutionIdentity;
        },
    };
    const proofs: VerifiedPaymentWebhook[] = [];
    const deps: ConnectorActivityDeps = {
      database: {} as AppDatabase,
      registry: createConnectorRegistry([createPaymentConnector(processor)]),
      secrets: {
        async withSecret(_reference, use) {
          loaded.restoreGeneration = replacement;
          headers['x-ensemus-signature'] = 'changed-during-await';
          body.fill(0);
          await Promise.resolve();
          return use(key);
        },
        revoke: async () => {
          throw new Error('TEST_NO_REVOCATION');
        },
      },
      network: {
        openRelay: async () => {
          throw new Error('TEST_NO_NETWORK');
        },
      },
      attestPaymentWebhook: async (proof) => {
        proofs.push(proof);
        return { token: 'c'.repeat(64), expiresAt: new Date(Date.now() + 60000) };
      },
    };
    try {
      const result = await createWebhookVerifier(deps).verify(
        randomUUID(),
        loaded,
        timestampSeconds * 1000,
      );
      expect(result.ok).toBe(true);
      expect(proofs).toHaveLength(1);
      expect(isVerifiedPaymentWebhook(proofs[0])).toBe(true);
      expect(proofs[0]?.restoreGeneration).toBe(generation);
      expect(proofs[0]?.bodySha256).toBe(loaded.bodySha256);
      expect(loaded.restoreGeneration).toBe(replacement);
    } finally {
      key.fill(0);
    }
  });
});
