// Owned by the connectors slice (CONNECT-05). See docs/06-delivery/m5-slices.md and ADR-029 D11. Tested
// against a local fake only. No real Microsoft tenant, client or token has been used.
import type { KnowledgeConnector, ProviderHttpClient } from '../knowledge';

export type Microsoft365Config = {
  /** Drives to read, by Graph ID. Never a host. */
  driveIds: readonly string[];
  grantedScopes: readonly string[];
};

export function createMicrosoft365Connector(_deps: {
  http: ProviderHttpClient;
}): KnowledgeConnector<Microsoft365Config> {
  throw new Error('NOT_IMPLEMENTED');
}
