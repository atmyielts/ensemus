// Deterministic workflow code (ADR-038 D1, D4). Only @temporalio/workflow, the queue names and types may be
// imported here. A Temporal Schedule runs it for each tenant, and the dispatcher runs it again when the web
// tier ends a consent attempt, so that attempt's sealed values are revoked at once.
import { isCancellation, patched, proxyActivities } from '@temporalio/workflow';
import { CONNECTOR_TASK_QUEUE } from './constants';
import type { TenantInput } from './schemas';
import type { SuiteUpkeepActivities } from './suite-upkeep-activities';

// On the connector worker, the only one holding the broker. If it is not running, this run ends having
// done nothing, and the next one on the schedule tries again. Both sweeps are safe to repeat.
const { sweepOAuthAttempts, holdDirectories, sweepSuiteReads } =
  proxyActivities<SuiteUpkeepActivities>({
    taskQueue: CONNECTOR_TASK_QUEUE,
    startToCloseTimeout: '5 minutes',
    scheduleToStartTimeout: '10 minutes',
    retry: { maximumAttempts: 3, initialInterval: '5 seconds', maximumInterval: '1 minute' },
  });

export type SuiteUpkeepResult = { swept: boolean; held: boolean; reads?: boolean };

/** Runs one sweep. A failure is the next run's to retry. A cancellation still ends the run. */
async function attempt(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    if (isCancellation(error)) throw error;
    return false;
  }
}

/** Every sweep for one tenant. One failing does not stop the others. */
export async function suiteUpkeepWorkflow(input: TenantInput): Promise<SuiteUpkeepResult> {
  const swept = await attempt(() => sweepOAuthAttempts(input));
  const held = await attempt(() => holdDirectories(input));
  // A history written before uncollected reads were swept never reaches this, so it replays as it ran.
  if (!patched('suite-upkeep-reads-v1')) return { swept, held };
  const reads = await attempt(() => sweepSuiteReads(input));
  return { swept, held, reads };
}
