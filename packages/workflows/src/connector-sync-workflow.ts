// Deterministic workflow code: only @temporalio/workflow, the queue names and types may be imported here.
// What to do is in the connection's row, and the cursor stays in PostgreSQL (CONNECT-01, ADR-027 D3).
import { isCancellation, proxyActivities } from '@temporalio/workflow';
import type { ConnectorSyncActivities } from './connector-sync-activities';
import { CONNECTOR_TASK_QUEUE } from './constants';
import type { ConnectorSyncInput, ConnectorSyncOutcome } from './schemas';

// On the queue only the connector worker polls, since a pass holds a credential. If that worker is not
// running, nothing is lost and the run says so after an hour. A retry is safe: a pass that dies has
// committed whole pages or nothing, and the next one carries on from the cursor.
const { syncConnection } = proxyActivities<ConnectorSyncActivities>({
  taskQueue: CONNECTOR_TASK_QUEUE,
  startToCloseTimeout: '10 minutes',
  scheduleToStartTimeout: '1 hour',
  retry: { maximumAttempts: 3, initialInterval: '5 seconds', maximumInterval: '1 minute' },
});

/**
 * A pass reading this many pages or more may have stopped at its limit, so another may have work. The
 * Activity holds the same number as SYNC_PAGES_PER_PASS, and a test keeps them equal. Extra passes cost
 * one read, because an idle stream has nothing to give.
 */
export const PAGES_PER_PASS = 20;
/** One run stops here, so a very large source cannot hold a run open forever. */
export const MAX_PASSES = 10;

/** Does what the connection's row says needs doing. Each request starts one, and an open run covers it. */
export async function connectorSyncWorkflow(
  input: ConnectorSyncInput,
): Promise<ConnectorSyncOutcome> {
  let pages = 0;
  let resources = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let result: ConnectorSyncOutcome;
    try {
      result = await syncConnection(input);
    } catch (error) {
      if (isCancellation(error)) throw error;
      // The connector worker was not there, or the database stayed away through every retry. Whatever
      // it reached is committed, and the next request carries on from there.
      return { outcome: 'failed', pages, resources };
    }
    pages += result.pages;
    resources += result.resources;
    if (result.outcome !== 'synced' || result.pages < PAGES_PER_PASS) {
      return { outcome: result.outcome, pages, resources };
    }
  }
  return { outcome: 'synced', pages, resources };
}
