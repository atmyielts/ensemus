import { createHash } from 'node:crypto';
import {
  meetingItemsOutputSchema,
  meetingSummaryOutputSchema,
  requestDerivationSchema,
} from '@ensemus/contracts/meetings';
import {
  egressDecisions,
  meetingDerivationRuns,
  meetingNotes,
  meetingParticipants,
  meetingProposedItems,
  meetingProviderApprovals,
  meetings,
  meetingSettings,
  meetingSummaries,
  modelProfiles,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  AGGREGATE_MEETING_DERIVATION,
  MEETING_DERIVATION_COMPLETED,
  MEETING_DERIVATION_REQUESTED,
  MEETING_DERIVATION_STOPPED,
  NOTIFY_MEETING_DERIVATION_STOPPED,
  NOTIFY_MEETING_ITEMS_PROPOSED,
} from '@ensemus/domain/expansion-events';
import {
  checkBeforeDerivation,
  checkProviderApproval,
  MAX_SUMMARY_BYTES,
  MEETING_STOP_CODES,
  meetingTargetRef,
  type DerivationPurpose,
  type DerivationStatus,
  type MeetingStatus,
  type MeetingStopCode,
  type ProviderApprovalFacts,
} from '@ensemus/domain/meeting';
import type { Classification } from '@ensemus/domain/policy';
import type { AiReasonCode } from '@ensemus/domain/ai';
import { decideEgress } from '@ensemus/policy';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from './errors';
import { loadTenantPolicyBundleInTx } from './ai/egress-log';
import { createHaltCheck } from './ai/halt';
import { toRoutableProfile } from './ai/model-profiles';
import type { RoutableProfile } from './ai/ports';
import { emit } from './events';
import type { MeetingModelAnswer, MeetingModelRequest } from './expansion-ports';
import { idSchema } from './ids';
import { meetingForContent, withMeetingPerson } from './meeting-manual';
import { auditAction, notify } from './work';

export type DerivationRunView = {
  id: string;
  meetingId: string;
  purpose: DerivationPurpose;
  status: DerivationStatus;
  statusCode: MeetingStopCode | null;
  requestedByMembershipId: string;
  createdAt: Date;
  finishedAt: Date | null;
};

type Run = typeof meetingDerivationRuns.$inferSelect;
type Room = Pick<
  typeof meetings.$inferSelect,
  'id' | 'organizationId' | 'organizerMembershipId' | 'status' | 'classification'
>;
const open = (run: Run) => run.status === 'requested' || run.status === 'running';
const view = (row: Run): DerivationRunView => ({
  id: row.id,
  meetingId: row.meetingId,
  purpose: row.purpose as DerivationPurpose,
  status: row.status as DerivationStatus,
  statusCode: row.statusCode as MeetingStopCode | null,
  requestedByMembershipId: row.requestedByMembershipId,
  createdAt: row.createdAt,
  finishedAt: row.finishedAt,
});
const runIs = (context: TenantContext, id: string) =>
  and(
    eq(meetingDerivationRuns.organizationId, context.organizationId),
    eq(meetingDerivationRuns.id, id),
  );

function validId(id: string) {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}

async function latestNotes(tx: Tx, room: Room) {
  const [row] = await tx
    .select({
      id: meetingNotes.id,
      sha: meetingNotes.bodySha256,
      purged: sql<boolean>`${meetingNotes.body} is null`,
    })
    .from(meetingNotes)
    .where(
      and(
        eq(meetingNotes.organizationId, room.organizationId),
        eq(meetingNotes.meetingId, room.id),
      ),
    )
    .orderBy(desc(meetingNotes.version))
    .limit(1);
  return row;
}

async function hasConsent(tx: Tx, room: Room) {
  const result = await tx.execute<{ granted: boolean }>(
    sql`select meetings.consent_complete(${room.organizationId}::uuid, ${room.id}::uuid) as granted`,
  );
  return result.rows[0]?.granted === true;
}

