import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFakePaymentProcessor } from '@ensemus/saas/testing';
import type { PaymentEventFact } from '@ensemus/saas/payment';
import { MalformedWebhook, type ConnectorContext } from '../index';
import { createPaymentConnector } from './index';

const processor = () =>
  createFakePaymentProcessor({
    lookup: 'none',
    onCharge: () => ({ outcome: 'not_sent', code: 'PROCESSOR_NOT_CONFIGURED', retryable: false }),
  });
const context: ConnectorContext = {
  organizationId: randomUUID(),
  connectionId: randomUUID(),
  config: {},
  signal: new AbortController().signal,
  credentials: {
    withCredential: async () => {
      throw new Error('unexpected credential');
    },
  },
  network: {
    openRelay: async () => {
      throw new Error('unexpected network');
    },
  },
};
describe('payment webhook connector', () => {
  it('declares the credential and gateway without tenant-selectable network settings', () => {
    const connector = createPaymentConnector(processor());
    expect(connector.manifest.capabilities.network).toBe('egress_gateway');
    expect(connector.manifest.credential).toEqual({
      required: true,
      purpose: 'connector.payment_processor',
    });
    expect(connector.parseConfig({})).toEqual({});
    for (const raw of [
      null,
      [],
      { url: 'https://test.invalid' },
      { host: 'test.invalid' },
      { password: 'canary' },
    ])
      expect(() => connector.parseConfig(raw)).toThrow('PAYMENT_CONFIGURATION_INVALID');
  });
  it('returns nothing for a well-formed event deliberately ignored by the adapter', () => {
    const connector = createPaymentConnector(processor());
    expect(
      connector.webhooks!.interpret(context, {
        providerEventId: randomUUID(),
        body: new Uint8Array(),
        signedAtSeconds: 0,
      }),
    ).toEqual([]);
  });
  it('translates known facts and sanitizes malformed provider content', () => {
    const providerEventId = randomUUID(),
      fact: PaymentEventFact = {
        processor: 'test_scripted',
        providerEventId,
        kind: 'payment_succeeded',
        customerRefHash: 'a'.repeat(64),
        processorPaymentRef: randomUUID(),
        paymentId: randomUUID(),
        amountMicros: '42',
        currency: 'XTS',
        occurredAtSeconds: 0,
      };
    const fake = createFakePaymentProcessor({
      lookup: 'none',
      onCharge: () => ({ outcome: 'not_sent', code: 'PROCESSOR_ERROR', retryable: false }),
      interpret: () => fact,
    });
    expect(
      createPaymentConnector(fake).webhooks!.interpret(context, {
        providerEventId,
        body: new Uint8Array(),
        signedAtSeconds: 0,
      }),
    ).toEqual([{ kind: 'payment_event', event: fact }]);
    const malformed = createFakePaymentProcessor({
      lookup: 'none',
      onCharge: () => ({ outcome: 'not_sent', code: 'PROCESSOR_ERROR', retryable: false }),
      interpret: () => {
        throw new Error('private provider canary');
      },
    });
    expect(() =>
      createPaymentConnector(malformed).webhooks!.interpret(context, {
        providerEventId,
        body: new Uint8Array(),
        signedAtSeconds: 0,
      }),
    ).toThrow(MalformedWebhook);
    expect(() =>
      createPaymentConnector(fake).webhooks!.interpret(context, {
        providerEventId: randomUUID(),
        body: new Uint8Array(),
        signedAtSeconds: 0,
      }),
    ).toThrow(MalformedWebhook);
  });
});
