// ADR-028 open question 12, lifecycle item 8a: the dispatcher's route from a typed-record deletion event
// to its purge. Pure apart from the start call, so the routing and the reuse policy are unit-tested.
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { isRecordPurgeKind, KNOWLEDGE_RECORD_CLOSED } from '@ensemus/domain/knowledge-events';
import { PLATFORM_TASK_QUEUE } from '@ensemus/workflows/constants';
import {
  knowledgeRecordPurgeInputSchema,
  knowledgeRecordPurgeWorkflowIdFor,
  RECORD_PURGE_PAGE_LIMIT,
  type KnowledgeRecordPurgeInput,
} from '@ensemus/workflows/knowledge-schemas';

export type RecordPurgeStart = {
  workflowType: 'knowledgeRecordPurgeWorkflow';
  input: KnowledgeRecordPurgeInput;
  workflowId: string;
};

/**
 * The purge a `knowledge.record_closed` event asks for, or null for any other event. A malformed ID
 * throws, so the event is retried (and in the end parked) rather than silently dropped.
 */
export function recordPurgeStartFor(event: {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  organizationId: string;
}): RecordPurgeStart | null {
  if (event.eventType !== KNOWLEDGE_RECORD_CLOSED || !isRecordPurgeKind(event.aggregateType))
    return null;
  const input = knowledgeRecordPurgeInputSchema.parse({
    organizationId: event.organizationId,
    kind: event.aggregateType,
    id: event.aggregateId,
    limit: RECORD_PURGE_PAGE_LIMIT,
  });
  return {
    workflowType: 'knowledgeRecordPurgeWorkflow',
    input,
    workflowId: knowledgeRecordPurgeWorkflowIdFor(input),
  };
}

/** The slice of the Temporal client this route uses. */
export type RecordPurgeStarter = {
  workflow: {
    start(
      workflowType: string,
      options: {
        args: unknown[];
        taskQueue: string;
        workflowId: string;
        workflowIdReusePolicy: 'ALLOW_DUPLICATE';
      },
    ): Promise<unknown>;
  };
};

/**
 * Starts the record's purge. The workflow ID is per record, so ALLOW_DUPLICATE lets a pass after a
 * restore prove again from PostgreSQL; a pass is idempotent, and a live one is left running.
 */
export async function startRecordPurge(
  client: RecordPurgeStarter,
  start: RecordPurgeStart,
): Promise<void> {
  try {
    await client.workflow.start(start.workflowType, {
      args: [start.input],
      taskQueue: PLATFORM_TASK_QUEUE,
      workflowId: start.workflowId,
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
}
