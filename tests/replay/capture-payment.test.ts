import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { capturing, withCaptureWorkers } from './capture-support';

describe.skipIf(!capturing)('capture payment effect boundary', () => {
  it('records settlement, lost answers and verified event routing without money or customer data', async () => {
    let variant = 'succeeded',
      calls = 0;
    const activities = {
      chargePaymentStep: async () => {
        calls += 1;
        if (variant === 'interrupted') throw new Error('WORKER_INTERRUPTED');
        return {
          step:
            variant === 'succeeded'
              ? 'succeeded'
              : variant === 'not-sent' && calls === 1
                ? 'retry'
                : variant === 'not-sent'
                  ? 'succeeded'
                  : 'reconcile',
          ...(variant === 'not-sent' && calls === 1 ? { afterMs: 1 } : {}),
        };
      },
      inspectInterruptedPaymentStep: async () => 'attempt_open',
      reconcilePaymentStep: async () => (variant === 'lookup' ? 'succeeded' : 'unknown'),
      concludePaymentWithoutAnswerStep: async () => 'unknown',
      failUnsentPaymentStep: async () => undefined,
      settledPaymentOutcomeStep: async () => 'failed',
      routePaymentEventStep: async () => (variant === 'unmatched' ? 'unmatched' : 'applied'),
    };
    await withCaptureWorkers(
      { activities, queues: ['ensemus-platform', 'ensemus-connectors'] },
      async (run) => {
        for (const path of ['succeeded', 'not-sent', 'unknown', 'lookup', 'interrupted']) {
          variant = path;
          calls = 0;
          await run.record(`payment-${path}`, {
            workflowType: 'paymentWorkflow',
            args: [{ organizationId: randomUUID(), paymentId: randomUUID() }],
          });
        }
        for (const path of ['applied', 'unmatched']) {
          variant = path;
          await run.record(`payment-event-${path}`, {
            workflowType: 'paymentEventWorkflow',
            args: [{ organizationId: randomUUID(), paymentWebhookEventId: randomUUID() }],
          });
        }
      },
    );
  }, 180000);
});
