// Deterministic workflow code. Only @temporalio/workflow and types may be imported here, because
// this runs in a sandboxed VM and is replayed from history.
import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { Activities } from './activities';
import type { ProbeInput, ProbeResult } from './schemas';

const { recordProbeStep } = proxyActivities<Activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export const releaseProbeSignal = defineSignal('releaseProbe');

/**
 * The deployment smoke test: proves workers poll, survive restarts, wait durably, take signals and
 * honor cancellation, with no business data involved. It is the template for approval waits in M2.
 */
export async function platformProbeWorkflow(input: ProbeInput): Promise<ProbeResult> {
  let released = false;
  setHandler(releaseProbeSignal, () => {
    released = true;
  });
  await recordProbeStep(input.probeId, 'started');
  await condition(() => released);
  await recordProbeStep(input.probeId, 'finished');
  return { probeId: input.probeId, outcome: 'completed', steps: 2 };
}
