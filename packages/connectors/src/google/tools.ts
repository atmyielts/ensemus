// Google Workspace's suite tools for agents (ADR-038 D6). Owned by the google-tools builder. Each handler
// gets arguments or a frozen payload already re-parsed by its tool's schema (createSuiteToolDispatch), and
// checks the connection's granted scopes again before any request.
//
// Routes (ADR-038 "D6 in detail"): Gmail on `google_gmail` (gmail.googleapis.com, /gmail/v1/users/me/...),
// Calendar and Drive on `google_api` (www.googleapis.com, /calendar/v3 and /drive/v3, uploads under
// /upload/drive/v3), Docs on `google_docs` (docs.googleapis.com, /v1/documents), Sheets on
// `google_sheets` (sheets.googleapis.com, /v4/spreadsheets).
//
// Wire formats checked against Google's REST references (Gmail v1, Calendar v3, Drive v3, Docs v1,
// Sheets v4) through Context7 on 2026-11-11. Local fakes only: unqualified until the owner runs them
// against a test tenant holding no real data.
//
// Reads: member's own mail and calendar come back `confidential`, and so does a document or sheet read
// through a member's own connection. Through the organization's connection Drive, Docs and Sheets content
// comes back `internal`, the class the Drive sync gives the same content, with each resource's ID so the
// worker raises it to that resource's synced class and checks the initiator's source ACL. A search through the
// organization's connection keeps only what `access.permitted` returns. Output always fits the tool's
// `maxOutputBytes`: it is cut at a whole item or a clean text boundary and marked `truncated`.
//
// Changes: NotSent only when certain nothing reached the API (see ./tool-support.ts, `runChange`).
// - gmail.send and gmail.create_draft carry a Message-ID derived from the intent, at the deployment's own
//   domain, and reconcile by searching Sent (or Drafts) for it, best effort. With no domain configured,
//   mail is refused before anything is contacted.
// - calendar events tell attendees exactly as the payload's `send_updates` says, as `sendUpdates`.
// - calendar.create_event chooses its event ID from `idempotencyKey`. A 409 means that ID exists: it is
//   read back and, if there, the attempt is accepted. Reconcile is authoritative: a 404 for that ID means
//   it was not made.
// - drive.create_file sets an app property carrying the intent ID, and reconcile searches for it.
// - docs.edit sends `writeControl.requiredRevisionId`, so an edit to a changed document is refused (400,
//   `rejected`, never retried).
// - sheets.write_range writes with the payload's `valueInputOption` and reconciles by reading back.
import { createHash, randomBytes } from 'node:crypto';
import type { SendUpdates, SuiteToolArgs } from '@ensemus/contracts/suite-tools';
import { SUITE_CONNECTION_RULES, type ConnectionRule } from '@ensemus/domain/ai-tools';
import { NotSent, type ActionRequest, type AttemptResult, type ConnectorContext } from '../index';
import type { ProviderHttpClient, ProviderResponse } from '../knowledge';
import { array, object } from '../runtime/provider-oauth';
import {
  ownContentClass,
  parseMailIdDomain,
  SuiteReadRefused,
  type SuiteActionHandler,
  type SuiteReadHandler,
  type SuiteResourceAccess,
} from '../suites';
import {
  buildGmailMessage,
  decodeEntities,
  gmailMessageId,
  headerValue,
  htmlToText,
  messageIdsIn,
  messageText,
  rfc822SearchTerm,
  UnsafeGmailMessage,
  type GmailMessagePayload,
} from './gmail-message';
import {
  attemptAnswer,
  cleanLine,
  cleanText,
  cutText,
  externalIdOf,
  fitJson,
  hasToolScopes,
  jsonOutput,
  lookupFor,
  okJson,
  readJson,
  runChange,
  withReadToken,
  type SendSteps,
} from './tool-support';