async function checkStart(
  tx: Tx,
  room: Room,
  approvalId: string,
  purpose: DerivationPurpose,
  expectedNotesId?: string,
) {
  const [settings] = await tx
    .select({ enabled: meetingSettings.enabled })
    .from(meetingSettings)
    .where(eq(meetingSettings.organizationId, room.organizationId))
    .for('share');
  const notes = await latestNotes(tx, room);
  const [approval] = await tx
    .select()
    .from(meetingProviderApprovals)
    .where(
      and(
        eq(meetingProviderApprovals.organizationId, room.organizationId),
        eq(meetingProviderApprovals.id, approvalId),
      ),
    )
    .for('share');
  const classification = room.classification as Classification;
  const target = approval?.targetRef.startsWith('model_profile:')
    ? idSchema.safeParse(approval.targetRef.slice('model_profile:'.length))
    : null;
  const check = checkBeforeDerivation({
    meetingStatus: room.status as MeetingStatus,
    consent: (await hasConsent(tx, room)) ? 'complete' : 'pending',
    provider: checkProviderApproval(
      target?.success ? (approval as ProviderApprovalFacts) : null,
      { kind: 'model', purpose, classification },
      new Date(),
    ),
    notesCurrent:
      notes !== undefined && (expectedNotesId === undefined || notes.id === expectedNotesId),
    notesPurged: notes?.purged ?? false,
  });
  if (room.status === 'purged') return { code: 'MEETING_PURGED' } as const;
  if (!settings?.enabled) return { code: 'MEETINGS_NOT_ENABLED' } as const;
  if (!check.ok) return { code: check.code } as const;
  if (!notes || !target?.success) throw new AppError('INVALID_STATE');
  return { notes, modelProfileId: target.data, classification } as const;
}

function refuseRequest(code: MeetingStopCode): never {
  switch (code) {
    case 'MEETINGS_NOT_ENABLED':
    case 'MEETING_PURGED':
    case 'CONSENT_INCOMPLETE':
    case 'PROVIDER_APPROVAL_EXPIRED':
    case 'CLASSIFICATION_NOT_ALLOWED':
      throw new AppError(code);
    case 'NOTES_NOT_CURRENT':
      throw new AppError('MEETING_NOTES_REQUIRED');
    default:
      throw new AppError('PROVIDER_NOT_APPROVED');
  }
}

async function publishRun(
  tx: Tx,
  context: TenantContext,
  room: Room,
  run: Run,
  eventType: string,
  version: number,
  code?: MeetingStopCode,
) {
  await emit(tx, context, {
    eventType,
    aggregateType: AGGREGATE_MEETING_DERIVATION,
    aggregateId: run.id,
    aggregateVersion: version,
    classification: room.classification,
    payload: { meeting_id: room.id, purpose: run.purpose, ...(code ? { code } : {}) },
  });
  await auditAction(tx, context, eventType, meetingTargetRef(room.id), code);
}

/** Queues the latest consented notes once for an exact provider and purpose. */
export function requestMeetingDerivation(
  database: AppDatabase,
  context: TenantContext,
  input: {
    meetingId: string;
    purpose: DerivationPurpose;
    providerApprovalId: string;
    expectedNotesId?: string;
  },
): Promise<DerivationRunView> {
  return withMeetingPerson(database, context, async (tx, viewer) => {
    const parsed = requestDerivationSchema.safeParse({
      purpose: input.purpose,
      provider_approval_id: input.providerApprovalId,
    });
    if (!parsed.success) throw new AppError('INVALID_INPUT');
    const room = await meetingForContent(tx, input.meetingId, viewer, true);
    if (room.organizerMembershipId !== viewer.membershipId) throw new AppError('FORBIDDEN');
    const allowed = await checkStart(
      tx,
      room,
      parsed.data.provider_approval_id,
      parsed.data.purpose,
      input.expectedNotesId === undefined ? undefined : validId(input.expectedNotesId),
    );
    if ('code' in allowed) {
      if (allowed.code === 'NOTES_NOT_CURRENT' && input.expectedNotesId !== undefined)
        throw new AppError('VERSION_CONFLICT');
      refuseRequest(allowed.code);
    }
    const [prior] = await tx
      .select()
      .from(meetingDerivationRuns)
      .where(
        and(
          eq(meetingDerivationRuns.organizationId, room.organizationId),
          eq(meetingDerivationRuns.notesId, allowed.notes.id),
          eq(meetingDerivationRuns.purpose, parsed.data.purpose),
          inArray(meetingDerivationRuns.status, ['requested', 'running']),
        ),
      );
    if (prior) {
      if (prior.providerApprovalId !== parsed.data.provider_approval_id)
        throw new AppError('INVALID_STATE');
      return view(prior);
    }

    const [run] = await tx
      .insert(meetingDerivationRuns)
      .values({
        organizationId: room.organizationId,
        meetingId: room.id,
        notesId: allowed.notes.id,
        providerApprovalId: parsed.data.provider_approval_id,
        purpose: parsed.data.purpose,
        requestedByMembershipId: viewer.membershipId,
      })
      .returning();
    if (!run) throw new AppError('INVALID_STATE');
    await publishRun(tx, context, room, run, MEETING_DERIVATION_REQUESTED, run.version);
    return view(run);
  });
}

