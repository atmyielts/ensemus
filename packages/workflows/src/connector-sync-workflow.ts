// Owned by the sdk slice (CONNECT-01). See docs/06-delivery/m3-slices.md and ADR-027 D3. Deterministic
// workflow code: only @temporalio/workflow and types may be imported here.
import { ApplicationFailure } from '@temporalio/workflow';
import type { ConnectorSyncInput, ConnectorSyncOutcome } from './schemas';

/** Does what the connection's row says needs doing. No event starts this until M3 lands. */
export async function connectorSyncWorkflow(
  _input: ConnectorSyncInput,
): Promise<ConnectorSyncOutcome> {
  throw ApplicationFailure.nonRetryable('Not built yet', 'NOT_IMPLEMENTED');
}
