import { beforeEach, describe, expect, it, vi } from 'vitest';

const temporal = vi.hoisted(() => ({
  advance: vi.fn(),
  finish: vi.fn(),
  keepWake: true,
  signal: () => {},
  observed: [] as boolean[],
}));
vi.mock('@temporalio/workflow', () => ({
  CancellationScope: { nonCancellable: (effect: () => Promise<unknown>) => effect() },
  condition: async (predicate: () => boolean) => {
    temporal.observed.push(predicate());
  },
  continueAsNew: vi.fn(),
  defineSignal: () => 'processRunWake',
  isCancellation: () => false,
  patched: () => temporal.keepWake,
  proxyActivities: () => ({ advanceRun: temporal.advance, finishRun: temporal.finish }),
  setHandler: (_signal: unknown, handler: () => void) => {
    temporal.signal = handler;
  },
  workflowInfo: () => ({ runId: 'generated-temporal-run', continueAsNewSuggested: false }),
}));
import { processRunWorkflow } from '../../packages/workflows/src/process-run-workflow';

describe('process wake received during an Activity', () => {
  beforeEach(() => {
    temporal.advance.mockReset();
    temporal.finish.mockReset();
    temporal.observed = [];
    temporal.keepWake = true;
    temporal.advance
      .mockImplementationOnce(async () => {
        // Confirmation can commit while a previously started Activity is returning "wait".
        temporal.signal();
        await Promise.resolve();
        return { next: 'wait' };
      })
      .mockResolvedValueOnce({ next: 'finished', status: 'completed' });
  });
  it.each([true, false])(
    'preserves new behavior or old replay decisions: patch=%s',
    async (patched) => {
      temporal.keepWake = patched;
      await expect(
        processRunWorkflow({
          organizationId: '00000000-0000-4000-8000-000000000001',
          processRunId: '00000000-0000-4000-8000-000000000002',
        }),
      ).resolves.toBe('completed');
      expect(temporal.observed).toEqual([patched]);
      expect(temporal.advance).toHaveBeenCalledTimes(2);
      expect(temporal.finish).not.toHaveBeenCalled();
    },
  );
});
