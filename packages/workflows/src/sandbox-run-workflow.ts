// Owned by the sandbox-runs slice (EXP-05). See docs/06-delivery/m11b-slices.md and ADR-034 D3. Deterministic
// workflow code: only @temporalio/workflow and types may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { SandboxRunInput, SandboxRunResult } from './schemas';

/**
 * Takes one queued run to a settled status. The execute Activity is proxied to SANDBOX_TASK_QUEUE, with a
 * schedule-to-start limit, so a deployment with no sandbox worker settles `runner_unavailable` from the
 * platform queue rather than waiting for ever. Cancelling the workflow cancels the Activity, which tells
 * the runner to kill the job.
 */
export async function sandboxRunWorkflow(_input: SandboxRunInput): Promise<SandboxRunResult> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
