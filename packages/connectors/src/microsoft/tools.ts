// Microsoft 365's suite tools for agents (ADR-038 D6). Owned by the microsoft-tools builder. The foundation
// wires these through `createSuiteToolDispatch`, which re-parses every argument and payload by the tool's
// own schema first, so each handler here sees only a shape it was written for.
//
// Route: everything is Microsoft Graph v1.0 on `ms_graph` (graph.microsoft.com). Shapes were checked
// against the Graph v1.0 reference on 2026-11-11 and are unqualified until the owner runs them against a
// test tenant holding no real data:
// - Mail: `GET /me/messages?$search="…"`, `GET /me/messages?$filter=conversationId eq '…'`, a draft by
//   `POST /me/messages` (or `POST /me/messages/{id}/createReply` to thread a reply) and `POST
//   /me/messages/{id}/send`. Bodies come back as text through `Prefer: outlook.body-content-type="text"`.
// - Calendar: `GET /me/calendars/{id}/calendarView`, `POST /me/calendars/{id}/events` with
//   `transactionId`, `PATCH /me/calendars/{id}/events/{id}`. `primary` names `/me/calendar`. Graph tells
//   the attendees of any event it creates or changes and has no switch for it, so a payload whose
//   `send_updates` says otherwise is refused when it is proposed (`suitePayloadFits`), and again here.
// - Files: `GET /drives/{id}/root/search(q='…')`, `PUT /me/drive/…:/{name}:/content` with
//   `@microsoft.graph.conflictBehavior=fail`, and an item's `/content` for Word text. A Word or Excel
//   item is named by `drive_id` and `item_id` together, `/drives/{drive}/items/{item}`, the pair M5's
//   drive sync keys it by, so the source ACL the gateway checked is for exactly the item reached here.
// - Excel: `…/workbook/worksheets/{name}/range(address='…')`, GET and PATCH, sessionless.
// - Teams: `POST /teams/{id}/channels/{id}/messages`.
//
// The Message-ID: Graph lets a client set `internetMessageId` while a message is a draft ("Updatable only
// if isDraft = true"), and custom headers only when they start with `x-` and only on create. So a send is
// a draft carrying our Message-ID (and an `x-ensemus-intent` header), then `/send`, and reconcile looks for
// that Message-ID in Sent Items. `sendMail` is not used: it takes no Message-ID and leaves nothing to find.
// Its domain is the deployment's own (`ENSEMUS_MAIL_ID_DOMAIN`); with none, mail is refused unsent.
//
// Errors carry codes only. No provider text reaches an error, a result or a log from here.
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import type { SuiteToolArgs } from '@ensemus/contracts/suite-tools';
import type { AiClassification } from '@ensemus/domain/ai';
import type { ExternalActionCode } from '@ensemus/domain/external-action';
import {
  SUITE_CONNECTION_RULES,
  type ConnectionRule,
  type SuiteToolId,
} from '@ensemus/domain/suite-tools';
import {
  NotSent,
  SyncUnavailable,
  type ActionRequest,
  type AttemptResult,
  type ConnectorContext,
  type ReconcileResult,
} from '../index';
import { ProviderHttpFailed, type ProviderHttpClient, type ProviderResponse } from '../knowledge';
import {
  ownContentClass,
  parseMailIdDomain,
  SuiteReadRefused,
  type SuiteActionHandler,
  type SuiteReadContext,
  type SuiteReadHandler,
  type SuiteReadResult,
  type SuiteResourceAccess,
} from '../suites';

