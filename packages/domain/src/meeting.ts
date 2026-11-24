// Meetings and summaries (EXP-03, ADR-033 D4 to D7). Consent and provider approval are enforced twice:
// by these pure rules, which is what a page and a service read, and by the triggers in migration 0601,
// which hold even if a service forgets. A test keeps the lists here and in the SQL the same.
import type { Classification } from './policy';

export const MEETING_STATUSES = ['open', 'purged'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const MEETING_SOURCE_KINDS = ['manual', 'connector'] as const;
export type MeetingSourceKind = (typeof MEETING_SOURCE_KINDS)[number];

export const PARTICIPANT_KINDS = ['member', 'external'] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

export const CONSENT_DECISIONS = ['granted', 'declined', 'withdrawn'] as const;
export type ConsentDecision = (typeof CONSENT_DECISIONS)[number];

/** `self` is the person. `attested` is the organizer saying what an outside participant said. */
export const CONSENT_BASES = ['self', 'attested'] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export const PROVIDER_APPROVAL_KINDS = ['model', 'source'] as const;
export type ProviderApprovalKind = (typeof PROVIDER_APPROVAL_KINDS)[number];

export const MEETING_PURPOSES = ['import_notes', 'summarize', 'extract_items'] as const;
export type MeetingPurpose = (typeof MEETING_PURPOSES)[number];
export const DERIVATION_PURPOSES = ['summarize', 'extract_items'] as const;
export type DerivationPurpose = (typeof DERIVATION_PURPOSES)[number];

export const DERIVATION_STATUSES = [
  'requested',
  'running',
  'completed',
  'failed',
  'refused',
  'cancelled',
] as const;
export type DerivationStatus = (typeof DERIVATION_STATUSES)[number];

/** Matches the trigger meetings.check_derivation_change. */
export const DERIVATION_TRANSITIONS: Readonly<
  Record<DerivationStatus, readonly DerivationStatus[]>
> = {
  requested: ['running', 'failed', 'refused', 'cancelled'],
  running: ['completed', 'failed', 'refused'],
  completed: [],
  failed: [],
  refused: [],
  cancelled: [],
};

export const IMPORT_STATUSES = ['requested', 'completed', 'failed', 'refused'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const PROPOSED_ITEM_KINDS = ['decision', 'work'] as const;
export type ProposedItemKind = (typeof PROPOSED_ITEM_KINDS)[number];

/**
 * `proposed` is where every item starts, and the only way to anything else is a named person, or consent
 * being withdrawn. There is no transition a model or a workflow can make (ADR-033 D7).
 */
export const PROPOSED_ITEM_STATUSES = ['proposed', 'accepted', 'rejected', 'withdrawn'] as const;
export type ProposedItemStatus = (typeof PROPOSED_ITEM_STATUSES)[number];

export const PROPOSED_ITEM_TRANSITIONS: Readonly<
  Record<ProposedItemStatus, readonly ProposedItemStatus[]>
> = {
  proposed: ['accepted', 'rejected', 'withdrawn'],
  accepted: [],
  rejected: [],
  withdrawn: [],
};

/** Fixed codes for why a run or an import stopped. No provider or model text is ever stored. */
export const MEETING_STOP_CODES = [
  'MEETINGS_NOT_ENABLED',
  'CONSENT_INCOMPLETE',
  'CONSENT_WITHDRAWN',
  'PROVIDER_NOT_APPROVED',
  'PROVIDER_APPROVAL_EXPIRED',
  'CLASSIFICATION_NOT_ALLOWED',
  'EGRESS_DENIED',
  'MODEL_UNAVAILABLE',
  'MODEL_OUTPUT_INVALID',
  'MODEL_TIMEOUT',
  'NOTES_NOT_CURRENT',
  'MEETING_PURGED',
  'CONNECTOR_UNAVAILABLE',
  'SOURCE_NOT_FOUND',
  'SOURCE_TOO_LARGE',
  'CONNECTION_NOT_ACTIVE',
] as const;
export type MeetingStopCode = (typeof MEETING_STOP_CODES)[number];

/** Each matches a CHECK in migration 0600. */
export const MAX_MEETING_TITLE_LENGTH = 300;
export const MAX_NOTES_BYTES = 524_288;
export const MAX_SUMMARY_BYTES = 131_072;
export const MAX_ITEM_TITLE_LENGTH = 300;
export const MAX_ITEM_DETAIL_LENGTH = 4000;
export const MAX_DECISION_REASON_LENGTH = 2000;
export const MAX_ITEMS_PER_RUN = 100;
export const MAX_PARTICIPANTS = 200;
export const MAX_NOTICE_REF_LENGTH = 200;
export const MAX_TERMS_REF_LENGTH = 200;

const RANK: Readonly<Record<Classification, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/** Restricted content never reaches a provider through a meeting, whatever an approval says. */
export const classificationAllowedByApproval = (
  classification: Classification,
  maximum: Exclude<Classification, 'restricted'>,
): boolean => classification !== 'restricted' && RANK[classification] <= RANK[maximum];

export type ParticipantConsent = {
  participantId: string;
  /** The newest decision on record for them, or null when nobody has said anything. */
  decision: ConsentDecision | null;
};

export type ConsentState = 'none_listed' | 'pending' | 'complete' | 'refused' | 'withdrawn';

/**
 * Consent is all or nothing: everyone listed has said yes. One no stops it, and one withdrawal after a yes
 * ends it for good, because the content goes (ADR-033 D5). A meeting with nobody listed has no consent.
 */
export function consentStateOf(participants: readonly ParticipantConsent[]): ConsentState {
  if (participants.length === 0) return 'none_listed';
  if (participants.some((person) => person.decision === 'withdrawn')) return 'withdrawn';
  if (participants.some((person) => person.decision === 'declined')) return 'refused';
  return participants.every((person) => person.decision === 'granted') ? 'complete' : 'pending';
}

export type ConsentRecordingFacts = {
  participantKind: ParticipantKind;
  /** The membership this participant is, for a member. */
  participantMembershipId: string | null;
  organizerMembershipId: string;
  recorderMembershipId: string;
};

/**
 * Who may record what. A member speaks for themselves, and nobody speaks for them, the organizer and an
 * administrator included. An outside participant has no account, so the organizer attests, and the record
 * shows that it is the organizer's word.
 */
export function consentBasisFor(facts: ConsentRecordingFacts): ConsentBasis | null {
  if (facts.participantKind === 'member') {
    return facts.participantMembershipId === facts.recorderMembershipId ? 'self' : null;
  }
  return facts.organizerMembershipId === facts.recorderMembershipId ? 'attested' : null;
}

export type ProviderApprovalFacts = {
  kind: ProviderApprovalKind;
  purposes: readonly MeetingPurpose[];
  maxClassification: Exclude<Classification, 'restricted'>;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type ProviderCheck =
  | { ok: true }
  | {
      ok: false;
      code: Extract<
        MeetingStopCode,
        'PROVIDER_NOT_APPROVED' | 'PROVIDER_APPROVAL_EXPIRED' | 'CLASSIFICATION_NOT_ALLOWED'
      >;
    };

/** One provider, one purpose, one class, now. An approval never stretches to cover anything else. */
export function checkProviderApproval(
  approval: ProviderApprovalFacts | null,
  wanted: { kind: ProviderApprovalKind; purpose: MeetingPurpose; classification: Classification },
  now: Date,
): ProviderCheck {
  if (
    !approval ||
    approval.kind !== wanted.kind ||
    approval.revokedAt !== null ||
    !approval.purposes.includes(wanted.purpose)
  ) {
    return { ok: false, code: 'PROVIDER_NOT_APPROVED' };
  }
  if (approval.expiresAt <= now) return { ok: false, code: 'PROVIDER_APPROVAL_EXPIRED' };
  if (!classificationAllowedByApproval(wanted.classification, approval.maxClassification)) {
    return { ok: false, code: 'CLASSIFICATION_NOT_ALLOWED' };
  }
  return { ok: true };
}

/** What has to hold just before notes reach a provider. All of it is read under the meeting's lock. */
export type DerivationFacts = {
  meetingStatus: MeetingStatus;
  consent: ConsentState;
  provider: ProviderCheck;
  notesCurrent: boolean;
  notesPurged: boolean;
};

export type DerivationCheck = { ok: true } | { ok: false; code: MeetingStopCode };

/**
 * The recheck, and the last thing before a provider sees any notes. Withdrawal beats everything: it is
 * read first, so a run cannot pass on the strength of an approval while someone has said no.
 */
export function checkBeforeDerivation(facts: DerivationFacts): DerivationCheck {
  if (facts.meetingStatus === 'purged' || facts.notesPurged) {
    return { ok: false, code: 'MEETING_PURGED' };
  }
  if (facts.consent === 'withdrawn') return { ok: false, code: 'CONSENT_WITHDRAWN' };
  if (facts.consent !== 'complete') return { ok: false, code: 'CONSENT_INCOMPLETE' };
  if (!facts.provider.ok) return { ok: false, code: facts.provider.code };
  if (!facts.notesCurrent) return { ok: false, code: 'NOTES_NOT_CURRENT' };
  return { ok: true };
}

export type MeetingAccessFacts = {
  organizerMembershipId: string;
  /** Whether this person is listed as a participant. */
  isParticipant: boolean;
};

export type MeetingViewer = { membershipId: string; role: string };

const isOrgAdmin = (role: string) => role === 'owner' || role === 'admin';

/**
 * Notes, summaries and proposals are for the people who were in the room. An organization owner or admin
 * who was not there sees that a meeting exists and who ran it, and nothing it said, because what people
 * agreed to is processing, not their boss reading it (ADR-033 D6).
 */
export const canReadMeetingContent = (meeting: MeetingAccessFacts, viewer: MeetingViewer) =>
  meeting.organizerMembershipId === viewer.membershipId || meeting.isParticipant;

/** Whether the meeting's existence is visible at all. Anyone else gets not found. */
export const canSeeMeeting = (meeting: MeetingAccessFacts, viewer: MeetingViewer) =>
  canReadMeetingContent(meeting, viewer) || isOrgAdmin(viewer.role);

/** Listing people, importing notes and asking for a run are the organizer's. */
export const canManageMeeting = (meeting: MeetingAccessFacts, viewer: MeetingViewer) =>
  meeting.organizerMembershipId === viewer.membershipId;

/** A proposal is settled by someone who was there, as a person, and never by a service or a model. */
export const canDecideProposedItem = (meeting: MeetingAccessFacts, viewer: MeetingViewer) =>
  canReadMeetingContent(meeting, viewer);

/** Turning meetings on, naming the notice and approving a provider is an organization decision. */
export const canAdministerMeetings = (role: string) => isOrgAdmin(role);

/** The one thing an admin can do without reading: hand a meeting on when its organizer has left. */
export const canReassignOrganizer = (role: string) => isOrgAdmin(role);

export const meetingTargetRef = (meetingId: string) => `meeting:${meetingId}`;
export const modelProfileRef = (profileId: string) => `model_profile:${profileId}`;
export const proposedItemTargetRef = (itemId: string) => `meeting_item:${itemId}`;
