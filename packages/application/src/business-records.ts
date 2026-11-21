// EXP-02, ADR-033 D3. Stored
// fields from a connector, read through the source's own permissions, and the effects proposed on them, which
// go through the verified external action path (ADR-027) like anything else that leaves.
import { createHash } from 'node:crypto';
import {
  withTenantTx,
  businessRecords,
  businessRecordActions,
  externalActions,
  connections,
  externalResources,
  externalResourceAcl,
  teamMemberships,
  memberships,
  users,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  proposeExternalActionInTx,
  reviseExternalAction,
  retryExternalAction,
} from './external-actions';
import { createWorkUnitInTx, assignContributor } from './work';
import { databaseInTransaction } from './transaction-database';
import {
  businessConnectorTypeForTool,
  BUSINESS_TOOL_VERSION,
  CRM_RECORD_UPDATE_TOOL,
  TICKETING_RECORD_UPDATE_TOOL,
  ACCOUNTING_RECORD_UPDATE_TOOL,
  TICKETING_COMMENT_ADD_TOOL,
  ACCOUNTING_INVOICE_DRAFT_TOOL,
} from '@ensemus/domain/business-connector';
import { canonicalJson } from '@ensemus/domain/approval';
import {
  canReadBusinessRecord,
  connectorTypeOfStream,
  recordClassification,
  readScopeFor,
  selectRecordFields,
  streamRuleFor,
} from '@ensemus/domain/business-connector';
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from './errors';
import { idSchema } from './ids';
import type { BusinessConnectorType, RecordFields } from '@ensemus/domain/business-connector';

export type BusinessRecordPage = {
  connectionId: string;
  connectorType: BusinessConnectorType;
  stream: string;
  records: readonly {
    externalId: string;
    externalVersion: string | null;
    displayName: string | null;
    fields: RecordFields;
    fieldsSha256: string;
    classification: 'public' | 'internal' | 'confidential' | 'restricted';
  }[];
  deletedExternalIds: readonly string[];
};

export type BusinessRecordView = {
  id: string;
  connectionId: string;
  connectionDisplayName: string;
  stream: string;
  externalId: string;
  externalVersion: string | null;
  displayName: string | null;
  classification: string;
  fields: RecordFields;
  updatedAt: Date;
};

export type BusinessRecordList = {
  items: readonly BusinessRecordView[];
  nextCursor: string | null;
};

export type ProposedBusinessAction = {
  externalActionId: string;
  approvalId: string;
  requestHash: string;
};

const classification = z.enum(['public', 'internal', 'confidential', 'restricted']);
const externalId = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => !v.includes('\0'));
const pageSchema = z.strictObject({
  connectionId: idSchema,
  connectorType: z.enum(['crm_http', 'ticketing_http', 'accounting_http']),
  stream: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
  records: z
    .array(
      z.strictObject({
        externalId,
        externalVersion: externalId.nullable(),
        displayName: z.string().max(8000).nullable(),
        fields: z.record(z.string(), z.unknown()),
        fieldsSha256: z.string().regex(/^[0-9a-f]{64}$/),
        classification,
      }),
    )
    .max(1000),
  deletedExternalIds: z.array(externalId).max(1000),
});
const fieldsHash = (fields: RecordFields) =>
  createHash('sha256').update(canonicalJson(fields)).digest('hex');
const parsedId = (value: string) => {
  const p = idSchema.safeParse(value);
  if (!p.success) throw new AppError('INVALID_INPUT');
  return p.data;
};
async function person(tx: Tx, context: TenantContext) {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  const [row] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.id, context.membershipId),
        eq(memberships.userId, context.userId),
        eq(memberships.status, 'active'),
        inArray(memberships.role, ['owner', 'admin', 'member']),
      ),
    )
    .for('share');
  const native = await tx.execute<{ allowed: boolean }>(sql`select app.is_web_login() as allowed`);
  if (!row || !native.rows[0]?.allowed) throw new AppError('FORBIDDEN');
}
async function nativeService(
  tx: Tx,
  context: TenantContext,
  role: 'ensemus_connector' | 'ensemus_worker',
) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const result = await tx.execute<{ allowed: boolean }>(
    sql`select session_user=${role} and current_user=${role} and app.current_membership_id() is null as allowed`,
  );
  if (!result.rows[0]?.allowed) throw new AppError('FORBIDDEN');
}

