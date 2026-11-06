// Owned by the mcp slice (CONNECT-03). See docs/06-delivery/m5-slices.md. Runs in the connector worker. Asks
// each MCP server what it offers, and stores that as data for an admin to read.
import type { ConnectorActivityDeps } from './connector-deps';

export type McpRefreshInput = { organizationId: string; connectionId: string };
export type McpRefreshOutcome = {
  outcome: 'refreshed' | 'nothing_to_do' | 'failed';
  added: number;
  changed: number;
  removed: number;
};

export function createMcpActivities(_deps: ConnectorActivityDeps) {
  return {
    async refreshMcpTools(_input: McpRefreshInput): Promise<McpRefreshOutcome> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type McpActivities = ReturnType<typeof createMcpActivities>;
