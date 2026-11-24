// Hosted checkout providers (ADR-032 D4a). Each is a connector with a webhook in the deployment's own
// organization, so a provider's call comes down M3's path unchanged: stored by the web tier, verified in the
// connector worker, and only then read. A verified call becomes one `checkout_callback` effect.
import { CHECKOUT_CONNECTOR_PREFIX, type CheckoutProvider } from '@ensemus/domain/checkout';
import type { CheckoutSignatureScheme } from '@ensemus/domain/webhook';
import { MalformedWebhook, type Connector } from '../../index';
import { parseClickCall } from './click';
import { interpretPaddleNotification } from './paddle';
import { parsePaymeCall } from './payme';

export * from './click';
export * from './paddle';
export * from './payme';

export const CHECKOUT_SCHEMES: Readonly<Record<CheckoutProvider, CheckoutSignatureScheme>> = {
  paddle: 'paddle_signature_v1',
  payme: 'payme_basic_v1',
  click: 'click_md5_v1',
};

export type CheckoutConnectorConfig = { serviceId: string | null };

/**
 * The connector for one provider's inbound address. Its only setting is Click's service id, which every
 * Click call must name. It holds no credential: the endpoint's signing secret is the provider's key.
 */
export function createCheckoutConnector(
  provider: CheckoutProvider,
): Connector<CheckoutConnectorConfig> {
  return {
    manifest: {
      type: CHECKOUT_CONNECTOR_PREFIX + provider,
      version: '1',
      displayName: { paddle: 'Paddle checkout', payme: 'Payme checkout', click: 'Click checkout' }[
        provider
      ],
      capabilities: {
        actions: [],
        reconcile: 'none',
        nativeIdempotency: false,
        sync: null,
        aclMapping: false,
        webhooks: { scheme: CHECKOUT_SCHEMES[provider] },
        network: 'none',
      },
      credential: { required: false, purpose: 'webhook_signing' },
    },
    parseConfig(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('CHECKOUT_CONFIGURATION_INVALID');
      const keys = Object.keys(raw);
      if (provider !== 'click') {
        if (keys.length) throw new Error('CHECKOUT_CONFIGURATION_INVALID');
        return { serviceId: null };
      }
      const serviceId = (raw as Record<string, unknown>).serviceId;
      if (keys.length !== 1 || typeof serviceId !== 'string' || !/^[0-9]{1,20}$/.test(serviceId))
        throw new Error('CHECKOUT_CONFIGURATION_INVALID');
      return { serviceId };
    },
    webhooks: {
      interpret(context, webhook) {
        if (provider === 'payme') {
          const call = parsePaymeCall(webhook.body);
          // Authenticated but not a JSON-RPC call at all: the web tier answers Payme's invalid-request code
          // for a delivery refused here. A call for a method we do not offer still gets its own answer.
          if (call.method === 'invalid') throw new MalformedWebhook();
          return [{ kind: 'checkout_callback', callback: call }];
        }
        if (provider === 'click') {
          if (!context.config.serviceId) throw new MalformedWebhook();
          return [
            {
              kind: 'checkout_callback',
              callback: parseClickCall(webhook.body, context.config.serviceId),
            },
          ];
        }
        const fact = interpretPaddleNotification(webhook.body);
        if (fact && fact.eventId !== webhook.providerEventId) throw new MalformedWebhook();
        return fact ? [{ kind: 'checkout_callback', callback: fact }] : [];
      },
    },
  };
}
