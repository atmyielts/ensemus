import { createHash } from 'node:crypto';
import {
  connections,
  meetingImportRequests,
  meetingNotes,
  meetingProviderApprovals,
  meetings,
  meetingSettings,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  AGGREGATE_MEETING,
  AGGREGATE_MEETING_IMPORT,
  MEETING_IMPORT_REQUESTED,
  MEETING_NOTES_IMPORTED,
} from '@ensemus/domain/expansion-events';
import {
  checkProviderApproval,
  MAX_NOTES_BYTES,
  meetingTargetRef,
  type ImportStatus,
  type MeetingStopCode,
  type ProviderApprovalFacts,
} from '@ensemus/domain/meeting';
import type { Classification } from '@ensemus/domain/policy';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { AppError } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import { meetingForContent, withMeetingPerson } from './meeting-manual';
import {
  coversMeetingSource,
  findMeetingSource,
  MEETING_NOTES_SOURCE_TYPE,
} from './meeting-source';
import { auditAction } from './work';

type Room = typeof meetings.$inferSelect;
type Request = typeof meetingImportRequests.$inferSelect;
type TerminalStatus = Exclude<ImportStatus, 'requested'>;

export type ImportRequestView = {
  id: string;
  meetingId: string;
  status: ImportStatus;
  statusCode: MeetingStopCode | null;
  createdAt: Date;
  finishedAt: Date | null;
};

