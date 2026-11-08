// Owned by the invoicing slice (BILL-02). Deterministic: only @temporalio/workflow and types. A Temporal Schedule
// runs it per tenant, carrying only the organization ID, the same as tenantRemindersWorkflow.
import { proxyActivities } from '@temporalio/workflow';
import type { BillingCycleInput, BillingCycleResult } from './saas-schemas';
import type { BillingActivities } from './billing-activities';
import type { CreditActivities } from './credit-activities';
import type { TaxActivities } from './tax-activities';
import { runBillingCycle } from './billing-cycle-step';

const platform = proxyActivities<BillingActivities & CreditActivities>({
  taskQueue: 'ensemus-platform',
  startToCloseTimeout: '2 minutes',
});
const connector = proxyActivities<TaxActivities>({
  taskQueue: 'ensemus-connectors',
  startToCloseTimeout: '2 minutes',
});

export async function billingCycleWorkflow(input: BillingCycleInput): Promise<BillingCycleResult> {
  return runBillingCycle(input, platform, connector);
}
