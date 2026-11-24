// EXP-02: admission shared by the human proposal kernel and the final native connector attempt.
// The SDK independently parses this same contracts/domain allowlist before any provider contact.
import {
  businessRecords,
  externalResources,
  externalResourceAcl,
  teamMemberships,
  memberships,
  connections,
  type Tx,
  type TenantContext,
} from '@ensemus/database';
import {
  recordUpdatePayloadSchema,
  ticketCommentAddPayloadSchema,
  invoiceDraftCreatePayloadSchema,
} from '@ensemus/contracts/business-records';
import {
  ACCOUNTING_INVOICE_DRAFT_TOOL,
  TICKETING_COMMENT_ADD_TOOL,
  businessConnectorTypeForTool,
  checkRecordChange,
  connectorTypeOfStream,
  recordClassification,
  readScopeFor,
  writeScopeFor,
  type BusinessConnectorType,
} from '@ensemus/domain/business-connector';
import { and, eq, sql } from 'drizzle-orm';
import { AppError, pgCode } from './errors';

type Connection = typeof connections.$inferSelect;
type Work = { id: string; classification: string };
const ranks: Record<string, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
function rejectNullByte<T>(parsed: T): T {
  const hasNull = (value: unknown): boolean =>
    typeof value === 'string'
      ? value.includes('\0')
      : Array.isArray(value)
        ? value.some(hasNull)
        : value !== null && typeof value === 'object'
          ? Object.values(value).some(hasNull)
          : false;
  if (hasNull(parsed)) throw new AppError('INVALID_INPUT');
  return parsed;
}
export function parseBusinessChange(tool: string, raw: unknown) {
  const type = businessConnectorTypeForTool(tool);
  if (!type) throw new AppError('INVALID_INPUT');
  if (tool === ACCOUNTING_INVOICE_DRAFT_TOOL) {
    const p = invoiceDraftCreatePayloadSchema.safeParse(raw);
    if (!p.success) throw new AppError('INVALID_INPUT');
    return rejectNullByte(p.data);
  }
  if (tool === TICKETING_COMMENT_ADD_TOOL) {
    const p = ticketCommentAddPayloadSchema.safeParse(raw);
    if (!p.success || p.data.body.includes('\0')) throw new AppError('INVALID_INPUT');
    return rejectNullByte(p.data);
  }
  const p = recordUpdatePayloadSchema.safeParse(raw);
  if (
    !p.success ||
    connectorTypeOfStream(p.data.record.stream) !== type ||
    !checkRecordChange(p.data.record.stream, p.data.changes).ok
  )
    throw new AppError('INVALID_INPUT');
  if (p.data.record.expected_version === null) throw new AppError('RECORD_VERSION_REQUIRED');
  return rejectNullByte(p.data);
}
function target(tool: string, payload: ReturnType<typeof parseBusinessChange>) {
  if (tool === ACCOUNTING_INVOICE_DRAFT_TOOL) return null;
  if ('ticket' in payload)
    return {
      stream: 'ticketing.tickets',
      externalId: payload.ticket.external_id,
      version: undefined,
    };
  if ('record' in payload)
    return {
      stream: payload.record.stream,
      externalId: payload.record.external_id,
      version: payload.record.expected_version,
    };
  throw new AppError('INVALID_INPUT');
}
async function activeMember(tx: Tx, id: string) {
  const [person] = await tx
    .select({ id: memberships.id, userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.id, id), eq(memberships.status, 'active')))
    .for('share');
  if (!person) throw new AppError('NOT_FOUND');
  return person;
}
async function hasGrant(tx: Tx, resourceId: string, membershipId: string, recordId: string) {
  // Keep actual matching grants and team membership stable through admission. Source revocation then
  // linearizes before this admission or after the recorded attempt, as with existing M3 connections.
  const grants = await tx
    .select({ resourceId: externalResourceAcl.resourceId, teamId: externalResourceAcl.teamId })
    .from(externalResourceAcl)
    .where(
      and(
        eq(externalResourceAcl.resourceId, resourceId),
        sql`${externalResourceAcl.access} in ('read','write','owner')`,
        sql`(${externalResourceAcl.membershipId}=${membershipId}::uuid or exists(select 1 from ${teamMemberships} team where team.organization_id=${externalResourceAcl.organizationId} and team.team_id=${externalResourceAcl.teamId} and team.membership_id=${membershipId}::uuid))`,
      ),
    )
    .for('share');
  if (!grants.length) return false;
  for (const grant of grants)
    if (grant.teamId) {
      try {
        const rows = await tx.execute<{ allowed: boolean }>(
          sql`select integrations.lock_business_proposal_team(${recordId}::uuid,${grant.teamId}::uuid,${membershipId}::uuid) allowed`,
        );
        if (!rows.rows[0]?.allowed) continue;
        return true;
      } catch (error) {
        if (pgCode(error) === '55P03') throw new AppError('VERSION_CONFLICT');
        throw error;
      }
    } else return true;
  return false;
}
function allowedConnection(
  connection: Connection,
  type: BusinessConnectorType,
  membershipId: string,
) {
  if (connection.state !== 'active') throw new AppError('CONNECTION_NOT_ACTIVE');
  if (connection.connectorType !== type) throw new AppError('INVALID_INPUT');
  if (connection.ownerMembershipId !== null && connection.ownerMembershipId !== membershipId)
    throw new AppError('FORBIDDEN');
  const config = connection.config as { scopes?: unknown; streams?: unknown };
  if (
    ![readScopeFor(type), writeScopeFor(type)].every(
      (scope) =>
        connection.grantedScopes.includes(scope) &&
        Array.isArray(config.scopes) &&
        config.scopes.includes(scope),
    )
  )
    throw new AppError('CONNECTION_SCOPE_MISSING');
  return config;
}
async function currentTarget(
  tx: Tx,
  tool: string,
  payload: ReturnType<typeof parseBusinessChange>,
  connection: Connection,
  members: readonly string[],
  work: Work,
) {
  const type = businessConnectorTypeForTool(tool)!;
  const config = allowedConnection(connection, type, members[0]!);
  const minimum = recordClassification(type, undefined);
  if (work.classification === 'restricted' || (ranks[work.classification] ?? -1) < ranks[minimum]!)
    throw new AppError('RESTRICTED_NOT_ALLOWED');
  const named = target(tool, payload);
  if (!named) return null;
  if (!Array.isArray(config.streams) || !config.streams.includes(named.stream))
    throw new AppError('CONNECTION_SCOPE_MISSING');
  const query = tx
    .select({
      id: businessRecords.id,
      version: businessRecords.externalVersion,
      hash: businessRecords.fieldsSha256,
      classification: businessRecords.classification,
      deletedAt: businessRecords.deletedAt,
      resourceId: externalResources.id,
      resourceVersion: externalResources.externalVersion,
      resourceHash: externalResources.contentSha256,
      resourceClass: externalResources.classification,
      acl: externalResources.aclState,
      resourceDeleted: externalResources.deletedAt,
    })
    .from(businessRecords)
    .innerJoin(
      externalResources,
      and(
        eq(externalResources.organizationId, businessRecords.organizationId),
        eq(externalResources.connectionId, businessRecords.connectionId),
        eq(externalResources.externalId, businessRecords.externalId),
        eq(externalResources.stream, businessRecords.stream),
      ),
    )
    .where(
      and(
        eq(businessRecords.connectionId, connection.id),
        eq(businessRecords.externalId, named.externalId),
        eq(businessRecords.stream, named.stream),
      ),
    );
  const nativeWeb = await tx.execute<{ allowed: boolean }>(sql`select app.is_web_login() allowed`);
  const [row] = nativeWeb.rows[0]?.allowed ? await query : await query.for('share');
  if (
    !row ||
    row.deletedAt ||
    row.resourceDeleted ||
    !['mapped', 'partial'].includes(row.acl) ||
    row.hash !== row.resourceHash ||
    row.version !== row.resourceVersion ||
    row.classification !== row.resourceClass
  )
    throw new AppError('NOT_FOUND');
  if (nativeWeb.rows[0]?.allowed) {
    try {
      const locked = await tx.execute<{ allowed: boolean }>(
        sql`select integrations.lock_business_proposal_record(${row.id}::uuid,${row.version}::text,${row.hash}::text,${row.classification}::text) allowed`,
      );
      if (!locked.rows[0]?.allowed) throw new AppError('RECORD_VERSION_STALE');
    } catch (error) {
      if (pgCode(error) === '55P03') throw new AppError('VERSION_CONFLICT');
      throw error;
    }
  }
  if (named.version !== undefined && row.version !== named.version)
    throw new AppError('RECORD_VERSION_STALE');
  if ((ranks[work.classification] ?? -1) < (ranks[row.classification] ?? 99))
    throw new AppError('RESTRICTED_NOT_ALLOWED');
  for (const member of members)
    if (!(await hasGrant(tx, row.resourceId, member, row.id))) throw new AppError('NOT_FOUND');
  return row.id;
}
export async function admitBusinessChangeInTx(
  tx: Tx,
  context: TenantContext,
  work: Work,
  connection: Connection,
  input: { toolName: string; payload: unknown; approverMembershipId?: string },
) {
  if (context.actorType !== 'user' || !input.approverMembershipId) throw new AppError('FORBIDDEN');
  const native = await tx.execute<{ allowed: boolean }>(sql`select app.is_web_login() as allowed`);
  if (!native.rows[0]?.allowed) throw new AppError('FORBIDDEN');
  const actor = await activeMember(tx, context.membershipId);
  if (actor.userId !== context.userId) throw new AppError('FORBIDDEN');
  await activeMember(tx, input.approverMembershipId);
  if (
    connection.ownerMembershipId !== null &&
    connection.ownerMembershipId !== input.approverMembershipId
  )
    throw new AppError('NOT_FOUND');
  const payload = parseBusinessChange(input.toolName, input.payload);
  const recordId = await currentTarget(
    tx,
    input.toolName,
    payload,
    connection,
    [context.membershipId, input.approverMembershipId],
    work,
  );
  return { payload, recordId };
}
export async function recheckBusinessChangeInTx(
  tx: Tx,
  action: {
    toolName: string;
    payload: unknown;
    workUnitId: string;
    createdByMembershipId: string | null;
    classification: string;
  },
  connection: Connection | null,
): Promise<
  'ACCESS_REVOKED' | 'CONNECTION_CHANGED' | 'SCOPE_NOT_GRANTED' | 'PAYLOAD_CHANGED' | null
