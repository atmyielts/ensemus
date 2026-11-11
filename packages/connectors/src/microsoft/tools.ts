// Microsoft 365's suite tools for agents (ADR-038 D6). Owned by the microsoft-tools builder, who fills in
// each handler and its tests; the foundation only wires them. Every handler here throws until written:
// a read with NOT_IMPLEMENTED, a change with NotImplementedSend, which is a NotSent, so an intent sent to
// an unwritten handler ends failed and never unknown.
//
// Route: everything is Microsoft Graph v1.0 on `ms_graph` (graph.microsoft.com): Outlook mail under
// /v1.0/me/messages and /me/sendMail, calendar under /v1.0/me/calendars/{id}/events, OneDrive under
// /v1.0/me/drive, Word content through the drive item, Excel through /workbook/worksheets/{name}/range,
// Teams through /v1.0/teams/{id}/channels/{id}/messages. Checked against the Graph v1.0 reference on
// 2026-11-11; unqualified until the owner runs them against a test tenant.
//
// What each handler must do, in ADR-038 D6's words:
// - Reads return classified UTF-8 (JSON or text) and every resource of the organization's content they
//   contain. A search through the organization's connection drops what `access.permitted` leaves out.
// - calendar.create_event sets `transactionId` from the intent (`idempotencyKey`), so Graph dedupes a
//   retried create; reconcile is best effort, since Graph cannot prove absence.
// - outlook.send and outlook.create_draft set an internet Message-ID header from the intent, and reconcile
//   by searching Sent Items (or Drafts) for it, best effort.
// - onedrive.create_file names the file from the payload and refuses to replace one that exists.
// - teams.post_message posts plain text to one channel; reconcile is best effort.
import type { ConnectorContext } from '../index';
import type { ProviderHttpClient } from '../knowledge';
import {
  NotImplementedSend,
  notImplemented,
  type SuiteActionHandler,
  type SuiteReadHandler,
} from '../suites';

/** What a Microsoft handler is given: the HTTP client over fixed routes, and a token for this connection. */
export type MicrosoftToolDeps = {
  http: ProviderHttpClient;
  withToken<T>(context: ConnectorContext, use: (token: string) => Promise<T>): Promise<T>;
};

export const MICROSOFT_READ_TOOLS = [
  'outlook.search',
  'outlook.read_thread',
  'calendar.list_events',
  'onedrive.search',
  'word.read',
  'excel.read_range',
] as const;
export type MicrosoftReadTool = (typeof MICROSOFT_READ_TOOLS)[number];

export const MICROSOFT_ACTION_TOOLS = [
  'outlook.create_draft',
  'outlook.send',
  'calendar.create_event',
  'calendar.update_event',
  'onedrive.create_file',
  'excel.write_range',
  'teams.post_message',
] as const;
export type MicrosoftActionTool = (typeof MICROSOFT_ACTION_TOOLS)[number];

const unwrittenRead: SuiteReadHandler<MicrosoftToolDeps> = async () => notImplemented();

const unwrittenAction: SuiteActionHandler<MicrosoftToolDeps> = {
  async send() {
    throw new NotImplementedSend();
  },
  async reconcile() {
    return notImplemented();
  },
};

// --- Reads. Each is `(deps, context, args, access) => Promise<SuiteReadResult>`.

export const outlookSearch: SuiteReadHandler<MicrosoftToolDeps> = unwrittenRead;
export const outlookReadThread: SuiteReadHandler<MicrosoftToolDeps> = unwrittenRead;
export const calendarListEvents: SuiteReadHandler<MicrosoftToolDeps> = unwrittenRead;
export const onedriveSearch: SuiteReadHandler<MicrosoftToolDeps> = unwrittenRead;
export const wordRead: SuiteReadHandler<MicrosoftToolDeps> = unwrittenRead;
export const excelReadRange: SuiteReadHandler<MicrosoftToolDeps> = unwrittenRead;

// --- Changes. Each is `{ send, reconcile }` over the frozen, re-parsed payload.

export const outlookCreateDraft: SuiteActionHandler<MicrosoftToolDeps> = unwrittenAction;
export const outlookSend: SuiteActionHandler<MicrosoftToolDeps> = unwrittenAction;
export const calendarCreateEvent: SuiteActionHandler<MicrosoftToolDeps> = unwrittenAction;
export const calendarUpdateEvent: SuiteActionHandler<MicrosoftToolDeps> = unwrittenAction;
export const onedriveCreateFile: SuiteActionHandler<MicrosoftToolDeps> = unwrittenAction;
export const excelWriteRange: SuiteActionHandler<MicrosoftToolDeps> = unwrittenAction;
export const teamsPostMessage: SuiteActionHandler<MicrosoftToolDeps> = unwrittenAction;

export const MICROSOFT_READ_HANDLERS: Readonly<
  Record<MicrosoftReadTool, SuiteReadHandler<MicrosoftToolDeps>>
> = {
  'outlook.search': outlookSearch,
  'outlook.read_thread': outlookReadThread,
  'calendar.list_events': calendarListEvents,
  'onedrive.search': onedriveSearch,
  'word.read': wordRead,
  'excel.read_range': excelReadRange,
};

export const MICROSOFT_ACTION_HANDLERS: Readonly<
  Record<MicrosoftActionTool, SuiteActionHandler<MicrosoftToolDeps>>
> = {
  'outlook.create_draft': outlookCreateDraft,
  'outlook.send': outlookSend,
  'calendar.create_event': calendarCreateEvent,
  'calendar.update_event': calendarUpdateEvent,
  'onedrive.create_file': onedriveCreateFile,
  'excel.write_range': excelWriteRange,
  'teams.post_message': teamsPostMessage,
};
