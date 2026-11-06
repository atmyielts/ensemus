// Owned by the mcp slice (CONNECT-03). See docs/06-delivery/m5-slices.md. Runs in the connector worker. Asks
// each MCP server what it offers, and stores that as data for an admin to read.
import type { ConnectorActivityDeps } from './connector-deps';
import { connections, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { recordMcpToolList } from '@ensemus/application/knowledge/mcp';
import { mcpDefinitionHash, type McpClient, type McpServerConfig } from '@ensemus/connectors/mcp';
import { eq } from 'drizzle-orm';

export type McpRefreshInput = { organizationId: string; connectionId: string };
export type McpRefreshOutcome = {
  outcome: 'refreshed' | 'nothing_to_do' | 'failed';
  added: number;
  changed: number;
  removed: number;
};

export function createMcpActivities(deps: ConnectorActivityDeps) {
  return {
    async refreshMcpTools(input: McpRefreshInput): Promise<McpRefreshOutcome> {
      const context = createServiceContext(input.organizationId);
      const [connection] = await withTenantTx(deps.database, context, (tx) =>
        tx.select().from(connections).where(eq(connections.id, input.connectionId)),
      );
      if (!connection || connection.state !== 'active' || connection.connectorType !== 'mcp_server')
        return { outcome: 'nothing_to_do', added: 0, changed: 0, removed: 0 };
      const connector = deps.registry.get('mcp_server');
      if (!connector || !('mcp' in connector))
        return { outcome: 'failed', added: 0, changed: 0, removed: 0 };
      try {
        const mcp = (connector as typeof connector & { mcp: McpClient }).mcp;
        const config = connector.parseConfig(connection.config) as McpServerConfig;
        const result = await mcp.listToolsWithReport({
          organizationId: context.organizationId,
          connectionId: connection.id,
          config,
          network: deps.network,
          signal: AbortSignal.timeout(60_000),
          credentials: {
            withCredential: async (use) => {
              if (!connection.credentialSecretId) throw new Error('CREDENTIAL_UNAVAILABLE');
              return deps.secrets.withSecret(
                {
                  organizationId: context.organizationId,
                  secretId: connection.credentialSecretId,
                  purpose: connector.manifest.credential.purpose,
                },
                use,
              );
            },
          },
        });
        const counts = await recordMcpToolList(deps.database, context, {
          connectionId: connection.id,
          tools: result.tools.map((tool) => ({
            name: tool.name,
            definition: tool.definition,
            definitionSha256: mcpDefinitionHash(tool.definition),
          })),
        });
        await withTenantTx(deps.database, context, (tx) =>
          tx
            .update(connections)
            .set({
              lastErrorCode: result.skipped ? 'MCP_DEFINITION_REJECTED' : null,
              lastErrorAt: result.skipped ? new Date() : null,
            })
            .where(eq(connections.id, connection.id)),
        );
        return { outcome: 'refreshed', ...counts };
      } catch {
        await withTenantTx(deps.database, context, (tx) =>
          tx
            .update(connections)
            .set({ lastErrorCode: 'MCP_UNAVAILABLE', lastErrorAt: new Date() })
            .where(eq(connections.id, connection.id)),
        );
        return { outcome: 'failed', added: 0, changed: 0, removed: 0 };
      }
    },
  };
}
export type McpActivities = ReturnType<typeof createMcpActivities>;
