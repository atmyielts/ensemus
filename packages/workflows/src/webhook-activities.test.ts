import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createServiceContext } from '@ensemus/database/service';
import type { Tx } from '@ensemus/database';
import type { WebhookEffectHandlers } from '@ensemus/application';
import { createWebhookEffectHandlers } from './webhook-activities';

const context = createServiceContext(randomUUID()),
  connectionId = randomUUID();
const settings = {
  billingOrganizationId: context.organizationId,
  billingConnectionId: connectionId,
  processor: 'test_scripted',
};
const source = { deliveryId: randomUUID(), endpointId: randomUUID(), connectionId, providerEventId: randomUUID() };
const effect: Parameters<WebhookEffectHandlers['recordPaymentEvent']>[2] = {
  kind: 'payment_event',
  event: {
    processor: 'test_scripted',
    providerEventId: source.providerEventId,
    kind: 'payment_succeeded',
    customerRefHash: 'a'.repeat(64),
    processorPaymentRef: null,
    paymentId: null,
    amountMicros: null,
    currency: null,
    occurredAtSeconds: 1700000000,
  },
};

describe('payment webhook binding refuses before body/record access', () => {
  it.each([
    undefined,
    { ...settings, billingOrganizationId: null },
    { ...settings, billingConnectionId: null },
    { ...settings, processor: null },
    { ...settings, billingOrganizationId: randomUUID() },
    { ...settings, billingConnectionId: randomUUID() },
    { ...settings, processor: 'another_processor' },
  ])('does not guess a missing or different trusted binding %j', async (binding) => {
    const select = vi.fn(() => {
      throw new Error('TEST_SQL_MUST_NOT_RUN');
    });
    const tx = { select } as unknown as Tx;
    await expect(
      createWebhookEffectHandlers(undefined, binding).recordPaymentEvent(
        tx,
        context,
        effect,
        source,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(select).not.toHaveBeenCalled();
  });
  it('refuses an event identifier that differs from the actual stored envelope', async () => {
    const select = vi.fn(() => {
      throw new Error('TEST_SQL_MUST_NOT_RUN');
    });
    await expect(
      createWebhookEffectHandlers(undefined, settings).recordPaymentEvent(
        { select } as unknown as Tx,
        context,
        { ...effect, event: { ...effect.event, providerEventId: randomUUID() } },
        source,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(select).not.toHaveBeenCalled();
  });
});