export function listMeetingDerivations(
  database: AppDatabase,
  context: TenantContext,
  meetingId: string,
  options: { recentOnly?: boolean } = {},
): Promise<readonly DerivationRunView[]> {
  return withMeetingPerson(database, context, async (tx, viewer) => {
    const room = await meetingForContent(tx, meetingId, viewer);
    const query = tx
      .select()
      .from(meetingDerivationRuns)
      .where(
        and(
          eq(meetingDerivationRuns.organizationId, room.organizationId),
          eq(meetingDerivationRuns.meetingId, room.id),
        ),
      )
      .orderBy(desc(meetingDerivationRuns.createdAt), desc(meetingDerivationRuns.id));
    const rows = await (options.recentOnly ? query.limit(10) : query);
    return rows.map(view);
  });
}

export function getMeetingDerivation(
  database: AppDatabase,
  context: TenantContext,
  meetingId: string,
  runId: string,
): Promise<DerivationRunView> {
  return withMeetingPerson(database, context, async (tx, viewer) => {
    const room = await meetingForContent(tx, meetingId, viewer);
    const [row] = await tx
      .select()
      .from(meetingDerivationRuns)
      .where(and(runIs(context, validId(runId)), eq(meetingDerivationRuns.meetingId, room.id)));
    if (!row) throw new AppError('NOT_FOUND');
    return view(row);
  });
}

/** A native worker locks the room before the run, as withdrawal does. */
type DerivationWorker = 'ensemus_worker' | 'ensemus_agent';
function withWorkerRun<T>(
  database: AppDatabase,
  context: TenantContext,
  runId: string,
  use: (tx: Tx, room: Room, run: Run, worker: DerivationWorker) => Promise<T>,
): Promise<T | null> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  return withTenantTx(database, context, async (tx) => {
    const identity = await tx.execute<{ login: string | null }>(
      sql`select case when session_user=current_user then session_user::text end as login`,
    );
    const login = identity.rows[0]?.login;
    if (login !== 'ensemus_worker' && login !== 'ensemus_agent') throw new AppError('FORBIDDEN');
    const selector = runIs(context, validId(runId));
    const [parent] = await tx
      .select({ id: meetingDerivationRuns.meetingId })
      .from(meetingDerivationRuns)
      .where(selector);
    if (!parent) return null;
    const [room] = await tx
      .select({
        id: meetings.id,
        organizationId: meetings.organizationId,
        organizerMembershipId: meetings.organizerMembershipId,
        status: meetings.status,
        classification: meetings.classification,
      })
      .from(meetings)
      .where(and(eq(meetings.organizationId, context.organizationId), eq(meetings.id, parent.id)))
      .for('update');
    if (!room) return null;
    const [run] = await tx.select().from(meetingDerivationRuns).where(selector).for('update');
    return run ? use(tx, room, run, login) : null;
  });
}

function profileIs(context: TenantContext, id: string) {
  return and(eq(modelProfiles.organizationId, context.organizationId), eq(modelProfiles.id, id));
}

export async function loadMeetingModelProfile(
  database: AppDatabase,
  context: TenantContext,
  id: string,
): Promise<RoutableProfile | null> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const [profile] = await withTenantTx(database, context, (tx) =>
    tx
      .select()
      .from(modelProfiles)
      .where(profileIs(context, validId(id))),
  );
  return profile ? toRoutableProfile(profile) : null;
}

export type MeetingModelDispatchInput = Pick<
  MeetingModelRequest,
  'runId' | 'temporalRunId' | 'notesSha256' | 'purpose' | 'classification' | 'modelProfileId'
