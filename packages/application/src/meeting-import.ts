// Owned by the meetings-connector slice (EXP-03). See docs/06-delivery/m11a-slices.md and ADR-033 D5. Reading a
// note's text from its source waits for everyone's consent and an approved connection, and is rechecked right
// before the read and again when it is stored.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { ImportStatus, MeetingStopCode } from '@ensemus/domain/meeting';

export type ImportRequestView = {
  id: string;
  meetingId: string;
  status: ImportStatus;
  statusCode: MeetingStopCode | null;
  createdAt: Date;
  finishedAt: Date | null;
};

/** The organizer asks. Emits MEETING_IMPORT_REQUESTED. A service context is refused. */
export function requestMeetingNotesImport(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { meetingId: string; providerApprovalId: string },
): Promise<ImportRequestView> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Everything the read takes. Lives only in the worker's memory. */
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
  | { kind: 'done'; status: ImportStatus }
  | { kind: 'stopped'; code: MeetingStopCode };

/** Service context. Rechecks consent, the approval and the connection under the meeting's lock. */
export function beginMeetingImport(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { importRequestId: string; temporalRunId: string },
): Promise<BeginImport> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Service context. Stores the text as the next version. The trigger holds consent and approval again. */
export function finishMeetingImport(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { importRequestId: string; text: string; externalVersion: string | null },
): Promise<{ notesId: string; version: number } | { stopped: MeetingStopCode }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function stopMeetingImport(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { importRequestId: string; code: MeetingStopCode; to: 'failed' | 'refused' },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}
