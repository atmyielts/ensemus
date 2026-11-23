import { createHash, randomUUID } from 'node:crypto';
import { PLATFORM_TASK_QUEUE } from '@ensemus/workflows/constants';
import type { TenantInput } from '@ensemus/workflows/schemas';
import {
  isGrpcServiceError,
  ScheduleAlreadyRunning,
  ScheduleOverlapPolicy,
  type ScheduleClient,
} from '@temporalio/client';
import temporalProto from '@temporalio/proto';

type TenantSchedule = {
  scheduleId: string;
  organizationId: string;
  workflowType: string;
  everySeconds: number;
};

const GRPC_NOT_FOUND = 5;

// Stable across retries and restarts. Different schedules for the same tenant get independent phases.
export function tenantScheduleOffsetSeconds(scheduleId: string, everySeconds: number): number {
  return 1 + (createHash('sha256').update(scheduleId).digest().readUInt32BE() % (everySeconds - 1));
}

/** Rephase only the original single-interval definition. Send the raw action so encrypted input and
 * operator settings survive unchanged, and use Temporal's conflict token to fence concurrent edits. */
async function retimeExisting(client: ScheduleClient, target: TenantSchedule): Promise<boolean> {
  const { scheduleId, workflowType, everySeconds } = target;
  const { namespace, identity } = client.options;
  let response;
  try {
    response = await client.workflowService.describeSchedule({ namespace, scheduleId });
  } catch (error) {
    if (isGrpcServiceError(error) && error.code === GRPC_NOT_FOUND) return false;
    throw error;
  }

  const { schedule, conflictToken } = response;
  const spec = schedule?.spec;
  const interval = spec?.interval?.[0];
  const workflow = schedule?.action?.startWorkflow;
  if (
    !schedule ||
    !conflictToken?.length ||
    !spec ||
    spec.interval?.length !== 1 ||
    !interval?.interval ||
    Number(interval.interval.seconds) !== everySeconds ||
    interval.interval.nanos ||
    Number(interval.phase?.seconds ?? 0) ||
    interval.phase?.nanos ||
    spec.calendar?.length ||
    spec.structuredCalendar?.length ||
    spec.cronString?.length ||
    spec.excludeCalendar?.length ||
    spec.excludeStructuredCalendar?.length ||
    spec.startTime ||
    spec.endTime ||
    Number(spec.jitter?.seconds ?? 0) ||
    spec.jitter?.nanos ||
    workflow?.workflowType?.name !== workflowType ||
    workflow.taskQueue?.name !== PLATFORM_TASK_QUEUE
  ) {
    return true;
  }

  try {
    await client.workflowService.updateSchedule({
      namespace,
      scheduleId,
      identity,
      requestId: randomUUID(),
      conflictToken,
      schedule: {
        ...schedule,
        spec: {
          ...spec,
          interval: [
            {
              ...interval,
              phase: temporalProto.google.protobuf.Duration.fromObject({
                seconds: tenantScheduleOffsetSeconds(scheduleId, everySeconds),
              }),
            },
          ],
        },
      },
    });
  } catch (error) {
    // A concurrent offboarding may have removed it. An update must never recreate that schedule.
    if (!(isGrpcServiceError(error) && error.code === GRPC_NOT_FOUND)) throw error;
  }
  return true;
}

/** Retiming is done in the background reconciliation, outside foreground outbox delivery. */
export async function ensureTenantSchedule(
  client: ScheduleClient,
  target: TenantSchedule,
  reconcile = false,
): Promise<void> {
  if (reconcile && (await retimeExisting(client, target))) return;

  const { scheduleId, workflowType, organizationId, everySeconds } = target;
  const input: TenantInput = { organizationId };
  try {
    await client.create({
      scheduleId,
      spec: {
        intervals: [
          {
            every: everySeconds * 1_000,
            offset: tenantScheduleOffsetSeconds(scheduleId, everySeconds) * 1_000,
          },
        ],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
      action: {
        type: 'startWorkflow',
        workflowType,
        args: [input],
        taskQueue: PLATFORM_TASK_QUEUE,
      },
    });
  } catch (error) {
    if (!(error instanceof ScheduleAlreadyRunning)) throw error;
  }
}
