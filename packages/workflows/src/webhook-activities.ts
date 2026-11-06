// Owned by the webhooks slice (CONNECT-02). See docs/06-delivery/m3-slices.md and ADR-027 D4.
import type { ConnectorActivityDeps } from './connector-deps';
import type { WebhookDeliveryInput, WebhookDeliveryOutcome } from './schemas';

/** On the connector queue, because this opens a signing secret and reads what a stranger sent. */
export function createWebhookActivities(_deps: ConnectorActivityDeps) {
  return {
    /** Verifies, dedupes and applies one delivery. A retry finds it finished and does nothing. */
    async processWebhookDelivery(_input: WebhookDeliveryInput): Promise<WebhookDeliveryOutcome> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type WebhookActivities = ReturnType<typeof createWebhookActivities>;