/** Bounded native connector sink. A repeated snapshot changes neither its row nor its timestamp. */
export async function applyBusinessRecordPage(
  database: AppDatabase,
  context: TenantContext,
  input: BusinessRecordPage,
): Promise<void> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const parsed = pageSchema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const page = parsed.data;
  if (connectorTypeOfStream(page.stream) !== page.connectorType)
    throw new AppError('INVALID_INPUT');
  const ids = [...page.records.map((r) => r.externalId), ...page.deletedExternalIds];
  if (new Set(ids).size !== ids.length) throw new AppError('INVALID_INPUT');
  const titleField = streamRuleFor(page.stream)!.titleField;
  const records = page.records.map((record) => {
    const kept = selectRecordFields(page.stream, record.fields);
    if (
      !kept.ok ||
      fieldsHash(kept.fields) !== record.fieldsSha256 ||
      recordClassification(page.connectorType, record.classification) !== record.classification
    )
      throw new AppError('INVALID_INPUT');
    const title = kept.fields[titleField];
    return {
      ...record,
      fields: kept.fields,
      displayName: typeof title === 'string' && title.length ? title : null,
    };
  });
  await withTenantTx(database, context, async (tx) => {
    await nativeService(tx, context, 'ensemus_connector');
    const [connection] = await tx
      .select()
      .from(connections)
      .where(eq(connections.id, page.connectionId))
      .for('share');
    if (!connection) throw new AppError('NOT_FOUND');
    if (connection.connectorType !== page.connectorType) throw new AppError('INVALID_INPUT');
    if (connection.state !== 'active') throw new AppError('CONNECTION_NOT_ACTIVE');
    const config = connection.config as { streams?: unknown };
    if (
      !connection.grantedScopes.includes(readScopeFor(page.connectorType)) ||
      !Array.isArray(config?.streams) ||
      !config.streams.includes(page.stream)
    )
      throw new AppError('CONNECTION_SCOPE_MISSING');
    await tx.execute(sql`select set_config('app.business_connection_id',${connection.id},true)`);
    for (const record of records) {
      const [existing] = await tx
        .select({ stream: businessRecords.stream })
        .from(businessRecords)
        .where(
          and(
            eq(businessRecords.connectionId, connection.id),
            eq(businessRecords.externalId, record.externalId),
          ),
        )
        .for('update');
      if (existing && existing.stream !== page.stream) throw new AppError('INVALID_INPUT');
      await tx
        .insert(businessRecords)
        .values({
          organizationId: context.organizationId,
          connectionId: connection.id,
          stream: page.stream,
          ...record,
        })
        .onConflictDoUpdate({
          target: [
            businessRecords.organizationId,
            businessRecords.connectionId,
            businessRecords.externalId,
          ],
          set: {
            externalVersion: record.externalVersion,
            displayName: record.displayName,
            fields: record.fields,
            fieldsSha256: record.fieldsSha256,
            classification: record.classification,
            deletedAt: null,
            updatedAt: new Date(),
          },
          setWhere: sql`(${businessRecords.externalVersion},${businessRecords.displayName},${businessRecords.fieldsSha256},${businessRecords.classification},${businessRecords.deletedAt}) is distinct from (${record.externalVersion}::text,${record.displayName}::text,${record.fieldsSha256}::text,${record.classification}::text,null::timestamptz)`,
        });
    }
    if (page.deletedExternalIds.length)
      await tx
        .update(businessRecords)
        .set({
          fields: {},
          fieldsSha256: fieldsHash({}),
          displayName: null,
          deletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(businessRecords.connectionId, connection.id),
            eq(businessRecords.stream, page.stream),
            inArray(businessRecords.externalId, page.deletedExternalIds),
            isNull(businessRecords.deletedAt),
          ),
        );
  });
}

