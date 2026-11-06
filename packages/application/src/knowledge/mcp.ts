// Owned by the mcp slice (CONNECT-03). See docs/06-delivery/m5-slices.md and ADR-029 D11. What an MCP
// server says about its tools is data for an admin to read, and it confers nothing.
import { createHash } from 'node:crypto';
import {
  appendAudit,
  connections,
  mcpTools,
  memberships,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import type { McpSideEffect, McpToolState } from '@ensemus/domain/knowledge';
import { can, type Classification } from '@ensemus/domain/policy';
import { canonicalJson } from '@ensemus/domain/approval';
import { MCP_TOOL_REVIEWED } from '@ensemus/domain/knowledge-events';
import { and, asc, eq, sql } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { idSchema } from '../ids';
import { emit } from '../events';
import { requireSearchPerson } from './retrieval';

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
export async function recordMcpToolList(
  database: AppDatabase,
  context: TenantContext,
  input: {
    connectionId: string;
    tools: readonly { name: string; definition: unknown; definitionSha256: string }[];
  },
): Promise<{ added: number; changed: number; removed: number }> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const connectionId = id(input.connectionId),
    names = new Set<string>();
  let bytes = 0;
  if (input.tools.length > 1000) throw new AppError('INVALID_INPUT');
  for (const tool of input.tools) {
    if (!tool.name || tool.name.length > 128 || /[\0\r\n]/.test(tool.name) || names.has(tool.name))
      throw new AppError('INVALID_INPUT');
    names.add(tool.name);
    const value = tool.definition as Record<string, unknown> | null;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value.name !== tool.name ||
      definitionHash(value) !== tool.definitionSha256
    )
      throw new AppError('INVALID_INPUT');
    try {
      const size = Buffer.byteLength(JSON.stringify(value));
      if (size > 65536 || bytes + size > 2_097_152) throw new Error('TOO_LARGE');
      bytes += size;
    } catch {
      throw new AppError('INVALID_INPUT');
    }
  }
  return safe(() =>
    withTenantTx(database, context, async (tx) => {
      await connection(tx, connectionId, 'update');
      // PostgreSQL's JSONB text includes spaces that compact JSON omits. Check the actual stored size.
      if (input.tools.length) {
        const size = await tx.execute(
          sql`select 1 from jsonb_array_elements(${JSON.stringify(input.tools.map((tool) => tool.definition))}::jsonb) value where octet_length(value::text)>65536 limit 1`,
        );
        if (size.rows.length) throw new AppError('INVALID_INPUT');
      }
      const existing = await tx
        .select()
        .from(mcpTools)
        .where(eq(mcpTools.connectionId, connectionId))
        .for('update');
      const byName = new Map(existing.map((tool) => [tool.toolName, tool]));
      let added = 0,
        changed = 0,
        removed = 0;
      for (const tool of input.tools) {
        const previous = byName.get(tool.name);
        if (!previous) {
          await tx
            .insert(mcpTools)
            .values({
              organizationId: context.organizationId,
              connectionId,
              toolName: tool.name,
              definition: tool.definition,
              definitionSha256: tool.definitionSha256,
            });
          added++;
        } else if (
          previous.definitionSha256 !== tool.definitionSha256 ||
          previous.status === 'removed'
        ) {
          await tx
            .update(mcpTools)
            .set({
              definition: tool.definition,
              definitionSha256: tool.definitionSha256,
              status: 'pending_review',
              sideEffectLevel: null,
              allowedClasses: [],
              reviewedByMembershipId: null,
              reviewedAt: null,
              version: previous.version + 1,
              updatedAt: new Date(),
            })
            .where(eq(mcpTools.id, previous.id));
          changed++;
        }
      }
      for (const tool of existing)
        if (!names.has(tool.toolName) && tool.status !== 'removed') {
          await tx
            .update(mcpTools)
            .set({
              status: 'removed',
              sideEffectLevel: null,
              allowedClasses: [],
              reviewedByMembershipId: null,
              reviewedAt: null,
              version: tool.version + 1,
              updatedAt: new Date(),
            })
            .where(eq(mcpTools.id, tool.id));
          removed++;
        }
      if (added || changed || removed)
        await appendAudit(tx, {
          organizationId: context.organizationId,
          actorType: 'system',
          action: 'mcp.tools_refreshed',
          targetRef: `connection:${connectionId}`,
          decision: 'allow',
        });
      return { added, changed, removed };
    }),
  );
}

