// Owned by the webhooks slice (CONNECT-02). See docs/06-delivery/m3-slices.md and ADR-027 D4. Deterministic
// workflow code: only @temporalio/workflow and types may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { WebhookDeliveryInput, WebhookDeliveryOutcome } from './schemas';

/** One stored delivery through verification. No event starts this until M3 lands. */
export async function webhookDeliveryWorkflow(
  _input: WebhookDeliveryInput,
): Promise<WebhookDeliveryOutcome> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
