// FD-23: the probe's workflow, with the SDK's proxy stood in for. Its real histories come from a Temporal
// server (tests/replay/capture-model-probe.test.ts) and replay in tests/replay/replay.test.ts.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_SCHEDULE_TO_START, AGENT_TASK_QUEUE } from './constants';

const sdk = vi.hoisted(() => {
  class ActivityFailure extends Error {}
  return {
    ActivityFailure,
    options: undefined as unknown,
    runModelProbe: vi.fn(),
  };
});

vi.mock('@temporalio/workflow', () => ({
  ActivityFailure: sdk.ActivityFailure,
  proxyActivities: (options: unknown) => {
    sdk.options = options;
    return { runModelProbe: sdk.runModelProbe };
  },
}));

const { modelProbeWorkflow } = await import('./model-probe');
const input = { organizationId: randomUUID(), modelProfileId: randomUUID() };

describe('modelProbeWorkflow', () => {
  it('runs on the agent queue, and says so if nothing is there to pick it up', () => {
    expect(sdk.options).toMatchObject({
      taskQueue: AGENT_TASK_QUEUE,
      scheduleToStartTimeout: AGENT_SCHEDULE_TO_START,
    });
  });

  it.each(['passed', 'failed', 'skipped'] as const)('hands back %s', async (outcome) => {
    sdk.runModelProbe.mockResolvedValueOnce(outcome);
    await expect(modelProbeWorkflow(input)).resolves.toBe(outcome);
    expect(sdk.runModelProbe).toHaveBeenLastCalledWith(input);
  });

  it('answers failed when the Activity never finished', async () => {
    sdk.runModelProbe.mockRejectedValueOnce(new sdk.ActivityFailure('no worker'));
    await expect(modelProbeWorkflow(input)).resolves.toBe('failed');
  });

  it('does not hide anything else, such as a cancellation', async () => {
    sdk.runModelProbe.mockRejectedValueOnce(new Error('cancelled'));
    await expect(modelProbeWorkflow(input)).rejects.toThrow('cancelled');
  });

  it('imports only what workflow code may', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./model-probe.ts', import.meta.url)),
      'utf8',
    );
    const values = [...source.matchAll(/^import (?!type )[^;]*? from '([^']+)'/gm)].map(
      (match) => match[1],
    );
    expect(values.sort()).toEqual(['./constants', '@temporalio/workflow']);
  });
});
