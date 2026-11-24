// Owned by the meetings-proposals slice (EXP-03). See docs/06-delivery/m11a-slices.md and ADR-033 D7. Derived work
// is proposed, never applied: this is the only path from a proposal to a Work Unit, and it takes a person.
import {
  meetingProposedItems,
  meetingSummaries,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  proposedItemTargetRef,
  type ProposedItemKind,
  type ProposedItemStatus,
} from '@ensemus/domain/meeting';
import { MEETING_ITEM_ACCEPTED, MEETING_ITEM_REJECTED } from '@ensemus/domain/expansion-events';
import type { Classification } from '@ensemus/domain/policy';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, pgCode } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import { meetingForContent, withMeetingPerson } from './meeting-manual';
import { auditAction, createWorkUnitInTx } from './work';

export type ProposedItemView = {
  id: string;
  meetingId: string;
  kind: ProposedItemKind;
  /** Null once consent has gone. */
  title: string | null;
  detail: string | null;
  suggestedOwnerMembershipId: string | null;
  suggestedDueOn: string | null;
  status: ProposedItemStatus;
  decidedByMembershipId: string | null;
  decidedAt: Date | null;
  workUnitId: string | null;
  version: number;
};

export type MeetingSummaryTextView = {
  id: string;
  runId: string;
  /** Null once consent has gone. */
  text: string | null;
  /** Always `model_generated`, and the page says so. */
  trust: 'model_generated';
  createdAt: Date;
};

type ProposalVersion = { itemId: string; expectedVersion: number };

function validId(value: string) {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}

async function proposalMeetingId(tx: Tx, id: string) {
  const [item] = await tx
    .select({ meetingId: meetingProposedItems.meetingId })
    .from(meetingProposedItems)
    .where(eq(meetingProposedItems.id, validId(id)));
  if (!item) throw new AppError('NOT_FOUND');
  return item.meetingId;
}

export function listProposedItems(
  database: AppDatabase,
  context: TenantContext,
  meetingId: string,
): Promise<readonly ProposedItemView[]> {
  return withMeetingPerson(database, context, async (tx, viewer) => {
    const meeting = await meetingForContent(tx, meetingId, viewer);
    const rows = await tx
      .select({
        id: meetingProposedItems.id,
        meetingId: meetingProposedItems.meetingId,
        kind: meetingProposedItems.kind,
        title: meetingProposedItems.title,
        detail: meetingProposedItems.detail,
        suggestedOwnerMembershipId: meetingProposedItems.suggestedOwnerMembershipId,
        suggestedDueOn: meetingProposedItems.suggestedDueOn,
        status: meetingProposedItems.status,
        decidedByMembershipId: meetingProposedItems.decidedByMembershipId,
        decidedAt: meetingProposedItems.decidedAt,
        workUnitId: meetingProposedItems.workUnitId,
        version: meetingProposedItems.version,
      })
      .from(meetingProposedItems)
      .where(eq(meetingProposedItems.meetingId, meeting.id))
      .orderBy(
        asc(meetingProposedItems.createdAt),
        asc(meetingProposedItems.runId),
        asc(meetingProposedItems.ordinal),
      );
    return rows.map((row) => ({
      ...row,
      kind: row.kind as ProposedItemKind,
      status: row.status as ProposedItemStatus,
      suggestedOwnerMembershipId: row.title === null ? null : row.suggestedOwnerMembershipId,
      suggestedDueOn: row.title === null ? null : row.suggestedDueOn,
    }));
  });
}

export function listMeetingSummaries(
  database: AppDatabase,
  context: TenantContext,
  meetingId: string,
): Promise<readonly MeetingSummaryTextView[]> {
  return withMeetingPerson(database, context, async (tx, viewer) => {
    const meeting = await meetingForContent(tx, meetingId, viewer);
    const rows = await tx
      .select({
        id: meetingSummaries.id,
        runId: meetingSummaries.runId,
        text: meetingSummaries.body,
        createdAt: meetingSummaries.createdAt,
      })
      .from(meetingSummaries)
      .where(eq(meetingSummaries.meetingId, meeting.id))
      .orderBy(asc(meetingSummaries.createdAt), asc(meetingSummaries.id));
    return rows.map((row) => ({ ...row, trust: 'model_generated' as const }));
  });
}

