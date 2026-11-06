// The outbox dispatcher (ADR-024 D3). The only path from committed business state to Temporal: the
// web tier has no client and no network route. Delivery is at least once, so every action here is
// idempotent, and a crash just repeats it.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret } from '@ensemus/config';
import {
  dispatchDueEvents,
  listOrganizationIds,
  openDispatcherDatabase,
  type DispatchableEvent,
} from '@ensemus/database/dispatcher';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { PLATFORM_TASK_QUEUE, TEMPORAL_CHANNEL_ARGS } from '@ensemus/workflows/constants';
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
import { classifyDeliveryError } from './dispatch-errors';

const log = createLogger('dispatcher');
const here = path.dirname(fileURLToPath(import.meta.url));
const IDLE_MS = 500;
const REMINDER_INTERVAL = '15 minutes';
/** One Temporal call may never hold up the signals behind it for longer than this. */
const CALL_DEADLINE_MS = 10_000;
/** How often to try checking the reminder schedules again if Temporal was down at startup. */
const RECONCILE_RETRY_MS = 60_000;

async function main() {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
    channelArgs: TEMPORAL_CHANNEL_ARGS,
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

  const ensureReminderSchedule = async (organizationId: string) => {
    const scheduleInput: TenantInput = { organizationId };
    try {
      await client.schedule.create({
        scheduleId: reminderScheduleIdFor(organizationId),
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
  };

  const deliver = async (event: DispatchableEvent) => {
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
          // Not an outage, so not worth holding the batch for. If that open run can never claim this
          // request, it stays standing, and the tenant's upkeep asks again.
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

      case 'organization.created':
        await ensureReminderSchedule(event.organizationId);
        return;

      default:
        // Nothing consumes this event yet. It stays in domain_events for projections.
        return;
    }
  };

  const handle = (event: DispatchableEvent) =>
    connection.withDeadline(Date.now() + CALL_DEADLINE_MS, () => deliver(event));

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  const beat = () => writeFileSync('/tmp/worker-alive', String(Date.now()));

  /** A tenant whose first event was lost before this existed still gets its reminders. */
  const reconcileReminderSchedules = async () => {
    const organizations = await listOrganizationIds(db);
    for (const organizationId of organizations) {
      if (!running) return false;
      beat();
      await connection.withDeadline(Date.now() + CALL_DEADLINE_MS, () =>
        ensureReminderSchedule(organizationId),
      );
    }
    log.info('dispatcher.schedules_reconciled', { count: organizations.length });
    return true;
  };

  log.info('dispatcher.started');
  let reconciled = false;
  let nextReconcileAt = 0;
  while (running) {
    beat();
    if (!reconciled && Date.now() >= nextReconcileAt) {
      nextReconcileAt = Date.now() + RECONCILE_RETRY_MS;
      await reconcileReminderSchedules().then(
        (done) => {
          reconciled = done;
        },
        (error: unknown) => {
          log.warn('dispatcher.reconcile_failed', { errorCode: errorCode(error) });
        },
      );
    }
    try {
      const result = await dispatchDueEvents(db, handle, {
        classify: classifyDeliveryError,
        shouldStop: () => !running,
        onEvent: (error) => {
          beat();
          // A code is enough to tell an outage from a bad event, and it can quote nothing.
          if (error) log.warn('dispatcher.delivery_failed', { errorCode: errorCode(error) });
        },
      });
      if (result.failed || result.dead || result.deferred) {
        log.warn('dispatcher.delivery_problem', {
          count: result.failed + result.dead + result.deferred,
        });
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
