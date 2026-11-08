import { z } from 'zod';

// M8 (ADR-032). The ADR-024 rule again: identifiers, enums and counters. No price, no name, no address and no
// processor text crosses Temporal. Amounts stay in PostgreSQL, and only the outcome comes back.

export const billingCycleInputSchema = z.strictObject({ organizationId: z.uuid() });
export type BillingCycleInput = z.infer<typeof billingCycleInputSchema>;
export const billingScheduleIdFor = (organizationId: string) => `billing-${organizationId}`;
/** Operational, and not a commercial term: how often to look for what has fallen due. */
export const BILLING_SWEEP_INTERVAL = '1 hour';
export type BillingCycleResult = {
  closedPeriods: number;
  issued: number;
  stepsTaken: number;
  refusedCode: string | null;
};

export const paymentInputSchema = z.strictObject({
  organizationId: z.uuid(),
  paymentId: z.uuid(),
});
export type PaymentInput = z.infer<typeof paymentInputSchema>;
export const paymentWorkflowIdFor = (input: PaymentInput) =>
  `payment-${input.organizationId}-${input.paymentId}`;
export type PaymentOutcome = 'succeeded' | 'failed' | 'unknown' | 'cancelled';
export type PaymentResult = { paymentId: string; outcome: PaymentOutcome };
export type ChargeStep =
  | { step: 'succeeded' | 'failed' | 'cancelled' | 'unknown' }
  | { step: 'retry'; afterMs: number }
  | { step: 'reconcile' };
export type InterruptedPaymentStep = 'nothing_sent' | 'attempt_open' | 'settled';
export type PaymentReconcileStep = 'succeeded' | 'failed' | 'cancelled' | 'retry' | 'unknown';

/** `organizationId` here is the operator's own organization, where the event was verified and held. */
export const paymentEventInputSchema = z.strictObject({
  organizationId: z.uuid(),
  paymentWebhookEventId: z.uuid(),
});
export type PaymentEventInput = z.infer<typeof paymentEventInputSchema>;
export const paymentEventWorkflowIdFor = (input: PaymentEventInput) =>
  `payment-event-${input.organizationId}-${input.paymentWebhookEventId}`;
export type PaymentEventOutcome = 'applied' | 'unmatched' | 'ignored' | 'already_done';

export const retentionInputSchema = z.strictObject({ organizationId: z.uuid() });
export type RetentionInput = z.infer<typeof retentionInputSchema>;
export const retentionScheduleIdFor = (organizationId: string) => `retention-${organizationId}`;
/** Operational: how often to look. How long anything is kept is a rule, and never this. */
export const RETENTION_SWEEP_INTERVAL = '6 hours';
export type RetentionResult = { categories: number; removed: number; held: number; more: boolean };

export const offboardingInputSchema = z.strictObject({
  organizationId: z.uuid(),
  offboardingId: z.uuid(),
});
export type OffboardingInput = z.infer<typeof offboardingInputSchema>;
export const offboardingWorkflowIdFor = (input: OffboardingInput) =>
  `offboarding-${input.organizationId}-${input.offboardingId}`;
/** Where this run stopped. `awaiting_operator` and `blocked_by_hold` end the run, and an event starts the next. */
export type OffboardingOutcome = 'awaiting_operator' | 'blocked_by_hold' | 'cancelled' | 'reported';
export type OffboardingStepResult =
  | { kind: 'continue' }
  | { kind: 'wait'; untilMs: number }
  | { kind: 'stop'; outcome: OffboardingOutcome };