/** Needs `connection.manage`. */
export async function listMcpTools(
  database: AppDatabase,
  context: TenantContext,
  input: { connectionId: string },
): Promise<readonly McpToolView[]> {
  const connectionId = id(input.connectionId);
  return withTenantTx(database, context, async (tx) => {
    await manager(tx, context);
    await connection(tx, connectionId, 'share', false);
    const rows = await tx
      .select()
      .from(mcpTools)
      .where(eq(mcpTools.connectionId, connectionId))
      .orderBy(asc(mcpTools.toolName));
    return rows.map((row) => ({
      id: row.id,
      connectionId: row.connectionId,
      toolName: row.toolName,
      definition: row.definition,
      definitionSha256: row.definitionSha256,
      status: row.status as McpToolState,
      sideEffectLevel: row.sideEffectLevel as McpSideEffect | null,
      allowedClasses: row.allowedClasses as Classification[],
      reviewedByMembershipId: row.reviewedByMembershipId,
      reviewedAt: row.reviewedAt,
      version: row.version,
    }));
  });
}

/**
 * Needs `connection.manage` and a user context. Approving sets the side-effect level and classes the admin
 * chose, and nothing is read from the server's annotations to choose them. Audited with IDs.
 */
export async function reviewMcpTool(
  database: AppDatabase,
  context: TenantContext,
  input: {
    toolId: string;
    expectedVersion: number;
    decision: 'approve' | 'reject';
    sideEffectLevel?: McpSideEffect;
    allowedClasses?: readonly Classification[];
  },
): Promise<{ status: McpToolState; version: number }> {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  const toolId = id(input.toolId),
    classes = [...new Set(input.allowedClasses ?? [])];
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    !['approve', 'reject'].includes(input.decision)
  )
    throw new AppError('INVALID_INPUT');
  if (classes.includes('restricted')) throw new AppError('RESTRICTED_NOT_ALLOWED');
  if (
    classes.some((value) => !['public', 'internal', 'confidential'].includes(value)) ||
    (input.decision === 'approve' &&
      !['read_only', 'external_write'].includes(input.sideEffectLevel ?? ''))
  )
    throw new AppError('INVALID_INPUT');
  return safe(() =>
    withTenantTx(database, context, async (tx) => {
      await manager(tx, context);
      const [found] = await tx
        .select({ connectionId: mcpTools.connectionId })
        .from(mcpTools)
        .where(eq(mcpTools.id, toolId));
      if (!found) throw new AppError('NOT_FOUND');
      await connection(tx, found.connectionId, 'share');
      const [tool] = await tx.select().from(mcpTools).where(eq(mcpTools.id, toolId)).for('update');
      if (!tool || tool.status === 'removed') throw new AppError('MCP_TOOL_NOT_APPROVED');
      if (tool.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
      if (definitionHash(tool.definition) !== tool.definitionSha256)
        throw new AppError('MCP_TOOL_NOT_APPROVED');
      const approved = input.decision === 'approve',
        status: McpToolState = approved ? 'approved' : 'rejected',
        version = tool.version + 1;
      await tx
        .update(mcpTools)
        .set({
          status,
          sideEffectLevel: approved ? input.sideEffectLevel! : null,
          allowedClasses: approved ? classes : [],
          reviewedByMembershipId: context.membershipId,
          reviewedAt: new Date(),
          version,
          updatedAt: new Date(),
        })
        .where(eq(mcpTools.id, toolId));
      await appendAudit(tx, {
        organizationId: context.organizationId,
        actorType: 'user',
        actorId: context.membershipId,
        action: 'mcp.tool_reviewed',
        targetRef: `mcp_tool:${toolId}`,
        decision: 'allow',
        safeReason: approved ? 'MCP_TOOL_APPROVED' : 'MCP_TOOL_REJECTED',
      });
      await emit(tx, context, {
        eventType: MCP_TOOL_REVIEWED,
        aggregateType: 'mcp_tool',
        aggregateId: toolId,
        aggregateVersion: version,
        classification: 'internal',
        payload: {
          tool_id: toolId,
          decision: input.decision,
          side_effect_level: approved ? input.sideEffectLevel! : null,
        },
      });
      return { status, version };
    }),
  );
}

