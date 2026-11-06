// Owned by the retention slice (LIFE-02). Deterministic: only @temporalio/workflow and types. A Temporal Schedule
// runs it per tenant once that tenant has a retention rule. No rule, no schedule, nothing swept.
import { ApplicationFailure } from '@temporalio/workflow';
import type { RetentionInput, RetentionResult } from './saas-schemas';

export async function retentionSweepWorkflow(_input: RetentionInput): Promise<RetentionResult> {
  throw ApplicationFailure.nonRetryable('NOT_IMPLEMENTED');
}
