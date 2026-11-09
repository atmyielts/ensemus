// ADR-028 open question 12, lifecycle item 8a: the dispatcher's typed-record purge route.
import { describe, expect, it, vi } from 'vitest';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { PLATFORM_TASK_QUEUE } from '@ensemus/workflows/constants';
import { recordPurgeStartFor, startRecordPurge } from './record-purge-route';

const organizationId = '00000000-0000-4000-8000-0000000000aa';
const id = '00000000-0000-4000-8000-0000000000bb';
const event = (eventType: string, aggregateType: string, aggregateId = id) => ({
  eventType,
  aggregateType,
  aggregateId,
  organizationId,
});

describe('the typed-record purge route', () => {
  it.each(['work_unit', 'project', 'client', 'object_record'] as const)(
    'starts knowledgeRecordPurgeWorkflow for a closed %s, one workflow ID per record',
    (kind) => {
      expect(recordPurgeStartFor(event('knowledge.record_closed', kind))).toEqual({
        workflowType: 'knowledgeRecordPurgeWorkflow',
        input: { organizationId, kind, id, limit: 25 },
        workflowId: `knowledge-record-purge-${organizationId}-${kind}-${id}`,
      });
    },
  );

  it('ignores another event type and every kind a record purge does not cover', () => {
    expect(recordPurgeStartFor(event('knowledge.source_closed', 'work_unit'))).toBeNull();
    expect(recordPurgeStartFor(event('tombstone.recorded', 'work_unit'))).toBeNull();
    for (const kind of ['artifact', 'knowledge_source', '', 'WORK_UNIT'])
      expect(recordPurgeStartFor(event('knowledge.record_closed', kind))).toBeNull();
  });

  it('throws on a malformed record ID, so the event is retried rather than dropped', () => {
    expect(() =>
      recordPurgeStartFor(event('knowledge.record_closed', 'work_unit', 'not-a-uuid')),
    ).toThrow();
  });

  it('starts with ALLOW_DUPLICATE on the platform queue and treats an open run as done', async () => {
    const start = recordPurgeStartFor(event('knowledge.record_closed', 'client'))!;
    const client = { workflow: { start: vi.fn().mockResolvedValue(undefined) } };
    await startRecordPurge(client, start);
    expect(client.workflow.start).toHaveBeenCalledWith('knowledgeRecordPurgeWorkflow', {
      args: [start.input],
      taskQueue: PLATFORM_TASK_QUEUE,
      workflowId: start.workflowId,
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    });
    client.workflow.start.mockRejectedValueOnce(
      new WorkflowExecutionAlreadyStartedError('already', start.workflowId, start.workflowType),
    );
    await expect(startRecordPurge(client, start)).resolves.toBeUndefined();
    const outage = new Error('Generated outage');
    client.workflow.start.mockRejectedValueOnce(outage);
    await expect(startRecordPurge(client, start)).rejects.toBe(outage);
  });
});
