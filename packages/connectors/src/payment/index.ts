// Owned by the payments slice (BILL-01). Makes any PaymentProcessor a connector with a webhook, so a processor's
// callbacks arrive down M3's path (ADR-027 D4, ADR-032 D4): stored by the web tier, verified in the connector
// worker, deduped by the inbox, and only then read. No processor is registered anywhere until the owner chooses.
import type { PaymentProcessor } from '@ensemus/saas/payment';
import type { Connector } from '../index';

export const PAYMENT_CONNECTOR_PREFIX = 'payment_';
export const SECRET_PURPOSE_PAYMENT_PROCESSOR = 'connector.payment_processor';

/** Declares `network: 'egress_gateway'`, and `credential.required`. `interpret` answers `payment_event`. */
export function createPaymentConnector(_processor: PaymentProcessor): Connector<unknown> {
  throw new Error('NOT_IMPLEMENTED');
}