function view(row: Request): ImportRequestView {
  return {
    id: row.id,
    meetingId: row.meetingId,
    status: row.status as ImportStatus,
    statusCode: row.statusCode as MeetingStopCode | null,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

function validId(value: string) {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}

function roomIs(organizationId: string, id: string) {
  return and(eq(meetings.organizationId, organizationId), eq(meetings.id, id));
}
function requestIs(organizationId: string, id: string) {
  return and(
    eq(meetingImportRequests.organizationId, organizationId),
    eq(meetingImportRequests.id, id),
  );
}

async function sourceAuthority(tx: Tx, room: Room, approvalId: string, requester: string) {
  const org = room.organizationId;
  if (room.status === 'purged') return { code: 'MEETING_PURGED' } as const;
  if (
    room.sourceKind !== 'connector' ||
    !room.connectionId ||
    !room.sourceResourceId ||
    room.organizerMembershipId !== requester
  )
    return { code: 'SOURCE_NOT_FOUND' } as const;
  const [settings] = await tx
    .select({ enabled: meetingSettings.enabled })
    .from(meetingSettings)
    .where(eq(meetingSettings.organizationId, org))
    .for('share');
  if (!settings?.enabled) return { code: 'MEETINGS_NOT_ENABLED' } as const;
  const consent = await tx.execute<{ allowed: boolean }>(
    sql`select meetings.consent_complete(${org}::uuid,${room.id}::uuid) as allowed`,
  );
  if (consent.rows[0]?.allowed !== true) return { code: 'CONSENT_INCOMPLETE' } as const;

  const [approval] = await tx
    .select()
    .from(meetingProviderApprovals)
    .where(
      and(
        eq(meetingProviderApprovals.organizationId, org),
        eq(meetingProviderApprovals.id, approvalId),
      ),
    )
    .for('share');
  const valid = checkProviderApproval(
    approval?.targetRef === `connection:${room.connectionId}`
      ? (approval as ProviderApprovalFacts)
      : null,
    {
      kind: 'source',
      purpose: 'import_notes',
      classification: room.classification as Classification,
    },
    new Date(),
  );
  if (!valid.ok) return { code: valid.code } as const;

  const [connection] = await tx
    .select({
      id: connections.id,
      connectorType: connections.connectorType,
      state: connections.state,
      config: connections.config,
      credentialSecretId: connections.credentialSecretId,
    })
    .from(connections)
    .where(
      and(
        eq(connections.organizationId, org),
        eq(connections.id, room.connectionId),
        eq(connections.connectorType, MEETING_NOTES_SOURCE_TYPE),
        isNull(connections.ownerMembershipId),
      ),
    )
    .for('share');
  if (!connection || connection.state !== 'active')
    return { code: 'CONNECTION_NOT_ACTIVE' } as const;
  if (!connection.credentialSecretId) return { code: 'CONNECTOR_UNAVAILABLE' } as const;

  const source = await findMeetingSource(tx, {
    organizationId: org,
    resourceId: room.sourceResourceId,
    connectionId: connection.id,
    requester,
  });
  if (!source) return { code: 'SOURCE_NOT_FOUND' } as const;
  // Imported notes inherit the meeting's class, so a source upgrade must block a downgrade.
  if (!coversMeetingSource(room.classification, source.classification))
    return { code: 'CLASSIFICATION_NOT_ALLOWED' } as const;
  return { connection, externalId: source.externalId } as const;
}

function refuseRequest(code: MeetingStopCode): never {
  if (code === 'SOURCE_NOT_FOUND') throw new AppError('NOT_FOUND');
  switch (code) {
    case 'MEETING_PURGED':
    case 'MEETINGS_NOT_ENABLED':
    case 'CONSENT_INCOMPLETE':
    case 'PROVIDER_APPROVAL_EXPIRED':
    case 'CLASSIFICATION_NOT_ALLOWED':
    case 'CONNECTION_NOT_ACTIVE':
      throw new AppError(code);
    default:
      throw new AppError('PROVIDER_NOT_APPROVED');
  }
}

/** Only the current organizer may queue a read of this meeting's exact, approved source. */
export function requestMeetingNotesImport(
  database: AppDatabase,
  context: TenantContext,
  input: { meetingId: string; providerApprovalId: string },
): Promise<ImportRequestView> {
  const approvalId = validId(input.providerApprovalId);
  return withMeetingPerson(database, context, async (tx, viewer) => {
    const { id, organizerMembershipId } = await meetingForContent(
      tx,
      input.meetingId,
      viewer,
      true,
    );
    if (organizerMembershipId !== viewer.membershipId) throw new AppError('FORBIDDEN');
    const [room] = await tx.select().from(meetings).where(roomIs(context.organizationId, id));
    if (!room || room.sourceKind !== 'connector') throw new AppError('INVALID_STATE');
    const allowed = await sourceAuthority(tx, room, approvalId, viewer.membershipId);
    if ('code' in allowed) refuseRequest(allowed.code);
    const [open] = await tx
      .select()
      .from(meetingImportRequests)
      .where(
        and(
          eq(meetingImportRequests.organizationId, room.organizationId),
          eq(meetingImportRequests.meetingId, id),
          eq(meetingImportRequests.status, 'requested'),
        ),
      );
    if (open) {
      if (open.sourceApprovalId !== approvalId) throw new AppError('VERSION_CONFLICT');
      return view(open);
    }
    const [request] = await tx
      .insert(meetingImportRequests)
      .values({
        organizationId: room.organizationId,
        meetingId: id,
        sourceApprovalId: approvalId,
        requestedByMembershipId: viewer.membershipId,
      })
      .returning();
    if (!request) throw new AppError('INVALID_STATE');
    await emit(tx, context, {
      eventType: MEETING_IMPORT_REQUESTED,
      aggregateType: AGGREGATE_MEETING_IMPORT,
      aggregateId: request.id,
      aggregateVersion: request.version,
      classification: room.classification,
      payload: { meeting_id: id },
    });
    await auditAction(tx, context, MEETING_IMPORT_REQUESTED, meetingTargetRef(id));
    return view(request);
  });
}

export function getMeetingImport(
  database: AppDatabase,
  context: TenantContext,
  meetingId: string,
  importRequestId: string,
): Promise<ImportRequestView> {
  return withMeetingPerson(database, context, async (tx, viewer) => {
    const room = await meetingForContent(tx, meetingId, viewer);
    if (room.organizerMembershipId !== viewer.membershipId) throw new AppError('FORBIDDEN');
    const [row] = await tx
      .select()
      .from(meetingImportRequests)
      .where(
        and(
          requestIs(context.organizationId, validId(importRequestId)),
          eq(meetingImportRequests.meetingId, room.id),
          eq(meetingImportRequests.requestedByMembershipId, viewer.membershipId),
        ),
      );
    if (!row) throw new AppError('NOT_FOUND');
    return view(row);
  });
}

export function getMeetingSourceImportPanel(
  database: AppDatabase,
  context: TenantContext,
  meetingId: string,
) {
  return withMeetingPerson(database, context, async (tx, viewer) => {
    const visible = await meetingForContent(tx, meetingId, viewer);
    if (visible.organizerMembershipId !== viewer.membershipId) throw new AppError('FORBIDDEN');
    const [room] = await tx
      .select()
      .from(meetings)
      .where(roomIs(context.organizationId, visible.id));
    if (!room || !room.sourceResourceId || !room.connectionId) throw new AppError('NOT_FOUND');
    const [last] = await tx
      .select()
      .from(meetingImportRequests)
      .where(
        and(
          eq(meetingImportRequests.organizationId, room.organizationId),
          eq(meetingImportRequests.meetingId, room.id),
          eq(meetingImportRequests.requestedByMembershipId, viewer.membershipId),
        ),
      )
      .orderBy(desc(meetingImportRequests.createdAt), desc(meetingImportRequests.id))
      .limit(1);
    const source = await findMeetingSource(tx, {
      organizationId: room.organizationId,
      resourceId: room.sourceResourceId,
      connectionId: room.connectionId,
      requester: viewer.membershipId,
    });
    const approvals =
      source && coversMeetingSource(room.classification, source.classification)
        ? await tx
            .select({
              id: meetingProviderApprovals.id,
              expiresAt: meetingProviderApprovals.expiresAt,
              max: meetingProviderApprovals.maxClassification,
            })
            .from(meetingProviderApprovals)
            .where(
              and(
                eq(meetingProviderApprovals.organizationId, room.organizationId),
                eq(meetingProviderApprovals.kind, 'source'),
                eq(meetingProviderApprovals.targetRef, `connection:${room.connectionId}`),
                isNull(meetingProviderApprovals.revokedAt),
                gt(meetingProviderApprovals.expiresAt, new Date()),
              ),
            )
            .orderBy(desc(meetingProviderApprovals.expiresAt), desc(meetingProviderApprovals.id))
            .limit(20)
        : [];
    return {
      last: last ? view(last) : null,
      sourceName: source?.connectionName ?? null,
      approvals: approvals
        .filter((approval) => coversMeetingSource(approval.max, room.classification))
        .map(({ id, expiresAt }) => ({ id, expiresAt })),
    };
  });
}

/** Only the bound connector Activity handles this transport data. */
export type PreparedImport = {
  importRequestId: string;
  meetingId: string;
  externalId: string;
  connection: {
    id: string;
    connectorType: string;
    config: unknown;
    credentialSecretId: string | null;
  };
};
export type BeginImport =
  | { kind: 'go'; prepared: PreparedImport }
  | { kind: 'done'; status: TerminalStatus }
  | { kind: 'stopped'; code: MeetingStopCode };

function withImport<T>(
  database: AppDatabase,
  context: TenantContext,
  id: string,
  role: 'connector' | 'platform' | 'either',
  use: (tx: Tx, room: Room, request: Request, login: string) => Promise<T>,
) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  return withTenantTx(database, context, async (tx) => {
    const authority = await tx.execute<{ login: string | null }>(
      sql`select case when session_user=current_user then session_user::text end as login`,
    );
    const login = authority.rows[0]?.login;
    if (
      !login ||
      !(
        (login === 'ensemus_connector' && role !== 'platform') ||
        (login === 'ensemus_worker' && role !== 'connector')
      )
    )
      throw new AppError('FORBIDDEN');
    const select = requestIs(context.organizationId, validId(id));
    const [parent] = await tx
      .select({ meetingId: meetingImportRequests.meetingId })
      .from(meetingImportRequests)
      .where(select);
    if (!parent) return null;
    // Withdrawal also takes the meeting lock before the request lock.
    const [room] = await tx
      .select()
      .from(meetings)
      .where(roomIs(context.organizationId, parent.meetingId))
      .for('update');
    const [request] = await tx.select().from(meetingImportRequests).where(select).for('update');
    return room && request ? use(tx, room, request, login) : null;
  });
}

async function settle(
  tx: Tx,
  request: Request,
  status: TerminalStatus,
  code: MeetingStopCode | null,
) {
  await tx
    .update(meetingImportRequests)
    .set({
      status,
      statusCode: code,
      version: request.version + 1,
      finishedAt: new Date(),
    })
    .where(requestIs(request.organizationId, request.id));
  return status;
}

export async function beginMeetingImport(
  database: AppDatabase,
  context: TenantContext,
  input: { importRequestId: string; temporalRunId: string },
): Promise<BeginImport> {
  const temporalRunId = validId(input.temporalRunId);
  return (
    (await withImport(
      database,
      context,
      input.importRequestId,
      'connector',
      async (tx, room, request) => {
        if (request.status !== 'requested')
          return { kind: 'done', status: request.status as TerminalStatus } as const;
        if (request.temporalRunId && request.temporalRunId !== temporalRunId)
          throw new AppError('FORBIDDEN');
        const allowed = await sourceAuthority(
          tx,
          room,
          request.sourceApprovalId,
          request.requestedByMembershipId,
        );
        if ('code' in allowed) {
          await settle(tx, request, 'refused', allowed.code);
          return { kind: 'stopped', code: allowed.code } as const;
        }
        if (!request.temporalRunId)
          await tx
            .update(meetingImportRequests)
            .set({ temporalRunId })
            .where(requestIs(request.organizationId, request.id));
        return {
          kind: 'go',
          prepared: {
            importRequestId: request.id,
            meetingId: room.id,
            externalId: allowed.externalId,
            connection: allowed.connection,
          },
        } as const;
      },
    )) ?? { kind: 'stopped', code: 'SOURCE_NOT_FOUND' }
  );
}

/** Consent and source authority are checked again after the network read in the store transaction. */
export async function finishMeetingImport(
  database: AppDatabase,
  context: TenantContext,
  input: {
    importRequestId: string;
    temporalRunId: string;
    text: string;
    externalVersion: string | null;
  },
): Promise<{ notesId: string; version: number } | { stopped: MeetingStopCode }> {
  const temporalRunId = validId(input.temporalRunId);
  return (
    (await withImport(
      database,
      context,
      input.importRequestId,
      'connector',
      async (tx, room, request) => {
        if (request.temporalRunId !== temporalRunId) throw new AppError('FORBIDDEN');
        if (request.status === 'completed') {
          const [note] = await tx
            .select({ version: meetingNotes.version })
            .from(meetingNotes)
            .where(
              and(
                eq(meetingNotes.organizationId, request.organizationId),
                eq(meetingNotes.id, request.id),
                eq(meetingNotes.meetingId, room.id),
                isNull(meetingNotes.purgedAt),
              ),
            );
          return note
            ? { notesId: request.id, version: note.version }
            : { stopped: 'MEETING_PURGED' as const };
        }
        if (request.status !== 'requested')
          return {
            stopped: (request.statusCode as MeetingStopCode | null) ?? 'CONNECTOR_UNAVAILABLE',
          };
        const allowed = await sourceAuthority(
          tx,
          room,
          request.sourceApprovalId,
          request.requestedByMembershipId,
        );
        if ('code' in allowed) {
          await settle(tx, request, 'refused', allowed.code);
          return { stopped: allowed.code };
        }
        const size = Buffer.byteLength(input.text);
        if (size > MAX_NOTES_BYTES) {
          await settle(tx, request, 'failed', 'SOURCE_TOO_LARGE');
          return { stopped: 'SOURCE_TOO_LARGE' as const };
        }
        if (
          !input.text.trim() ||
          input.text.includes('\0') ||
          (input.externalVersion !== null &&
            (!input.externalVersion ||
              input.externalVersion.length > 1024 ||
              input.externalVersion.includes('\0')))
        ) {
          await settle(tx, request, 'failed', 'CONNECTOR_UNAVAILABLE');
          return { stopped: 'CONNECTOR_UNAVAILABLE' as const };
        }
        const [last] = await tx
          .select({ version: meetingNotes.version })
          .from(meetingNotes)
          .where(
            and(
              eq(meetingNotes.organizationId, room.organizationId),
              eq(meetingNotes.meetingId, room.id),
            ),
          )
          .orderBy(desc(meetingNotes.version))
          .limit(1);
        const version = (last?.version ?? 0) + 1;
        // The request ID is also the immutable insert receipt, so an Activity retry cannot duplicate notes.
        await tx.insert(meetingNotes).values({
          organizationId: room.organizationId,
          id: request.id,
          meetingId: room.id,
          version,
          sourceKind: 'connector',
          sourceApprovalId: request.sourceApprovalId,
          sourceExternalVersion: input.externalVersion,
          body: input.text,
          bodySha256: createHash('sha256').update(input.text).digest('hex'),
          sizeBytes: size,
          classification: room.classification,
        });
        await tx
          .update(meetings)
          .set({ version: room.version + 1, updatedAt: new Date() })
          .where(roomIs(room.organizationId, room.id));
        await settle(tx, request, 'completed', null);
        await emit(tx, context, {
          eventType: MEETING_NOTES_IMPORTED,
          aggregateType: AGGREGATE_MEETING,
          aggregateId: room.id,
          aggregateVersion: room.version + 1,
          classification: room.classification,
          payload: { meeting_id: room.id, notes_id: request.id, notes_version: version },
        });
        await auditAction(tx, context, MEETING_NOTES_IMPORTED, meetingTargetRef(room.id));
        return { notesId: request.id, version };
      },
    )) ?? { stopped: 'SOURCE_NOT_FOUND' }
  );
}

export async function stopMeetingImport(
  database: AppDatabase,
  context: TenantContext,
  input: {
    importRequestId: string;
    temporalRunId: string;
    code: MeetingStopCode;
    to: 'failed' | 'refused';
  },
): Promise<TerminalStatus> {
  const temporalRunId = validId(input.temporalRunId);
  return (
    (await withImport(
      database,
      context,
      input.importRequestId,
      'either',
      async (tx, _, request, login) => {
        if (request.temporalRunId && request.temporalRunId !== temporalRunId)
          throw new AppError('FORBIDDEN');
        if (request.status !== 'requested') return request.status as TerminalStatus;
        if (login === 'ensemus_worker')
          return settle(tx, request, 'failed', 'CONNECTOR_UNAVAILABLE');
        return settle(tx, request, input.to, input.code);
      },
    )) ?? 'refused'
  );
}
