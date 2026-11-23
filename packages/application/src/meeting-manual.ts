// Manual meeting content stays with the people in the room. Every mutation locks the meeting first.
import { createHash } from 'node:crypto';
import {
  interactiveSessionOf,
  meetingConsentRecords,
  meetingDerivationRuns,
  meetingImportRequests,
  meetingNotes,
  meetingParticipants,
  meetingProposedItems,
  meetings,
  meetingSettings,
  meetingSummaries,
  memberships,
  organizations,
  tombstones,
  users,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  canAdministerMeetings,
  canManageMeeting,
  canReadMeetingContent,
  canSeeMeeting,
  consentBasisFor,
  consentStateOf,
  MAX_NOTES_BYTES,
  MAX_PARTICIPANTS,
  meetingTargetRef,
  type ConsentBasis,
  type ConsentDecision,
  type ParticipantKind,
} from '@ensemus/domain/meeting';
import { TOMBSTONE_RECORDED } from '@ensemus/domain/tombstone-ledger';
import {
  MEETING_CREATED,
  MEETING_CONSENT_RECORDED,
  MEETING_CONSENT_WITHDRAWN,
  MEETING_CONTENT_PURGED,
  MEETING_NOTES_IMPORTED,
  NOTIFY_MEETING_CONSENT_REQUESTED,
  NOTIFY_MEETING_CONTENT_PURGED,
} from '@ensemus/domain/expansion-events';
import { and, asc, desc, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Classification } from '@ensemus/domain/policy';
import type { MeetingDetailView, MeetingParticipantView, MeetingSettingsView } from './meetings';
import { AppError, pgCode } from './errors';
import { idSchema } from './ids';
import { emit } from './events';
import { auditAction, notify } from './work';
import { assertInteractivePrivilege } from './product/privileged';