/** Check the current room and linkage before reporting the result of an idempotent retry. */
export function confirmProposedWork(
  database: AppDatabase,
  context: TenantContext,
  itemId: string,
  workUnitId: string,
): Promise<void> {
  return withMeetingPerson(database, context, async (tx, viewer) => {
    const meeting = await meetingForContent(tx, await proposalMeetingId(tx, itemId), viewer);
    if (meeting.status !== 'open') throw new AppError('MEETING_PURGED');
    const [row] = await tx
      .select({ id: meetingProposedItems.id })
      .from(meetingProposedItems)
      .where(
        and(
          eq(meetingProposedItems.id, itemId),
          eq(meetingProposedItems.status, 'accepted'),
          eq(meetingProposedItems.workUnitId, workUnitId),
        ),
      );
    if (!row) throw new AppError('NOT_FOUND');
  });
}

type Outcome =
  | {
      kind: 'work';
      title: string;
      objective?: string;
      ownerMembershipId: string;
      dueAt: Date | null;
    }
  | { kind: 'decision' | 'reject'; reason?: string };
const reasonSchema = z.string().trim().min(1).max(2000).optional();

function settleProposal(
  database: AppDatabase,
  context: TenantContext,
  input: ProposalVersion,
  outcome: Outcome,
) {
  return withMeetingPerson(database, context, async (tx, viewer) => {
    const itemId = validId(input.itemId);
    // Withdrawal and decision use the same room-first order.
    const meeting = await meetingForContent(tx, await proposalMeetingId(tx, itemId), viewer, true);
    if (meeting.status !== 'open') throw new AppError('MEETING_PURGED');
    const [item] = await tx
      .select({
        status: meetingProposedItems.status,
        kind: meetingProposedItems.kind,
        version: meetingProposedItems.version,
        title: meetingProposedItems.title,
      })
      .from(meetingProposedItems)
      .where(eq(meetingProposedItems.id, itemId))
      .for('update');
    if (!item) throw new AppError('NOT_FOUND');
    if (item.status !== 'proposed' || item.title === null)
      throw new AppError('PROPOSAL_ALREADY_DECIDED');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
      throw new AppError('INVALID_INPUT');
    if (item.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (outcome.kind !== 'reject' && outcome.kind !== item.kind)
      throw new AppError('INVALID_INPUT');

    const reason = reasonSchema.safeParse(outcome.kind === 'work' ? undefined : outcome.reason);
    if (!reason.success) throw new AppError('INVALID_INPUT');
    const work =
      outcome.kind === 'work'
        ? await createWorkUnitInTx(tx, context, {
            title: outcome.title,
            objective: outcome.objective,
            ownerMembershipId: outcome.ownerMembershipId,
            dueAt: outcome.dueAt ?? undefined,
            classification: meeting.classification as Classification,
          })
        : null;
    const version = item.version + 1;
    const now = new Date();
    await tx
      .update(meetingProposedItems)
      .set({
        status: outcome.kind === 'reject' ? 'rejected' : 'accepted',
        version,
        decidedAt: now,
        updatedAt: now,
        decidedByMembershipId: viewer.membershipId,
        decisionReason: reason.data ?? null,
        workUnitId: work?.id ?? null,
      })
      .where(eq(meetingProposedItems.id, itemId));
    const event = outcome.kind === 'reject' ? MEETING_ITEM_REJECTED : MEETING_ITEM_ACCEPTED;
    await emit(tx, context, {
      eventType: event,
      aggregateType: 'meeting_item',
      aggregateId: itemId,
      aggregateVersion: version,
      classification: meeting.classification,
      payload: { item_id: itemId, meeting_id: meeting.id },
    });
    await auditAction(tx, context, event, proposedItemTargetRef(itemId));
    // The HTTP idempotency receipt is derived from the transaction's return value.
    return work ? { workUnitId: work.id, version: work.version } : { workUnitId: null, version };
  }).catch((error) => {
    if (pgCode(error) === 'EN113') throw new AppError('INVALID_STATE');
    throw error;
  });
}

export async function acceptProposedWork(
  database: AppDatabase,
  context: TenantContext,
  input: ProposalVersion & {
    title: string;
    objective?: string;
    ownerMembershipId: string;
    dueAt: Date | null;
  },
): Promise<{ workUnitId: string; version: number }> {
  const result = await settleProposal(database, context, input, { ...input, kind: 'work' });
  if (result.workUnitId === null) throw new AppError('INVALID_STATE');
  return result;
}

export async function acceptProposedDecision(
  database: AppDatabase,
  context: TenantContext,
  input: ProposalVersion & { reason?: string },
): Promise<{ version: number }> {
  const { version } = await settleProposal(database, context, input, {
    ...input,
    kind: 'decision',
  });
  return { version };
}

export async function rejectProposedItem(
  database: AppDatabase,
  context: TenantContext,
  input: ProposalVersion & { reason?: string },
): Promise<{ version: number }> {
  const { version } = await settleProposal(database, context, input, { ...input, kind: 'reject' });
  return { version };
}