> {
  if (!businessConnectorTypeForTool(action.toolName)) return null;
  if (!connection || !action.createdByMembershipId) return 'CONNECTION_CHANGED';
  const native = await tx.execute<{ allowed: boolean }>(
    sql`select session_user='ensemus_connector' and current_user='ensemus_connector' and knowledge.is_service_actor() allowed`,
  );
  if (!native.rows[0]?.allowed) return 'ACCESS_REVOKED';
  const previous = await tx.execute<{ value: string | null }>(
    sql`select current_setting('app.business_connection_id',true) value`,
  );
  let restoreSelector = true;
  try {
    await activeMember(tx, action.createdByMembershipId);
    const access = await tx.execute<{ allowed: boolean }>(
      sql`select knowledge.can_read_work(${action.workUnitId}::uuid,${action.createdByMembershipId}::uuid) allowed`,
    );
    if (!access.rows[0]?.allowed) return 'ACCESS_REVOKED';
    await tx.execute(sql`select set_config('app.business_connection_id',${connection.id},true)`);
    const payload = parseBusinessChange(action.toolName, action.payload);
    await currentTarget(tx, action.toolName, payload, connection, [action.createdByMembershipId], {
      id: action.workUnitId,
      classification: action.classification,
    });
    return null;
  } catch (error) {
    if (pgCode(error) || (error instanceof AppError && error.code === 'VERSION_CONFLICT')) {
      // A failed SQL statement aborts this transaction. Its local selector rolls back with it;
      // another SQL statement here would mask the original conflict with 25P02.
      restoreSelector = false;
      throw error;
    }
    if (!(error instanceof AppError)) throw error;
    if (error.code === 'CONNECTION_SCOPE_MISSING') return 'SCOPE_NOT_GRANTED';
    if (
      error.code === 'INVALID_INPUT' ||
      error.code === 'RECORD_VERSION_STALE' ||
      error.code === 'RECORD_VERSION_REQUIRED'
    )
      return 'PAYLOAD_CHANGED';
    return 'ACCESS_REVOKED';
  } finally {
    if (restoreSelector)
      await tx.execute(
        sql`select set_config('app.business_connection_id',${previous.rows[0]?.value ?? ''},true)`,
      );
  }
}
