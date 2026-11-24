import type { PortableReader } from './portability-m7-readers';

const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const nullableInstant = (column: string) =>
  `CASE WHEN ${column} IS NULL THEN NULL ELSE ${instant(column)} END`;

function meetingChild(
  table: string,
  kind: PortableReader['kind'],
  fields: PortableReader['fields'],
): PortableReader {
  return {
    table: `meetings.${table}`,
    kind,
    join: 'JOIN meetings.meetings m ON m.organization_id=t.organization_id AND m.id=t.meeting_id',
    fields: {
      id: 't.id',
      meeting_id: 't.meeting_id',
      classification: 'm.classification',
      ...fields,
    },
  };
}

// Purge receipts preserve the history and links between its records. Free-text content, note
// fingerprints, external names, source connection identifiers and runtime IDs have no field here.
export const MEETING_HISTORY_READERS: readonly PortableReader[] = [
  {
    table: 'meetings.meetings',
    kind: 'meeting_purge_history',
    fields: {
      id: 't.id',
      organizer_membership_id: 't.organizer_membership_id',
      classification: 't.classification',
      source_kind: 't.source_kind',
      occurred_at: instant('t.occurred_at'),
      created_at: instant('t.created_at'),
      purged_at: instant('t.purged_at'),
    },
  },
  meetingChild('participants', 'meeting_participant_history', {
    member_id: 't.membership_id',
    participant_kind: 't.kind',
    created_at: instant('t.created_at'),
  }),
  meetingChild('consent_records', 'meeting_consent_history', {
    participant_id: 't.participant_id',
    decision: 't.decision',
    basis: 't.basis',
    notice_ref: 't.notice_ref',
    recorded_by_membership_id: 't.recorded_by_membership_id',
    recorded_at: instant('t.recorded_at'),
    position: `(SELECT count(*)::text FROM meetings.consent_records earlier
      WHERE earlier.organization_id=t.organization_id AND earlier.meeting_id=t.meeting_id AND earlier.seq<=t.seq)`,
  }),
  meetingChild('notes', 'meeting_note_purge_history', {
    classification: 't.classification',
    version: 't.version',
    source_kind: 't.source_kind',
    source_approval_id: 't.source_approval_id',
    imported_by_membership_id: 't.imported_by_membership_id',
    created_at: instant('t.created_at'),
    purged_at: instant('t.purged_at'),
  }),
  meetingChild('summaries', 'meeting_summary_purge_history', {
    classification: 't.classification',
    run_id: 't.run_id',
    created_at: instant('t.created_at'),
    purged_at: instant('t.purged_at'),
  }),
  meetingChild('proposed_items', 'meeting_proposal_history', {
    classification: 't.classification',
    run_id: 't.run_id',
    ordinal: 't.ordinal',
    proposal_kind: 't.kind',
    status: 't.status',
    decided_by_membership_id: 't.decided_by_membership_id',
    decided_at: nullableInstant('t.decided_at'),
    created_at: instant('t.created_at'),
    purged_at: instant('t.purged_at'),
  }),
  meetingChild('derivation_runs', 'meeting_derivation_history', {
    notes_id: 't.notes_id',
    provider_approval_id: 't.provider_approval_id',
    purpose: 't.purpose',
    status: 't.status',
    requested_by_membership_id: 't.requested_by_membership_id',
    created_at: instant('t.created_at'),
    finished_at: nullableInstant('t.finished_at'),
  }),
  meetingChild('import_requests', 'meeting_import_history', {
    source_approval_id: 't.source_approval_id',
    status: 't.status',
    requested_by_membership_id: 't.requested_by_membership_id',
    created_at: instant('t.created_at'),
    finished_at: nullableInstant('t.finished_at'),
  }),
];
