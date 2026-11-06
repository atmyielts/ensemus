// Owned by the model-profiles slice (MODEL-01). See docs/06-delivery/m4-slices.md and ADR-028 FD-23.
// Deterministic workflow code: only @temporalio/workflow, constants and types may be imported here. Its
// shape is in the replay corpus, so changing the order of anything below needs `patched`.
import { ActivityFailure, proxyActivities } from '@temporalio/workflow';
import type { ModelProbeInput, ModelProbeOutcome } from './agent-schemas';
import { AGENT_SCHEDULE_TO_START, AGENT_TASK_QUEUE } from './constants';
import type { ModelProbeActivities } from './model-probe-activities';

// The Activity runs where the key can be opened, and nowhere else. A second attempt repeats a small paid
// call, so there is only one, and it is there for a database that failed as the result was being written.
const { runModelProbe } = proxyActivities<ModelProbeActivities>({
  taskQueue: AGENT_TASK_QUEUE,
  scheduleToStartTimeout: AGENT_SCHEDULE_TO_START,
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 2, initialInterval: '5 seconds' },
});

/**
 * Sends one synthetic prompt from agent-worker, and writes whether the profile passed. If the Activity
 * never finishes, because agent-worker is away, nothing can write the result: only that role may. So the
 * answer is `failed` and the profile says it is still being tested, until someone asks again.
 */
export async function modelProbeWorkflow(input: ModelProbeInput): Promise<ModelProbeOutcome> {
  try {
    return await runModelProbe(input);
  } catch (error) {
    if (error instanceof ActivityFailure) return 'failed';
    throw error;
  }
}
