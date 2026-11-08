// Owned by the retention slice (LIFE-02). Deterministic: only @temporalio/workflow and types. A Temporal Schedule
// runs it per tenant once that tenant has a retention rule. No rule, no schedule, nothing swept.
import { proxyActivities } from '@temporalio/workflow';
import type { RetentionActivities } from './retention-activities';
import type { RetentionInput, RetentionResult } from './saas-schemas';

const platform = proxyActivities<RetentionActivities>({
  taskQueue: 'ensemus-platform',
  startToCloseTimeout: '2 minutes',
  retry: { nonRetryableErrorTypes: ['AppError'] },
});
export async function retentionSweepWorkflow(input: RetentionInput): Promise<RetentionResult> {
  // One bounded page per category, per scheduled run. PostgreSQL keeps each finite cycle's position;
  // repeatedly looping here could restart a completed category while another still has pages left.
  return platform.sweepRetentionPage(input);
}