> & {
  profileVersion: number;
  /** A credential or canary in the source always raises it to restricted for the decision. */
  effectiveClass: Classification;
  transportRefusal: AiReasonCode | null;
};

function modelHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Resolves the exact approved version and records its decision before a provider key can be opened. */
export async function claimMeetingModelDispatch(
  database: AppDatabase,
  context: TenantContext,
  input: MeetingModelDispatchInput,
): Promise<{ allowed: true } | { allowed: false; code: MeetingStopCode }> {
  const result = await withWorkerRun(
    database,
    context,
    input.runId,
    async (tx, room, run, worker) => {
      if (worker !== 'ensemus_agent') throw new AppError('FORBIDDEN');
      if (run.status !== 'running' || run.temporalRunId !== input.temporalRunId)
        return {
          allowed: false,
          code: room.status === 'purged' ? 'MEETING_PURGED' : 'EGRESS_DENIED',
        } as const;
      if (run.dispatchStartedAt) return { allowed: false, code: 'MODEL_UNAVAILABLE' } as const;
      const purpose = run.purpose as DerivationPurpose;
      const checked = await checkStart(tx, room, run.providerApprovalId, purpose, run.notesId);
      if ('code' in checked) return { allowed: false, code: checked.code } as const;
      if (
        input.modelProfileId !== checked.modelProfileId ||
        input.purpose !== purpose ||
        input.classification !== checked.classification ||
        input.notesSha256 !== checked.notes.sha ||
        (input.effectiveClass !== checked.classification && input.effectiveClass !== 'restricted')
      )
        return { allowed: false, code: 'EGRESS_DENIED' } as const;

      const [row] = await tx
        .select()
        .from(modelProfiles)
        .where(profileIs(context, checked.modelProfileId))
        .for('share');
      const profile = row ? toRoutableProfile(row) : null;
      const current = profile?.version === input.profileVersion;
      const modelPurpose = purpose === 'summarize' ? 'compose' : 'extract';
      const dataClass = input.effectiveClass;
      let reason: AiReasonCode | null = input.transportRefusal;
      if (!profile || !current) reason = 'PROFILE_CHANGED';
      else if (dataClass === 'restricted') reason = 'CLASS_DENIED';
      else if (profile.billingOwner !== 'customer') reason = 'BILLING_OWNER_CROSSED';
      const host = profile ? modelHost(profile.endpointUrl) : null;
      const decision =
        profile && host
          ? decideEgress({
              dataClass,
              purpose: modelPurpose,
              requiredRegion: null,
              bundle: await loadTenantPolicyBundleInTx(tx, context),
              profile: {
                id: profile.id,
                version: profile.version,
                active: profile.status === 'active',
                destination: profile.destination,
                destinationHost: host,
                billingOwner: profile.billingOwner,
                region: profile.region,
                allowedClasses: profile.allowedClasses,
                allowedPurposes: profile.allowedPurposes,
                retentionBasis: profile.retentionBasis,
                contractRef: profile.contractRef,
              },
              now: new Date(),
            })
          : null;
      if (!reason && decision?.decision !== 'allow')
        reason = decision?.reasonCode ?? 'POLICY_UNREADABLE';
      if (!reason && profile) {
        try {
          await createHaltCheck().assertRunning(tx, context, {
            providerKind: profile.providerKind,
          });
        } catch {
          reason = 'POLICY_UNREADABLE';
        }
      }

      const requestHash = createHash('sha256')
        .update(
          JSON.stringify([
            'meeting-derivation',
            room.organizationId,
            run.id,
            checked.notes.sha,
            checked.modelProfileId,
            input.profileVersion,
            purpose,
          ]),
        )
        .digest('hex');
      await tx.insert(egressDecisions).values({
        organizationId: room.organizationId,
        profileId: profile?.id ?? null,
        dataClass,
        purpose: modelPurpose,
        destinationHost: host,
        requestHash,
        decision: reason ? 'deny' : 'allow',
        reasonCode: reason ?? 'ALLOWED',
        policyVersion: decision?.policyVersion ?? 'meeting-dispatch-1',
      });
      if (reason) return { allowed: false, code: 'EGRESS_DENIED' } as const;
      await tx
        .update(meetingDerivationRuns)
        .set({ dispatchStartedAt: new Date() })
        .where(runIs(context, run.id));
      return { allowed: true } as const;
    },
  );
  return result ?? { allowed: false, code: 'EGRESS_DENIED' };
}