/** What a Microsoft handler is given: the HTTP client over fixed routes, and a token for this connection. */
export type MicrosoftToolDeps = {
  http: ProviderHttpClient;
  withToken<T>(context: ConnectorContext, use: (token: string) => Promise<T>): Promise<T>;
  /** The right-hand side of the Message-ID a mail carries. Not a host anything connects to. */
  messageIdDomain?: string | null;
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

// --- Limits and classes.

const READ_TIMEOUT_MS = 30_000;
/** Two writes fit inside runSend's sixty seconds, with time left to say what is known. */
const WRITE_TIMEOUT_MS = 25_000;
const JSON_MAX_BYTES = 4_194_304;
/** The most of a document downloaded to read its text. Larger is refused, never cut part-way. */
const CONTENT_MAX_BYTES = 20_971_520;
/** What document.xml may inflate to. A larger one is refused as too large, so a zip bomb stops here. */
const XML_MAX_BYTES = 33_554_432;
/** The HTTP client's own ceiling on a request body. */
const BODY_MAX_BYTES = 1_048_576;
/** The suite_reads table's own ceiling, whatever a manifest says. */
const READ_TABLE_MAX_BYTES = 1_048_576;
export const TRUNCATION_MARKER = '\n[truncated]';
const SAFE_TOKEN = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * The class each source's content carries before the worker raises it to each resource's own. A person's
 * mail and calendar are their correspondence, so confidential, whoever's connection it is. Files take the
 * class of whose connection they come through (`ownContentClass`): a member's own documents are
 * confidential, and the organization's take the house default for synced content, internal, which the
 * worker raises to each file's synced class.
 */
const classOf = (tool: MicrosoftReadTool, context: SuiteReadContext): AiClassification =>
  tool === 'outlook.search' || tool === 'outlook.read_thread' || tool === 'calendar.list_events'
    ? 'confidential'
    : ownContentClass(context);

const ruleOf = (tool: SuiteToolId) => SUITE_CONNECTION_RULES[tool] as ConnectionRule;

/** Graph's permission names are not case-sensitive. A context with no recorded scopes has none. */
function hasScopes(context: ConnectorContext, tool: SuiteToolId): boolean {
  const needed = ruleOf(tool).bindings.microsoft_365?.scopes;
  const granted = context.grantedScopes;
  if (!needed || !granted) return false;
  const have = new Set(granted.map((scope) => scope.toLowerCase()));
  return needed.every((scope) => have.has(scope.toLowerCase()));
}

const outputLimit = (tool: SuiteToolId) =>
  Math.min(ruleOf(tool).maxOutputBytes, READ_TABLE_MAX_BYTES);

// --- Encoding.

/** One path segment. Encodes everything outside the unreserved set, so an ID can mean nothing else. */
export const segment = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const odataString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const queryOf = (params: readonly (readonly [string, string])[]) =>
  `?${params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
const hasLineBreak = (value: string) => /[\r\n\0]/.test(value);

const calendarBase = (calendarId: string) =>
  calendarId === 'primary' ? '/v1.0/me/calendar' : `/v1.0/me/calendars/${segment(calendarId)}`;

/** The drives an organization's connection syncs, from its parsed config. Empty means `/me/drive`. */
function configuredDrives(config: unknown): string[] {
  if (!config || typeof config !== 'object') return [];
  const drives = (config as { driveIds?: unknown }).driveIds;
  if (!Array.isArray(drives)) return [];
  return drives.filter(
    (drive): drive is string => typeof drive === 'string' && /^[A-Za-z0-9_!.-]{1,256}$/.test(drive),
  );
}

/** The same external ID M5's drive sync stores, so the worker's ACL check finds the synced row. */
export const driveResourceId = (driveId: string, itemId: string) =>
  JSON.stringify([driveId, itemId]);

// --- Reading what Graph says. Nothing here keeps provider text in an error.

const invalid = () => new SyncUnavailable('PROVIDER_RESPONSE_INVALID');

function idOf(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024) throw invalid();
  for (let at = 0; at < value.length; at++) if (value.charCodeAt(at) < 0x20) throw invalid();
  return value;
}
/** Provider text for output: a string, cut to a length, or null. Never thrown, never logged. */
function textOf(value: unknown, max = 1000): string | null {
  if (typeof value !== 'string') return null;
  return value.length > max ? value.slice(0, max) : value;
}
function recordOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function listOf(value: unknown, max: number): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value;
}
function addressOf(value: unknown): { name: string | null; address: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const email = (value as { emailAddress?: unknown }).emailAddress;
  if (!email || typeof email !== 'object') return null;
  const { name, address } = email as { name?: unknown; address?: unknown };
  return { name: textOf(name, 320), address: textOf(address, 320) };
}
const addressesOf = (value: unknown) =>
  (Array.isArray(value) ? value.slice(0, 100) : []).map(addressOf).filter((each) => each !== null);

/** A read's verdict on a status. 401 is worth another token; the rest of 4xx will not change. */
function checkReadStatus(response: ProviderResponse): void {
  const status = response.status;
  if (status >= 200 && status < 300) return;
  if (status === 401) throw new SyncUnavailable('CREDENTIAL_REJECTED');
  if (status === 403) throw new SuiteReadRefused('PROVIDER_REFUSED');
  if (status === 404 || status === 410) throw new SuiteReadRefused('PROVIDER_NOT_FOUND');
  if (status === 429) throw new SyncUnavailable('RATE_LIMITED');
  if (status >= 300 && status < 400) throw new SyncUnavailable('PROVIDER_REDIRECT');
  if (status >= 500 || status === 408) throw new SyncUnavailable('PROVIDER_UNAVAILABLE');
  throw new SuiteReadRefused('PROVIDER_REFUSED');
}

function parseJson(body: Buffer): Record<string, unknown> {
  try {
    return recordOf(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
  } catch {
    throw invalid();
  }
}

function jsonOf(response: ProviderResponse): Record<string, unknown> {
  checkReadStatus(response);
  return parseJson(response.body);
}

type GetOptions = { maxBytes?: number; prefer?: string };

/** One GET on Graph. Transport failures become a retryable code; a body over the limit, a refusal. */
async function graphGet(
  deps: MicrosoftToolDeps,
  context: ConnectorContext,
  token: string,
  path: string,
  options: GetOptions = {},
): Promise<ProviderResponse> {
  try {
    return await deps.http.request({
      route: 'ms_graph',
      method: 'GET',
      path,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(options.prefer ? { prefer: options.prefer } : {}),
      },
      timeoutMs: READ_TIMEOUT_MS,
      maxResponseBytes: options.maxBytes ?? JSON_MAX_BYTES,
      signal: context.signal,
    });
  } catch (error) {
    if (error instanceof ProviderHttpFailed && error.code === 'PROVIDER_RESPONSE_TOO_LARGE')
      throw new SuiteReadRefused('TOOL_OUTPUT_TOO_LARGE');
    const timedOut =
      context.signal.aborted ||
      (error instanceof ProviderHttpFailed && error.code === 'PROVIDER_TIMEOUT');
    throw new SyncUnavailable(timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE');
  }
}

/**
 * Runs work with a token, keeping the work's own error. The real `withToken` turns any error it does not
 * know into PROVIDER_UNAVAILABLE, which would turn a refusal or a NotSent into "maybe", so the work's
 * outcome is carried back as a value and thrown again out here.
 */
async function withGraph<T>(
  deps: MicrosoftToolDeps,
  context: ConnectorContext,
  work: (token: string) => Promise<T>,
  started?: { value: boolean },
): Promise<T> {
  const outcome = await deps.withToken(
    context,
    async (token): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
      if (started) started.value = true;
      try {
        return { ok: true, value: await work(token) };
      } catch (error) {
        return { ok: false, error };
      }
    },
  );
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

// --- Fitting output under the tool's limit. A list loses its tail, text loses its end, each marked.

const encodeJson = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');

/** Cuts text to at most `maxBytes` of UTF-8 on a character boundary, with the marker, when it is cut. */
export function clipText(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  const marker = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  let end = Math.max(0, maxBytes - marker);
  // Back off any continuation byte, so a character is never split.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') + TRUNCATION_MARKER;
}

/** The largest cap for which `build` fits, by bisection. Null when even a cap of zero does not. */
function fitByCap(build: (cap: number) => unknown, longest: number, limit: number): Buffer | null {
  const whole = encodeJson(build(Number.MAX_SAFE_INTEGER));
  if (whole.length <= limit) return whole;
  let low = 0;
  let high = longest;
  let best: Buffer | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const bytes = encodeJson(build(middle));
    if (bytes.length <= limit) {
      best = bytes;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

/** Keeps the longest prefix of `items` that fits, marked `truncated` when anything was left out. */
function fitItems<T>(
  items: readonly T[],
  build: (items: readonly T[], truncated: boolean) => unknown,
  limit: number,
  alreadyTruncated = false,
): Buffer {
  const whole = encodeJson(build(items, alreadyTruncated));
  if (whole.length <= limit) return whole;
  let low = 0;
  let high = items.length - 1;
  let best: Buffer | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const bytes = encodeJson(build(items.slice(0, middle), true));
    if (bytes.length <= limit) {
      best = bytes;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (!best) throw new SuiteReadRefused('TOOL_OUTPUT_TOO_LARGE');
  return best;
}

const jsonResult = (
  scope: ReadScope,
  tool: MicrosoftReadTool,
  bytes: Buffer,
  resourceExternalIds: readonly string[] = [],
): SuiteReadResult => ({
  bytes,
  mediaType: 'application/json',
  classification: classOf(tool, scope.context),
  resourceExternalIds,
});

// --- Text out of HTML and Word. Links are dropped with their tags: nothing here follows one.

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // A plain space: the whitespace pass that follows folds it like any other.
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      const allowed =
        Number.isInteger(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code <= 0xdfff) &&
        (code >= 0x20 || code === 9 || code === 10);
      return allowed ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Plain text from a mail's HTML. Scripts, styles and comments go; links keep only their words. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote|table)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(stripped)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\xa0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TEXT_TYPES: readonly string[] = ['text/plain', 'text/markdown', 'text/csv'];

/** One entry of a zip, stored or deflated, bounded. No ZIP64, which a Word document does not need. */
export function zipEntry(zip: Buffer, name: string, maxBytes: number): Buffer {
  const broken = () => new SuiteReadRefused('PROVIDER_REFUSED');
  const lowest = Math.max(0, zip.length - 65_557);
  let directoryEnd = -1;
  for (let at = zip.length - 22; at >= lowest; at--) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      directoryEnd = at;
      break;
    }
  }
  if (directoryEnd < 0) throw broken();
  const count = zip.readUInt16LE(directoryEnd + 10);
  let at = zip.readUInt32LE(directoryEnd + 16);
  for (let entry = 0; entry < count; entry++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) throw broken();
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    if (at + 46 + nameLength > zip.length) throw broken();
    if (zip.toString('utf8', at + 46, at + 46 + nameLength) === name) {
      if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw broken();
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const end = start + compressed;
      if (compressed === 0xffffffff || end > zip.length) throw broken();
      const data = zip.subarray(start, end);
      if (method === 0) {
        if (data.length > maxBytes) throw new SuiteReadRefused('TOOL_OUTPUT_TOO_LARGE');
        return data;
      }
      if (method !== 8) throw broken();
      try {
        return inflateRawSync(data, { maxOutputLength: maxBytes });
      } catch (error) {
        throw error instanceof RangeError
          ? new SuiteReadRefused('TOOL_OUTPUT_TOO_LARGE')
          : broken();
      }
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw broken();
}

/** The words of a Word document's body: runs of text, tabs and breaks, one line per paragraph. */
export function wordXmlText(xml: string): string {
  const parts: string[] = [];
  const pattern = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)(?:\s[^>]*)?\/>|<\/w:p>/g;
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) parts.push(decodeEntities(match[1]));
    else if (match[2] === 'tab') parts.push('\t');
    else parts.push('\n');
  }
  return parts
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Reads.

type ReadScope = {
  deps: MicrosoftToolDeps;
  context: SuiteReadContext;
  token: string;
  raw(path: string, options?: GetOptions): Promise<ProviderResponse>;
  json(path: string, options?: GetOptions): Promise<Record<string, unknown>>;
};

const scopeFor = (
  deps: MicrosoftToolDeps,
  context: SuiteReadContext,
  token: string,
): ReadScope => ({
  deps,
  context,
  token,
  raw: (path, options) => graphGet(deps, context, token, path, options),
  json: async (path, options) => jsonOf(await graphGet(deps, context, token, path, options)),
});

function readTool<Id extends MicrosoftReadTool>(
  tool: Id,
  run: (
    scope: ReadScope,
    args: SuiteToolArgs<Id>,
    access: SuiteResourceAccess | null,
    limit: number,
  ) => Promise<SuiteReadResult>,
): SuiteReadHandler<MicrosoftToolDeps> {
  return async (deps, context, args, access) => {
    if (!hasScopes(context, tool)) throw new SuiteReadRefused('SCOPE_NOT_GRANTED');
    if (context.signal.aborted) throw new SyncUnavailable('PROVIDER_TIMEOUT');
    return withGraph(deps, context, (token) =>
      run(scopeFor(deps, context, token), args as SuiteToolArgs<Id>, access, outputLimit(tool)),
    );
  };
}

const TEXT_BODY = 'outlook.body-content-type="text"';
const UTC_TEXT = 'outlook.timezone="UTC", outlook.body-content-type="text"';

export const outlookSearch = readTool('outlook.search', async (scope, args, _access, limit) => {
  // KQL inside $search is a quoted phrase, so a quote or backslash in the query is escaped, not obeyed.
  const phrase = `"${args.query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const data = await scope.json(
    `/v1.0/me/messages${queryOf([
      ['$search', phrase],
      ['$top', String(args.max_results)],
      [
        '$select',
        'id,conversationId,subject,from,receivedDateTime,bodyPreview,hasAttachments,isDraft',
      ],
    ])}`,
  );
  const messages = listOf(data.value, args.max_results).map((raw) => {
    const message = recordOf(raw);
    return {
      id: idOf(message.id),
      conversation_id: textOf(message.conversationId, 1024),
      subject: textOf(message.subject),
      from: addressOf(message.from),
      received_at: textOf(message.receivedDateTime, 64),
      preview: textOf(message.bodyPreview, 1000),
      has_attachments: message.hasAttachments === true,
      is_draft: message.isDraft === true,
    };
  });
  return jsonResult(
    scope,
    'outlook.search',
    fitItems(messages, (items, truncated) => ({ messages: items, truncated }), limit),
  );
});