/** What a Google handler is given: the HTTP client over fixed routes, and a token for this connection. */
export type GoogleToolDeps = {
  http: ProviderHttpClient;
  withToken<T>(context: ConnectorContext, use: (token: string) => Promise<T>): Promise<T>;
  /** The right-hand side of the Message-ID a mail carries. Not a host anything connects to. */
  messageIdDomain?: string | null;
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

type Args<Id extends GoogleReadTool | GoogleActionTool> = SuiteToolArgs<Id>;
type Payload<Id extends GoogleActionTool> = Omit<SuiteToolArgs<Id>, 'connection_id'>;

const GMAIL = '/gmail/v1/users/me';
const CALENDAR = '/calendar/v3/calendars';
const DRIVE = '/drive/v3/files';
const DOCS = '/v1/documents';
const SHEETS = '/v4/spreadsheets';
/** The app property a created file carries, private to our OAuth client. */
export const DRIVE_INTENT_PROPERTY = 'ensemusIntent';
/** Large enough for a long thread or document; the output is cut to the tool's limit afterwards. */
const BIG_RESPONSE_BYTES = 16_777_216;

const enc = encodeURIComponent;

const maxOutput = (toolId: GoogleReadTool) =>
  (SUITE_CONNECTION_RULES as Readonly<Record<string, ConnectionRule>>)[toolId]!.maxOutputBytes;

function requireReadScopes(context: ConnectorContext, toolId: GoogleReadTool) {
  if (!hasToolScopes(context, toolId)) throw new SuiteReadRefused('SCOPE_NOT_GRANTED');
}

function requireSendScopes(context: ConnectorContext, toolId: GoogleActionTool) {
  // Nothing has been contacted, and asking again will not grant the scope.
  if (!hasToolScopes(context, toolId)) throw new NotSent('AUTH_FAILED', false);
}

const isResponse = (value: ProviderResponse | AttemptResult): value is ProviderResponse =>
  'status' in value && 'body' in value;

// --- Reads.

type MailSummary = {
  id: string;
  thread_id: string | null;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
};

export const gmailSearch: SuiteReadHandler<GoogleToolDeps> = async (deps, context, raw) => {
  requireReadScopes(context, 'gmail.search');
  const args = raw as Args<'gmail.search'>;
  const messages = await withReadToken(deps, context, async (token) => {
    const query = new URLSearchParams({ q: args.query, maxResults: String(args.max_results) });
    const list = (await readJson(deps, context, token, {
      route: 'google_gmail',
      method: 'GET',
      path: `${GMAIL}/messages?${query}`,
    }))!;
    const found: MailSummary[] = [];
    for (const item of array(list.messages ?? [], 500).slice(0, args.max_results)) {
      const id = externalIdOf(object(item).id);
      if (!id) continue;
      const meta = new URLSearchParams({ format: 'metadata' });
      for (const name of ['From', 'To', 'Subject', 'Date']) meta.append('metadataHeaders', name);
      // A message gone since the list was read is left out, which is the truth now.
      const message = await readJson(
        deps,
        context,
        token,
        { route: 'google_gmail', method: 'GET', path: `${GMAIL}/messages/${enc(id)}?${meta}` },
        [404],
      );
      if (!message) continue;
      const headers = (message.payload as { headers?: unknown } | undefined)?.headers;
      found.push({
        id,
        thread_id: externalIdOf(message.threadId) ?? null,
        from: cleanLine(headerValue(headers, 'From')),
        to: cleanLine(headerValue(headers, 'To'), 2_000),
        subject: cleanLine(headerValue(headers, 'Subject')),
        date: cleanLine(headerValue(headers, 'Date'), 100),
        snippet: cleanLine(decodeEntities(cleanText(message.snippet, 2_000)), 1_000),
      });
    }
    return found;
  });
  const bytes = fitJson(
    (limit) => ({
      messages: limit === null ? messages : messages.slice(0, limit),
      truncated: limit !== null && limit < messages.length,
    }),
    maxOutput('gmail.search'),
    messages.length,
  );
  return jsonOutput(bytes, 'confidential', []);
};

export const gmailReadThread: SuiteReadHandler<GoogleToolDeps> = async (deps, context, raw) => {
  requireReadScopes(context, 'gmail.read_thread');
  const args = raw as Args<'gmail.read_thread'>;
  const thread = (await withReadToken(deps, context, (token) =>
    readJson(deps, context, token, {
      route: 'google_gmail',
      method: 'GET',
      path: `${GMAIL}/threads/${enc(args.thread_id)}?format=full`,
      maxResponseBytes: BIG_RESPONSE_BYTES,
    }),
  ))!;
  const messages = array(thread.messages ?? [], 1_000).map((item) => {
    const message = object(item);
    const payload = message.payload as { headers?: unknown } | undefined;
    const headers = payload?.headers;
    return {
      id: externalIdOf(message.id) ?? null,
      from: cleanLine(headerValue(headers, 'From')),
      to: cleanLine(headerValue(headers, 'To'), 4_000),
      cc: cleanLine(headerValue(headers, 'Cc'), 4_000),
      subject: cleanLine(headerValue(headers, 'Subject')),
      date: cleanLine(headerValue(headers, 'Date'), 100),
      body: cleanText(messageText(payload), 4_000_000),
    };
  });
  const longest = messages.reduce((most, message) => Math.max(most, message.body.length), 0);
  const bytes = fitJson(
    (limit) => {
      let truncated = false;
      const kept = messages.map((message) => {
        const body = cutText(message.body, limit);
        truncated ||= body.cut;
        return { ...message, body: body.text };
      });
      return { thread_id: args.thread_id, messages: kept, truncated };
    },
    maxOutput('gmail.read_thread'),
    longest,
  );
  return jsonOutput(bytes, 'confidential', []);
};

/** An event time as Google gives it: `dateTime` for a timed event, `date` for an all-day one. */
function eventTime(value: unknown): { at: string; time_zone: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const time = value as { dateTime?: unknown; date?: unknown; timeZone?: unknown };
  const at = typeof time.dateTime === 'string' ? time.dateTime : time.date;
  if (typeof at !== 'string') return null;
  return {
    at: cleanLine(at, 64),
    time_zone: typeof time.timeZone === 'string' ? cleanLine(time.timeZone, 64) : null,
  };
}

/** Calendar descriptions may be HTML. Only their text is kept. */
const descriptionText = (value: unknown) => {
  const text = cleanText(value, 200_000);
  return /<[a-z!/][^>]*>/i.test(text) ? htmlToText(text) : text;
};

export const calendarListEvents: SuiteReadHandler<GoogleToolDeps> = async (deps, context, raw) => {
  requireReadScopes(context, 'calendar.list_events');
  const args = raw as Args<'calendar.list_events'>;
  const query = new URLSearchParams({
    timeMin: args.time_min,
    timeMax: args.time_max,
    maxResults: String(args.max_results),
    singleEvents: 'true',
    orderBy: 'startTime',
    fields:
      'items(id,status,summary,description,location,start,end,attendees(email,responseStatus),organizer(email))',
  });
  const listed = (await withReadToken(deps, context, (token) =>
    readJson(deps, context, token, {
      route: 'google_api',
      method: 'GET',
      path: `${CALENDAR}/${enc(args.calendar_id)}/events?${query}`,
      maxResponseBytes: BIG_RESPONSE_BYTES,
    }),
  ))!;
  const events = array(listed.items ?? [], 2_500)
    .slice(0, args.max_results)
    .map((item) => {
      const event = object(item);
      return {
        id: externalIdOf(event.id) ?? null,
        status: cleanLine(event.status, 20),
        summary: cleanLine(event.summary, 1_000),
        description: descriptionText(event.description),
        location: cleanLine(event.location, 1_000),
        start: eventTime(event.start),
        end: eventTime(event.end),
        organizer: cleanLine((event.organizer as { email?: unknown } | undefined)?.email, 320),
        attendees: (Array.isArray(event.attendees) ? event.attendees.slice(0, 200) : []).map(
          (attendee) => ({
            email: cleanLine((attendee as { email?: unknown } | null)?.email, 320),
            response: cleanLine(
              (attendee as { responseStatus?: unknown } | null)?.responseStatus,
              20,
            ),
          }),
        ),
      };
    });
  const longest = events.reduce((most, event) => Math.max(most, event.description.length), 0);
  const bytes = fitJson(
    (limit) => {
      let truncated = false;
      const kept = events.map((event) => {
        const description = cutText(event.description, limit);
        truncated ||= description.cut;
        return { ...event, description: description.text };
      });
      return { calendar_id: args.calendar_id, events: kept, truncated };
    },
    maxOutput('calendar.list_events'),
    longest,
  );
  return jsonOutput(bytes, 'confidential', []);
};

/** A Drive query string literal: backslash and quote escaped, as Drive's search reference says. */
const driveLiteral = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function permittedOnly(
  access: SuiteResourceAccess | null,
  ids: readonly string[],
): Promise<ReadonlySet<string> | null> {
  if (!access) return null;
  return access.permitted(ids);
}

export const driveSearch: SuiteReadHandler<GoogleToolDeps> = async (deps, context, raw, access) => {
  requireReadScopes(context, 'drive.search');
  const args = raw as Args<'drive.search'>;
  const query = new URLSearchParams({
    q: `fullText contains ${driveLiteral(args.query)} and trashed = false`,
    // More than asked for, because the initiator's ACL may leave some out.
    pageSize: String(Math.min(100, args.max_results * 2)),
    fields: 'files(id,name,mimeType,modifiedTime)',
    corpora: 'allDrives',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const listed = (await withReadToken(deps, context, (token) =>
    readJson(deps, context, token, {
      route: 'google_api',
      method: 'GET',
      path: `${DRIVE}?${query}`,
    }),
  ))!;
  const files = array(listed.files ?? [], 100).flatMap((item) => {
    const file = object(item);
    const id = externalIdOf(file.id);
    return id
      ? [
          {
            id,
            name: cleanLine(file.name, 500),
            mime_type: cleanLine(file.mimeType, 256),
            modified_time: cleanLine(file.modifiedTime, 64),
          },
        ]
      : [];
  });
  const permitted = await permittedOnly(
    access,
    files.map((file) => file.id),
  );
  const kept = files
    .filter((file) => permitted === null || permitted.has(file.id))
    .slice(0, args.max_results);
  const bytes = fitJson(
    (limit) => ({
      files: limit === null ? kept : kept.slice(0, limit),
      truncated: limit !== null && limit < kept.length,
    }),
    maxOutput('drive.search'),
    kept.length,
  );
  // Only the files the output still holds are named, so the worker checks exactly what it keeps.
  const shown = (JSON.parse(bytes.toString('utf8')) as { files: { id: string }[] }).files;
  return jsonOutput(bytes, ownContentClass(context), access ? shown.map((file) => file.id) : []);
};

/** A document's text: its paragraphs' runs, table cells by tab and row, and its contents tables. */
function documentText(content: unknown, depth = 0): string {
  if (!Array.isArray(content) || depth > 8) return '';
  const out: string[] = [];
  for (const raw of content.slice(0, 100_000)) {
    if (!raw || typeof raw !== 'object') continue;
    const element = raw as {
      paragraph?: { elements?: unknown };
      table?: { tableRows?: unknown };
      tableOfContents?: { content?: unknown };
    };
    if (element.paragraph && Array.isArray(element.paragraph.elements)) {
      for (const run of element.paragraph.elements) {
        const text = (run as { textRun?: { content?: unknown } } | null)?.textRun?.content;
        if (typeof text === 'string') out.push(text);
      }
    } else if (element.table && Array.isArray(element.table.tableRows)) {
      for (const row of element.table.tableRows) {
        const cells = (row as { tableCells?: unknown } | null)?.tableCells;
        if (!Array.isArray(cells)) continue;
        out.push(
          cells
            .map((cell) =>
              documentText((cell as { content?: unknown } | null)?.content, depth + 1)
                .replace(/\n+/g, ' ')
                .trim(),
            )
            .join('\t') + '\n',
        );
      }
    } else if (element.tableOfContents) {
      out.push(documentText(element.tableOfContents.content, depth + 1));
    }
  }
  return out.join('');
}

export const docsRead: SuiteReadHandler<GoogleToolDeps> = async (deps, context, raw) => {
  requireReadScopes(context, 'docs.read');
  const args = raw as Args<'docs.read'>;
  const document = (await withReadToken(deps, context, (token) =>
    readJson(deps, context, token, {
      route: 'google_docs',
      method: 'GET',
      path: `${DOCS}/${enc(args.document_id)}`,
      maxResponseBytes: BIG_RESPONSE_BYTES,
    }),
  ))!;
  const text = cleanText(
    documentText((document.body as { content?: unknown })?.content),
    8_000_000,
  );
  const head = {
    document_id: args.document_id,
    title: cleanLine(document.title, 1_000),
    // What docs.edit needs, so an edit applies only to the revision the model read.
    revision_id: externalIdOf(document.revisionId) ?? null,
  };
  const bytes = fitJson(
    (limit) => {
      const body = cutText(text, limit);
      return { ...head, text: body.text, truncated: body.cut };
    },
    maxOutput('docs.read'),
    text.length,
  );
  return jsonOutput(bytes, ownContentClass(context), [args.document_id]);
};

const cellValue = (value: unknown) =>
  typeof value === 'string'
    ? cleanText(value, 50_000)
    : typeof value === 'number' || typeof value === 'boolean'
      ? value
      : null;

export const sheetsReadRange: SuiteReadHandler<GoogleToolDeps> = async (deps, context, raw) => {
  requireReadScopes(context, 'sheets.read_range');
  const args = raw as Args<'sheets.read_range'>;
  const query = new URLSearchParams({
    majorDimension: 'ROWS',
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const read = (await withReadToken(deps, context, (token) =>
    readJson(deps, context, token, {
      route: 'google_sheets',
      method: 'GET',
      path: `${SHEETS}/${enc(args.spreadsheet_id)}/values/${enc(args.range)}?${query}`,
      maxResponseBytes: BIG_RESPONSE_BYTES,
    }),
  ))!;
  const rows = array(read.values ?? [], 1_000_000).map((row) => array(row, 18_278).map(cellValue));
  const bytes = fitJson(
    (limit) => ({
      spreadsheet_id: args.spreadsheet_id,
      range: cleanLine(read.range, 300) || args.range,
      values: limit === null ? rows : rows.slice(0, limit),
      truncated: limit !== null && limit < rows.length,
    }),
    maxOutput('sheets.read_range'),
    rows.length,
  );
  return jsonOutput(bytes, ownContentClass(context), [args.spreadsheet_id]);
};

// --- Changes.

type MailPayload = Payload<'gmail.send'>;

/** The deployment's Message-ID domain. Without one nothing is sent, and nothing has been contacted. */
function mailIdDomain(deps: GoogleToolDeps): string {
  const domain = parseMailIdDomain(deps.messageIdDomain);
  if (!domain) throw new NotSent('CONNECTOR_UNAVAILABLE', false);
  return domain;
}

/** Building refuses what it will not send, and nothing has been contacted yet. */
function mailRaw(
  payload: MailPayload,
  request: ActionRequest,
  domain: string,
  reply?: { messageId: string; references: readonly string[] },
): string {
  try {
    return Buffer.from(
      buildGmailMessage({
        payload: payload.message as GmailMessagePayload,
        messageId: gmailMessageId(request.externalActionId, domain),
        date: new Date(),
        inReplyTo: reply,
      }),
      'utf8',
    ).toString('base64url');
  } catch (error) {
    if (error instanceof UnsafeGmailMessage) throw new NotSent('PAYLOAD_CHANGED', false);
    throw error;
  }
}

/**
 * The thread and headers of the message a reply answers, looked up before anything is written. They
 * change only where it files, never who receives it. Gone is the payload no longer fitting; any other
 * failure is certain nothing was sent.
 */
async function replyTo(
  io: SendSteps,
  messageId: string,
): Promise<{ threadId?: string; header?: { messageId: string; references: string[] } }> {
  const query = new URLSearchParams({ format: 'metadata' });
  query.append('metadataHeaders', 'Message-ID');
  query.append('metadataHeaders', 'References');
  const response = await io.lookup({
    route: 'google_gmail',
    method: 'GET',
    path: `${GMAIL}/messages/${enc(messageId)}?${query}`,
  });
  if (response.status === 404 || response.status === 400)
    throw new NotSent('PAYLOAD_CHANGED', false);
  const answer = attemptAnswer(response);
  if (answer.outcome !== 'accepted') {
    throw answer.outcome === 'not_sent'
      ? new NotSent(answer.code, answer.retryable === true)
      : new NotSent('CONNECT_FAILED', true);
  }
  const message = okJson(response);
  if (!message) throw new NotSent('CONNECT_FAILED', true);
  const headers = (message.payload as { headers?: unknown } | undefined)?.headers;
  const own = messageIdsIn(headerValue(headers, 'Message-ID'))[0];
  const threadId = externalIdOf(message.threadId);
  return {
    ...(threadId ? { threadId } : {}),
    ...(own
      ? { header: { messageId: own, references: messageIdsIn(headerValue(headers, 'References')) } }
      : {}),
  };
}

async function sendMail(
  deps: GoogleToolDeps,
  context: ConnectorContext,
  request: ActionRequest<Record<string, unknown>>,
  kind: 'send' | 'draft',
): Promise<AttemptResult> {
  requireSendScopes(context, kind === 'send' ? 'gmail.send' : 'gmail.create_draft');
  const payload = request.payload as unknown as MailPayload;
  const domain = mailIdDomain(deps);
  // Checked before any contact, so a header that would not go is refused with nothing sent.
  mailRaw(payload, request, domain);
  return runChange(deps, context, async (io) => {
    const reply = payload.message.in_reply_to ? await replyTo(io, payload.message.in_reply_to) : {};
    const message = {
      raw: mailRaw(payload, request, domain, reply.header),
      ...(reply.threadId ? { threadId: reply.threadId } : {}),
    };
    const answer = await io.write(
      kind === 'send'
        ? { route: 'google_gmail', method: 'POST', path: `${GMAIL}/messages/send`, json: message }
        : { route: 'google_gmail', method: 'POST', path: `${GMAIL}/drafts`, json: { message } },
    );
    if (!isResponse(answer)) return answer;
    return attemptAnswer(answer, externalIdOf(okJson(answer)?.id));
  });
}

/** Searches a mailbox for the intent's Message-ID: Sent for a send, Drafts for a draft. */
function findMail(kind: 'send' | 'draft'): SuiteActionHandler<GoogleToolDeps>['reconcile'] {
  return (deps, context, request) =>
    lookupFor(deps, context, async (get) => {
      // With no domain no send could have left, but only a lookup is believed here.
      const domain = parseMailIdDomain(deps.messageIdDomain);
      if (!domain) return { answer: 'cannot_answer' };
      const term = rfc822SearchTerm(gmailMessageId(request.externalActionId, domain));
      const query = new URLSearchParams({
        q: kind === 'send' ? `in:sent ${term}` : term,
        maxResults: '1',
      });
      const found = okJson(
        await get({
          route: 'google_gmail',
          method: 'GET',
          path: `${GMAIL}/${kind === 'send' ? 'messages' : 'drafts'}?${query}`,
        }),
      );
      if (!found) return { answer: 'cannot_answer' };
      const list = found[kind === 'send' ? 'messages' : 'drafts'];
      if (list === undefined || (Array.isArray(list) && list.length === 0))
        return { answer: 'not_found' };
      if (!Array.isArray(list)) return { answer: 'cannot_answer' };
      const id = externalIdOf((list[0] as { id?: unknown } | null)?.id);
      return { answer: 'found', ...(id ? { externalId: id } : {}) };
    });
}

export const gmailCreateDraft: SuiteActionHandler<GoogleToolDeps> = {
  send: (deps, context, request) => sendMail(deps, context, request, 'draft'),
  reconcile: findMail('draft'),
};

export const gmailSend: SuiteActionHandler<GoogleToolDeps> = {
  send: (deps, context, request) => sendMail(deps, context, request, 'send'),
  reconcile: findMail('send'),
};

/**
 * The event ID an intent's create uses, the same on every attempt: SHA-256 of the idempotency key in hex,
 * which is inside Calendar's base32hex alphabet (a–v, 0–9) and 64 characters long, within 5 to 1024.
 */
export const calendarEventId = (idempotencyKey: string) =>
  createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');

/** Calendar's `sendUpdates` for the payload's own `send_updates`, which the approval bound. */
const SEND_UPDATES: Readonly<Record<SendUpdates, string>> = {
  all: 'all',
  external_only: 'externalOnly',
  none: 'none',
};

const eventPath = (calendarId: string, eventId: string) =>
  `${CALENDAR}/${enc(calendarId)}/events/${enc(eventId)}`;

export const calendarCreateEvent: SuiteActionHandler<GoogleToolDeps> = {
  async send(deps, context, request) {
    requireSendScopes(context, 'calendar.create_event');
    const payload = request.payload as unknown as Payload<'calendar.create_event'>;
    const id = calendarEventId(request.idempotencyKey);
    const event = {
      id,
      summary: payload.summary,
      ...(payload.description === undefined ? {} : { description: payload.description }),
      ...(payload.location === undefined ? {} : { location: payload.location }),
      start: { dateTime: payload.start, timeZone: payload.time_zone },
      end: { dateTime: payload.end, timeZone: payload.time_zone },
      attendees: payload.attendees.map((email) => ({ email })),
    };
    const query = new URLSearchParams({ sendUpdates: SEND_UPDATES[payload.send_updates] });
    return runChange(deps, context, async (io) => {
      const answer = await io.write({
        route: 'google_api',
        method: 'POST',
        path: `${CALENDAR}/${enc(payload.calendar_id)}/events?${query}`,
        json: event,
      });
      if (!isResponse(answer)) return answer;
      if (answer.status !== 409) return attemptAnswer(answer, id);
      // That ID exists, and only this intent derives it: an earlier attempt made it. Read it to be sure.
      const existing = okJson(
        await io.lookup({
          route: 'google_api',
          method: 'GET',
          path: eventPath(payload.calendar_id, id),
        }),
      );
      if (existing?.id === id)
        return {
          outcome: 'accepted',
          code: 'ACCEPTED_BY_PROVIDER',
          providerStatus: 409,
          externalId: id,
        };
      return {
        outcome: 'indeterminate',
        code: 'CONNECTION_LOST_AFTER_COMMIT',
        providerStatus: 409,
      };
    });
  },
  // Authoritative: the ID is ours, so a 404 for it means the create never happened. A deleted event
  // (410, or one listed as cancelled) was made, and so counts as found.
  reconcile: (deps, context, request) =>
    lookupFor(deps, context, async (get) => {
      const payload = request.payload as unknown as Payload<'calendar.create_event'>;
      const id = calendarEventId(request.idempotencyKey);
      const response = await get({
        route: 'google_api',
        method: 'GET',
        path: eventPath(payload.calendar_id, id),
      });
      if (response.status === 404) return { answer: 'not_found' };
      if (response.status === 410) return { answer: 'found', externalId: id };
      const event = okJson(response);
      return event?.id === id ? { answer: 'found', externalId: id } : { answer: 'cannot_answer' };
    }),
};

type EventChanges = Payload<'calendar.update_event'>['changes'];

/** Exactly the fields the payload changes. A time zone alone is merged into start and end by PATCH. */
function eventPatch(changes: EventChanges): Record<string, unknown> {
  const time = (at: string | undefined) =>
    at === undefined && changes.time_zone === undefined
      ? undefined
      : {
          ...(at === undefined ? {} : { dateTime: at }),
          ...(changes.time_zone === undefined ? {} : { timeZone: changes.time_zone }),
        };
  const start = time(changes.start);
  const end = time(changes.end);
  return {
    ...(changes.summary === undefined ? {} : { summary: changes.summary }),
    ...(changes.description === undefined ? {} : { description: changes.description }),
    ...(changes.location === undefined ? {} : { location: changes.location }),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(changes.attendees === undefined
      ? {}
      : { attendees: changes.attendees.map((email) => ({ email })) }),
  };
}

/** Whether the event as it is now carries every change. */
function carries(event: Record<string, unknown>, changes: EventChanges): boolean {
  const same = (a: unknown, b: unknown) => a === b;
  const instant = (value: unknown) => (typeof value === 'string' ? Date.parse(value) : Number.NaN);
  const start = event.start as { dateTime?: unknown; timeZone?: unknown } | undefined;
  const end = event.end as { dateTime?: unknown; timeZone?: unknown } | undefined;
  if (changes.summary !== undefined && !same(event.summary, changes.summary)) return false;
  if (changes.description !== undefined && !same(event.description ?? '', changes.description))
    return false;
  if (changes.location !== undefined && !same(event.location ?? '', changes.location)) return false;
  if (changes.start !== undefined && instant(start?.dateTime) !== Date.parse(changes.start))
    return false;
  if (changes.end !== undefined && instant(end?.dateTime) !== Date.parse(changes.end)) return false;
  if (
    changes.time_zone !== undefined &&
    (start?.timeZone !== changes.time_zone || end?.timeZone !== changes.time_zone)
  )
    return false;
  if (changes.attendees !== undefined) {
    const now = new Set(
      (Array.isArray(event.attendees) ? event.attendees : []).map((attendee) =>
        String((attendee as { email?: unknown } | null)?.email ?? '').toLowerCase(),
      ),
    );
    const wanted = new Set(changes.attendees.map((email) => email.toLowerCase()));
    if (now.size !== wanted.size || [...wanted].some((email) => !now.has(email))) return false;
  }
  return true;
}

export const calendarUpdateEvent: SuiteActionHandler<GoogleToolDeps> = {
  async send(deps, context, request) {
    requireSendScopes(context, 'calendar.update_event');
    const payload = request.payload as unknown as Payload<'calendar.update_event'>;
    // Guests hear of the change exactly as the approved payload says.
    const query = new URLSearchParams({ sendUpdates: SEND_UPDATES[payload.send_updates] });
    return runChange(deps, context, async (io) => {
      const answer = await io.write({
        route: 'google_api',
        method: 'PATCH',
        path: `${eventPath(payload.calendar_id, payload.event_id)}?${query}`,
        json: eventPatch(payload.changes),
      });
      return isResponse(answer) ? attemptAnswer(answer, payload.event_id) : answer;
    });
  },
  // Best effort: the event carrying every change is found. Someone else may have made the same change.
  reconcile: (deps, context, request) =>
    lookupFor(deps, context, async (get) => {
      const payload = request.payload as unknown as Payload<'calendar.update_event'>;
      const event = okJson(
        await get({
          route: 'google_api',
          method: 'GET',
          path: eventPath(payload.calendar_id, payload.event_id),
        }),
      );
      if (!event) return { answer: 'cannot_answer' };
      return carries(event, payload.changes)
        ? { answer: 'found', externalId: payload.event_id }
        : { answer: 'not_found' };
    }),
};

export const driveCreateFile: SuiteActionHandler<GoogleToolDeps> = {
  async send(deps, context, request) {
    requireSendScopes(context, 'drive.create_file');
    const payload = request.payload as unknown as Payload<'drive.create_file'>;
    const metadata = {
      name: payload.name,
      mimeType: payload.media_type,
      ...(payload.parent_id ? { parents: [payload.parent_id] } : {}),
      appProperties: { [DRIVE_INTENT_PROPERTY]: request.externalActionId },
    };
    const boundary = `ensemus-${randomBytes(16).toString('hex')}`;
    if (payload.text.includes(boundary)) throw new NotSent('PAYLOAD_CHANGED', false);
    const body = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: ${payload.media_type}; charset=UTF-8\r\n\r\n` +
        `${payload.text}\r\n--${boundary}--`,
      'utf8',
    );
    const query = new URLSearchParams({
      uploadType: 'multipart',
      supportsAllDrives: 'true',
      fields: 'id',
    });
    return runChange(deps, context, async (io) => {
      const answer = await io.write({
        route: 'google_api',
        method: 'POST',
        path: `/upload${DRIVE}?${query}`,
        raw: { body, contentType: `multipart/related; boundary=${boundary}` },
      });
      return isResponse(answer) ? attemptAnswer(answer, externalIdOf(okJson(answer)?.id)) : answer;
    });
  },
  // Best effort: the app property is ours, and only our client can see it. Trashed still counts as made.
  reconcile: (deps, context, request) =>
    lookupFor(deps, context, async (get) => {
      const query = new URLSearchParams({
        q: `appProperties has { key='${DRIVE_INTENT_PROPERTY}' and value=${driveLiteral(request.externalActionId)} }`,
        pageSize: '1',
        fields: 'files(id)',
        corpora: 'allDrives',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      const found = okJson(
        await get({ route: 'google_api', method: 'GET', path: `${DRIVE}?${query}` }),
      );
      if (!found || (found.files !== undefined && !Array.isArray(found.files)))
        return { answer: 'cannot_answer' };
      const files = (found.files ?? []) as unknown[];
      if (files.length === 0) return { answer: 'not_found' };
      const id = externalIdOf((files[0] as { id?: unknown } | null)?.id);
      return { answer: 'found', ...(id ? { externalId: id } : {}) };
    }),
};

type DocEdit = Payload<'docs.edit'>['edits'][number];

function docRequest(edit: DocEdit): Record<string, unknown> {
  switch (edit.kind) {
    case 'insert_text':
      return { insertText: { location: { index: edit.index }, text: edit.text } };
    case 'replace_all_text':
      return {
        replaceAllText: {
          containsText: { text: edit.find, matchCase: edit.match_case },
          replaceText: edit.replace,
        },
      };
    case 'delete_range':
      return {
        deleteContentRange: { range: { startIndex: edit.start_index, endIndex: edit.end_index } },
      };
  }
}

export const docsEdit: SuiteActionHandler<GoogleToolDeps> = {
  async send(deps, context, request) {
    requireSendScopes(context, 'docs.edit');
    const payload = request.payload as unknown as Payload<'docs.edit'>;
    // Docs would refuse an empty range; refusing here is certain and contacts nobody.
    if (
      payload.edits.some(
        (edit) => edit.kind === 'delete_range' && edit.end_index <= edit.start_index,
      )
    )
      throw new NotSent('PAYLOAD_CHANGED', false);
    return runChange(deps, context, async (io) => {
      const answer = await io.write({
        route: 'google_docs',
        method: 'POST',
        path: `${DOCS}/${enc(payload.document_id)}:batchUpdate`,
        json: {
          requests: payload.edits.map(docRequest),
          writeControl: { requiredRevisionId: payload.required_revision_id },
        },
      });
      // A changed document is a 400, which attemptAnswer makes `rejected`: final, and never retried.
      return isResponse(answer) ? attemptAnswer(answer, payload.document_id) : answer;
    });
  },
  // Best effort: still at the revision the edit required means the edit did not apply. Moved on means
  // something changed, which may or may not have been this edit.
  reconcile: (deps, context, request) =>
    lookupFor(deps, context, async (get) => {
      const payload = request.payload as unknown as Payload<'docs.edit'>;
      const document = okJson(
        await get({
          route: 'google_docs',
          method: 'GET',
          path: `${DOCS}/${enc(payload.document_id)}?fields=revisionId`,
        }),
      );
      if (typeof document?.revisionId !== 'string') return { answer: 'cannot_answer' };
      return document.revisionId === payload.required_revision_id
        ? { answer: 'not_found' }
        : { answer: 'cannot_answer' };
    }),
};

/** A cell as both sides can compare it: booleans in Sheets' spelling, everything else as text. */
const comparable = (value: unknown) =>
  typeof value === 'boolean'
    ? value
      ? 'TRUE'
      : 'FALSE'
    : typeof value === 'string' && /^(true|false)$/i.test(value)
      ? value.toUpperCase()
      : String(value ?? '');

export const sheetsWriteRange: SuiteActionHandler<GoogleToolDeps> = {
  async send(deps, context, request) {
    requireSendScopes(context, 'sheets.write_range');
    const payload = request.payload as unknown as Payload<'sheets.write_range'>;
    const query = new URLSearchParams({
      valueInputOption: payload.value_input === 'raw' ? 'RAW' : 'USER_ENTERED',
      includeValuesInResponse: 'false',
    });
    return runChange(deps, context, async (io) => {
      const answer = await io.write({
        route: 'google_sheets',
        method: 'PUT',
        path: `${SHEETS}/${enc(payload.spreadsheet_id)}/values/${enc(payload.range)}?${query}`,
        json: { majorDimension: 'ROWS', values: payload.values },
      });
      return isResponse(answer) ? attemptAnswer(answer, payload.spreadsheet_id) : answer;
    });
  },
  // Best effort: the range read back holds every value written. A null cell was left as it was, so it
  // is not compared. A formula is read back as its formula.
  reconcile: (deps, context, request) =>
    lookupFor(deps, context, async (get) => {
      const payload = request.payload as unknown as Payload<'sheets.write_range'>;
      const query = new URLSearchParams({
        majorDimension: 'ROWS',
        valueRenderOption: payload.value_input === 'raw' ? 'UNFORMATTED_VALUE' : 'FORMULA',
      });
      const read = okJson(
        await get({
          route: 'google_sheets',
          method: 'GET',
          path: `${SHEETS}/${enc(payload.spreadsheet_id)}/values/${enc(payload.range)}?${query}`,
          maxResponseBytes: BIG_RESPONSE_BYTES,
        }),
      );
      if (!read || (read.values !== undefined && !Array.isArray(read.values)))
        return { answer: 'cannot_answer' };
      const rows = (read.values ?? []) as unknown[];
      const matches = payload.values.every((row, r) =>
        row.every((cell, c) => {
          if (cell === null) return true;
          const now = Array.isArray(rows[r]) ? (rows[r] as unknown[])[c] : undefined;
          return comparable(now) === comparable(cell);
        }),
      );
      return matches
        ? { answer: 'found', externalId: payload.spreadsheet_id }
        : { answer: 'not_found' };
    }),
};

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