async function participants(tx: Tx, room: Room) {
  const people = await tx
    .select({ member: meetingParticipants.membershipId })
    .from(meetingParticipants)
    .where(
      and(
        eq(meetingParticipants.organizationId, room.organizationId),
        eq(meetingParticipants.meetingId, room.id),
      ),
    )
    .orderBy(asc(meetingParticipants.createdAt), asc(meetingParticipants.id));
  return people.map((person) => person.member);
}

async function stop(
  tx: Tx,
  context: TenantContext,
  room: Room,
  run: Run,
  to: 'failed' | 'refused',
  code: MeetingStopCode,
) {
  const version = run.version + 1;
  await tx
    .update(meetingDerivationRuns)
    .set({
      status: to,
      statusCode: code,
      version,
      finishedAt: new Date(),
    })
    .where(runIs(context, run.id));
  await publishRun(tx, context, room, run, MEETING_DERIVATION_STOPPED, version, code);
  await notify(
    tx,
    context,
    [run.requestedByMembershipId, room.organizerMembershipId],
    NOTIFY_MEETING_DERIVATION_STOPPED,
    meetingTargetRef(room.id),
  );
}

/** Notes and positional mapping stay in the worker that makes the call. */
export type PreparedDerivation = {
  runId: string;
  meetingId: string;
  purpose: DerivationPurpose;
  classification: Classification;
  modelProfileId: string;
  notes: string;
  notesSha256: string;
  participants: readonly (string | null)[];
};

export type BeginDerivation =
  | { kind: 'go'; prepared: PreparedDerivation }
  | { kind: 'done'; status: DerivationStatus }
  | { kind: 'stopped'; code: MeetingStopCode };

export async function beginMeetingDerivation(
  database: AppDatabase,
  context: TenantContext,
  input: { derivationRunId: string; temporalRunId: string },
): Promise<BeginDerivation> {
  const temporalRunId = validId(input.temporalRunId);
  return (
    (await withWorkerRun<BeginDerivation>(
      database,
      context,
      input.derivationRunId,
      async (tx, room, run) => {
        if (!open(run)) return { kind: 'done', status: run.status as DerivationStatus };
        if (run.status === 'running' && run.temporalRunId !== temporalRunId)
          return { kind: 'done', status: 'cancelled' };

        const purpose = run.purpose as DerivationPurpose;
        const allowed = await checkStart(tx, room, run.providerApprovalId, purpose, run.notesId);
        if ('code' in allowed) {
          await stop(tx, context, room, run, 'refused', allowed.code);
          return { kind: 'stopped', code: allowed.code };
        }
        const [notes] = await tx
          .select({ text: meetingNotes.body })
          .from(meetingNotes)
          .where(
            and(
              eq(meetingNotes.organizationId, room.organizationId),
              eq(meetingNotes.meetingId, room.id),
              eq(meetingNotes.id, allowed.notes.id),
            ),
          );
        if (!notes?.text) throw new AppError('INVALID_STATE');
        if (run.status === 'requested') {
          await tx
            .update(meetingDerivationRuns)
            .set({
              status: 'running',
              temporalRunId,
              version: run.version + 1,
              startedAt: new Date(),
            })
            .where(runIs(context, run.id));
        }
        return {
          kind: 'go',
          prepared: {
            runId: run.id,
            meetingId: room.id,
            purpose,
            classification: allowed.classification,
            modelProfileId: allowed.modelProfileId,
            notes: notes.text,
            notesSha256: allowed.notes.sha,
            participants: await participants(tx, room),
          },
        };
      },
    )) ?? { kind: 'done', status: 'cancelled' }
  );
}

const receiptSchema = z.strictObject({
  modelRef: z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/),
  inputTokens: z.int().min(0).max(2_147_483_647),
  outputTokens: z.int().min(0).max(2_147_483_647),
});
const safeText = (text: string) => !text.includes('\u0000');

type DerivedResult = { status: DerivationStatus | 'dropped'; items: number };

