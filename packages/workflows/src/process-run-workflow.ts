// One run of a process spec (AGENT-13, ADR-031 D7). Deterministic workflow code: only @temporalio/workflow and
// types may be imported here. All deciding is in the Activity, which reads PostgreSQL, so this file is a small
// loop that can run for weeks and stay replayable. Owned by the process slice. Changing the order of steps
// below needs a patch, and the replay corpus fails the build if that is forgotten.
import {
  CancellationScope,
  condition,
  continueAsNew,
  defineSignal,
  isCancellation,
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

const { advanceRun, finishRun } = proxyActivities<ProcessRunActivities>({
  startToCloseTimeout: '2 minutes',
  // A refusal does not change by asking again. A database that is away for a moment does.
  retry: {
    maximumAttempts: 10,
    initialInterval: '5 seconds',
    maximumInterval: '1 minute',
    nonRetryableErrorTypes: ['AppError'],
  },
});

const wake = defineSignal(PROCESS_RUN_WAKE_SIGNAL);

/** A lost signal costs at most this long. Nothing depends on one arriving. */
const CHECK_AGAIN = '5 minutes';

/** What a run says when the worker could not take it further, so it does not look as if it is still going. */
const ADVANCE_FAILED = 'ADVANCE_FAILED';

export async function processRunWorkflow(input: ProcessRunInput): Promise<ProcessRunOutcome> {
  let woken = false;
  setHandler(wake, () => {
    woken = true;
  });
  for (;;) {
    let step;
    try {
      step = await advanceRun({ ...input, temporalRunId: workflowInfo().runId });
    } catch (error) {
      if (isCancellation(error)) throw error;
      // Report it honestly. If even that fails, the workflow fails and stays visible.
      await CancellationScope.nonCancellable(() => finishRun({ ...input, code: ADVANCE_FAILED }));
      return 'failed';
    }
    if (step.next === 'finished') return step.status;
    woken = false;
    await condition(() => woken, CHECK_AGAIN);
    if (workflowInfo().continueAsNewSuggested)
      await continueAsNew<typeof processRunWorkflow>(input);
  }
}
