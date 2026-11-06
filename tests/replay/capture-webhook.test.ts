// Records webhookDeliveryWorkflow's paths from a real Temporal, with stub Activities and the corpus's own
// key. Skipped unless ENSEMUS_CAPTURE_REPLAY=1 (see tests/replay/capture-support.ts). A recorded history
// is never rewritten, because it is what proves later code still reads work already in flight.
import { randomUUID } from 'node:crypto';
import { ApplicationFailure } from '@temporalio/common';
import { describe, it } from 'vitest';
import { CONNECTOR_TASK_QUEUE } from '@ensemus/workflows/constants';
import type { WebhookDeliveryOutcome } from '@ensemus/workflows/schemas';
import { capturing, withCaptureWorkers } from './capture-support';

const ORGANIZATION = '00000000-0000-4000-8000-0000000000aa';

describe.skipIf(!capturing)('capture the webhook corpus', () => {
  it('records each path', async () => {
    // What the Activity says for each delivery, in the order the workflow asks. A thrown one retries.
    const script = new Map<string, (WebhookDeliveryOutcome | 'throw')[]>();
    const path = (steps: (WebhookDeliveryOutcome | 'throw')[]) => {
      const deliveryId = randomUUID();
      script.set(deliveryId, [...steps]);
      return {
        workflowType: 'webhookDeliveryWorkflow',
        args: [{ organizationId: ORGANIZATION, deliveryId }],
      };
    };
    const activities = {
      processWebhookDelivery: async (input: { deliveryId: string }) => {
        const next = script.get(input.deliveryId)?.shift();
        if (next === 'throw') throw ApplicationFailure.retryable('Worth retrying', 'TRANSIENT');
        return next ?? 'skipped';
      },
    };
    await withCaptureWorkers(
      { activities, queues: [`replay-webhook-${randomUUID()}`, CONNECTOR_TASK_QUEUE] },
      async (run) => {
        await run.record('webhook-applied', path(['applied']));
        await run.record('webhook-duplicate', path(['duplicate']));
        await run.record('webhook-rejected', path(['rejected']));
        await run.record('webhook-skipped', path(['skipped']));
        await run.record('webhook-retried-then-applied', path(['throw', 'applied']));
      },
    );
  }, 120_000);
});
