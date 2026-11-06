// Owned by the payments slice (BILL-01). Deterministic: only @temporalio/workflow and types. The same shape as
// externalActionWorkflow (ADR-027 D2). The charge Activity has `maximumAttempts: 1`, and it ends on `unknown`.
import {
  ActivityFailure,
  CancellationScope,
  proxyActivities,
  sleep,
  TimeoutFailure,
  workflowInfo,
} from '@temporalio/workflow';
import { CONNECTOR_TASK_QUEUE } from './constants';
import { runPayment } from './payment-step';
import type { PaymentConnectorActivities, PaymentPlatformActivities } from './payment-activities';
import type {
  PaymentEventInput,
  PaymentEventOutcome,
  PaymentInput,
  PaymentResult,
} from './saas-schemas';

const { chargePaymentStep } = proxyActivities<PaymentConnectorActivities>({
  taskQueue: CONNECTOR_TASK_QUEUE,
  startToCloseTimeout: '2 minutes',
  scheduleToStartTimeout: '1 hour',
  retry: { maximumAttempts: 1 },
});
const { reconcilePaymentStep } = proxyActivities<PaymentConnectorActivities>({
  taskQueue: CONNECTOR_TASK_QUEUE,
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '1 hour',
  retry: {
    initialInterval: '5 seconds',
    maximumInterval: '1 minute',
    nonRetryableErrorTypes: ['AppError'],
  },
});
const platform = proxyActivities<PaymentPlatformActivities>({
  startToCloseTimeout: '30 seconds',
  scheduleToCloseTimeout: '24 hours',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '1 minute',
    nonRetryableErrorTypes: ['AppError'],
  },
});

export async function paymentWorkflow(input: PaymentInput): Promise<PaymentResult> {
  const run = { ...input, runId: workflowInfo().runId };
  const outcome = await CancellationScope.nonCancellable(() =>
    runPayment({
      charge: () => chargePaymentStep(run),
      inspect: () => platform.inspectInterruptedPaymentStep(input),
      reconcile: () => reconcilePaymentStep(input),
      concludeWithoutAnswer: () => platform.concludePaymentWithoutAnswerStep(input),
      failUnsent: (code) => platform.failUnsentPaymentStep({ ...input, code }),
      outcome: () => platform.settledPaymentOutcomeStep(input),
      sleep: (ms) => sleep(ms),
      neverPickedUp: (error) =>
        error instanceof ActivityFailure &&
        error.cause instanceof TimeoutFailure &&
        error.cause.timeoutType === 'SCHEDULE_TO_START',
    }),
  );
  return { paymentId: input.paymentId, outcome };
}

export async function paymentEventWorkflow(input: PaymentEventInput): Promise<PaymentEventOutcome> {
  return platform.routePaymentEventStep(input);
}
