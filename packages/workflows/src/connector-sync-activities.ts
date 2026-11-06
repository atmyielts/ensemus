// Owned by the sdk slice (CONNECT-01). See docs/06-delivery/m3-slices.md and ADR-027 D3.
import type { ConnectorActivityDeps } from './connector-deps';
import type { ConnectorSyncInput, ConnectorSyncOutcome } from './schemas';

export function createConnectorSyncActivities(_deps: ConnectorActivityDeps) {
  return {
    /** One pass, bounded by page count. A revoked connection has its secret revoked instead. */
    async syncConnection(_input: ConnectorSyncInput): Promise<ConnectorSyncOutcome> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type ConnectorSyncActivities = ReturnType<typeof createConnectorSyncActivities>;