/**
 * What M4's tool gateway calls before it lets a run call an MCP tool: approved, at this exact definition,
 * on an active connection, for this class. MCP_TOOL_NOT_APPROVED otherwise. `read_only` runs through the
 * gateway. `external_write` has to become an M3 external action, so it gets approval and a receipt.
 */
export async function loadCallableMcpTool(
  database: AppDatabase,
  context: TenantContext,
  input: { toolId: string; classification: Classification },
): Promise<{
  toolName: string;
  connectionId: string;
  definitionSha256: string;
  sideEffectLevel: McpSideEffect;
}> {
  const toolId = id(input.toolId);
  if (!['public', 'internal', 'confidential'].includes(input.classification))
    throw new AppError('MCP_TOOL_NOT_APPROVED');
  return withTenantTx(database, context, async (tx) => {
    await requireSearchPerson(tx, context);
    const [row] = await tx
      .select({ tool: mcpTools })
      .from(mcpTools)
      .innerJoin(
        connections,
        and(
          eq(connections.organizationId, mcpTools.organizationId),
          eq(connections.id, mcpTools.connectionId),
        ),
      )
      .where(
        and(
          eq(mcpTools.id, toolId),
          eq(mcpTools.status, 'approved'),
          eq(connections.state, 'active'),
          eq(connections.connectorType, 'mcp_server'),
          sql`${input.classification}=any(${mcpTools.allowedClasses})`,
        ),
      );
    if (
      !row ||
      definitionHash(row.tool.definition) !== row.tool.definitionSha256 ||
      !['read_only', 'external_write'].includes(row.tool.sideEffectLevel ?? '')
    )
      throw new AppError('MCP_TOOL_NOT_APPROVED');
    // Names never join the native tool registry. The gateway addresses this by connection/tool ID.
    // external_write MUST become an M3 intent and verified attempt; this function never authorizes a send.
    return {
      toolName: row.tool.toolName,
      connectionId: row.tool.connectionId,
      definitionSha256: row.tool.definitionSha256,
      sideEffectLevel: row.tool.sideEffectLevel as McpSideEffect,
    };
  });
}

function definitionHash(value: unknown): string {
  try {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
  } catch {
    throw new AppError('INVALID_INPUT');
  }
}
function id(value: string) {
  const result = idSchema.safeParse(value);
  if (!result.success) throw new AppError('INVALID_INPUT');
  return result.data;
}
async function manager(tx: Tx, context: TenantContext) {
  await requireSearchPerson(tx, context);
  const [member] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(eq(memberships.id, context.membershipId));
  if (!member || !can(member.role, 'connection.manage')) throw new AppError('FORBIDDEN');
}
async function connection(tx: Tx, connectionId: string, lock: 'share' | 'update', active = true) {
  const [row] = await tx
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.connectorType, 'mcp_server')))
    .for(lock);
  if (!row) throw new AppError('NOT_FOUND');
  if (active && row.state !== 'active') throw new AppError('CONNECTION_NOT_ACTIVE');
  return row;
}
async function safe<T>(use: () => Promise<T>): Promise<T> {
  try {
    return await use();
  } catch (error) {
    const code = pgCode(error);
    if (code === 'EN115' || code === '23514') throw new AppError('INVALID_INPUT');
    if (code === 'EN116') throw new AppError('FORBIDDEN');
    throw error;
  }
}
