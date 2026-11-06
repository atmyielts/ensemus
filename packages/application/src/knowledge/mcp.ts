// Owned by the mcp slice (CONNECT-03). See docs/06-delivery/m5-slices.md and ADR-029 D11. What an MCP
// server says about its tools is data for an admin to read, and it confers nothing.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { McpSideEffect, McpToolState } from '@ensemus/domain/knowledge';
import type { Classification } from '@ensemus/domain/policy';

export type McpToolView = {
  id: string;
  connectionId: string;
  toolName: string;
  /** The server's own words, for the review page, marked there as coming from the server. */
  definition: unknown;
  definitionSha256: string;
  status: McpToolState;
  sideEffectLevel: McpSideEffect | null;
  allowedClasses: readonly Classification[];
  reviewedByMembershipId: string | null;
  reviewedAt: Date | null;
  version: number;
};

/**
 * The worker's half. New tools arrive unreviewed, a changed definition loses its approval (a trigger holds
 * this), and a tool the server no longer lists becomes `removed`. Safe to repeat.
 */
export function recordMcpToolList(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    connectionId: string;
    tools: readonly { name: string; definition: unknown; definitionSha256: string }[];
  },
): Promise<{ added: number; changed: number; removed: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Needs `connection.manage`. */
export function listMcpTools(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { connectionId: string },
): Promise<readonly McpToolView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Needs `connection.manage` and a user context. Approving sets the side-effect level and classes the admin
 * chose, and nothing is read from the server's annotations to choose them. Audited with IDs.
 */
export function reviewMcpTool(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    toolId: string;
    expectedVersion: number;
    decision: 'approve' | 'reject';
    sideEffectLevel?: McpSideEffect;
    allowedClasses?: readonly Classification[];
  },
): Promise<{ status: McpToolState; version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * What M4's tool gateway calls before it lets a run call an MCP tool: approved, at this exact definition,
 * on an active connection, for this class. MCP_TOOL_NOT_APPROVED otherwise. `read_only` runs through the
 * gateway. `external_write` has to become an M3 external action, so it gets approval and a receipt.
 */
export function loadCallableMcpTool(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { toolId: string; classification: Classification },
): Promise<{
  toolName: string;
  connectionId: string;
  definitionSha256: string;
  sideEffectLevel: McpSideEffect;
}> {
  throw new Error('NOT_IMPLEMENTED');
}
