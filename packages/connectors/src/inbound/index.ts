// Owned by the webhooks slice. See docs/06-delivery/m3-slices.md.
import type { Connector } from '../index';

export const INBOUND_CONNECTOR_TYPE = 'inbound_webhook';

export type InboundConfig = Record<string, never>;

/**
 * The generic signed callback: a customer's own system tells Ensemus something needs doing, in the
 * envelope `inboundWebhookEnvelopeSchema` describes. It needs no network and no credential. Its secret is
 * the endpoint's signing secret.
 */
export function createInboundConnector(): Connector<InboundConfig> {
  throw new Error('NOT_IMPLEMENTED');
}
