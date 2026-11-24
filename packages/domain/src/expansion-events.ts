// Outbox event names for M11A (ADR-033). Payloads are IDs and enums only: no note, summary, field, title or
// provider text goes in an event, because events travel to places documents may not.

export const AGGREGATE_MEETING = 'meeting';
export const AGGREGATE_MEETING_DERIVATION = 'meeting_derivation';
export const AGGREGATE_MEETING_IMPORT = 'meeting_import';
export const AGGREGATE_BUSINESS_RECORD = 'business_record';

export const MEETING_CREATED = 'meeting.created';
export const MEETING_CONSENT_RECORDED = 'meeting.consent_recorded';
/** A yes was taken back. Everything derived from the notes goes in the same transaction. */
export const MEETING_CONSENT_WITHDRAWN = 'meeting.consent_withdrawn';
export const MEETING_NOTES_IMPORTED = 'meeting.notes_imported';
/** Tells M5 that this content must leave every index and cache (MeetingKnowledgeIndex). */
export const MEETING_CONTENT_PURGED = 'meeting.content_purged';
export const MEETING_PROVIDER_APPROVED = 'meeting.provider_approved';
export const MEETING_PROVIDER_REVOKED = 'meeting.provider_revoked';

/** The dispatcher starts meetingDerivationWorkflow. */
export const MEETING_DERIVATION_REQUESTED = 'meeting.derivation_requested';
export const MEETING_DERIVATION_COMPLETED = 'meeting.derivation_completed';
export const MEETING_DERIVATION_STOPPED = 'meeting.derivation_stopped';

/** The dispatcher starts meetingImportWorkflow. */
export const MEETING_IMPORT_REQUESTED = 'meeting.import_requested';

export const MEETING_ITEM_ACCEPTED = 'meeting.item_accepted';
export const MEETING_ITEM_REJECTED = 'meeting.item_rejected';

export const BUSINESS_RECORD_ACTION_PROPOSED = 'business_record.action_proposed';

/** Notification kinds. The target is `meeting:{id}`. */
export const NOTIFY_MEETING_CONSENT_REQUESTED = 'meeting.consent_requested';
export const NOTIFY_MEETING_ITEMS_PROPOSED = 'meeting.items_proposed';
export const NOTIFY_MEETING_DERIVATION_STOPPED = 'meeting.derivation_stopped';
export const NOTIFY_MEETING_CONTENT_PURGED = 'meeting.content_purged';
