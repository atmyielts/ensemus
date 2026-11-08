// Owned by the payments slice (BILL-01). Makes any PaymentProcessor a connector with a webhook, so a processor's
// callbacks arrive down M3's path (ADR-027 D4, ADR-032 D4): stored by the web tier, verified in the connector
// worker, deduped by the inbox, and only then read. No processor is registered anywhere until the owner chooses.
import { paymentExecutionIdentity, type PaymentProcessor } from '@ensemus/saas/payment';
import type { Connector } from '../index';
import { MalformedWebhook } from '../index';
import { PAYMENT_EVENT_KINDS, SIGNATURE_SCHEMES } from '@ensemus/domain/webhook';
export {
  runCharge, runPaymentLookup, runBoundCharge, runBoundCustomerRegistration, runBoundPaymentLookup, identifyPaymentExecution, isVerifiedPaymentExecutionIdentity,
  type VerifiedPaymentExecutionIdentity,
} from './runtime';
export { createPaymentHttpGateway, isPaymentTransportReceipt, type PaymentTransportReceipt } from './gateway';

export const PAYMENT_CONNECTOR_PREFIX = 'payment_';
export const SECRET_PURPOSE_PAYMENT_PROCESSOR = 'connector.payment_processor';

/** Declares `network: 'egress_gateway'`, and `credential.required`. `interpret` answers `payment_event`. */
export function createPaymentConnector(processor: PaymentProcessor): Connector<unknown> {
  const info = processor.manifest;
  const scheme = SIGNATURE_SCHEMES.find((value) => value === info.webhookScheme);
  if (
    !scheme ||
    !info.nativeIdempotency ||
    !/^[a-z][a-z0-9_]{1,55}$/.test(info.processor) ||
    !/^\d+\.\d+\.\d+$/.test(info.version)
  )
    throw new Error('PAYMENT_PROCESSOR_MANIFEST_INVALID');
  return {
    manifest: {
      type: PAYMENT_CONNECTOR_PREFIX + info.processor,
      version: info.version,
      displayName: 'Payment processor',
      capabilities: {
        actions: [],
        reconcile: 'none',
        nativeIdempotency: true,
        sync: null,
        aclMapping: false,
        webhooks: { scheme },
        network: 'egress_gateway',
      },
      credential: { required: true, purpose: SECRET_PURPOSE_PAYMENT_PROCESSOR },
    },
    parseConfig(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length)
        throw new Error('PAYMENT_CONFIGURATION_INVALID');
      return {};
    },
    webhooks: {
      interpret(_context, webhook) {
        try {
          const observed = processor.interpretExecutionWebhook?.(
            webhook.providerEventId, webhook.body, webhook.signedAtSeconds,
          );
          const identity = observed ? paymentExecutionIdentity(observed.identity, info) : null;
          if (observed && !identity) throw new MalformedWebhook();
          const event = observed?.event ?? processor.interpretWebhook(
            webhook.providerEventId,
            webhook.body,
            webhook.signedAtSeconds,
          );
          if (event === null) return [];
          if (
            event.processor !== info.processor ||
            event.providerEventId !== webhook.providerEventId ||
            !PAYMENT_EVENT_KINDS.includes(event.kind) ||
            !/^[0-9a-f]{64}$/.test(event.customerRefHash) ||
            !Number.isSafeInteger(event.occurredAtSeconds) ||
            event.occurredAtSeconds < 0 ||
            (event.amountMicros !== null && !/^-?(0|[1-9][0-9]{0,18})$/.test(event.amountMicros)) ||
            (event.currency !== null && !/^[A-Z]{3}$/.test(event.currency)) ||
            (event.paymentId !== null &&
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                event.paymentId,
              )) ||
            (event.processorPaymentRef !== null &&
              (typeof event.processorPaymentRef !== 'string' ||
                event.processorPaymentRef.length < 1 ||
                event.processorPaymentRef.length > 256 ||
                /[\r\n\0]/.test(event.processorPaymentRef)))
          )
            throw new MalformedWebhook();
          return [{ kind: 'payment_event', event,
            ...(identity ? { executionIdentitySha256: identity.sha256 } : {}),
          }];
        } catch {
          throw new MalformedWebhook();
        }
      },
    },
  };
}
