import 'server-only';
import {
  AppError,
  acceptProposedWork,
  confirmProposedWork,
  getWorkUnit,
  approveMeetingProvider,
  getMeetingProviderApproval,
  getMeeting,
  idSchema,
  importMeetingNotes,
  getMeetingDerivation,
  requestMeetingDerivation,
  requestHash,
  runIdempotent,
  type DerivationRunView,
  type MeetingDetailView,
  type MeetingParticipantView,
  type MeetingSummaryView,
  type MeetingSummaryTextView,
  type ProposedItemView,
  type ProviderApprovalView,
} from '@ensemus/application';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { canonicalJson } from '@ensemus/domain/approval';
import type {
  AcceptProposedWorkBody,
  ApproveProviderBody,
  RequestDerivationBody,
} from '@ensemus/contracts/meetings';
import { z } from 'zod';
import { organizationParams } from './api';
import { studioOnce } from './studio-api';
export const meetingParams = organizationParams.extend({ meetingId: idSchema });
export const participantParams = meetingParams.extend({ participantId: idSchema });
export const meetingSummaryDto = (row: MeetingSummaryView) => ({
  id: row.id,
  title: row.title,
  occurred_at: row.occurredAt.toISOString(),
  organizer_membership_id: row.organizerMembershipId,
  classification: row.classification,
  status: row.status,
  source_kind: row.sourceKind,
  consent: row.consent,
  version: row.version,
});
export const meetingParticipantDto = (row: MeetingParticipantView) => ({
  id: row.id,
  kind: row.kind,
  membership_id: row.membershipId,
  display_name: row.displayName,
  decision: row.decision,
  basis: row.basis,
  decided_at: row.decidedAt?.toISOString() ?? null,
});
export const meetingDto = (row: MeetingDetailView) => ({
  ...meetingSummaryDto(row),
  participants: row.participants.map(meetingParticipantDto),
  current_notes: row.currentNotes
    ? {
        id: row.currentNotes.id,
        version: row.currentNotes.version,
        text: row.currentNotes.text,
        created_at: row.currentNotes.createdAt.toISOString(),
      }
    : null,
});
/** Cache only the committed note identity; current room access and withdrawal are checked on replay. */
export async function importNotesOnce(
  database: AppDatabase,
  context: TenantContext,
  meetingId: string,
  text: string,
  key: string,
) {
  const current = await getMeeting(database, context, meetingId);
  if (current.status === 'purged') throw new AppError('MEETING_PURGED');
  if (current.organizerMembershipId !== context.membershipId) throw new AppError('FORBIDDEN');
  const result = await runIdempotent(
    database,
    context,
    { key, requestHash: requestHash(['meeting.notes', meetingId, canonicalJson({ text })]) },
    (db) => importMeetingNotes(db, context, { meetingId, text }),
    (row) => ({ status: 201, body: { id: row.notesId, version: row.version } }),
  );
  if (result.kind === 'conflict') throw new AppError('IDEMPOTENCY_KEY_REUSED');
  // A concurrent withdrawal closes even a response whose write completed just before it.
  if ((await getMeeting(database, context, meetingId)).status === 'purged')
    throw new AppError('MEETING_PURGED');
  return result.body as { id: string; version: number };
}

export const providerApprovalParams = organizationParams.extend({ providerApprovalId: idSchema });

export const meetingProviderApprovalDto = (row: ProviderApprovalView) => ({
  id: row.id,
  kind: row.kind,
  target_ref: row.targetRef,
  purposes: row.purposes,
  max_classification: row.maxClassification,
  terms_ref: row.termsRef,
  approved_by_membership_id: row.approvedByMembershipId,
  approved_at: row.approvedAt.toISOString(),
  expires_at: row.expiresAt.toISOString(),
  revoked_at: row.revokedAt?.toISOString() ?? null,
});

