// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md and ADR-029 D1. Deterministic
// workflow code: only @temporalio/workflow and types may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { TenantInput } from './schemas';
import type { KnowledgeSweepResult } from './knowledge-schemas';

/**
 * A tenant's connector content and closures, on a schedule. `listStaleResources` and `closeOrphanedSources`
 * on `KNOWLEDGE_TASK_QUEUE`, then `fetchConnectorContent` for each ID on `CONNECTOR_TASK_QUEUE`, which holds
 * the credential. One failing resource does not stop the others. Bounded per run.
 */
export async function knowledgeSweepWorkflow(_input: TenantInput): Promise<KnowledgeSweepResult> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
