// Google Workspace's suite tools for agents (ADR-038 D6). Owned by the google-tools builder, who fills in
// each handler and its tests; the foundation only wires them. Every handler here throws until written:
// a read with NOT_IMPLEMENTED, a change with NotImplementedSend, which is a NotSent, so an intent sent to
// an unwritten handler ends failed and never unknown.
//
// Routes (ADR-038 "D6 in detail", checked against Google's REST references on 2026-11-11; unqualified
// until the owner runs them against a test tenant): Gmail on `google_gmail` (gmail.googleapis.com, under
// /gmail/v1/users/me/...), Calendar and Drive on `google_api` (www.googleapis.com, under /calendar/v3 and
// /drive/v3, uploads under /upload/drive/v3), Docs on `google_docs` (docs.googleapis.com, /v1/documents),
// Sheets on `google_sheets` (sheets.googleapis.com, /v4/spreadsheets).
//
// What each handler must do, in ADR-038 D6's words:
// - Reads return classified UTF-8 (JSON or text) and every resource of the organization's content they
//   contain. A search through the organization's connection drops what `access.permitted` leaves out.
// - calendar.create_event uses a client-chosen event ID derived from the intent (`idempotencyKey`), and
//   its reconcile is authoritative: a 404 for that ID means it was not made.
// - gmail.send and gmail.create_draft set Message-ID from the intent, and reconcile by searching Sent (or
//   Drafts) for it, best effort.
// - docs.edit sends `writeControl.requiredRevisionId` from the payload, so an edit to a changed document is
//   refused by Docs and comes back `rejected`.
// - drive.create_file names the file from the payload and sets an app property carrying the intent ID, so
//   reconcile can find it.
import type { ConnectorContext } from '../index';
import type { ProviderHttpClient } from '../knowledge';
import {
  NotImplementedSend,
  notImplemented,
  type SuiteActionHandler,
  type SuiteReadHandler,
} from '../suites';

/** What a Google handler is given: the HTTP client over fixed routes, and a token for this connection. */
export type GoogleToolDeps = {
  http: ProviderHttpClient;
  withToken<T>(context: ConnectorContext, use: (token: string) => Promise<T>): Promise<T>;
};

export const GOOGLE_READ_TOOLS = [
  'gmail.search',
  'gmail.read_thread',
  'calendar.list_events',
  'drive.search',
  'docs.read',
  'sheets.read_range',
] as const;
export type GoogleReadTool = (typeof GOOGLE_READ_TOOLS)[number];

export const GOOGLE_ACTION_TOOLS = [
  'gmail.create_draft',
  'gmail.send',
  'calendar.create_event',
  'calendar.update_event',
  'drive.create_file',
  'docs.edit',
  'sheets.write_range',
] as const;
export type GoogleActionTool = (typeof GOOGLE_ACTION_TOOLS)[number];

const unwrittenRead: SuiteReadHandler<GoogleToolDeps> = async () => notImplemented();

const unwrittenAction: SuiteActionHandler<GoogleToolDeps> = {
  async send() {
    throw new NotImplementedSend();
  },
  async reconcile() {
    return notImplemented();
  },
};

// --- Reads. Each is `(deps, context, args, access) => Promise<SuiteReadResult>`.

export const gmailSearch: SuiteReadHandler<GoogleToolDeps> = unwrittenRead;
export const gmailReadThread: SuiteReadHandler<GoogleToolDeps> = unwrittenRead;
export const calendarListEvents: SuiteReadHandler<GoogleToolDeps> = unwrittenRead;
export const driveSearch: SuiteReadHandler<GoogleToolDeps> = unwrittenRead;
export const docsRead: SuiteReadHandler<GoogleToolDeps> = unwrittenRead;
export const sheetsReadRange: SuiteReadHandler<GoogleToolDeps> = unwrittenRead;

// --- Changes. Each is `{ send, reconcile }` over the frozen, re-parsed payload.

export const gmailCreateDraft: SuiteActionHandler<GoogleToolDeps> = unwrittenAction;
export const gmailSend: SuiteActionHandler<GoogleToolDeps> = unwrittenAction;
export const calendarCreateEvent: SuiteActionHandler<GoogleToolDeps> = unwrittenAction;
export const calendarUpdateEvent: SuiteActionHandler<GoogleToolDeps> = unwrittenAction;
export const driveCreateFile: SuiteActionHandler<GoogleToolDeps> = unwrittenAction;
export const docsEdit: SuiteActionHandler<GoogleToolDeps> = unwrittenAction;
export const sheetsWriteRange: SuiteActionHandler<GoogleToolDeps> = unwrittenAction;

export const GOOGLE_READ_HANDLERS: Readonly<
  Record<GoogleReadTool, SuiteReadHandler<GoogleToolDeps>>
> = {
  'gmail.search': gmailSearch,
  'gmail.read_thread': gmailReadThread,
  'calendar.list_events': calendarListEvents,
  'drive.search': driveSearch,
  'docs.read': docsRead,
  'sheets.read_range': sheetsReadRange,
};

export const GOOGLE_ACTION_HANDLERS: Readonly<
  Record<GoogleActionTool, SuiteActionHandler<GoogleToolDeps>>
> = {
  'gmail.create_draft': gmailCreateDraft,
  'gmail.send': gmailSend,
  'calendar.create_event': calendarCreateEvent,
  'calendar.update_event': calendarUpdateEvent,
  'drive.create_file': driveCreateFile,
  'docs.edit': docsEdit,
  'sheets.write_range': sheetsWriteRange,
};
