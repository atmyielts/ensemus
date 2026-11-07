// The outbox dispatcher (ADR-024 D3). The only path from committed business state to Temporal: the
// web tier has no client and no network route. Delivery is at least once, so every action here is
// idempotent, and a crash just repeats it.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret } from '@ensemus/config';
import {
  dispatchDueEvents,
  eventBacklog,
  listOrganizationIds,
  openDispatcherDatabase,
  type DispatchableEvent,
} from '@ensemus/database/dispatcher';
import {
  AGENT_RUN_CONTROL_REQUESTED,
  AGENT_RUN_REQUESTED,
  AGGREGATE_MODEL_PROFILE,
  MODEL_PROFILE_PROBE_REQUESTED,
} from '@ensemus/domain/ai-events';
import {
  AGGREGATE_CONNECTION,
  AGGREGATE_EXTERNAL_ACTION,
  AGGREGATE_WEBHOOK_DELIVERY,
  CONNECTION_REVOKED,
  CONNECTOR_SYNC_REQUESTED,
  EXTERNAL_ACTION_READY,
  WEBHOOK_RECEIVED,
} from '@ensemus/domain/integration-events';
import {
  AGGREGATE_CLIENT_ONBOARDING,
  AGGREGATE_KNOWLEDGE_ANSWER,
  AGGREGATE_KNOWLEDGE_DOCUMENT,
  AGGREGATE_KNOWLEDGE_SOURCE,
  CLIENT_ONBOARDING_REQUESTED,
  KNOWLEDGE_ANSWER_REQUESTED,
  KNOWLEDGE_DOCUMENT_RECEIVED,
  KNOWLEDGE_SOURCE_CLOSED,
} from '@ensemus/domain/knowledge-events';
import {
  AGGREGATE_OBJECT_MIGRATION,
  AGGREGATE_PROCESS_RUN,
  AGGREGATE_SIMULATION_RUN,
  OBJECT_MIGRATION_REQUESTED,
  PROCESS_RUN_REQUESTED,
  PROCESS_RUN_STOP_REQUESTED,
  PROCESS_RUN_WAKE,
  SIMULATION_REQUESTED,
} from '@ensemus/domain/product-events';
import { TOMBSTONE_RECORDED } from '@ensemus/domain/tombstone-ledger';
import { S3ObjectStore } from '@ensemus/storage';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { modelProbeInputSchema, modelProbeWorkflowIdFor } from '@ensemus/workflows/agent-schemas';
import { AGENT_RUN_CONTROL_SIGNAL, PLATFORM_TASK_QUEUE } from '@ensemus/workflows/constants';
import {
  clientOnboardingInputSchema,
  clientOnboardingWorkflowIdFor,
  knowledgeAnswerInputSchema,
  knowledgeAnswerWorkflowIdFor,
  knowledgeIngestInputSchema,
  knowledgeIngestWorkflowIdFor,
  knowledgePurgeInputSchema,
  knowledgePurgeWorkflowIdFor,
  knowledgeSweepScheduleIdFor,
} from '@ensemus/workflows/knowledge-schemas';
import {
  objectMigrationInputSchema,
  objectMigrationWorkflowIdFor,
  PROCESS_RUN_WAKE_SIGNAL,
  processRunInputSchema,
  processRunWorkflowIdFor,
  simulationInputSchema,
  simulationWorkflowIdFor,
} from '@ensemus/workflows/product-schemas';
import {
  connectorRevokeWorkflowIdFor,
  connectorSyncInputSchema,
  connectorSyncWorkflowIdFor,
  externalActionInputSchema,
  externalActionWorkflowIdFor,
  reminderScheduleIdFor,
  webhookDeliveryInputSchema,
  webhookWorkflowIdFor,
  workflowIdFor,
  workInputSchema,
  type TenantInput,
  type WorkInput,
} from '@ensemus/workflows/schemas';
import {
  Client,
  ScheduleOverlapPolicy,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  ScheduleAlreadyRunning,
} from '@temporalio/client';
import { classifyDeliveryError, needsOnlyTheStore } from './dispatch-errors';
import { openDispatcherConnection } from './temporal-connection';
import { createLedgerWriter } from './tombstone-ledger';

