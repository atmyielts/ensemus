// ADR-032 D4a. Deterministic: only @temporalio/workflow and types. Makes one Paddle transaction for one
// checkout, then looks it up on a widening schedule in case a notification never arrives. The open step
// runs at most once, because a second run could make a second transaction; the lookups only read.
import { proxyActivities, sleep } from '@temporalio/workflow';
import type { CheckoutConnectorActivities } from './checkout-activities';
import { CONNECTOR_TASK_QUEUE } from './constants';
import type { CheckoutInput, CheckoutResult } from './saas-schemas';

/**
 * Operational pacing for the backstop lookup when a notification never came, and not a commercial term:
 * nothing here closes a checkout; a customer can pay for as long as Paddle keeps the transaction open.
 * Changing it changes this workflow's history, so it needs patched().
 */
const CHECKOUT_RECONCILE_WAITS = ['15 minutes', '1 hour', '6 hours', '1 day', '3 days'] as const;

const { openCheckoutStep } = proxyActivities<CheckoutConnectorActivities>({
  taskQueue: CONNECTOR_TASK_QUEUE,
  startToCloseTimeout: '2 minutes',
  scheduleToStartTimeout: '1 hour',
  retry: { maximumAttempts: 1 },
});
const { lookupCheckoutStep } = proxyActivities<CheckoutConnectorActivities>({
  taskQueue: CONNECTOR_TASK_QUEUE,
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '1 hour',
  retry: {
    initialInterval: '5 seconds',
    maximumInterval: '1 minute',
    nonRetryableErrorTypes: ['AppError'],
  },
});

export async function checkoutWorkflow(input: CheckoutInput): Promise<CheckoutResult> {
  const opened = await openCheckoutStep(input);
  if (opened !== 'open') return { sessionId: input.sessionId, outcome: opened };
  for (const wait of CHECKOUT_RECONCILE_WAITS) {
    await sleep(wait);
    const step = await lookupCheckoutStep(input);
    if (step !== 'still_open') return { sessionId: input.sessionId, outcome: step };
  }
  return { sessionId: input.sessionId, outcome: 'still_open' };
}
