// Owned by the connectors slice (CONNECT-04). See docs/06-delivery/m5-slices.md and ADR-029 D11. Tested
// against a local fake only. No real Google account, client or token has been used.
import type { KnowledgeConnector, ProviderHttpClient } from '../knowledge';

export type GoogleWorkspaceConfig = {
  /** Shared drives to read, by ID. Empty means what the granted account can see. Never a host. */
  driveIds: readonly string[];
  /** The scopes the admin consented to, copied from the connection. A stream needing another is refused. */
  grantedScopes: readonly string[];
};

export function createGoogleWorkspaceConnector(_deps: {
  http: ProviderHttpClient;
}): KnowledgeConnector<GoogleWorkspaceConfig> {
  throw new Error('NOT_IMPLEMENTED');
}
