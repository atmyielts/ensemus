import 'server-only';
import {
  AppError,
  getMeeting,
  idSchema,
  importMeetingNotes,
  requestHash,
  runIdempotent,
  type MeetingDetailView,
  type MeetingParticipantView,
  type MeetingSummaryView,
} from '@ensemus/application';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { canonicalJson } from '@ensemus/domain/approval';
import { organizationParams } from './api';
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