const listSchema = z.strictObject({
  connectionId: idSchema.optional(),
  stream: z
    .string()
    .regex(/^[a-z0-9_.-]{1,64}$/)
    .optional(),
  after: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const cursorSchema = z.strictObject({
  at: z.iso.datetime(),
  id: idSchema,
  c: idSchema.nullable(),
  s: z.string().nullable(),
});
// Millisecond precision matches the public Date representation, with ID breaking every tie.
const orderTime = sql`date_trunc('milliseconds',${businessRecords.updatedAt})`;
function cursorOf(
  row: BusinessRecordView,
  input: { connectionId?: string | undefined; stream?: string | undefined },
) {
  return Buffer.from(
    JSON.stringify({
      at: row.updatedAt.toISOString(),
      id: row.id,
      c: input.connectionId ?? null,
      s: input.stream ?? null,
    }),
  ).toString('base64url');
}
function cursorFrom(
  value: string,
  input: { connectionId?: string | undefined; stream?: string | undefined },
) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
    const raw = Buffer.from(value, 'base64url');
    if (raw.toString('base64url') !== value) throw Error();
    const c = cursorSchema.parse(JSON.parse(raw.toString('utf8')));
    if (c.c !== (input.connectionId ?? null) || c.s !== (input.stream ?? null)) throw Error();
    return c;
  } catch {
    throw new AppError('INVALID_INPUT');
  }
}
function visible(tx: Tx, context: TenantContext) {
  const grant = sql<boolean>`exists(select 1 from ${externalResourceAcl} a where a.organization_id=${context.organizationId} and a.resource_id=${externalResources.id} and a.access in ('read','write','owner') and (a.membership_id=${context.membershipId} or exists(select 1 from ${teamMemberships} tm where tm.organization_id=a.organization_id and tm.team_id=a.team_id and tm.membership_id=${context.membershipId})))`;
  return tx
    .select({
      id: businessRecords.id,
      connectionId: businessRecords.connectionId,
      connectionDisplayName: connections.displayName,
      stream: businessRecords.stream,
      externalId: businessRecords.externalId,
      externalVersion: businessRecords.externalVersion,
      displayName: businessRecords.displayName,
      classification: businessRecords.classification,
      fields: businessRecords.fields,
      updatedAt: businessRecords.updatedAt,
      aclState: externalResources.aclState,
      hasGrant: grant,
      deletedAt: businessRecords.deletedAt,
    })
    .from(businessRecords)
    .innerJoin(
      connections,
      and(
        eq(connections.organizationId, businessRecords.organizationId),
        eq(connections.id, businessRecords.connectionId),
      ),
    )
    .innerJoin(
      externalResources,
      and(
        eq(externalResources.organizationId, businessRecords.organizationId),
        eq(externalResources.connectionId, businessRecords.connectionId),
        eq(externalResources.externalId, businessRecords.externalId),
        eq(externalResources.stream, businessRecords.stream),
      ),
    );
}
function view(row: Awaited<ReturnType<typeof visible>>[number]): BusinessRecordView {
  if (
    !canReadBusinessRecord({
      aclState: row.aclState as 'mapped' | 'partial' | 'unmapped',
      viewerHasGrant: row.hasGrant,
      deleted: row.deletedAt !== null,
    })
  )
    throw new AppError('NOT_FOUND');
  return {
    id: row.id,
    connectionId: row.connectionId,
    connectionDisplayName: row.connectionDisplayName,
    stream: row.stream,
    externalId: row.externalId,
    externalVersion: row.externalVersion,
    displayName: row.displayName,
    classification: row.classification,
    fields: row.fields as RecordFields,
    updatedAt: row.updatedAt,
  };
}
/** Source ACLs filter before the page cap. Admin status adds no grant. */
export async function listBusinessRecords(
  database: AppDatabase,
  context: TenantContext,
  input: { connectionId?: string; stream?: string; after?: string; limit?: number },
): Promise<BusinessRecordList> {
  const parsed = listSchema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const p = parsed.data,
    c = p.after ? cursorFrom(p.after, p) : null,
    limit = p.limit ?? 50;
  return withTenantTx(database, context, async (tx) => {
    await person(tx, context);
    const rows = await visible(tx, context)
      .where(
        and(
          p.connectionId ? eq(businessRecords.connectionId, p.connectionId) : undefined,
          p.stream ? eq(businessRecords.stream, p.stream) : undefined,
          c
            ? or(
                sql`${orderTime}>${c.at}::timestamptz`,
                and(sql`${orderTime}=${c.at}::timestamptz`, gt(businessRecords.id, c.id)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(orderTime), asc(businessRecords.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(view);
    return {
      items,
      nextCursor: rows.length > limit ? cursorOf(items[items.length - 1]!, p) : null,
    };
  });
}
/** Not found unless the current native person has an actual source grant. */
export async function getBusinessRecord(
  database: AppDatabase,
  context: TenantContext,
  recordId: string,
): Promise<BusinessRecordView> {
  const id = parsedId(recordId);
  return withTenantTx(database, context, async (tx) => {
    await person(tx, context);
    const [row] = await visible(tx, context).where(eq(businessRecords.id, id));
    if (!row) throw new AppError('NOT_FOUND');
    return view(row);
  });
}

/** Business changes share M3's immutable intent, review, revision and retry kernel. */
export async function proposeBusinessActionInTx(
  tx: Tx,
  context: TenantContext,
  input: {
    workUnitId: string;
    connectionId: string;
    toolName: string;
    toolVersion: string;
    payload: unknown;
    approverMembershipId: string;
    expiresAt?: Date;
    supersedesId?: string;
    retryOfId?: string;
    businessRecordId?: string;
  },
): Promise<ProposedBusinessAction> {
  await person(tx, context);
  if (!businessConnectorTypeForTool(input.toolName)) throw new AppError('INVALID_INPUT');
  // An optional source identifier cannot disagree with the actual payload target. The shared kernel
  // derives and records the source association from the locked, permitted stored record.
  if (input.businessRecordId) {
    const [record] = await tx
      .select()
      .from(businessRecords)
      .where(eq(businessRecords.id, parsedId(input.businessRecordId)));
    if (!record || record.connectionId !== input.connectionId) throw new AppError('NOT_FOUND');
    const payload = input.payload as {
      record?: { external_id?: unknown; stream?: unknown };
      ticket?: { external_id?: unknown };
    };
    if (
      !payload ||
      (payload.record?.external_id ?? payload.ticket?.external_id) !== record.externalId ||
      (payload.record && payload.record.stream !== record.stream)
    )
      throw new AppError('INVALID_INPUT');
  }
  return proposeExternalActionInTx(tx, context, input);
}
async function recordForProposal(tx: Tx, context: TenantContext, id: string) {
  await person(tx, context);
  const [row] = await tx
    .select()
    .from(businessRecords)
    .where(eq(businessRecords.id, parsedId(id)));
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}
export function proposeRecordUpdate(
  database: AppDatabase,
  context: TenantContext,
  input: {
    recordId: string;
    workUnitId: string;
    expectedVersion: string | null;
    changes: Readonly<Record<string, string | number | boolean | null>>;
    approverMembershipId: string;
  },
): Promise<ProposedBusinessAction> {
  return withTenantTx(database, context, async (tx) => {
    const record = await recordForProposal(tx, context, input.recordId);
    if (record.externalVersion !== input.expectedVersion)
      throw new AppError('RECORD_VERSION_STALE');
    const type = connectorTypeOfStream(record.stream);
    const toolName =
      type === 'crm_http'
        ? CRM_RECORD_UPDATE_TOOL
        : type === 'ticketing_http'
          ? TICKETING_RECORD_UPDATE_TOOL
          : ACCOUNTING_RECORD_UPDATE_TOOL;
    return proposeBusinessActionInTx(tx, context, {
      workUnitId: parsedId(input.workUnitId),
      connectionId: record.connectionId,
      toolName,
      toolVersion: BUSINESS_TOOL_VERSION,
      payload: {
        record: {
          stream: record.stream,
          external_id: record.externalId,
          expected_version: input.expectedVersion,
        },
        changes: input.changes,
      },
      approverMembershipId: parsedId(input.approverMembershipId),
      businessRecordId: record.id,
    });
  });
}
export function proposeTicketComment(
  database: AppDatabase,
  context: TenantContext,
  input: { recordId: string; workUnitId: string; body: string; approverMembershipId: string },
): Promise<ProposedBusinessAction> {
  return withTenantTx(database, context, async (tx) => {
    const record = await recordForProposal(tx, context, input.recordId);
    if (record.stream !== 'ticketing.tickets') throw new AppError('INVALID_INPUT');
    return proposeBusinessActionInTx(tx, context, {
      workUnitId: parsedId(input.workUnitId),
      connectionId: record.connectionId,
      toolName: TICKETING_COMMENT_ADD_TOOL,
      toolVersion: BUSINESS_TOOL_VERSION,
      payload: {
        ticket: { external_id: record.externalId },
        visibility: 'internal',
        body: input.body,
      },
      approverMembershipId: parsedId(input.approverMembershipId),
      businessRecordId: record.id,
    });
  });
}
export function proposeInvoiceDraft(
  database: AppDatabase,
  context: TenantContext,
  input: {
    workUnitId: string;
    connectionId: string;
    invoice: unknown;
    approverMembershipId: string;
  },
): Promise<ProposedBusinessAction> {
  return withTenantTx(database, context, (tx) =>
    proposeBusinessActionInTx(tx, context, {
      workUnitId: parsedId(input.workUnitId),
      connectionId: parsedId(input.connectionId),
      toolName: ACCOUNTING_INVOICE_DRAFT_TOOL,
      toolVersion: BUSINESS_TOOL_VERSION,
      payload: input.invoice,
      approverMembershipId: parsedId(input.approverMembershipId),
    }),
  );
}
async function businessIntent(tx: Tx, context: TenantContext, id: string) {
  await person(tx, context);
  const [row] = await tx
    .select({ toolName: externalActions.toolName })
    .from(externalActions)
    .where(eq(externalActions.id, parsedId(id)));
  if (!row) throw new AppError('NOT_FOUND');
  if (!businessConnectorTypeForTool(row.toolName)) throw new AppError('INVALID_INPUT');
}
export function reviseBusinessAction(
  database: AppDatabase,
  context: TenantContext,
  input: {
    externalActionId: string;
    expectedVersion: number;
    payload: unknown;
    approverMembershipId: string;
  },
): Promise<ProposedBusinessAction> {
  return withTenantTx(database, context, async (tx) => {
    await businessIntent(tx, context, input.externalActionId);
    return reviseExternalAction(databaseInTransaction(tx), context, input);
  });
}
export function retryBusinessAction(
  database: AppDatabase,
  context: TenantContext,
  input: { externalActionId: string; approverMembershipId: string },
): Promise<ProposedBusinessAction> {
  return withTenantTx(database, context, async (tx) => {
    await businessIntent(tx, context, input.externalActionId);
    return retryExternalAction(databaseInTransaction(tx), context, input);
  });
}

/** Internal UI link, readable only with both the current Work and source-record grants. */
export function getBusinessActionRecordId(
  database: AppDatabase,
  context: TenantContext,
  externalActionId: string,
): Promise<string | null> {
  return withTenantTx(database, context, async (tx) => {
    await person(tx, context);
    const [row] = await tx
      .select({ id: businessRecords.id })
      .from(businessRecordActions)
      .innerJoin(
        externalActions,
        and(
          eq(externalActions.organizationId, businessRecordActions.organizationId),
          eq(externalActions.id, businessRecordActions.externalActionId),
        ),
      )
      .innerJoin(
        businessRecords,
        and(
          eq(businessRecords.organizationId, businessRecordActions.organizationId),
          eq(businessRecords.id, businessRecordActions.businessRecordId),
        ),
      )
      .where(eq(externalActions.id, parsedId(externalActionId)));
    return row?.id ?? null;
  });
}

/** Eligible independent source readers, filtered before the bounded picker limit. */
export function listBusinessRecordReviewers(
  database: AppDatabase,
  context: TenantContext,
  recordId: string,
) {
  return withTenantTx(database, context, async (tx) => {
    const record = await recordForProposal(tx, context, recordId);
    const [connection] = await tx
      .select({ owner: connections.ownerMembershipId })
      .from(connections)
      .where(eq(connections.id, record.connectionId));
    if (!connection || connection.owner !== null) return [];
    return tx
      .select({ membershipId: memberships.id, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.status, 'active'),
          sql`${memberships.id}<>${context.membershipId}::uuid`,
          sql`exists(select 1 from ${externalResources} resource join ${externalResourceAcl} grant_row on grant_row.organization_id=resource.organization_id and grant_row.resource_id=resource.id where resource.organization_id=${context.organizationId}::uuid and resource.connection_id=${record.connectionId}::uuid and resource.external_id=${record.externalId} and resource.stream=${record.stream} and resource.deleted_at is null and resource.acl_state in ('mapped','partial') and grant_row.access in ('read','write','owner') and (grant_row.membership_id=${memberships.id} or exists(select 1 from ${teamMemberships} team where team.organization_id=grant_row.organization_id and team.team_id=grant_row.team_id and team.membership_id=${memberships.id})))`,
        ),
      )
      .orderBy(asc(users.name), asc(memberships.id))
      .limit(200);
  });
}

/** One human form creates accountable Work and its exact proposal atomically. A refusal leaves neither. */
export function createBusinessRecordProposal(
  database: AppDatabase,
  context: TenantContext,
  input: { recordId: string; title: string; approverMembershipId: string } & (
    | {
        kind: 'update';
        expectedVersion: string | null;
        changes: Readonly<Record<string, string | number | boolean | null>>;
      }
    | { kind: 'note'; body: string }
    | { kind: 'invoice'; invoice: unknown }
  ),
): Promise<ProposedBusinessAction & { workUnitId: string }> {
  return withTenantTx(database, context, async (tx) => {
    const record = await recordForProposal(tx, context, input.recordId);
    if (record.classification === 'restricted') throw new AppError('RESTRICTED_NOT_ALLOWED');
    if (input.kind === 'update' && record.externalVersion !== input.expectedVersion)
      throw new AppError('RECORD_VERSION_STALE');
    const work = await createWorkUnitInTx(tx, context, {
      title: input.title,
      classification: record.classification as 'public' | 'internal' | 'confidential',
      completionCriteria: [{ kind: 'external_receipt' }],
    });
    const joined = databaseInTransaction(tx);
    await assignContributor(joined, context, {
      id: work.id,
      membershipId: parsedId(input.approverMembershipId),
      responsibility: 'reviewer',
    });
    let proposed: ProposedBusinessAction;
    if (input.kind === 'update')
      proposed = await proposeRecordUpdate(joined, context, {
        recordId: record.id,
        workUnitId: work.id,
        expectedVersion: input.expectedVersion,
        changes: input.changes,
        approverMembershipId: input.approverMembershipId,
      });
    else if (input.kind === 'note')
      proposed = await proposeTicketComment(joined, context, {
        recordId: record.id,
        workUnitId: work.id,
        body: input.body,
        approverMembershipId: input.approverMembershipId,
      });
    else if (input.kind === 'invoice')
      proposed = await proposeInvoiceDraft(joined, context, {
        connectionId: record.connectionId,
        workUnitId: work.id,
        invoice: input.invoice,
        approverMembershipId: input.approverMembershipId,
      });
    else throw new AppError('INVALID_INPUT');
    return { ...proposed, workUnitId: work.id };
  });
}

/** Tenant upkeep clears content only on revoked connections, using the native platform worker. */
export async function purgeRevokedBusinessRecords(
  database: AppDatabase,
  context: TenantContext,
): Promise<number> {
  return withTenantTx(database, context, async (tx) => {
    await nativeService(tx, context, 'ensemus_worker');
    await tx.execute(sql`select set_config('app.business_record_purge','true',true)`);
    const revoked = tx
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.state, 'revoked'));
    const rows = await tx
      .update(businessRecords)
      .set({
        fields: {},
        fieldsSha256: fieldsHash({}),
        displayName: null,
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(businessRecords.connectionId, revoked),
          or(
            isNull(businessRecords.deletedAt),
            sql`${businessRecords.fields}<>'{}'::jsonb`,
            sql`${businessRecords.displayName} is not null`,
          ),
        ),
      )
      .returning({ id: businessRecords.id });
    return rows.length;
  });
}