export const outlookReadThread = readTool(
  'outlook.read_thread',
  async (scope, args, _access, limit) => {
    // Sorted here: Graph refuses some orderings with a conversationId filter.
    const data = await scope.json(
      `/v1.0/me/messages${queryOf([
        ['$filter', `conversationId eq ${odataString(args.conversation_id)}`],
        ['$top', '50'],
        [
          '$select',
          'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,isDraft',
        ],
      ])}`,
      { prefer: TEXT_BODY },
    );
    const more = typeof data['@odata.nextLink'] === 'string';
    const messages = listOf(data.value, 50)
      .map((raw) => {
        const message = recordOf(raw);
        const body = message.body && typeof message.body === 'object' ? message.body : {};
        const { contentType, content } = body as { contentType?: unknown; content?: unknown };
        const text = typeof content === 'string' ? content : '';
        return {
          id: idOf(message.id),
          subject: textOf(message.subject),
          from: addressOf(message.from),
          to: addressesOf(message.toRecipients),
          cc: addressesOf(message.ccRecipients),
          received_at: textOf(message.receivedDateTime, 64),
          has_attachments: message.hasAttachments === true,
          is_draft: message.isDraft === true,
          text:
            typeof contentType === 'string' && contentType.toLowerCase() === 'html'
              ? htmlToText(text)
              : text.replace(/\r\n?/g, '\n'),
        };
      })
      .sort((a, b) => (a.received_at ?? '').localeCompare(b.received_at ?? ''));
    if (messages.length === 0) throw new SuiteReadRefused('PROVIDER_NOT_FOUND');
    const longest = Math.max(...messages.map((message) => Buffer.byteLength(message.text)));
    const build = (cap: number) => ({
      conversation_id: args.conversation_id,
      messages: messages.map((message) => ({ ...message, text: clipText(message.text, cap) })),
      truncated: more || cap < longest,
    });
    const fitted = fitByCap(build, longest, limit);
    if (fitted) return jsonResult(scope, 'outlook.read_thread', fitted);
    // Even empty bodies do not fit: keep the earliest messages, each body empty and marked.
    const bare = messages.map((message) => ({ ...message, text: clipText(message.text, 0) }));
    return jsonResult(
      scope,
      'outlook.read_thread',
      fitItems(
        bare,
        (items) => ({ conversation_id: args.conversation_id, messages: items, truncated: true }),
        limit,
        true,
      ),
    );
  },
);

export const calendarListEvents = readTool(
  'calendar.list_events',
  async (scope, args, _access, limit) => {
    const data = await scope.json(
      `${calendarBase(args.calendar_id)}/calendarView${queryOf([
        ['startDateTime', args.time_min],
        ['endDateTime', args.time_max],
        ['$top', String(args.max_results)],
        ['$orderby', 'start/dateTime'],
        [
          '$select',
          'id,subject,start,end,location,attendees,organizer,isAllDay,isCancelled,bodyPreview',
        ],
      ])}`,
      { prefer: UTC_TEXT },
    );
    const when = (value: unknown) => {
      if (!value || typeof value !== 'object') return null;
      const { dateTime, timeZone } = value as { dateTime?: unknown; timeZone?: unknown };
      return { date_time: textOf(dateTime, 64), time_zone: textOf(timeZone, 64) };
    };
    const events = listOf(data.value, args.max_results).map((raw) => {
      const event = recordOf(raw);
      const location =
        event.location && typeof event.location === 'object'
          ? textOf((event.location as { displayName?: unknown }).displayName, 500)
          : null;
      return {
        id: idOf(event.id),
        summary: textOf(event.subject, 500),
        start: when(event.start),
        end: when(event.end),
        all_day: event.isAllDay === true,
        cancelled: event.isCancelled === true,
        location,
        organizer: addressOf(event.organizer),
        attendees: addressesOf(event.attendees),
        preview: textOf(event.bodyPreview, 1000),
      };
    });
    const more = typeof data['@odata.nextLink'] === 'string';
    return jsonResult(
      scope,
      'calendar.list_events',
      fitItems(events, (items, truncated) => ({ events: items, truncated }), limit, more),
    );
  },
);

