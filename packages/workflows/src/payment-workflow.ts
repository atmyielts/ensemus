// Owned by the payments slice (BILL-01). Deterministic: only @temporalio/workflow and types. The same shape as
// externalActionWorkflow (ADR-027 D2). The charge Activity has `maximumAttempts: 1`, and it ends on `unknown`.
import { ApplicationFailure } from '@temporalio/workflow';
import type {
  PaymentEventInput,
  PaymentEventOutcome,
  PaymentInput,
  PaymentResult,
} from './saas-schemas';

export async function paymentWorkflow(_input: PaymentInput): Promise<PaymentResult> {
  throw ApplicationFailure.nonRetryable('NOT_IMPLEMENTED');
}

export async function paymentEventWorkflow(
  _input: PaymentEventInput,
): Promise<PaymentEventOutcome> {
  throw ApplicationFailure.nonRetryable('NOT_IMPLEMENTED');
}
