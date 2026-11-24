import { describe, expect, it, vi } from 'vitest';
import { PLATFORM_TASK_QUEUE } from '@ensemus/workflows/constants';
import type { ScheduleClient } from '@temporalio/client';
import { ensureTenantSchedule, tenantScheduleOffsetSeconds } from './tenant-schedules';

const target = {
  scheduleId: 'reminders-72f890af-7768-4baf-b62b-b664e6cf4550',
  organizationId: '72f890af-7768-4baf-b62b-b664e6cf4550',
  workflowType: 'tenantRemindersWorkflow',
  everySeconds: 900,
};

function setup() {
  const describeSchedule = vi.fn();
  const updateSchedule = vi.fn();
  const create = vi.fn();
  const client = {
    options: { namespace: 'generated', identity: 'test' },
    workflowService: { describeSchedule, updateSchedule },
    create,
  } as unknown as ScheduleClient;
  return { client, describeSchedule, updateSchedule, create };
}

const legacy = {
  spec: { interval: [{ interval: { seconds: 900 } }] },
  action: {
    startWorkflow: {
      workflowType: { name: target.workflowType },
      taskQueue: { name: PLATFORM_TASK_QUEUE },
      input: { payloads: [{ data: Uint8Array.of(42) }] },
    },
  },
  state: { paused: true, notes: 'An operator paused this schedule' },
};

describe('dispatcher schedule phases', () => {
  it('distributes stable nonzero whole-second phases across tenant and workflow ids', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `knowledge-sweep-generated-${i}`);
    const offsets = ids.map((id) => tenantScheduleOffsetSeconds(id, 900));
    expect(Math.min(...offsets)).toBeGreaterThan(0);
    expect(Math.max(...offsets)).toBeLessThan(900);
    expect(new Set(offsets).size).toBeGreaterThan(350);
    expect(ids.map((id) => tenantScheduleOffsetSeconds(id, 900))).toEqual(offsets);
  });

  it('creates a schedule with standard cadence, overlap policy and the generated phase', async () => {
    const { client, create, describeSchedule } = setup();
    await ensureTenantSchedule(client, target);
    expect(describeSchedule).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      scheduleId: target.scheduleId,
      spec: {
        intervals: [
          { every: 900_000, offset: tenantScheduleOffsetSeconds(target.scheduleId, 900) * 1_000 },
        ],
      },
      policies: { overlap: 'SKIP' },
      action: {
        type: 'startWorkflow',
        workflowType: target.workflowType,
        args: [{ organizationId: target.organizationId }],
        taskQueue: PLATFORM_TASK_QUEUE,
      },
    });
  });

  it('updates the legacy phase while preserving action payload and pause state', async () => {
    const { client, updateSchedule, describeSchedule, create } = setup();
    const conflictToken = Uint8Array.of(1);
    describeSchedule.mockResolvedValue({ schedule: legacy, conflictToken });
    await ensureTenantSchedule(client, target, true);
    expect(create).not.toHaveBeenCalled();
    expect(updateSchedule).toHaveBeenCalledWith({
      namespace: 'generated',
      identity: 'test',
      scheduleId: target.scheduleId,
      conflictToken,
      requestId: expect.any(String),
      schedule: {
        ...legacy,
        spec: {
          interval: [
            {
              interval: { seconds: 900 },
              phase: expect.anything(),
            },
          ],
        },
      },
    });
    const phase = updateSchedule.mock.calls[0]?.[0].schedule.spec.interval[0].phase;
    expect(Number(phase.seconds)).toBe(tenantScheduleOffsetSeconds(target.scheduleId, 900));
  });

  it('leaves a customized schedule or an unfenced snapshot alone', async () => {
    const { client, updateSchedule, describeSchedule, create } = setup();
    describeSchedule.mockResolvedValueOnce({ schedule: legacy }).mockResolvedValueOnce({
      schedule: { ...legacy, spec: { ...legacy.spec, jitter: { seconds: 30 } } },
      conflictToken: Uint8Array.of(1),
    });
    await ensureTenantSchedule(client, target, true);
    await ensureTenantSchedule(client, target, true);
    expect(create).not.toHaveBeenCalled();
    expect(updateSchedule).not.toHaveBeenCalled();
  });
});
