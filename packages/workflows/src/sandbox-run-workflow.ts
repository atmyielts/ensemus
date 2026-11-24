// Workflow payloads carry the admitted run and tenant IDs only. Jobs remain on their own queue.
import {
  ActivityCancellationType,
  CancellationScope,
  proxyActivities,
  sleep,
} from '@temporalio/workflow';
import type { SandboxRunActivities, SandboxRunPlatformActivities } from './sandbox-run-activities';
import { SANDBOX_TASK_QUEUE } from './constants';
import type { SandboxRunInput, SandboxRunResult } from './schemas';

const execute = proxyActivities<SandboxRunActivities>({
  taskQueue: SANDBOX_TASK_QUEUE,
  scheduleToStartTimeout: '15 seconds',
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '15 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 1 },
});
const platform = proxyActivities<SandboxRunPlatformActivities>({
  startToCloseTimeout: '30 seconds',
  scheduleToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

export async function sandboxRunWorkflow(input: SandboxRunInput): Promise<SandboxRunResult> {
  try {
    // Bound capacity waits as well as failed attempts. The database independently caps attempts.
    for (let turn = 0; turn < 20; turn += 1) {
      const step = await execute.executeSandboxRun(input);
      if (step.step === 'settled')
        return { sandboxRunId: input.sandboxRunId, outcome: step.outcome };
      await sleep(step.afterMs);
    }
  } catch {
    // The activity may never have started or may have lost its runner. Neither proves execution.
    // The platform settlement also preserves a queued cancellation already committed by the API.
  }
  return {
    sandboxRunId: input.sandboxRunId,
    outcome: await CancellationScope.nonCancellable(() => platform.abandonSandboxRun(input)),
  };
}