const log = createLogger('dispatcher');
const here = path.dirname(fileURLToPath(import.meta.url));
const IDLE_MS = 500;
const REMINDER_INTERVAL = '15 minutes';
/** How often a tenant's connector content is looked at. A revoke does not wait for this (ADR-029 D1). */
const KNOWLEDGE_SWEEP_INTERVAL = '15 minutes';
/** One Temporal call may never hold up the signals behind it for longer than this. */
const CALL_DEADLINE_MS = 10_000;
/** How often to try checking the reminder schedules again if Temporal was down at startup. */
const RECONCILE_RETRY_MS = 60_000;
/**
 * One ledger write may hold up the events behind it for about this long, like a Temporal call, and
 * the outbox retries. A store that is only cold needs some of it: SeaweedFS took over 4 seconds for
 * its first write on a new stack, and a limit under that would miss for no reason.
 */
const LEDGER_REQUEST_MS = CALL_DEADLINE_MS;
/** How often to say so if tombstones are waiting to reach the ledger (ADR-026). */
const LEDGER_BACKLOG_CHECK_MS = 60_000;

async function main() {
  const connection = openDispatcherConnection(process.env.TEMPORAL_ADDRESS ?? 'temporal:7233');
  const client = new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    dataConverter: {
      payloadCodecs: [new AesGcmPayloadCodec(readSecret('TEMPORAL_CODEC_KEY'))],
      failureConverterPath: path.join(here, 'failure-converter.cjs'),
    },
  });
  const { db, close } = openDispatcherDatabase(readSecret('DATABASE_URL_DISPATCHER'));
  // Its own credential, which reaches the ledger and no customer's bytes (ADR-026).
  const writeLedgerEntry = createLedgerWriter(
    new S3ObjectStore({
      endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
      bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
      accessKey: readSecret('OBJECT_STORAGE_LEDGER_ACCESS_KEY'),
      secretKey: readSecret('OBJECT_STORAGE_LEDGER_SECRET_KEY'),
      requestTimeoutMs: LEDGER_REQUEST_MS,
      maxAttempts: 1,
    }),
  );

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
    try {
      await client.schedule.create({
        scheduleId: knowledgeSweepScheduleIdFor(organizationId),
        spec: { intervals: [{ every: KNOWLEDGE_SWEEP_INTERVAL }] },
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
        action: {
          type: 'startWorkflow',
          workflowType: 'knowledgeSweepWorkflow',
          args: [scheduleInput],
          taskQueue: PLATFORM_TASK_QUEUE,
        },
      });
    } catch (error) {
      if (!(error instanceof ScheduleAlreadyRunning)) throw error;
    }
  };

  /** Starts a workflow whose ID can only ever run once. Finding it started or finished is success. */
  const startOnce = async <I>(
    workflowType: string,
    start: { input: I; workflowIdFor: (input: I) => string },
  ) => {
    try {
      await client.workflow.start(workflowType, {
        args: [start.input],
        taskQueue: PLATFORM_TASK_QUEUE,
        workflowId: start.workflowIdFor(start.input),
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
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

      // An agent run uses the Work Unit's standard workflow ID, so approval.resolved and
      // work.stop_requested above reach it unchanged, and the stranded-run sweep probes the right
      // thing (ADR-028 FD-1). The first Activity finds the queued run in PostgreSQL. If a workflow is
      // already open on this work, the request stands and is picked up from there.
      case AGENT_RUN_REQUESTED:
        if (!input) return;
        try {
          await client.workflow.start('agentRunWorkflow', {
            args: [input],
            taskQueue: PLATFORM_TASK_QUEUE,
            workflowId: workflowIdFor(input),
            workflowIdReusePolicy: 'ALLOW_DUPLICATE',
          });
        } catch (error) {
          if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        }
        return;

      // A wake-up. The stop or pause itself is already committed in ai.run_controls, and each step
      // rechecks it, so a lost signal delays this and cannot lose it.
      case AGENT_RUN_CONTROL_REQUESTED:
        if (!input) return;
        try {
          await client.workflow.getHandle(workflowIdFor(input)).signal(AGENT_RUN_CONTROL_SIGNAL);
        } catch (error) {
          if (!(error instanceof WorkflowNotFoundError)) throw error;
        }
        return;

      case MODEL_PROFILE_PROBE_REQUESTED: {
        if (event.aggregateType !== AGGREGATE_MODEL_PROFILE) return;
        const probeInput = modelProbeInputSchema.parse({
          organizationId: event.organizationId,
          modelProfileId: event.aggregateId,
        });
        try {
          await client.workflow.start('modelProbeWorkflow', {
            args: [probeInput],
            taskQueue: PLATFORM_TASK_QUEUE,
            workflowId: modelProbeWorkflowIdFor(probeInput),
            workflowIdReusePolicy: 'ALLOW_DUPLICATE',
          });
        } catch (error) {
          if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        }
        return;
      }

      case 'organization.created':
        await ensureReminderSchedule(event.organizationId);
        return;

      case TOMBSTONE_RECORDED:
        await writeLedgerEntry(event);
        return;

      // An effect belongs to one run, ever. A finished run stays finished, so an event delivered again
      // can never start a second send, whatever this intent's row says by then (ADR-027 D2).
      case EXTERNAL_ACTION_READY:
        if (event.aggregateType !== AGGREGATE_EXTERNAL_ACTION) return;
        await startOnce('externalActionWorkflow', {
          input: externalActionInputSchema.parse({
            organizationId: event.organizationId,
            externalActionId: event.aggregateId,
          }),
          workflowIdFor: externalActionWorkflowIdFor,
        });
        return;

      case WEBHOOK_RECEIVED:
        if (event.aggregateType !== AGGREGATE_WEBHOOK_DELIVERY) return;
        await startOnce('webhookDeliveryWorkflow', {
          input: webhookDeliveryInputSchema.parse({
            organizationId: event.organizationId,
            deliveryId: event.aggregateId,
          }),
          workflowIdFor: webhookWorkflowIdFor,
        });
        return;

      // M7 (ADR-031). Each starts once, ever, as an external action does: an event delivered again finds
      // the finished run, and the row in PostgreSQL says the rest.
      case SIMULATION_REQUESTED:
        if (event.aggregateType !== AGGREGATE_SIMULATION_RUN) return;
        await startOnce('simulationWorkflow', {
          input: simulationInputSchema.parse({
            organizationId: event.organizationId,
            simulationId: event.aggregateId,
          }),
          workflowIdFor: simulationWorkflowIdFor,
        });
        return;

      case PROCESS_RUN_REQUESTED:
        if (event.aggregateType !== AGGREGATE_PROCESS_RUN) return;
        await startOnce('processRunWorkflow', {
          input: processRunInputSchema.parse({
            organizationId: event.organizationId,
            processRunId: event.aggregateId,
          }),
          workflowIdFor: processRunWorkflowIdFor,
        });
        return;

      // Only saves waiting for the run's next check. A stop is already committed by the time this goes.
      case PROCESS_RUN_WAKE:
      case PROCESS_RUN_STOP_REQUESTED:
        if (event.aggregateType !== AGGREGATE_PROCESS_RUN) return;
        try {
          await client.workflow
            .getHandle(
              processRunWorkflowIdFor(
                processRunInputSchema.parse({
                  organizationId: event.organizationId,
                  processRunId: event.aggregateId,
                }),
              ),
            )
            .signal(PROCESS_RUN_WAKE_SIGNAL);
        } catch (error) {
          if (!(error instanceof WorkflowNotFoundError)) throw error;
        }
        return;

      case OBJECT_MIGRATION_REQUESTED:
        if (event.aggregateType !== AGGREGATE_OBJECT_MIGRATION) return;
        await startOnce('objectMigrationWorkflow', {
          input: objectMigrationInputSchema.parse({
            organizationId: event.organizationId,
            migrationId: event.aggregateId,
          }),
          workflowIdFor: objectMigrationWorkflowIdFor,
        });
        return;

      // Revoked is final, so this runs once, and an open sync run can never swallow it. That run may
      // have read the row before the revoke committed, so it does not cover this, and this run does.
      case CONNECTION_REVOKED:
        if (event.aggregateType !== AGGREGATE_CONNECTION) return;
        await startOnce('connectorSyncWorkflow', {
          input: connectorSyncInputSchema.parse({
            organizationId: event.organizationId,
            connectionId: event.aggregateId,
          }),
          workflowIdFor: connectorRevokeWorkflowIdFor,
        });
        return;

      // Unlike those, this one is run again each time something asks. An open run covers it.
      case CONNECTOR_SYNC_REQUESTED: {
        if (event.aggregateType !== AGGREGATE_CONNECTION) return;
        const syncInput = connectorSyncInputSchema.parse({
          organizationId: event.organizationId,
          connectionId: event.aggregateId,
        });
        try {
          await client.workflow.start('connectorSyncWorkflow', {
            args: [syncInput],
            taskQueue: PLATFORM_TASK_QUEUE,
            workflowId: connectorSyncWorkflowIdFor(syncInput),
            workflowIdReusePolicy: 'ALLOW_DUPLICATE',
          });
        } catch (error) {
          if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        }
        return;
      }

      // M5 (ADR-029). Each ID can only ever run once: one document, one source's purge, one question.
      case KNOWLEDGE_DOCUMENT_RECEIVED:
        if (event.aggregateType !== AGGREGATE_KNOWLEDGE_DOCUMENT) return;
        await startOnce('knowledgeIngestWorkflow', {
          input: knowledgeIngestInputSchema.parse({
            organizationId: event.organizationId,
            documentId: event.aggregateId,
          }),
          workflowIdFor: knowledgeIngestWorkflowIdFor,
        });
        return;

      case KNOWLEDGE_SOURCE_CLOSED:
        if (event.aggregateType !== AGGREGATE_KNOWLEDGE_SOURCE) return;
        await startOnce('knowledgePurgeWorkflow', {
          input: knowledgePurgeInputSchema.parse({
            organizationId: event.organizationId,
            sourceId: event.aggregateId,
          }),
          workflowIdFor: knowledgePurgeWorkflowIdFor,
        });
        return;

      case KNOWLEDGE_ANSWER_REQUESTED:
        if (event.aggregateType !== AGGREGATE_KNOWLEDGE_ANSWER) return;
        await startOnce('knowledgeAnswerWorkflow', {
          input: knowledgeAnswerInputSchema.parse({
            organizationId: event.organizationId,
            answerId: event.aggregateId,
          }),
          workflowIdFor: knowledgeAnswerWorkflowIdFor,
        });
        return;

      case CLIENT_ONBOARDING_REQUESTED:
        if (event.aggregateType !== AGGREGATE_CLIENT_ONBOARDING) return;
        await startOnce('clientOnboardingWorkflow', {
          input: clientOnboardingInputSchema.parse({
            organizationId: event.organizationId,
            onboardingId: event.aggregateId,
          }),
          workflowIdFor: clientOnboardingWorkflowIdFor,
        });
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
  let nextBacklogCheckAt = Date.now() + LEDGER_BACKLOG_CHECK_MS;
  while (running) {
    beat();
    if (Date.now() >= nextBacklogCheckAt) {
      nextBacklogCheckAt = Date.now() + LEDGER_BACKLOG_CHECK_MS;
      await eventBacklog(db, TOMBSTONE_RECORDED).then(
        ({ queued, dead, oldestSeconds }) => {
          if (queued + dead > 0) {
            log.warn('tombstone_ledger.backlog', { count: queued + dead, oldestSeconds });
          }
        },
        (error: unknown) => {
          log.warn('tombstone_ledger.backlog_failed', { errorCode: errorCode(error) });
        },
      );
    }
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
      writeLedgerEntry.startBatch();
      const result = await dispatchDueEvents(db, handle, {
        classify: classifyDeliveryError,
        needsOnlyTheStore,
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
