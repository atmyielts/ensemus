// Owned by the payments slice (BILL-01). See docs/06-delivery/m8-slices.md and ADR-032 D4.
import type { PaymentCode } from '@ensemus/saas/payment';
import type { PaymentConnectorDeps, PaymentPlatformDeps } from './saas-deps';
import type {
  ChargeStep,
  InterruptedPaymentStep,
  PaymentEventInput,
  PaymentEventOutcome,
  PaymentInput,
  PaymentReconcileStep,
} from './saas-schemas';

/** Only what reads and writes PostgreSQL. */
export function createPaymentPlatformActivities(_deps: PaymentPlatformDeps) {
  return {
    async inspectInterruptedPaymentStep(_input: PaymentInput): Promise<InterruptedPaymentStep> {
      throw new Error('NOT_IMPLEMENTED');
    },
    async failUnsentPaymentStep(_input: PaymentInput & { code: PaymentCode }): Promise<void> {
      throw new Error('NOT_IMPLEMENTED');
    },
    async routePaymentEventStep(_input: PaymentEventInput): Promise<PaymentEventOutcome> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type PaymentPlatformActivities = ReturnType<typeof createPaymentPlatformActivities>;

/** On the connector queue, because these hold the processor's credential and leave through the gateway. */
export function createPaymentConnectorActivities(_deps: PaymentConnectorDeps) {
  return {
    /** Begins the attempt, charges once, and records what happened. Temporal never retries this. */
    async chargePaymentStep(_input: PaymentInput & { runId: string }): Promise<ChargeStep> {
      throw new Error('NOT_IMPLEMENTED');
    },
    /** Only reads. It may retry. */
    async reconcilePaymentStep(_input: PaymentInput): Promise<PaymentReconcileStep> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type PaymentConnectorActivities = ReturnType<typeof createPaymentConnectorActivities>;
