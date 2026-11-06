// One run of a process spec (AGENT-13, ADR-031 D7). Deterministic workflow code: only @temporalio/workflow and
// types may be imported here. All deciding is in the Activity, which reads PostgreSQL, so this file is a small
// loop that can run for weeks and stay replayable. Owned by the process slice. Changing the order of steps
// below needs a patch, and the replay corpus fails the build if that is forgotten.
import {
  condition,
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { ProcessRunActivities } from './process-run-activities';
import {
  PROCESS_RUN_WAKE_SIGNAL,
  type ProcessRunInput,
  type ProcessRunOutcome,
} from './product-schemas';

const { advanceRun } = proxyActivities<ProcessRunActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 10, initialInterval: '5 seconds', maximumInterval: '1 minute' },
});

const wake = defineSignal(PROCESS_RUN_WAKE_SIGNAL);

/** A lost signal costs at most this long. Nothing depends on one arriving. */
const CHECK_AGAIN = '5 minutes';

export async function processRunWorkflow(input: ProcessRunInput): Promise<ProcessRunOutcome> {
  let woken = false;
  setHandler(wake, () => {
    woken = true;
  });
  for (;;) {
    const step = await advanceRun({ ...input, temporalRunId: workflowInfo().runId });
    if (step.next === 'finished') return step.status;
    woken = false;
    await condition(() => woken, CHECK_AGAIN);
    if (workflowInfo().continueAsNewSuggested)
      await continueAsNew<typeof processRunWorkflow>(input);
  }
}