export async function finishMeetingDerivation(
  database: AppDatabase,
  context: TenantContext,
  input: { derivationRunId: string; temporalRunId: string; answer: MeetingModelAnswer },
): Promise<DerivedResult> {
  const temporalRunId = validId(input.temporalRunId);
  const { output, ...receipt } = input.answer;
  return (
    (await withWorkerRun<DerivedResult>(
      database,
      context,
      input.derivationRunId,
      async (tx, room, run, worker) => {
        if (
          run.temporalRunId !== temporalRunId ||
          room.status !== 'open' ||
          !(await hasConsent(tx, room))
        )
          return { status: 'dropped', items: 0 };
        if (run.status !== 'running') return { status: run.status as DerivationStatus, items: 0 };
        if (worker === 'ensemus_agent' && !run.dispatchStartedAt)
          return { status: 'dropped', items: 0 };

        const metadata = receiptSchema.safeParse(receipt);
        const summary =
          run.purpose === 'summarize' ? meetingSummaryOutputSchema.safeParse(output) : null;
        const items =
          run.purpose === 'extract_items' ? meetingItemsOutputSchema.safeParse(output) : null;
        const summaryText = summary?.success ? summary.data.summary : null;
        const suggestions = items?.success ? items.data.items : null;
        const invalidSummary =
          summaryText === null ||
          !safeText(summaryText) ||
          Buffer.byteLength(summaryText) > MAX_SUMMARY_BYTES;
        const invalidItems =
          suggestions === null ||
          suggestions.some(
            (item) => !safeText(item.title) || (item.detail != null && !safeText(item.detail)),
          );
        if (!metadata.success || (run.purpose === 'summarize' ? invalidSummary : invalidItems)) {
          await stop(tx, context, room, run, 'refused', 'MODEL_OUTPUT_INVALID');
          return { status: 'refused', items: 0 };
        }

        const key = {
          organizationId: room.organizationId,
          meetingId: room.id,
          runId: run.id,
          classification: room.classification,
        };
        if (summaryText !== null) {
          const [source] = await tx
            .select({ sha: meetingNotes.bodySha256 })
            .from(meetingNotes)
            .where(
              and(
                eq(meetingNotes.organizationId, room.organizationId),
                eq(meetingNotes.id, run.notesId),
              ),
            );
          if (!source) throw new AppError('INVALID_STATE');
          await tx
            .insert(meetingSummaries)
            .values({ ...key, sourceNotesSha256: source.sha, body: summaryText });
        }
        if (suggestions?.length) {
          const people = await participants(tx, room);
          await tx.insert(meetingProposedItems).values(
            suggestions.map((item, index) => ({
              ...key,
              ordinal: index + 1,
              kind: item.kind,
              title: item.title,
              detail: item.detail ?? null,
              suggestedDueOn: z.iso.date().safeParse(item.suggested_due_on).data ?? null,
              suggestedOwnerMembershipId:
                item.suggested_participant == null
                  ? null
                  : (people[item.suggested_participant - 1] ?? null),
            })),
          );
          await notify(
            tx,
            context,
            [room.organizerMembershipId, ...people],
            NOTIFY_MEETING_ITEMS_PROPOSED,
            meetingTargetRef(room.id),
          );
        }
        const version = run.version + 1;
        await tx
          .update(meetingDerivationRuns)
          .set({
            ...metadata.data,
            status: 'completed',
            version,
            finishedAt: new Date(),
          })
          .where(runIs(context, run.id));
        await publishRun(tx, context, room, run, MEETING_DERIVATION_COMPLETED, version);
        return { status: 'completed', items: suggestions?.length ?? 0 };
      },
    )) ?? { status: 'dropped', items: 0 }
  );
}

export async function stopMeetingDerivation(
  database: AppDatabase,
  context: TenantContext,
  input: {
    derivationRunId: string;
    temporalRunId: string;
    code: MeetingStopCode;
    to: 'failed' | 'refused';
  },
): Promise<DerivationStatus> {
  const temporalRunId = validId(input.temporalRunId);
  if (!MEETING_STOP_CODES.includes(input.code)) throw new AppError('INVALID_INPUT');
  return (
    (await withWorkerRun<DerivationStatus>(
      database,
      context,
      input.derivationRunId,
      async (tx, room, run) => {
        if (!open(run)) return run.status as DerivationStatus;
        if (run.status === 'running' && run.temporalRunId !== temporalRunId) return 'cancelled';
        await stop(tx, context, room, run, input.to, input.code);
        return input.to;
      },
    )) ?? 'cancelled'
  );
}