const id = idSchema;
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const createInput = z.strictObject({
  title: z.string().trim().min(1).max(300),
  occurredAt: z.date(),
  classification: z
    .enum(['public', 'internal', 'confidential', 'restricted'])
    .default('confidential'),
});
type MeetingRow = typeof meetings.$inferSelect;
function parsed<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('INVALID_INPUT');
  return result.data;
}
function person(context: TenantContext) {
  if (context.actorType !== 'user' || !interactiveSessionOf(context))
    throw new AppError('FORBIDDEN');
}
async function activePerson(tx: Tx, context: TenantContext) {
  const native = await tx.execute<{ allowed: boolean }>(sql`select app.is_web_login() as allowed`);
  const [row] = await tx
    .select({ id: memberships.id, role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.id, context.membershipId),
        eq(memberships.userId, context.userId),
        eq(memberships.status, 'active'),
      ),
    );
  if (native.rows[0]?.allowed !== true || !row) throw new AppError('FORBIDDEN');
  return { membershipId: row.id, role: row.role };
}
async function human<T>(
  database: AppDatabase,
  context: TenantContext,
  use: (tx: Tx, viewer: { membershipId: string; role: string }) => Promise<T>,
): Promise<T> {
  person(context);
  return withTenantTx(database, context, async (tx) =>
    use(tx, await activePerson(tx, context)),
  ).catch((error) => {
    const code = pgCode(error);
    // Service checks give the detailed reason; concurrent SQL refusals still have safe public codes.
    if (code === 'EN110') throw new AppError('CONSENT_INCOMPLETE');
    if (code === 'EN111') throw new AppError('PROVIDER_NOT_APPROVED');
    if (code === 'EN112' || code === '23503' || code === '23505')
      throw new AppError('INVALID_STATE');
    throw error;
  });
}
async function settings(tx: Tx, lock = false): Promise<MeetingSettingsView> {
  const query = tx.select().from(meetingSettings);
  const [row] = await (lock ? query.for('share') : query);
  return row
    ? { enabled: row.enabled, noticeRef: row.noticeRef, version: row.version }
    : { enabled: false, noticeRef: null, version: 1 };
}
async function enabled(tx: Tx) {
  const value = await settings(tx, true);
  if (!value.enabled) throw new AppError('MEETINGS_NOT_ENABLED');
  return value;
}
export function getMeetingSettings(database: AppDatabase, context: TenantContext) {
  return human(database, context, (tx) => settings(tx));
}
export function updateMeetingSettings(
  database: AppDatabase,
  context: TenantContext,
  input: { expectedVersion: number; enabled: boolean; noticeRef: string | null },
) {
  return human(database, context, async (tx, viewer) => {
    if (!canAdministerMeetings(viewer.role)) throw new AppError('FORBIDDEN');
    const value = parsed(
      z.strictObject({
        expectedVersion: version,
        enabled: z.boolean(),
        noticeRef: z.string().trim().min(1).max(200).nullable(),
      }),
      input,
    );
    if (value.enabled && !value.noticeRef) throw new AppError('INVALID_INPUT');
    await assertInteractivePrivilege(tx, context, 'meeting.manage');
    await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .for('update');
    const prior = await settings(tx);
    if (prior.version !== value.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (value.noticeRef === null) {
      const [open] = await tx
        .select({ id: meetings.id })
        .from(meetings)
        .where(eq(meetings.status, 'open'))
        .limit(1);
      if (open) throw new AppError('INVALID_INPUT');
    }

    await tx
      .insert(meetingSettings)
      .values({
        organizationId: context.organizationId,
        enabled: value.enabled,
        noticeRef: value.noticeRef,
        version: prior.version + 1,
        updatedByMembershipId: viewer.membershipId,
      })
      .onConflictDoUpdate({
        target: meetingSettings.organizationId,
        set: {
          enabled: value.enabled,
          noticeRef: value.noticeRef,
          version: prior.version + 1,
          updatedByMembershipId: viewer.membershipId,
          updatedAt: new Date(),
        },
      });
    await auditAction(
      tx,
      context,
      'meeting.settings_changed',
      `organization:${context.organizationId}`,
    );
    return settings(tx);
  });
}
async function load(tx: Tx, meetingId: string, lock = false) {
  parsed(id, meetingId);
  const query = tx.select().from(meetings).where(eq(meetings.id, meetingId));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}
async function people(tx: Tx, meetingId: string): Promise<MeetingParticipantView[]> {
  const listed = await tx
    .select({
      id: meetingParticipants.id,
      kind: meetingParticipants.kind,
      membershipId: meetingParticipants.membershipId,
      label: meetingParticipants.externalLabel,
      name: users.name,
    })
    .from(meetingParticipants)
    .leftJoin(
      memberships,
      and(
        eq(memberships.id, meetingParticipants.membershipId),
        eq(memberships.organizationId, meetingParticipants.organizationId),
      ),
    )
    .leftJoin(users, eq(users.id, memberships.userId))
    .where(eq(meetingParticipants.meetingId, meetingId))
    .orderBy(asc(meetingParticipants.createdAt), asc(meetingParticipants.id));
  const answers = await tx
    .select()
    .from(meetingConsentRecords)
    .where(eq(meetingConsentRecords.meetingId, meetingId))
    .orderBy(desc(meetingConsentRecords.seq));
  return listed.map((row) => {
    const answer = answers.find((a) => a.participantId === row.id);
    return {
      id: row.id,
      kind: row.kind as ParticipantKind,
      membershipId: row.membershipId,
      displayName: row.label ?? row.name ?? 'Former member',
      decision: (answer?.decision ?? null) as ConsentDecision | null,
      basis: (answer?.basis ?? null) as ConsentBasis | null,
      decidedAt: answer?.recordedAt ?? null,
    };
  });
}
async function access(tx: Tx, row: MeetingRow, viewer: { membershipId: string; role: string }) {
  const listed = await people(tx, row.id);
  const facts = {
    organizerMembershipId: row.organizerMembershipId,
    isParticipant: listed.some((p) => p.membershipId === viewer.membershipId),
  };
  if (!canSeeMeeting(facts, viewer)) throw new AppError('NOT_FOUND');
  return { listed, facts, readable: canReadMeetingContent(facts, viewer) };
}
async function detail(
  tx: Tx,
  row: MeetingRow,
  viewer: { membershipId: string; role: string },
  includeNotes = true,
): Promise<MeetingDetailView> {
  const a = await access(tx, row, viewer);
  const [note] =
    a.readable && includeNotes
      ? await tx
          .select()
          .from(meetingNotes)
          .where(eq(meetingNotes.meetingId, row.id))
          .orderBy(desc(meetingNotes.version))
          .limit(1)
      : [];
  return {
    id: row.id,
    title: a.readable ? row.title : null,
    occurredAt: row.occurredAt,
    organizerMembershipId: row.organizerMembershipId,
    classification: row.classification as Classification,
    status: row.status as 'open' | 'purged',
    sourceKind: row.sourceKind as 'manual' | 'connector',
    consent: consentStateOf(a.listed.map((p) => ({ participantId: p.id, decision: p.decision }))),
    version: row.version,
    participants: a.readable ? a.listed : [],
    currentNotes: note
      ? { id: note.id, version: note.version, text: note.body, createdAt: note.createdAt }
      : null,
  };
}
export function createMeeting(
  database: AppDatabase,
  context: TenantContext,
  input: { title: string; occurredAt: Date; classification?: Classification },
) {
  return human(database, context, async (tx, viewer) => {
    const value = parsed(createInput, input);
    await enabled(tx);
    const [row] = await tx
      .insert(meetings)
      .values({
        organizationId: context.organizationId,
        title: value.title,
        occurredAt: value.occurredAt,
        classification: value.classification,
        organizerMembershipId: viewer.membershipId,
      })
      .returning();
    if (!row) throw new AppError('INVALID_STATE');
    await tx.insert(meetingParticipants).values({
      organizationId: context.organizationId,
      meetingId: row.id,
      kind: 'member',
      membershipId: viewer.membershipId,
    });
    await emit(tx, context, {
      eventType: MEETING_CREATED,
      aggregateType: 'meeting',
      aggregateId: row.id,
      aggregateVersion: row.version,
      classification: row.classification,
      payload: { meeting_id: row.id },
    });
    await auditAction(tx, context, MEETING_CREATED, meetingTargetRef(row.id));
    return detail(tx, row, viewer);
  });
}
export function getMeeting(database: AppDatabase, context: TenantContext, meetingId: string) {
  return human(database, context, async (tx, viewer) =>
    detail(tx, await load(tx, meetingId), viewer),
  );
}
const cursorSchema = z.strictObject({ at: z.iso.datetime({ offset: true }), id });
export function listMeetings(
  database: AppDatabase,
  context: TenantContext,
  input: { after?: string; limit?: number },
) {
  return human(database, context, async (tx, viewer) => {
    const limit = parsed(z.number().int().min(1).max(100), input.limit ?? 25);
    let after: z.infer<typeof cursorSchema> | null = null;
    if (input.after !== undefined) {
      try {
        if (input.after.length > 256) throw new Error();
        after = parsed(
          cursorSchema,
          JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8')),
        );
      } catch {
        throw new AppError('INVALID_INPUT');
      }
    }
    const visible = canAdministerMeetings(viewer.role)
      ? undefined
      : or(
          eq(meetings.organizerMembershipId, viewer.membershipId),
          sql`exists(select 1 from meetings.participants p where p.organization_id=${meetings.organizationId} and p.meeting_id=${meetings.id} and p.membership_id=${viewer.membershipId}::uuid)`,
        );
    const rows = await tx
      .select()
      .from(meetings)
      .where(
        and(
          visible,
          after
            ? or(
                lt(meetings.occurredAt, new Date(after.at)),
                and(eq(meetings.occurredAt, new Date(after.at)), lt(meetings.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(meetings.occurredAt), desc(meetings.id))
      .limit(limit + 1);
    const items = await Promise.all(
      rows.slice(0, limit).map(async (row) => {
        const {
          participants: _,
          currentNotes: __,
          ...summary
        } = await detail(tx, row, viewer, false);
        return summary;
      }),
    );
    const last = rows[limit - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ at: last.occurredAt.toISOString(), id: last.id }),
            ).toString('base64url')
          : null,
    };
  });
}
async function changeable(
  tx: Tx,
  context: TenantContext,
  viewer: { membershipId: string; role: string },
  meetingId: string,
  expectedVersion?: number,
) {
  const row = await load(tx, meetingId, true),
    a = await access(tx, row, viewer);
  if (!canManageMeeting(a.facts, viewer)) throw new AppError('FORBIDDEN');
  if (row.status !== 'open') throw new AppError('MEETING_PURGED');
  if (expectedVersion !== undefined && row.version !== parsed(version, expectedVersion))
    throw new AppError('VERSION_CONFLICT');
  return { row, ...a };
}
async function advance(tx: Tx, row: MeetingRow) {
  await tx
    .update(meetings)
    .set({ version: row.version + 1, updatedAt: new Date() })
    .where(eq(meetings.id, row.id));
}
async function noNotes(tx: Tx, meetingId: string) {
  const [found] = await tx
    .select({ id: meetingNotes.id })
    .from(meetingNotes)
    .where(eq(meetingNotes.meetingId, meetingId))
    .limit(1);
  if (found) throw new AppError('MEETING_PARTICIPANTS_FROZEN');
}
export function addMeetingParticipant(
  database: AppDatabase,
  context: TenantContext,
  input: {
    meetingId: string;
    expectedVersion: number;
    participant: { kind: 'member'; membershipId: string } | { kind: 'external'; label: string };
  },
) {
  return human(database, context, async (tx, viewer) => {
    const value = parsed(
      z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('member'), membershipId: id }),
        z.strictObject({ kind: z.literal('external'), label: z.string().trim().min(1).max(200) }),
      ]),
      input.participant,
    );
    const { row, listed } = await changeable(
      tx,
      context,
      viewer,
      input.meetingId,
      input.expectedVersion,
    );
    await noNotes(tx, row.id);
    if (listed.length >= MAX_PARTICIPANTS) throw new AppError('INVALID_INPUT');
    if (value.kind === 'member') {
      const [member] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.id, value.membershipId), eq(memberships.status, 'active')))
        .for('share');
      if (!member) throw new AppError('NOT_FOUND');
      if (listed.some((p) => p.membershipId === value.membershipId))
        throw new AppError('INVALID_STATE');
    }
    const [added] = await tx
      .insert(meetingParticipants)
      .values({
        organizationId: context.organizationId,
        meetingId: row.id,
        kind: value.kind,
        membershipId: value.kind === 'member' ? value.membershipId : null,
        externalLabel: value.kind === 'external' ? value.label : null,
      })
      .returning({ id: meetingParticipants.id });
    if (!added) throw new AppError('INVALID_STATE');
    await advance(tx, row);
    if (value.kind === 'member')
      await notify(
        tx,
        context,
        [value.membershipId],
        NOTIFY_MEETING_CONSENT_REQUESTED,
        meetingTargetRef(row.id),
      );
    await auditAction(tx, context, 'meeting.participant_added', meetingTargetRef(row.id));
    return (await people(tx, row.id)).find((p) => p.id === added.id)!;
  });
}
export function removeMeetingParticipant(
  database: AppDatabase,
  context: TenantContext,
  input: { meetingId: string; participantId: string; expectedVersion: number },
) {
  return human(database, context, async (tx, viewer) => {
    parsed(id, input.participantId);
    const { row, listed } = await changeable(
      tx,
      context,
      viewer,
      input.meetingId,
      input.expectedVersion,
    );
    await noNotes(tx, row.id);
    const p = listed.find((p) => p.id === input.participantId);
    if (!p) throw new AppError('NOT_FOUND');
    // An answered participant stays with their append-only consent record; the organizer stays listed.
    if (p.membershipId === row.organizerMembershipId || p.decision !== null)
      throw new AppError('INVALID_STATE');
    await tx
      .delete(meetingParticipants)
      .where(and(eq(meetingParticipants.meetingId, row.id), eq(meetingParticipants.id, p.id)));
    await advance(tx, row);
    await auditAction(tx, context, 'meeting.participant_removed', meetingTargetRef(row.id));
  });
}
export function recordMeetingConsent(
  database: AppDatabase,
  context: TenantContext,
  input: { meetingId: string; participantId: string; decision: ConsentDecision; noticeRef: string },
) {
  return human(database, context, async (tx, viewer) => {
    const value = parsed(
      z.strictObject({
        meetingId: id,
        participantId: id,
        decision: z.enum(['granted', 'declined', 'withdrawn']),
        noticeRef: z.string().trim().min(1).max(200),
      }),
      input,
    );
    const row = await load(tx, value.meetingId, true),
      a = await access(tx, row, viewer);
    if (row.status !== 'open') throw new AppError('MEETING_PURGED');
    const p = a.listed.find((p) => p.id === value.participantId);
    if (!p) throw new AppError('NOT_FOUND');
    const basis = consentBasisFor({
      participantKind: p.kind,
      participantMembershipId: p.membershipId,
      organizerMembershipId: row.organizerMembershipId,
      recorderMembershipId: viewer.membershipId,
    });
    if (!basis) throw new AppError('CONSENT_NOT_YOURS');
    const current = await settings(tx, true);
    if (current.noticeRef !== value.noticeRef) throw new AppError('CONSENT_NOTICE_NOT_CURRENT');
    if (value.decision !== 'withdrawn' && !current.enabled)
      throw new AppError('MEETINGS_NOT_ENABLED');
    if (value.decision === 'declined') await noNotes(tx, row.id);
    await tx.insert(meetingConsentRecords).values({
      organizationId: context.organizationId,
      meetingId: row.id,
      participantId: p.id,
      decision: value.decision,
      basis,
      noticeRef: value.noticeRef,
      recordedByMembershipId: viewer.membershipId,
    });
    await emit(tx, context, {
      eventType:
        value.decision === 'withdrawn' ? MEETING_CONSENT_WITHDRAWN : MEETING_CONSENT_RECORDED,
      aggregateType: 'meeting',
      aggregateId: row.id,
      aggregateVersion: row.version + 1,
      classification: row.classification,
      payload: { meeting_id: row.id, participant_id: p.id, decision: value.decision, basis },
    });
    if (value.decision === 'withdrawn')
      await purgeMeetingContentInTx(tx, context, {
        meetingId: row.id,
        reasonCode: 'CONSENT_WITHDRAWN',
      });
    else await advance(tx, row);
    await auditAction(
      tx,
      context,
      value.decision === 'withdrawn' ? MEETING_CONSENT_WITHDRAWN : MEETING_CONSENT_RECORDED,
      meetingTargetRef(row.id),
    );
    return {
      consent: consentStateOf(
        (await people(tx, row.id)).map((p) => ({ participantId: p.id, decision: p.decision })),
      ),
      status: (value.decision === 'withdrawn' ? 'purged' : 'open') as 'purged' | 'open',
    };
  });
}
export function importMeetingNotes(
  database: AppDatabase,
  context: TenantContext,
  input: { meetingId: string; text: string },
) {
  return human(database, context, async (tx, viewer) => {
    if (
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      Buffer.byteLength(input.text, 'utf8') > MAX_NOTES_BYTES
    )
      throw new AppError('INVALID_INPUT');
    const { row, listed } = await changeable(tx, context, viewer, input.meetingId);
    await enabled(tx);
    if (row.sourceKind !== 'manual') throw new AppError('INVALID_STATE');
    if (
      consentStateOf(listed.map((p) => ({ participantId: p.id, decision: p.decision }))) !==
      'complete'
    )
      throw new AppError('CONSENT_INCOMPLETE');
    const [last] = await tx
      .select({ version: meetingNotes.version })
      .from(meetingNotes)
      .where(eq(meetingNotes.meetingId, row.id))
      .orderBy(desc(meetingNotes.version))
      .limit(1);
    const next = (last?.version ?? 0) + 1;
    const [note] = await tx
      .insert(meetingNotes)
      .values({
        organizationId: context.organizationId,
        meetingId: row.id,
        version: next,
        sourceKind: 'manual',
        body: input.text,
        bodySha256: createHash('sha256').update(input.text).digest('hex'),
        sizeBytes: Buffer.byteLength(input.text, 'utf8'),
        classification: row.classification,
        importedByMembershipId: viewer.membershipId,
      })
      .returning({ id: meetingNotes.id });
    if (!note) throw new AppError('INVALID_STATE');
    await advance(tx, row);
    await emit(tx, context, {
      eventType: MEETING_NOTES_IMPORTED,
      aggregateType: 'meeting',
      aggregateId: row.id,
      aggregateVersion: row.version + 1,
      classification: row.classification,
      payload: { meeting_id: row.id, notes_id: note.id, notes_version: next },
    });
    await auditAction(tx, context, MEETING_NOTES_IMPORTED, meetingTargetRef(row.id));
    return { notesId: note.id, version: next };
  });
}
export async function purgeMeetingContentInTx(
  tx: Tx,
  context: TenantContext,
  input: { meetingId: string; reasonCode: 'CONSENT_WITHDRAWN' },
) {
  if (input.reasonCode !== 'CONSENT_WITHDRAWN') throw new AppError('INVALID_INPUT');
  const row = await load(tx, input.meetingId, true);
  if (context.actorType === 'service') {
    const native = await tx.execute<{ allowed: boolean }>(
      sql`select session_user='ensemus_worker' and current_user=session_user as allowed`,
    );
    if (native.rows[0]?.allowed !== true) throw new AppError('FORBIDDEN');
  } else {
    person(context);
    const viewer = await activePerson(tx, context),
      a = await access(tx, row, viewer);
    if (!a.readable) throw new AppError('FORBIDDEN');
    if (
      consentStateOf(a.listed.map((p) => ({ participantId: p.id, decision: p.decision }))) !==
      'withdrawn'
    )
      throw new AppError('INVALID_STATE');
  }
  const now = new Date();
  await tx
    .update(meetingDerivationRuns)
    .set({
      status: 'refused',
      statusCode: 'CONSENT_WITHDRAWN',
      version: sql`${meetingDerivationRuns.version}+1`,
      finishedAt: now,
    })
    .where(
      and(
        eq(meetingDerivationRuns.meetingId, row.id),
        inArray(meetingDerivationRuns.status, ['requested', 'running']),
      ),
    );
  await tx
    .update(meetingImportRequests)
    .set({
      status: 'refused',
      statusCode: 'CONSENT_WITHDRAWN',
      version: sql`${meetingImportRequests.version}+1`,
      finishedAt: now,
    })
    .where(
      and(
        eq(meetingImportRequests.meetingId, row.id),
        eq(meetingImportRequests.status, 'requested'),
      ),
    );
  await tx
    .update(meetingProposedItems)
    .set({
      status: 'withdrawn',
      title: null,
      detail: null,
      decisionReason: null,
      purgedAt: now,
      version: sql`${meetingProposedItems.version}+1`,
      updatedAt: now,
    })
    .where(
      and(eq(meetingProposedItems.meetingId, row.id), eq(meetingProposedItems.status, 'proposed')),
    );
  await tx
    .update(meetingProposedItems)
    .set({
      title: null,
      detail: null,
      decisionReason: null,
      purgedAt: now,
      version: sql`${meetingProposedItems.version}+1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(meetingProposedItems.meetingId, row.id),
        inArray(meetingProposedItems.status, ['accepted', 'rejected']),
        isNotNull(meetingProposedItems.title),
      ),
    );
  const cleared = await tx
    .update(meetingNotes)
    .set({ body: null, purgedAt: now })
    .where(and(eq(meetingNotes.meetingId, row.id), isNotNull(meetingNotes.body)))
    .returning({ id: meetingNotes.id });
  await tx
    .update(meetingSummaries)
    .set({ body: null, purgedAt: now })
    .where(and(eq(meetingSummaries.meetingId, row.id), isNotNull(meetingSummaries.body)));
  if (row.status !== 'purged')
    await tx
      .update(meetings)
      .set({ status: 'purged', version: row.version + 1, updatedAt: now })
      .where(eq(meetings.id, row.id));
  const added = await tx
    .insert(tombstones)
    .values({
      organizationId: context.organizationId,
      targetType: 'meeting',
      targetId: row.id,
      reasonCode: input.reasonCode,
    })
    .onConflictDoNothing()
    .returning({ id: tombstones.targetId });
  if (added.length)
    await emit(tx, context, {
      eventType: TOMBSTONE_RECORDED,
      aggregateType: 'meeting',
      aggregateId: row.id,
      aggregateVersion: 1,
      classification: row.classification,
      payload: { meeting_id: row.id },
    });
  if (row.status !== 'purged' || cleared.length) {
    await emit(tx, context, {
      eventType: MEETING_CONTENT_PURGED,
      aggregateType: 'meeting',
      aggregateId: row.id,
      aggregateVersion: row.version + 1,
      classification: row.classification,
      payload: { meeting_id: row.id, reason_code: input.reasonCode },
    });
    await notify(
      tx,
      context,
      (await people(tx, row.id)).map((p) => p.membershipId),
      NOTIFY_MEETING_CONTENT_PURGED,
      meetingTargetRef(row.id),
    );
  }
}
