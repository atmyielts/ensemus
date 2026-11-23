import * as manual from './meeting-manual';
// Owned by the meetings-core slice (EXP-03). See docs/06-delivery/m11a-slices.md and ADR-033 D4 to D6. Settings,
// meetings, who was there, consent, provider approvals, imported notes and the purge when consent goes.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type {
  ConsentBasis,
  ConsentDecision,
  ConsentState,
  MeetingPurpose,
  MeetingSourceKind,
  MeetingStatus,
  ParticipantKind,
  ProviderApprovalKind,
} from '@ensemus/domain/meeting';
import type { Classification } from '@ensemus/domain/policy';

export type MeetingSettingsView = {
  enabled: boolean;
  noticeRef: string | null;
  version: number;
};

export type MeetingParticipantView = {
  id: string;
  kind: ParticipantKind;
  membershipId: string | null;
  /** The person's name if a member, or the organizer's label for them. */
  displayName: string;
  decision: ConsentDecision | null;
  basis: ConsentBasis | null;
  decidedAt: Date | null;
};

/** What an owner or admin who was not there gets. It names no content. */
export type MeetingSummaryView = {
  id: string;
  occurredAt: Date;
  organizerMembershipId: string;
  classification: Classification;
  status: MeetingStatus;
  sourceKind: MeetingSourceKind;
  consent: ConsentState;
  version: number;
  /** Null when this person may see that it exists and not what it is about. */
  title: string | null;
};

export type MeetingDetailView = MeetingSummaryView & {
  participants: readonly MeetingParticipantView[];
  /** Null for a viewer who may not read content. */
  currentNotes: { id: string; version: number; text: string | null; createdAt: Date } | null;
};

export type ProviderApprovalView = {
  id: string;
  kind: ProviderApprovalKind;
  targetRef: string;
  purposes: readonly MeetingPurpose[];
  maxClassification: Exclude<Classification, 'restricted'>;
  termsRef: string;
  approvedByMembershipId: string;
  approvedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

export function getMeetingSettings(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<MeetingSettingsView> {
  return manual.getMeetingSettings(_database, _context);
}

/** Owners and admins. Turning on needs a notice reference, and changing it asks everyone again. */
export function updateMeetingSettings(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { expectedVersion: number; enabled: boolean; noticeRef: string | null },
): Promise<MeetingSettingsView> {
  return manual.updateMeetingSettings(_database, _context, _input);
}

/** MEETINGS_NOT_ENABLED until an administrator has turned them on. The organizer is listed at once. */
export function createMeeting(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { title: string; occurredAt: Date; classification?: Classification },
): Promise<MeetingDetailView> {
  return manual.createMeeting(_database, _context, _input);
}

export function createMeetingFromResource(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    resourceId: string;
    title: string;
    occurredAt: Date;
    classification?: Classification;
  },
): Promise<MeetingDetailView> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Meetings this person organized or attended, and for owners and admins every meeting's metadata. */
export function listMeetings(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { after?: string; limit?: number },
): Promise<{ items: readonly MeetingSummaryView[]; nextCursor: string | null }> {
  return manual.listMeetings(_database, _context, _input);
}

/** Not found for anyone canSeeMeeting says no to. An admin gets the metadata, with no title or notes. */
export function getMeeting(
  _database: AppDatabase,
  _context: TenantContext,
  _meetingId: string,
): Promise<MeetingDetailView> {
  return manual.getMeeting(_database, _context, _meetingId);
}

export function addMeetingParticipant(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    meetingId: string;
    expectedVersion: number;
    participant: { kind: 'member'; membershipId: string } | { kind: 'external'; label: string };
  },
): Promise<MeetingParticipantView> {
  return manual.addMeetingParticipant(_database, _context, _input);
}

export function removeMeetingParticipant(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { meetingId: string; participantId: string; expectedVersion: number },
): Promise<void> {
  return manual.removeMeetingParticipant(_database, _context, _input);
}

/**
 * Records one person's decision. A member records their own, the organizer attests for someone outside, and
 * nobody else can (CONSENT_NOT_YOURS). A `withdrawn` decision purges the meeting in the same transaction.
 */
export function recordMeetingConsent(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    meetingId: string;
    participantId: string;
    decision: ConsentDecision;
    noticeRef: string;
  },
): Promise<{ consent: ConsentState; status: MeetingStatus }> {
  return manual.recordMeetingConsent(_database, _context, _input);
}

/** Refuses until consent is complete (CONSENT_INCOMPLETE). A second import is a new version. */
export function importMeetingNotes(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { meetingId: string; text: string },
): Promise<{ notesId: string; version: number }> {
  return manual.importMeetingNotes(_database, _context, _input);
}

export {
  approveMeetingProvider,
  getMeetingProviderApproval,
  listMeetingProviderApprovals,
  listMeetingProviderTargets,
  revokeMeetingProvider,
} from './meeting-providers';

/** The organizer has left. Owners and admins hand it on, and that shows them nothing it said. */
export function reassignMeetingOrganizer(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { meetingId: string; expectedVersion: number; organizerMembershipId: string },
): Promise<void> {
  return manual.reassignMeetingOrganizer(_database, _context, _input);
}

/**
 * Takes every word this meeting produced out of the product, in the caller's transaction, under the meeting's
 * lock: notes and summaries lose their text, open proposals become `withdrawn`, accepted and rejected ones lose
 * theirs, open runs become `refused` with CONSENT_WITHDRAWN, the meeting becomes `purged`, a tombstone goes in
 * with its ledger event (ADR-026), and MEETING_CONTENT_PURGED is emitted for M5's index. A Work Unit a person
 * made from a proposal stays, because it is theirs, and it holds what they chose to write.
 */
export function purgeMeetingContentInTx(
  _tx: Tx,
  _context: TenantContext,
  _input: { meetingId: string; reasonCode: 'CONSENT_WITHDRAWN' },
): Promise<void> {
  return manual.purgeMeetingContentInTx(_tx, _context, _input);
}
