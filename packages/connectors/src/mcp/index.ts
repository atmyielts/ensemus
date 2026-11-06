// Owned by the mcp slice (CONNECT-03). See docs/06-delivery/m5-slices.md and ADR-029 D11. JSON-RPC over the
// gateway, and nothing that server says is trusted. Tested against a local fake only.
import type { Connector, ConnectorContext } from '../index';
import type { McpToolDescription, ProviderHttpClient } from '../knowledge';

export type McpServerConfig = {
  /** A path on the operator's one configured server. It can never name a host. */
  endpointPath: string;
};

export type McpCallResult = {
  /** Bounded, and treated as untrusted tool output by M4's gateway. */
  content: unknown;
  isError: boolean;
};

export interface McpClient {
  listTools(context: ConnectorContext<McpServerConfig>): Promise<readonly McpToolDescription[]>;
  /** M4's tool gateway is the only caller, once `loadCallableMcpTool` has allowed it. */
  callTool(
    context: ConnectorContext<McpServerConfig>,
    call: { name: string; arguments: unknown; timeoutMs: number },
  ): Promise<McpCallResult>;
}

export function createMcpConnector(_deps: {
  http: ProviderHttpClient;
}): Connector<McpServerConfig> & { readonly mcp: McpClient } {
  throw new Error('NOT_IMPLEMENTED');
}

/** SHA-256 over canonical JSON of a tool's whole description, so any change at all loses its approval. */
export function mcpDefinitionHash(_definition: unknown): string {
  throw new Error('NOT_IMPLEMENTED');
}
