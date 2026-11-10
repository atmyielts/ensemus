// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md and ADR-029 D1. Deterministic
// workflow code: only @temporalio/workflow and types may be imported here.
import {
  ActivityFailure,
  executeChild,
  patched,
  proxyActivities,
  TimeoutFailure,
} from '@temporalio/workflow';
import type { KnowledgeEmbedActivities } from './knowledge-embed-activities';
import type { TenantInput } from './schemas';
import type { KnowledgeSweepResult } from './knowledge-schemas';
import type { KnowledgeIngestActivities } from './knowledge-ingest-activities';
import type { KnowledgeConnectorActivities } from './knowledge-connector-activities';
import type { McpActivities } from './mcp-activities';
import { runKnowledgeSweep } from './knowledge-ingest-step';
import { knowledgePurgeWorkflow } from './knowledge-purge-workflow';
import {
  knowledgePurgeWorkflowIdFor,
  knowledgeRecordPurgeWorkflowIdFor,
  type KnowledgeRecordPurgeInput,
} from './knowledge-schemas';
import { knowledgeRecordPurgeWorkflow } from './knowledge-record-purge-workflow';
import type { RecordPurgeResult } from './knowledge-record-purge-step';
import type { KnowledgePurgeActivities } from './knowledge-purge-activities';
import { restartKnowledgePurge } from './knowledge-purge-step';

/**
 * A tenant's connector content and closures, on a schedule. `listStaleResources` and `closeOrphanedSources`
 * on `KNOWLEDGE_TASK_QUEUE`, then `fetchConnectorContent` for each ID on `CONNECTOR_TASK_QUEUE`, which holds
 * the credential. One failing resource does not stop the others. Bounded per run.
 */
export async function knowledgeSweepWorkflow(input: TenantInput): Promise<KnowledgeSweepResult> {
  const local = proxyActivities<KnowledgeIngestActivities & KnowledgePurgeActivities>({
    taskQueue: 'ensemus-knowledge',
    startToCloseTimeout: '5 minutes',
    retry: { maximumAttempts: 3 },
  });
  const connector = proxyActivities<KnowledgeConnectorActivities & McpActivities>({
    taskQueue: 'ensemus-connectors',
    startToCloseTimeout: '2 minutes',
    scheduleToStartTimeout: '30 seconds',
    retry: { maximumAttempts: 2 },
  });
  const models = proxyActivities<KnowledgeEmbedActivities>({
    taskQueue: 'ensemus-agent',
    startToCloseTimeout: '5 minutes',
    scheduleToStartTimeout: '30 seconds',
    retry: { maximumAttempts: 1 },
  });
  const alreadyRunning = (error: unknown) =>
    error instanceof Error && error.name === 'WorkflowExecutionAlreadyStartedError';
  // ADR-028 lifecycle item 8a: restart every typed-record purge PostgreSQL does not yet prove. Behind a
  // patch, so histories recorded before it replay without the new Activity.
  const recordPurgeRestart = patched('record-purge-restart-v1')
    ? {
        recordPurges: () => local.claimRecordPurgeRestarts(input),
        retryRecordPurge: (child: KnowledgeRecordPurgeInput) =>
          restartKnowledgePurge<RecordPurgeResult>({
            start: () =>
              executeChild(knowledgeRecordPurgeWorkflow, {
                args: [child],
                workflowId: knowledgeRecordPurgeWorkflowIdFor(child),
                taskQueue: 'ensemus-platform',
                // Per record, not per pass: a pass after a restore must prove again from PostgreSQL.
                workflowIdReusePolicy: 'ALLOW_DUPLICATE',
                parentClosePolicy: 'ABANDON',
                cancellationType: 'ABANDON',
              }),
            existing: () => local.readRecordPurgeState(child),
            alreadyRunning,
          }),
      }
    : {};
  return runKnowledgeSweep({
    ...recordPurgeRestart,
    purges: () => local.claimSourcePurgeRetries(input),
    retryPurge: async (sourceId) => {
      const child = { organizationId: input.organizationId, sourceId };
      return restartKnowledgePurge<{
        state: 'pending' | 'running' | 'completed' | 'failed';
        chunks: number;
      }>({
        start: () =>
          executeChild(knowledgePurgeWorkflow, {
            args: [child],
            workflowId: knowledgePurgeWorkflowIdFor(child),
            taskQueue: 'ensemus-platform',
            workflowIdReusePolicy: 'ALLOW_DUPLICATE',
            parentClosePolicy: 'ABANDON',
            cancellationType: 'ABANDON',
          }),
        existing: () => local.readSourcePurgeState(child),
        alreadyRunning,
      });
    },
    close: () => local.closeOrphanedSources(input),
    list: () => local.listStaleResources(input),
    fetch: (externalResourceId) =>
      connector.fetchConnectorContent({ organizationId: input.organizationId, externalResourceId }),
    mcp: () => local.listMcpConnections(input),
    refresh: (connectionId) =>
      connector.refreshMcpTools({ organizationId: input.organizationId, connectionId }),
    pending: () => local.listDocumentsNeedingIngestion(input),
    parse: (documentId) =>
      local.parseAndChunk({ organizationId: input.organizationId, documentId }),
    documents: () => local.listDocumentsNeedingEmbedding(input),
    embed: (documentId) =>
      models.embedDocumentChunks({ organizationId: input.organizationId, documentId }),
    modelWorkerAbsent: (error) =>
      error instanceof ActivityFailure &&
      error.cause instanceof TimeoutFailure &&
      error.cause.timeoutType === 'SCHEDULE_TO_START',
  });
}