export const onedriveSearch = readTool('onedrive.search', async (scope, args, access, limit) => {
  const drives = configuredDrives(scope.context.config);
  const bases = drives.length
    ? drives.map((drive) => ({ drive, path: `/v1.0/drives/${segment(drive)}` }))
    : [{ drive: null, path: '/v1.0/me/drive' }];
  const q = encodeURIComponent(args.query.replace(/'/g, "''"));
  const found: {
    resource: string;
    item_id: string;
    drive_id: string;
    name: string | null;
    media_type: string | null;
    size: number | null;
    modified_at: string | null;
  }[] = [];
  let more = false;
  for (const base of bases) {
    if (found.length >= args.max_results) {
      more = true;
      break;
    }
    const data = await scope.json(
      `${base.path}/root/search(q='${q}')${queryOf([
        ['$top', String(args.max_results)],
        ['$select', 'id,name,size,file,folder,parentReference,lastModifiedDateTime'],
      ])}`,
    );
    if (typeof data['@odata.nextLink'] === 'string') more = true;
    for (const raw of listOf(data.value, 1000)) {
      const item = recordOf(raw);
      if (!item.file || typeof item.file !== 'object') continue;
      const reference =
        item.parentReference && typeof item.parentReference === 'object'
          ? (item.parentReference as { driveId?: unknown }).driveId
          : undefined;
      // A synced drive is named as the connection's config names it, which is how the sync keys its
      // items, so the ACL check and a later word.read find the same row.
      const said = typeof reference === 'string' ? idOf(reference) : null;
      const driveId =
        base.drive && (!said || said.toLowerCase() === base.drive.toLowerCase())
          ? base.drive
          : said;
      if (!driveId) throw invalid();
      const itemId = idOf(item.id);
      found.push({
        resource: driveResourceId(driveId, itemId),
        item_id: itemId,
        drive_id: driveId,
        name: textOf(item.name, 500),
        media_type: textOf((item.file as { mimeType?: unknown }).mimeType, 256),
        size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : null,
        modified_at: textOf(item.lastModifiedDateTime, 64),
      });
    }
  }
  // Through the organization's connection the initiator sees only what the source grants them.
  const permitted = access ? await access.permitted(found.map((each) => each.resource)) : null;
  const kept = found
    .filter((each) => !permitted || permitted.has(each.resource))
    .slice(0, args.max_results);
  if (found.length > args.max_results) more = true;
  const files = kept.map(({ resource: _resource, ...file }) => file);
  const bytes = fitItems(files, (items, truncated) => ({ files: items, truncated }), limit, more);
  const shown = (JSON.parse(bytes.toString('utf8')) as { files: unknown[] }).files.length;
  return jsonResult(
    scope,
    'onedrive.search',
    bytes,
    kept.slice(0, shown).map((each) => each.resource),
  );
});

type LocatedItem = { base: string; driveId: string; itemId: string; item: Record<string, unknown> };

/**
 * Where a drive item is: `/drives/{drive}/items/{item}`, exactly the pair the gateway checked. A connection
 * whose config names drives reaches only those, so a drive outside them is not found, whatever Graph
 * would allow. Null for that.
 */
function driveItemBase(config: unknown, driveId: string, itemId: string): string | null {
  const drives = configuredDrives(config);
  if (drives.length && !drives.includes(driveId)) return null;
  return `/v1.0/drives/${segment(driveId)}/items/${segment(itemId)}`;
}

/**
 * Reads an item by its drive and ID. Answers the pair as given, so the output names the same resource the
 * drive sync recorded and the gateway checked.
 */
async function locateItem(
  scope: ReadScope,
  driveId: string,
  itemId: string,
  select: string,
): Promise<LocatedItem> {
  const base = driveItemBase(scope.context.config, driveId, itemId);
  if (!base) throw new SuiteReadRefused('PROVIDER_NOT_FOUND');
  const item = jsonOf(await scope.raw(`${base}${queryOf([['$select', select]])}`));
  if (idOf(item.id) !== itemId) throw invalid();
  return { base, driveId, itemId, item };
}

/** An item's bytes. Graph answers with a redirect to a download host, taken only through `download`. */
async function itemContent(scope: ReadScope, base: string): Promise<Buffer> {
  let response = await scope.raw(`${base}/content`, { maxBytes: CONTENT_MAX_BYTES });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.location;
    if (!location || !scope.deps.http.download) throw new SuiteReadRefused('PROVIDER_UNAVAILABLE');
    try {
      response = await scope.deps.http.download({
        url: location,
        timeoutMs: READ_TIMEOUT_MS,
        maxResponseBytes: CONTENT_MAX_BYTES,
        signal: scope.context.signal,
      });
    } catch (error) {
      if (error instanceof ProviderHttpFailed && error.code === 'PROVIDER_RESPONSE_TOO_LARGE')
        throw new SuiteReadRefused('TOOL_OUTPUT_TOO_LARGE');
      if (error instanceof ProviderHttpFailed && error.code === 'PROVIDER_ROUTE_UNAVAILABLE')
        throw new SuiteReadRefused('PROVIDER_UNAVAILABLE');
      throw new SyncUnavailable('PROVIDER_UNAVAILABLE');
    }
    if (response.status >= 300 && response.status < 400)
      throw new SuiteReadRefused('PROVIDER_UNAVAILABLE');
  }
  checkReadStatus(response);
  return response.body;
}

export const wordRead = readTool('word.read', async (scope, args, _access, limit) => {
  const located = await locateItem(
    scope,
    args.drive_id,
    args.item_id,
    'id,name,size,file,parentReference',
  );
  const file =
    located.item.file && typeof located.item.file === 'object'
      ? (located.item.file as { mimeType?: unknown })
      : null;
  if (!file) throw new SuiteReadRefused('TOOL_ARGS_INVALID');
  const name = textOf(located.item.name, 500);
  const mime = (typeof file.mimeType === 'string' ? file.mimeType : '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  let text: string;
  if (mime === DOCX || (!mime && name?.toLowerCase().endsWith('.docx'))) {
    const zip = await itemContent(scope, located.base);
    text = wordXmlText(zipEntry(zip, 'word/document.xml', XML_MAX_BYTES).toString('utf8'));
  } else if (TEXT_TYPES.includes(mime)) {
    text = new TextDecoder('utf-8').decode(await itemContent(scope, located.base));
  } else {
    // Not a document whose words can be read without a converter: a refusal, not a guess.
    throw new SuiteReadRefused('TOOL_ARGS_INVALID');
  }
  const longest = Buffer.byteLength(text);
  const build = (cap: number) => ({
    item_id: located.itemId,
    name,
    media_type: mime || DOCX,
    text: clipText(text, cap),
    truncated: cap < longest,
  });
  const fitted = fitByCap(build, longest, limit);
  if (!fitted) throw new SuiteReadRefused('TOOL_OUTPUT_TOO_LARGE');
  return jsonResult(scope, 'word.read', fitted, [driveResourceId(located.driveId, located.itemId)]);
});

/** The range without its sheet. A sheet named in the range must be the worksheet argument. */
function bareAddress(range: string, worksheet: string): string | null {
  const bang = range.lastIndexOf('!');
  if (bang < 0) return range;
  let sheet = range.slice(0, bang);
  if (sheet.startsWith("'") && sheet.endsWith("'")) sheet = sheet.slice(1, -1);
  return sheet === worksheet ? range.slice(bang + 1) : null;
}

const rangePath = (base: string, worksheet: string, address: string) =>
  `${base}/workbook/worksheets/${segment(worksheet)}/range(address='${address}')`;

const cellOf = (value: unknown): string | number | boolean | null =>
  typeof value === 'string'
    ? (textOf(value, 50_000) ?? '')
    : typeof value === 'number' || typeof value === 'boolean'
      ? value
      : null;

export const excelReadRange = readTool('excel.read_range', async (scope, args, _access, limit) => {
  const address = bareAddress(args.range, args.worksheet);
  if (address === null) throw new SuiteReadRefused('TOOL_ARGS_INVALID');
  const located = await locateItem(scope, args.drive_id, args.item_id, 'id,parentReference');
  // Sessionless: a read changes nothing, so no workbook session is opened.
  const data = await scope.json(
    `${rangePath(located.base, args.worksheet, address)}${queryOf([['$select', 'address,values']])}`,
  );
  const rows = listOf(data.values, 100_000).map((row) =>
    listOf(row, 16_384).slice(0, 1000).map(cellOf),
  );
  return jsonResult(
    scope,
    'excel.read_range',
    fitItems(
      rows,
      (items, truncated) => ({
        item_id: located.itemId,
        worksheet: args.worksheet,
        address: textOf(data.address, 300),
        values: items,
        truncated,
      }),
      limit,
    ),
    [driveResourceId(located.driveId, located.itemId)],
  );
});

// --- Changes. A send names one commit point; before it, nothing has happened, and any failure is a
// certain NotSent. After it, only an answer from Graph is believed.

/** Past the commit point with no answer to believe. */
class Uncertain extends Error {
  override name = 'Uncertain';
  constructor(
    readonly code: ExternalActionCode,
    readonly providerStatus?: number,
  ) {
    super(code);
  }
}

type Writer = {
  context: ConnectorContext;
  token: string;
  /** A read before the commit point. Its failure is a NotSent with a code. */
  get(path: string, options?: GetOptions): Promise<Record<string, unknown>>;
  raw(path: string, options?: GetOptions): Promise<ProviderResponse>;
  /** A write that is not itself the effect (a draft before `/send`). Any failure means no effect. */
  prepare(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<ProviderResponse>;
  /** The commit point. Transport failure once the request may be on the wire is Uncertain. */
  commit(
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    body: unknown,
    contentType?: string,
  ): Promise<ProviderResponse>;
};

/** Transport failures that are certain the request never left: no relay, no TLS, no route. */
const NEVER_LEFT: ReadonlySet<string> = new Set([
  'PROVIDER_CONNECT_FAILED',
  'PROVIDER_TLS_FAILED',
  'PROVIDER_ROUTE_UNAVAILABLE',
]);

function bodyBytes(body: unknown): Buffer {
  const bytes = Buffer.isBuffer(body)
    ? body
    : body === undefined
      ? Buffer.alloc(0)
      : encodeJson(body);
  // The client refuses a larger body before sending, but its code says nothing about when.
  if (bytes.length > BODY_MAX_BYTES) throw new NotSent('PAYLOAD_CHANGED', false);
  return bytes;
}

/** A read's error, before anything was written, as the NotSent it is. */
function notSentFor(error: unknown): NotSent {
  if (error instanceof NotSent) return error;
  if (error instanceof SuiteReadRefused) {
    return error.code === 'PROVIDER_UNAVAILABLE'
      ? new NotSent('CONNECTOR_UNAVAILABLE', false)
      : new NotSent('REFUSED_BY_PROVIDER', false);
  }
  if (error instanceof SyncUnavailable) {
    switch (error.code) {
      case 'PROVIDER_TIMEOUT':
        return new NotSent('TIMEOUT_BEFORE_COMMIT', true);
      case 'RATE_LIMITED':
        return new NotSent('RELAY_BUSY', true);
      case 'CREDENTIAL_REJECTED':
        return new NotSent('AUTH_FAILED', false);
      default:
        return new NotSent('CONNECT_FAILED', true);
    }
  }
  return new NotSent('CONNECTOR_UNAVAILABLE', false);
}

/** `withToken` failed before any work: the token never came, so Graph was never asked. */
function notSentForToken(error: unknown): NotSent {
  const code = error instanceof SyncUnavailable ? error.code : '';
  if (code === 'PROVIDER_TIMEOUT') return new NotSent('TIMEOUT_BEFORE_COMMIT', true);
  const final = [
    'CREDENTIAL_INVALID',
    'CREDENTIAL_REJECTED',
    'CREDENTIAL_CONTEXT_MISMATCH',
    'CREDENTIAL_CHANGED',
  ].includes(code);
  return new NotSent('CREDENTIAL_UNAVAILABLE', !final);
}

const writerFor = (
  deps: MicrosoftToolDeps,
  context: ConnectorContext,
  token: string,
  state: { committed: boolean },
): Writer => {
  const write = (
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    bytes: Buffer,
    contentType: string,
  ) =>
    deps.http.request({
      route: 'ms_graph',
      method,
      path,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(bytes.length ? { 'content-type': contentType } : {}),
      },
      body: bytes,
      timeoutMs: WRITE_TIMEOUT_MS,
      maxResponseBytes: JSON_MAX_BYTES,
      signal: context.signal,
    });
  return {
    context,
    token,
    get: async (path, options) => {
      try {
        return jsonOf(await graphGet(deps, context, token, path, options));
      } catch (error) {
        throw notSentFor(error);
      }
    },
    raw: async (path, options) => {
      try {
        return await graphGet(deps, context, token, path, options);
      } catch (error) {
        throw notSentFor(error);
      }
    },
    prepare: async (method, path, body) => {
      const bytes = bodyBytes(body);
      if (context.signal.aborted) throw new NotSent('TIMEOUT_BEFORE_COMMIT', true);
      try {
        return await write(method, path, bytes, 'application/json');
      } catch {
        throw new NotSent(
          context.signal.aborted ? 'TIMEOUT_BEFORE_COMMIT' : 'CONNECT_FAILED',
          true,
        );
      }
    },
    commit: async (method, path, body, contentType = 'application/json') => {
      const bytes = bodyBytes(body);
      if (context.signal.aborted) throw new NotSent('TIMEOUT_BEFORE_COMMIT', true);
      state.committed = true;
      try {
        return await write(method, path, bytes, contentType);
      } catch (error) {
        if (error instanceof ProviderHttpFailed && NEVER_LEFT.has(error.code)) {
          throw error.code === 'PROVIDER_ROUTE_UNAVAILABLE'
            ? new NotSent('CONNECTOR_UNAVAILABLE', false)
            : new NotSent('CONNECT_FAILED', true);
        }
        const timedOut =
          context.signal.aborted ||
          (error instanceof ProviderHttpFailed && error.code === 'PROVIDER_TIMEOUT');
        throw new Uncertain(timedOut ? 'TIMEOUT_AFTER_COMMIT' : 'CONNECTION_LOST_AFTER_COMMIT');
      }
    },
  };
};

/** Graph's answer to the commit. 401 and 429 are refused before anything is done. */
function answerOf(response: ProviderResponse, externalId?: string | null): AttemptResult {
  const status = response.status;
  if (status >= 200 && status < 300)
    return {
      outcome: 'accepted',
      code: 'ACCEPTED_BY_PROVIDER',
      providerStatus: status,
      ...(externalId ? { externalId } : {}),
    };
  if (status === 401)
    return { outcome: 'not_sent', code: 'AUTH_FAILED', retryable: false, providerStatus: status };
  if (status === 429)
    return { outcome: 'not_sent', code: 'RELAY_BUSY', retryable: true, providerStatus: status };
  if (status >= 400 && status < 500 && status !== 408)
    return { outcome: 'rejected', code: 'REFUSED_BY_PROVIDER', providerStatus: status };
  // A redirect, a 408 or a 5xx after the request went: Graph may have done it.
  return { outcome: 'indeterminate', code: 'CONNECTION_LOST_AFTER_COMMIT', providerStatus: status };
}

/** A prepare step's failure, as what it is: nothing reached anyone. */
function preparedFailure(response: ProviderResponse): AttemptResult | null {
  const status = response.status;
  if (status >= 200 && status < 300) return null;
  if (status === 401)
    return { outcome: 'not_sent', code: 'AUTH_FAILED', retryable: false, providerStatus: status };
  if (status >= 400 && status < 500 && status !== 408 && status !== 429)
    return { outcome: 'rejected', code: 'REFUSED_BY_PROVIDER', providerStatus: status };
  return { outcome: 'not_sent', code: 'RELAY_BUSY', retryable: true, providerStatus: status };
}

/** The ID in a 2xx JSON answer, or null when there is none worth keeping. */
function createdId(response: ProviderResponse): string | null {
  try {
    const id = parseJson(response.body).id;
    return typeof id === 'string' && id.length > 0 && id.length <= 998 ? id : null;
  } catch {
    return null;
  }
}

type Reader = {
  context: ConnectorContext;
  raw(path: string, options?: GetOptions): Promise<ProviderResponse>;
  json(path: string, options?: GetOptions): Promise<Record<string, unknown>>;
};

function actionTool<Id extends MicrosoftActionTool>(
  tool: Id,
  handlers: {
    send(
      writer: Writer,
      payload: Omit<SuiteToolArgs<Id>, 'connection_id'>,
      request: ActionRequest<Record<string, unknown>>,
      deps: MicrosoftToolDeps,
    ): Promise<AttemptResult>;
    reconcile(
      reader: Reader,
      payload: Omit<SuiteToolArgs<Id>, 'connection_id'>,
      request: ActionRequest<Record<string, unknown>>,
      deps: MicrosoftToolDeps,
    ): Promise<ReconcileResult>;
  },
): SuiteActionHandler<MicrosoftToolDeps> {
  type Payload = Omit<SuiteToolArgs<Id>, 'connection_id'>;
  return {
    async send(deps, context, request) {
      if (!hasScopes(context, tool)) throw new NotSent('AUTH_FAILED', false);
      if (context.signal.aborted) throw new NotSent('TIMEOUT_BEFORE_COMMIT', true);
      const state = { committed: false };
      const started = { value: false };
      try {
        return await withGraph(
          deps,
          context,
          (token) =>
            handlers.send(
              writerFor(deps, context, token, state),
              request.payload as Payload,
              request,
              deps,
            ),
          started,
        );
      } catch (error) {
        if (!started.value) throw notSentForToken(error);
        if (error instanceof Uncertain)
          return {
            outcome: 'indeterminate',
            code: error.code,
            ...(error.providerStatus ? { providerStatus: error.providerStatus } : {}),
          };
        if (error instanceof NotSent) throw error;
        // Anything else: certain only while nothing was written.
        if (state.committed)
          return { outcome: 'indeterminate', code: 'CONNECTION_LOST_AFTER_COMMIT' };
        throw notSentFor(error);
      }
    },
    async reconcile(deps, context, request) {
      if (!hasScopes(context, tool)) return { answer: 'cannot_answer' };
      try {
        return await withGraph(deps, context, (token) =>
          handlers.reconcile(
            {
              context,
              raw: (path, options) => graphGet(deps, context, token, path, options),
              json: async (path, options) =>
                jsonOf(await graphGet(deps, context, token, path, options)),
            },
            request.payload as Payload,
            request,
            deps,
          ),
        );
      } catch {
        return { answer: 'cannot_answer' };
      }
    },
  };
}

// --- Mail.

type MailPayload = Omit<SuiteToolArgs<'outlook.send'>, 'connection_id'>;

/**
 * The Message-ID this intent's mail carries, the same on every attempt. With no deployment domain, nothing
 * is sent: nothing has been contacted, and asking again will not configure one.
 */
export function messageIdFor(request: ActionRequest, deps: MicrosoftToolDeps): string {
  const domain = parseMailIdDomain(deps.messageIdDomain);
  if (!domain) throw new NotSent('CONNECTOR_UNAVAILABLE', false);
  if (!SAFE_TOKEN.test(request.idempotencyKey)) throw new NotSent('PAYLOAD_CHANGED', false);
  return `<${request.idempotencyKey}@${domain}>`;
}

/** The draft's fields, exactly from the payload. A line break in any header value is refused. */
function draftOf(
  payload: MailPayload,
  messageId: string,
  request: ActionRequest,
  withHeaders: boolean,
): Record<string, unknown> {
  const { message } = payload;
  const all = [message.subject, ...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];
  if (all.some(hasLineBreak) || hasLineBreak(messageId) || !SAFE_TOKEN.test(request.idempotencyKey))
    throw new NotSent('PAYLOAD_CHANGED', false);
  const recipients = (list: readonly string[] | undefined) =>
    (list ?? []).map((address) => ({ emailAddress: { address } }));
  return {
    subject: message.subject,
    body: { contentType: 'text', content: message.text_body },
    toRecipients: recipients(message.to),
    ccRecipients: recipients(message.cc),
    bccRecipients: recipients(message.bcc),
    internetMessageId: messageId,
    // Custom headers may only be set on create and must start with x- (Graph's message resource).
    ...(withHeaders
      ? { internetMessageHeaders: [{ name: 'x-ensemus-intent', value: request.idempotencyKey }] }
      : {}),
  };
}

/** Creates the draft: a reply through createReply, so Outlook threads it, or a new message. */
function draftRequest(
  payload: MailPayload,
  messageId: string,
  request: ActionRequest,
): { path: string; body: unknown } {
  const replyTo = payload.message.in_reply_to;
  return replyTo
    ? {
        path: `/v1.0/me/messages/${segment(replyTo)}/createReply`,
        body: { message: draftOf(payload, messageId, request, false) },
      }
    : { path: '/v1.0/me/messages', body: draftOf(payload, messageId, request, true) };
}

/** Looks for our Message-ID, in one folder or the whole mailbox. */
async function findMessage(
  reader: Reader,
  folder: 'sentitems' | null,
  messageId: string,
): Promise<ReconcileResult> {
  const base = folder ? `/v1.0/me/mailFolders/${folder}/messages` : '/v1.0/me/messages';
  const data = await reader.json(
    `${base}${queryOf([
      ['$filter', `internetMessageId eq ${odataString(messageId)}`],
      ['$select', 'id,internetMessageId,isDraft'],
      ['$top', '5'],
    ])}`,
  );
  const hits = listOf(data.value, 5).filter((raw) => recordOf(raw).internetMessageId === messageId);
  if (hits.length === 0) return { answer: 'not_found' };
  const id = recordOf(hits[0]).id;
  return {
    answer: 'found',
    ...(typeof id === 'string' && id.length <= 998 ? { externalId: id } : {}),
  };
}

export const outlookCreateDraft = actionTool('outlook.create_draft', {
  async send(writer, payload, request, deps) {
    // The draft is the effect: it reaches nobody, and it is all this tool does.
    const messageId = messageIdFor(request, deps);
    const draft = draftRequest(payload, messageId, request);
    const response = await writer.commit('POST', draft.path, draft.body);
    return answerOf(response, createdId(response));
  },
  async reconcile(reader, _payload, request, deps) {
    // Anywhere in the mailbox: a person may already have moved or sent it.
    return findMessage(reader, null, messageIdFor(request, deps));
  },
});

export const outlookSend = actionTool('outlook.send', {
  async send(writer, payload, request, deps) {
    const messageId = messageIdFor(request, deps);
    const draft = draftRequest(payload, messageId, request);
    // The draft reaches nobody, so its failure is certain. A draft left by a failed /send is the
    // person's to delete: Graph's route here allows no DELETE.
    const created = await writer.prepare('POST', draft.path, draft.body);
    const failed = preparedFailure(created);
    if (failed) return failed;
    const draftId = createdId(created);
    if (!draftId) throw new NotSent('REFUSED_BY_PROVIDER', false);
    const sent = await writer.commit(
      'POST',
      `/v1.0/me/messages/${segment(draftId)}/send`,
      undefined,
    );
    return answerOf(sent, messageId);
  },
  async reconcile(reader, _payload, request, deps) {
    // Sent Items only. A draft that is still a draft was not sent.
    return findMessage(reader, 'sentitems', messageIdFor(request, deps));
  },
});

// --- Calendar.

/** An instant as wall-clock time in an IANA zone, the way Graph's dateTimeTimeZone takes it. */
export function wallTime(instant: string, timeZone: string): string {
  const at = new Date(instant);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
  } catch {
    throw new NotSent('PAYLOAD_CHANGED', false);
  }
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? '';
  const millis = at.getUTCMilliseconds();
  return (
    `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}` +
    (millis ? `.${String(millis).padStart(3, '0')}` : '')
  );
}

const attendeesOf = (list: readonly string[]) =>
  list.map((address) => ({ emailAddress: { address }, type: 'required' }));

/** Graph's UTC wall time (with `Prefer: outlook.timezone="UTC"`) as an instant. */
function utcInstant(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const { dateTime, timeZone } = value as { dateTime?: unknown; timeZone?: unknown };
  if (typeof dateTime !== 'string' || timeZone !== 'UTC') return null;
  const parsed = Date.parse(`${dateTime.replace(/(\.\d{3})\d*$/, '$1')}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

export const calendarCreateEvent = actionTool('calendar.create_event', {
  async send(writer, payload, request) {
    if (!SAFE_TOKEN.test(request.idempotencyKey)) throw new NotSent('PAYLOAD_CHANGED', false);
    const event = {
      subject: payload.summary,
      ...(payload.description !== undefined
        ? { body: { contentType: 'text', content: payload.description } }
        : {}),
      ...(payload.location !== undefined ? { location: { displayName: payload.location } } : {}),
      start: { dateTime: wallTime(payload.start, payload.time_zone), timeZone: payload.time_zone },
      end: { dateTime: wallTime(payload.end, payload.time_zone), timeZone: payload.time_zone },
      attendees: attendeesOf(payload.attendees),
      // Graph dedupes a retried create on this, so a repeat of this intent cannot make a second event.
      transactionId: request.idempotencyKey,
    };
    const response = await writer.commit(
      'POST',
      `${calendarBase(payload.calendar_id)}/events`,
      event,
    );
    return answerOf(response, createdId(response));
  },
  async reconcile(reader, payload, request) {
    // Graph offers no filter on transactionId, but returns it on an event an app set it on. So look at
    // the events in the payload's own window. Not finding it there proves nothing: best effort.
    const data = await reader.json(
      `${calendarBase(payload.calendar_id)}/calendarView${queryOf([
        ['startDateTime', payload.start],
        ['endDateTime', payload.end],
        ['$select', 'id,transactionId'],
        ['$top', '100'],
      ])}`,
      { prefer: 'outlook.timezone="UTC"' },
    );
    for (const raw of listOf(data.value, 100)) {
      const event = recordOf(raw);
      if (event.transactionId === request.idempotencyKey) {
        const id = event.id;
        return {
          answer: 'found',
          ...(typeof id === 'string' && id.length <= 998 ? { externalId: id } : {}),
        };
      }
    }
    return typeof data['@odata.nextLink'] === 'string'
      ? { answer: 'cannot_answer' }
      : { answer: 'not_found' };
  },
});

export const calendarUpdateEvent = actionTool('calendar.update_event', {
  async send(writer, payload) {
    const { changes } = payload;
    // A time zone alone cannot be said to Graph without restating the times, which the payload does
    // not hold. Refused, rather than guessed.
    if (changes.time_zone !== undefined && changes.start === undefined && changes.end === undefined)
      throw new NotSent('PAYLOAD_CHANGED', false);
    const zone = changes.time_zone ?? 'UTC';
    const patch = {
      ...(changes.summary !== undefined ? { subject: changes.summary } : {}),
      ...(changes.description !== undefined
        ? { body: { contentType: 'text', content: changes.description } }
        : {}),
      ...(changes.location !== undefined ? { location: { displayName: changes.location } } : {}),
      ...(changes.start !== undefined
        ? { start: { dateTime: wallTime(changes.start, zone), timeZone: zone } }
        : {}),
      ...(changes.end !== undefined
        ? { end: { dateTime: wallTime(changes.end, zone), timeZone: zone } }
        : {}),
      ...(changes.attendees !== undefined ? { attendees: attendeesOf(changes.attendees) } : {}),
    };
    const response = await writer.commit(
      'PATCH',
      `${calendarBase(payload.calendar_id)}/events/${segment(payload.event_id)}`,
      patch,
    );
    return answerOf(response, payload.event_id);
  },
  async reconcile(reader, payload) {
    // Found when the event now holds every changed field. A difference proves nothing: someone else
    // may have changed it since, so it cannot answer.
    const event = await reader.json(
      `${calendarBase(payload.calendar_id)}/events/${segment(payload.event_id)}${queryOf([
        ['$select', 'id,subject,body,location,start,end,attendees'],
      ])}`,
      { prefer: UTC_TEXT },
    );
    const { changes } = payload;
    const same: boolean[] = [];
    if (changes.summary !== undefined) same.push(event.subject === changes.summary);
    if (changes.location !== undefined) {
      const location =
        event.location && typeof event.location === 'object'
          ? (event.location as { displayName?: unknown }).displayName
          : undefined;
      same.push(location === changes.location);
    }
    if (changes.description !== undefined) {
      const content =
        event.body && typeof event.body === 'object'
          ? (event.body as { content?: unknown }).content
          : undefined;
      const normal = (text: string) => text.replace(/\r\n?/g, '\n').trim();
      same.push(typeof content === 'string' && normal(content) === normal(changes.description));
    }
    if (changes.start !== undefined)
      same.push(utcInstant(event.start) === Date.parse(changes.start));
    if (changes.end !== undefined) same.push(utcInstant(event.end) === Date.parse(changes.end));
    if (changes.attendees !== undefined) {
      const have = addressesOf(event.attendees)
        .map((each) => each.address?.toLowerCase() ?? '')
        .sort();
      const want = changes.attendees.map((each) => each.toLowerCase()).sort();
      same.push(JSON.stringify(have) === JSON.stringify(want));
    }
    return same.length > 0 && same.every(Boolean)
      ? { answer: 'found', externalId: payload.event_id }
      : { answer: 'cannot_answer' };
  },
});

// --- Files.

type NewFile = Omit<SuiteToolArgs<'onedrive.create_file'>, 'connection_id'>;

/** The file's path by name under its parent: the approved name exactly, never one we change. */
const newFilePath = (payload: NewFile) =>
  payload.parent_id
    ? `/v1.0/me/drive/items/${segment(payload.parent_id)}:/${segment(payload.name)}:`
    : `/v1.0/me/drive/root:/${segment(payload.name)}:`;

export const onedriveCreateFile = actionTool('onedrive.create_file', {
  async send(writer, payload) {
    const bytes = Buffer.from(payload.text, 'utf8');
    // `fail` makes Graph refuse rather than replace a file of that name, so a repeat cannot overwrite.
    const response = await writer.commit(
      'PUT',
      `${newFilePath(payload)}/content${queryOf([['@microsoft.graph.conflictBehavior', 'fail']])}`,
      bytes,
      `${payload.media_type}; charset=utf-8`,
    );
    return answerOf(response, createdId(response));
  },
  async reconcile(reader, payload) {
    // By path: the approved name under its parent. A file there counts as ours only when its bytes
    // are exactly the payload's, by the hash Graph gives or by reading it back.
    const response = await reader.raw(
      `${newFilePath(payload)}${queryOf([['$select', 'id,name,size,file']])}`,
    );
    if (response.status === 404) return { answer: 'not_found' };
    const item = jsonOf(response);
    const id = idOf(item.id);
    const bytes = Buffer.from(payload.text, 'utf8');
    if (item.size !== bytes.length) return { answer: 'cannot_answer' };
    const hashes =
      item.file && typeof item.file === 'object'
        ? ((item.file as { hashes?: unknown }).hashes as Record<string, unknown> | undefined)
        : undefined;
    const digest = (algorithm: string) =>
      createHash(algorithm).update(bytes).digest('hex').toUpperCase();
    let same: boolean | null = null;
    if (hashes && typeof hashes.sha256Hash === 'string')
      same = hashes.sha256Hash.toUpperCase() === digest('sha256');
    else if (hashes && typeof hashes.sha1Hash === 'string')
      same = hashes.sha1Hash.toUpperCase() === digest('sha1');
    else {
      const content = await reader.raw(`/v1.0/me/drive/items/${segment(id)}/content`, {
        maxBytes: Math.max(1, bytes.length + 1),
      });
      // A redirect to a download host is not followed here: without the bytes, it cannot answer.
      if (content.status >= 200 && content.status < 300) same = content.body.equals(bytes);
    }
    if (same === true) return { answer: 'found', externalId: id };
    return { answer: 'cannot_answer' };
  },
});

export const excelWriteRange = actionTool('excel.write_range', {
  async send(writer, payload) {
    const address = bareAddress(payload.range, payload.worksheet);
    if (address === null) throw new NotSent('PAYLOAD_CHANGED', false);
    // A drive this connection does not reach: certain nothing was written, and asking again will not
    // change that.
    const base = driveItemBase(writer.context.config, payload.drive_id, payload.item_id);
    if (!base) throw new NotSent('REFUSED_BY_PROVIDER', false);
    // Sessionless: Graph persists a sessionless change, and one PATCH needs no session to hold.
    // A null cell is left as it is, as Graph's range update defines it.
    const response = await writer.commit('PATCH', rangePath(base, payload.worksheet, address), {
      values: payload.values,
    });
    return answerOf(response, payload.item_id);
  },
  async reconcile(reader, payload) {
    const address = bareAddress(payload.range, payload.worksheet);
    if (address === null) return { answer: 'cannot_answer' };
    const base = driveItemBase(reader.context.config, payload.drive_id, payload.item_id);
    if (!base) return { answer: 'cannot_answer' };
    const data = await reader.json(
      `${rangePath(base, payload.worksheet, address)}${queryOf([['$select', 'values,formulas']])}`,
    );
    // Formulas hold what was typed: a constant as itself, a formula as its text. A null asked for no
    // change, so it is not compared.
    const formulas = listOf(data.formulas, 1000);
    const matches = payload.values.every((row, r) => {
      const have = listOf(formulas[r], 1000);
      return row.every((cell, c) => {
        if (cell === null) return true;
        const value = have[c];
        if (typeof cell === 'boolean') return String(value).toLowerCase() === String(cell);
        if (typeof cell === 'number') return Number(value) === cell;
        return String(value ?? '') === cell;
      });
    });
    return matches ? { answer: 'found', externalId: payload.item_id } : { answer: 'cannot_answer' };
  },
});

// --- Teams.

export const teamsPostMessage = actionTool('teams.post_message', {
  async send(writer, payload) {
    const response = await writer.commit(
      'POST',
      `/v1.0/teams/${segment(payload.team_id)}/channels/${segment(payload.channel_id)}/messages`,
      {
        ...(payload.subject !== undefined ? { subject: payload.subject } : {}),
        body: { contentType: 'text', content: payload.text_body },
      },
    );
    return answerOf(response, createdId(response));
  },
  async reconcile() {
    // A channel message takes no key of ours, and reading the channel back needs a scope this tool
    // does not ask for (ChannelMessage.Send only). There is nothing to look up that could be believed.
    return { answer: 'cannot_answer' };
  },
});

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
