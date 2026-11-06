// One stored delivery through verification (ADR-027 D4). Deterministic workflow code: only
// @temporalio/workflow, types and the queue names may be imported here, and only IDs cross into it.
import { proxyActivities } from '@temporalio/workflow';
import { CONNECTOR_TASK_QUEUE } from './constants';
import type { WebhookActivities } from './webhook-activities';
import type { WebhookDeliveryInput, WebhookDeliveryOutcome } from './schemas';

// A connector worker that is down holds these, and nothing is lost, for as long as a body is kept. After
// that upkeep has ended the delivery, so a late Activity finds nothing left to do. The Activity is safe
// to repeat: it reads its state from PostgreSQL each time.
const { processWebhookDelivery } = proxyActivities<WebhookActivities>({
  taskQueue: CONNECTOR_TASK_QUEUE,
  startToCloseTimeout: '1 minute',
  scheduleToCloseTimeout: '24 hours',
  retry: { initialInterval: '5 seconds', backoffCoefficient: 2, maximumInterval: '5 minutes' },
});

/** Everything is in the Activity. This only gives it a durable place to be retried from. */
export async function webhookDeliveryWorkflow(
  input: WebhookDeliveryInput,
): Promise<WebhookDeliveryOutcome> {
  return processWebhookDelivery(input);
}
