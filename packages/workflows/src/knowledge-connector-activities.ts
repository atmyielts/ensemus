// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md. Runs in the connector worker,
// which holds the credential. It stages bytes and does not parse them: reading what a stranger wrote is the
// knowledge worker's, which holds no credential (ADR-029 D4).
import type { ConnectorActivityDeps } from './connector-deps';

export type FetchInput = { organizationId: string; externalResourceId: string };
export type FetchOutcome = { outcome: 'staged' | 'unchanged' | 'gone' | 'failed'; bytes: number };

export function createKnowledgeConnectorActivities(_deps: ConnectorActivityDeps) {
  return {
    async fetchConnectorContent(_input: FetchInput): Promise<FetchOutcome> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type KnowledgeConnectorActivities = ReturnType<typeof createKnowledgeConnectorActivities>;
