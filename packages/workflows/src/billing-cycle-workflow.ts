// Owned by the invoicing slice (BILL-02). Deterministic: only @temporalio/workflow and types. A Temporal Schedule
// runs it per tenant, carrying only the organization ID, the same as tenantRemindersWorkflow.
import { ApplicationFailure } from '@temporalio/workflow';
import type { BillingCycleInput, BillingCycleResult } from './saas-schemas';

export async function billingCycleWorkflow(_input: BillingCycleInput): Promise<BillingCycleResult> {
  throw ApplicationFailure.nonRetryable('NOT_IMPLEMENTED');
}