export async function approveMeetingProviderOnce(
  database: AppDatabase,
  context: TenantContext,
  key: string,
  body: ApproveProviderBody,
) {
  const common = {
    maxClassification: body.max_classification,
    termsRef: body.terms_ref,
    expiresAt: new Date(body.expires_at),
  };
  const id = await studioOnce(database, context, key, 'meeting.provider.approve', body, (db) =>
    approveMeetingProvider(
      db,
      context,
      body.kind === 'model'
        ? {
            ...common,
            kind: body.kind,
            modelProfileId: body.model_profile_id,
            purposes: body.purposes,
          }
        : { ...common, kind: body.kind, connectionId: body.connection_id },
    ),
  );
  // The memo holds only the ID. Current role and current revocation state are read on every response.
  return getMeetingProviderApproval(database, context, id);
}

export const meetingItemParams = organizationParams.extend({ itemId: idSchema });

export const meetingSummaryTextDto = (row: MeetingSummaryTextView) => ({
  id: row.id,
  run_id: row.runId,
  text: row.text,
  trust: row.trust,
  created_at: row.createdAt.toISOString(),
});

export const meetingProposalDto = (row: ProposedItemView) => ({
  id: row.id,
  meeting_id: row.meetingId,
  kind: row.kind,
  title: row.title,
  detail: row.detail,
  suggested_owner_membership_id: row.suggestedOwnerMembershipId,
  suggested_due_on: row.suggestedDueOn,
  status: row.status,
  decided_by_membership_id: row.decidedByMembershipId,
  decided_at: row.decidedAt?.toISOString() ?? null,
  work_unit_id: row.workUnitId,
  version: row.version,
});

const acceptedProposal = z.strictObject({ work_unit_id: idSchema, version: z.int().positive() });

export async function acceptProposedWorkOnce(
  database: AppDatabase,
  context: TenantContext,
  key: string,
  itemId: string,
  expectedVersion: number,
  body: AcceptProposedWorkBody,
) {
  const once = () =>
    runIdempotent(
      database,
      context,
      {
        key,
        requestHash: requestHash([
          'meeting.item.work',
          itemId,
          String(expectedVersion),
          canonicalJson(body),
        ]),
      },
      (db) =>
        acceptProposedWork(db, context, {
          itemId,
          expectedVersion,
          title: body.title,
          ...(body.objective !== undefined ? { objective: body.objective } : {}),
          ownerMembershipId: body.owner_membership_id,
          dueAt: body.due_at === null ? null : new Date(body.due_at),
        }),
      (work) => ({ status: 201, body: { work_unit_id: work.workUnitId, version: work.version } }),
    );
  const result = await once().catch((error: unknown) => {
    // A second request can reach the item lock before seeing the first request's committed key.
    if (!(error instanceof AppError) || error.code !== 'PROPOSAL_ALREADY_DECIDED') throw error;
    return once();
  });
  if (result.kind === 'conflict') throw new AppError('IDEMPOTENCY_KEY_REUSED');
  const parsed = acceptedProposal.safeParse(result.body);
  if (!parsed.success) throw new AppError('INVALID_STATE');
  await confirmProposedWork(database, context, itemId, parsed.data.work_unit_id);
  await getWorkUnit(database, context, parsed.data.work_unit_id);
  return parsed.data;
}

export const meetingDerivationDto = (row: DerivationRunView) => ({
  id: row.id,
  meeting_id: row.meetingId,
  purpose: row.purpose,
  status: row.status,
  status_code: row.statusCode,
  requested_by_membership_id: row.requestedByMembershipId,
  created_at: row.createdAt.toISOString(),
  finished_at: row.finishedAt?.toISOString() ?? null,
});

export async function requestDerivationOnce(
  database: AppDatabase,
  context: TenantContext,
  key: string,
  meetingId: string,
  body: RequestDerivationBody,
) {
  const input = { meetingId, purpose: body.purpose, providerApprovalId: body.provider_approval_id };
  const id = await studioOnce(
    database,
    context,
    key,
    'meeting.derivation.request',
    input,
    (db) => requestMeetingDerivation(db, context, input),
    202,
  );
  return getMeetingDerivation(database, context, meetingId, id);
}
