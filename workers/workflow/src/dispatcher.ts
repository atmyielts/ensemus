// The outbox dispatcher (ADR-024 D3). The only path from committed business state to Temporal: the
// web tier has no client and no network route. Delivery is at least once, so every action here is
// idempotent, and a crash just repeats it.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret } from '@ensemus/config';
import {
  dispatchDueEvents,
  openDispatcherDatabase,
  type DispatchableEvent,
} from '@ensemus/database/dispatcher';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { PLATFORM_TASK_QUEUE } from '@ensemus/workflows/constants';
import {
  reminderScheduleIdFor,
  workflowIdFor,
  workInputSchema,
  type TenantInput,
  type WorkInput,
} from '@ensemus/workflows/schemas';
import {
  Client,
  Connection,
  ScheduleOverlapPolicy,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  ScheduleAlreadyRunning,
} from '@temporalio/client';

const log = createLogger('dispatcher');
const here = path.dirname(fileURLToPath(import.meta.url));
const IDLE_MS = 500;
const REMINDER_INTERVAL = '15 minutes';

async function main() {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
  });
  const client = new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    dataConverter: {
      payloadCodecs: [new AesGcmPayloadCodec(readSecret('TEMPORAL_CODEC_KEY'))],
      failureConverterPath: path.join(here, 'failure-converter.cjs'),
    },
  });
  const { db, close } = openDispatcherDatabase(readSecret('DATABASE_URL_DISPATCHER'));

  const handle = async (event: DispatchableEvent) => {
    const input: WorkInput | null =
      event.aggregateType === 'work_unit'
        ? workInputSchema.parse({
            organizationId: event.organizationId,
            workUnitId: event.aggregateId,
          })
        : null;

    switch (event.eventType) {
      case 'work.execution_requested':
        if (!input) return;
        try {
          await client.workflow.start('workUnitWorkflow', {
            args: [input],
            taskQueue: PLATFORM_TASK_QUEUE,
            workflowId: workflowIdFor(input),
            // A finished workflow may run again after an authorized retry. A live one may not.
            workflowIdReusePolicy: 'ALLOW_DUPLICATE',
          });
        } catch (error) {
          if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        }
        return;

      case 'approval.resolved':
        if (!input) return;
        try {
          await client.workflow.getHandle(workflowIdFor(input)).signal('approvalResolved');
        } catch (error) {
          // Approvals on manual work have no workflow to tell.
          if (!(error instanceof WorkflowNotFoundError)) throw error;
        }
        return;

      case 'work.stop_requested':
        if (!input) return;
        try {
          await client.workflow.getHandle(workflowIdFor(input)).cancel();
        } catch (error) {
          if (!(error instanceof WorkflowNotFoundError)) throw error;
        }
        return;

      case 'organization.created': {
        const scheduleInput: TenantInput = { organizationId: event.organizationId };
        try {
          await client.schedule.create({
            scheduleId: reminderScheduleIdFor(event.organizationId),
            spec: { intervals: [{ every: REMINDER_INTERVAL }] },
            policies: { overlap: ScheduleOverlapPolicy.SKIP },
            action: {
              type: 'startWorkflow',
              workflowType: 'tenantRemindersWorkflow',
              args: [scheduleInput],
              taskQueue: PLATFORM_TASK_QUEUE,
            },
          });
        } catch (error) {
          if (!(error instanceof ScheduleAlreadyRunning)) throw error;
        }
        return;
      }

      default:
        // Nothing consumes this event yet. It stays in domain_events for projections.
        return;
    }
  };

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  log.info('dispatcher.started');
  const beat = () => writeFileSync('/tmp/worker-alive', String(Date.now()));
  while (running) {
    beat();
    try {
      const result = await dispatchDueEvents(db, handle);
      if (result.failed || result.dead) {
        log.warn('dispatcher.delivery_problem', { count: result.failed + result.dead });
      }
      if (result.handled === 0) await new Promise((done) => setTimeout(done, IDLE_MS));
    } catch (error) {
      log.error('dispatcher.poll_failed', { errorCode: errorCode(error) });
      await new Promise((done) => setTimeout(done, IDLE_MS * 4));
    }
  }
  await close();
  await connection.close();
  log.info('dispatcher.stopped');
}

main().catch((error: unknown) => {
  log.error('dispatcher.crashed', { errorCode: errorCode(error) });
  process.exit(1);
});
