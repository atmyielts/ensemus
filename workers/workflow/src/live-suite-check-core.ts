// The logic of the operator's live suite check (live-suite-check.ts), apart from PostgreSQL, the broker and
// the network, so its guards and its output can be tested on their own.
//
// A WIRE-FORMAT CHECK, NOT A PRODUCT PATH. It calls the suite tools' handlers directly, through the same
// createSuiteToolDispatch, runSend and runReconcile the connector worker uses, and so bypasses agents,
// proposals, approvals and the intent ledger on purpose. It exists to run once against a dedicated test
// tenant holding only generated data, and refuses any connection whose name does not start with "TEST ".
//
// Output is one line per check and the same as JSON: the tool, the step, a fixed outcome code, the HTTP
// status classes the provider answered with, an item count and a byte count. Never a subject, a name, an
// address, a provider ID or any content: what a handler returns is counted and dropped. For a read the
// bytes are its output's size; for a change or a reconcile, the size of the provider's answers.
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { providerIdSchema } from '@ensemus/contracts/suite-tools';
import type { ActionRequest, ConnectorContext } from '@ensemus/connectors';
import type { ProviderHttpClient, ProviderRoute } from '@ensemus/connectors/knowledge';
import { runReconcile, runSend } from '@ensemus/connectors/runtime';
import {
  hasDirectory,
  type SuiteCapableConnector,
  type SuiteReadContext,
  type SuiteReadResult,
  type SuiteResourceAccess,
} from '@ensemus/connectors/suites';
import { toolManifest } from '@ensemus/domain/ai-tools';
import { isSuiteConnectorType } from '@ensemus/domain/workspace-suites';
import { errorCode } from '@ensemus/telemetry';

export const LIVE_CHECK_ENV = 'ENSEMUS_LIVE_CHECK';
/** Only a connection named like this is ever touched. */
export const TEST_NAME_PREFIX = 'TEST ';
/** What a generated query, title and subject start with, so a test tenant's leftovers are easy to find. */
export const LIVE_CHECK_TAG = 'ensemus-live-check';

export const LIVE_CHECK_HEADER =
  'ensemus live suite check: operator-only wire-format check for test tenants. It calls suite tools ' +
  'directly and bypasses agents, approvals and intents on purpose. It is not a product path.';

export const LIVE_CHECK_USAGE = [
  'Usage: ENSEMUS_LIVE_CHECK=1 node dist/live-suite-check.js --organization <uuid> --connection <uuid>',
  '         [--out <file.json>] [--directory]',
  '         [--doc <id>] [--sheet <id> --range A1:C3] [--word <drive>:<item>]',
  '         [--workbook <drive>:<item> --range A1:C3 [--worksheet Sheet1]]',
  '         [--writes --self <own address> [--send-to-self] [--teams <team>:<channel>]]',
  'The connection must be active and its name must start with "TEST ".',
  '',
].join('\n');

// --- Arguments.

type DriveItem = { driveId: string; itemId: string };

export type LiveCheckOptions = {
  organizationId: string;
  connectionId: string;
  out: string | null;
  directory: boolean;
  writes: boolean;
  sendToSelf: boolean;
  /** The connected account's own address. The credential holds no identity, so the operator gives it. */
  self: string | null;
  doc: string | null;
  sheet: string | null;
  range: string | null;
  word: DriveItem | null;
  workbook: DriveItem | null;
  worksheet: string;
  teams: { teamId: string; channelId: string } | null;
};

export type ParsedLiveCheckArgs =
  { ok: true; options: LiveCheckOptions } | { ok: false; code: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A plain address. The tool's own schema checks it again before anything is sent. */
const ADDRESS = /^[^\s@<>,;:"()[\]\\]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const WORKSHEET = /^[^\r\n\0]{1,31}$/;
const matches = (pattern: RegExp, value: string | undefined): value is string =>
  value !== undefined && pattern.test(value);
/** The most cells a write fills, so a mistyped range cannot overwrite a sheet. */
const MAX_CELLS = 100;

/** `a:b`, split at the first colon. Teams channel IDs hold colons; team, drive and item IDs do not. */
function pairOf(value: string | undefined): [string, string] | null | undefined {
  if (value === undefined) return undefined;
  const at = value.indexOf(':');
  if (at < 1 || at === value.length - 1) return null;
  const first = value.slice(0, at);
  const second = value.slice(at + 1);
  if (!providerIdSchema.safeParse(first).success || !providerIdSchema.safeParse(second).success)
    return null;
  return [first, second];
}

const columnNumber = (letters: string) =>
  [...letters.toUpperCase()].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);

/**
 * The rows and columns of a bounded A1 range, with or without its sheet, or null for an open range such as
 * `A:A`, a reversed one, or one larger than MAX_CELLS.
 */
export function rangeDimensions(range: string): { rows: number; cols: number } | null {
  const bang = range.lastIndexOf('!');
  const cells = bang === -1 ? range : range.slice(bang + 1);
  if (bang !== -1 && !/^(?:'[^'\r\n]{1,100}'|[A-Za-z0-9_]{1,100})$/.test(range.slice(0, bang)))
    return null;
  const match = /^([A-Za-z]{1,3})(\d{1,7})(?::([A-Za-z]{1,3})(\d{1,7}))?$/.exec(cells);
  if (!match) return null;
  const [, c1, r1, c2 = c1, r2 = r1] = match as unknown as [string, string, string, string, string];
  const rows = Number(r2) - Number(r1) + 1;
  const cols = columnNumber(c2) - columnNumber(c1) + 1;
  if (Number(r1) < 1 || rows < 1 || cols < 1 || rows * cols > MAX_CELLS) return null;
  return { rows, cols };
}

export function parseLiveCheckArgs(argv: readonly string[]): ParsedLiveCheckArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        organization: { type: 'string' },
        connection: { type: 'string' },
        out: { type: 'string' },
        directory: { type: 'boolean' },
        writes: { type: 'boolean' },
        'send-to-self': { type: 'boolean' },
        self: { type: 'string' },
        doc: { type: 'string' },
        sheet: { type: 'string' },
        range: { type: 'string' },
        word: { type: 'string' },
        workbook: { type: 'string' },
        worksheet: { type: 'string' },
        teams: { type: 'string' },
      },
    }));
  } catch {
    return { ok: false, code: 'ARGS_INVALID' };
  }
  if (!matches(UUID, values.organization)) return { ok: false, code: 'ORGANIZATION_INVALID' };
  if (!matches(UUID, values.connection)) return { ok: false, code: 'CONNECTION_INVALID' };
  if (values.out !== undefined && !/^[^\0\r\n]{1,1024}$/.test(values.out))
    return { ok: false, code: 'OUT_INVALID' };

  const writes = values.writes === true;
  const sendToSelf = values['send-to-self'] === true;
  if (sendToSelf && !writes) return { ok: false, code: 'SEND_TO_SELF_NEEDS_WRITES' };
  if (values.teams !== undefined && !writes) return { ok: false, code: 'TEAMS_NEEDS_WRITES' };
  if (values.self !== undefined && (values.self.length > 254 || !matches(ADDRESS, values.self)))
    return { ok: false, code: 'SELF_INVALID' };
  if (writes && values.self === undefined) return { ok: false, code: 'SELF_REQUIRED' };

  for (const id of [values.doc, values.sheet]) {
    if (id !== undefined && !providerIdSchema.safeParse(id).success)
      return { ok: false, code: 'ID_INVALID' };
  }
  const word = pairOf(values.word);
  const workbook = pairOf(values.workbook);
  const teams = pairOf(values.teams);
  if (word === null || workbook === null) return { ok: false, code: 'DRIVE_ITEM_INVALID' };
  if (teams === null) return { ok: false, code: 'TEAMS_INVALID' };
  const needsRange = values.sheet !== undefined || workbook !== undefined;
  if (needsRange && values.range === undefined) return { ok: false, code: 'RANGE_REQUIRED' };
  if (values.range !== undefined && !rangeDimensions(values.range))
    return { ok: false, code: 'RANGE_INVALID' };
  if (values.worksheet !== undefined && !matches(WORKSHEET, values.worksheet))
    return { ok: false, code: 'WORKSHEET_INVALID' };

  return {
    ok: true,
    options: {
      organizationId: values.organization as string,
      connectionId: values.connection as string,
      out: values.out ?? null,
      directory: values.directory === true,
      writes,
      sendToSelf,
      self: values.self ?? null,
      doc: values.doc ?? null,
      sheet: values.sheet ?? null,
      range: values.range ?? null,
      word: word ? { driveId: word[0], itemId: word[1] } : null,
      workbook: workbook ? { driveId: workbook[0], itemId: workbook[1] } : null,
      worksheet: values.worksheet ?? 'Sheet1',
      teams: teams ? { teamId: teams[0], channelId: teams[1] } : null,
    },
  };
}

// --- Guards.

/** The first guard, asked before anything is opened: the operator set ENSEMUS_LIVE_CHECK=1 on purpose. */
export const liveCheckEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env[LIVE_CHECK_ENV] === '1';

export type LiveCheckTarget = {
  displayName: string;
  state: string;
  connectorType: string;
  credentialSecretId: string | null;
};

/** Why this connection may not be checked, or null. A name not starting "TEST " is always refused. */
export function connectionRefusal(connection: LiveCheckTarget | null): string | null {
  if (!connection) return 'CONNECTION_NOT_FOUND';
  if (!connection.displayName.startsWith(TEST_NAME_PREFIX)) return 'CONNECTION_NOT_TEST';
  if (!isSuiteConnectorType(connection.connectorType)) return 'CONNECTOR_NOT_SUITE';
  if (connection.state !== 'active') return 'CONNECTION_NOT_ACTIVE';
  if (!connection.credentialSecretId) return 'CREDENTIAL_UNAVAILABLE';
  return null;
}

/** An option that names another provider's tool, which would otherwise be skipped without a word. */
export function optionRefusal(options: LiveCheckOptions, connectorType: string): string | null {
  const google = connectorType === 'google_workspace';
  if (google && (options.word || options.workbook || options.teams))
    return 'OPTION_NOT_FOR_PROVIDER';
  if (!google && (options.doc || options.sheet)) return 'OPTION_NOT_FOR_PROVIDER';
  return null;
}

// --- What the provider answered, by status class only.

const TOKEN_ROUTES: ReadonlySet<ProviderRoute> = new Set(['google_oauth', 'ms_login']);

/**
 * The HTTP client with a tally beside it: the status class of each answer from a tool's own routes (a
 * token refresh is left out) and how many bytes came back. Bodies are counted, never kept.
 */
export function recordingHttp(inner: ProviderHttpClient) {
  let classes: string[] = [];
  let bytes = 0;
  const note = (value: string) => {
    if (classes.at(-1) !== value) classes.push(value);
  };
  const http: ProviderHttpClient = {
    async request(request) {
      if (TOKEN_ROUTES.has(request.route)) return inner.request(request);
      try {
        const response = await inner.request(request);
        note(`${Math.floor(response.status / 100)}xx`);
        bytes += response.body.length;
        return response;
      } catch (error) {
        note('net');
        throw error;
      }
    },
    ...(inner.download ? { download: inner.download.bind(inner) } : {}),
  };
  return {
    http,
    /** What was seen since the last take, and starts again. */
    take(): { status: string | null; bytes: number } {
      const seen = { status: classes.length ? classes.join('+') : null, bytes };
      classes = [];
      bytes = 0;
      return seen;
    },
  };
}

// --- Records.

export type CheckStep = 'read' | 'send' | 'resend_same_key' | 'reconcile' | 'idempotency' | 'skip';

/** One check. These fields and no others, each a fixed code or a number. */
export type CheckRecord = {
  tool: string;
  step: CheckStep;
  outcome: string;
  status: string | null;
  items: number | null;
  bytes: number | null;
  failed: boolean;
};

export const CHECK_FIELDS = [
  'tool',
  'step',
  'outcome',
  'status',
  'items',
  'bytes',
  'failed',
] as const;

export type DirectoryRecord = {
  outcome: string;
  status: string | null;
  pages: number;
  groups: number;
  /** Distinct user members across every group. */
  members: number;
  /** Group-in-group memberships. */
  nested: number;
  /** Of `members`, how many match an active membership in this tenant. */
  matched: number;
  failed: boolean;
};

export const DIRECTORY_FIELDS = [
  'outcome',
  'status',
  'pages',
  'groups',
  'members',
  'nested',
  'matched',
  'failed',
] as const;

export type LiveCheckReport = {
  header: string;
  connectorType: string;
  ownerKind: 'organization' | 'member';
  access: string;
  checks: CheckRecord[];
  directory: DirectoryRecord | null;
  failures: number;
};

/** A code as it may be printed: capitals, digits, underscores, colons. Anything else is UNKNOWN. */
const safeCode = (value: string) => (/^[A-Za-z0-9_:]{1,80}$/.test(value) ? value : 'UNKNOWN');

export function formatCheckLine(record: CheckRecord): string {
  return [
    record.tool,
    record.step,
    `outcome=${safeCode(record.outcome)}`,
    `status=${record.status ?? '-'}`,
    `items=${record.items ?? '-'}`,
    `bytes=${record.bytes ?? '-'}`,
    record.failed ? 'FAILED' : '',
  ]
    .join(' ')
    .trimEnd();
}

export function formatDirectoryLine(record: DirectoryRecord): string {
  return [
    'directory read',
    `outcome=${safeCode(record.outcome)}`,
    `status=${record.status ?? '-'}`,
    `pages=${record.pages}`,
    `groups=${record.groups}`,
    `members=${record.members}`,
    `nested=${record.nested}`,
    `matched=${record.matched}`,
    record.failed ? 'FAILED' : '',
  ]
    .join(' ')
    .trimEnd();
}

/**
 * How many things an output holds: the length of its first top-level list (messages, events, files,
 * rows), else one. Read in memory and dropped.
 */
export function itemCount(result: SuiteReadResult): number {
  if (result.mediaType !== 'application/json') return 1;
  try {
    const value: unknown = JSON.parse(result.bytes.toString('utf8'));
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === 'object') {
      const list = Object.values(value).find(Array.isArray);
      return list ? list.length : 1;
    }
  } catch {
    // Counted as one: the output was collected, whatever it holds.
  }
  return 1;
}

/** One field of an output, for a later step only (a thread to read, a revision to edit against). */
function fieldOf(result: SuiteReadResult | null, read: (value: never) => unknown): unknown {
  if (!result || result.mediaType !== 'application/json') return undefined;
  try {
    return read(JSON.parse(result.bytes.toString('utf8')) as never);
  } catch {
    return undefined;
  }
}

// --- The run.

type DocumentHead = { revision_id?: unknown; text?: unknown; truncated?: unknown };

export type LiveCheckPorts = {
  connector: SuiteCapableConnector;
  /** A fresh context for each read, with its own deadline, on the run's one credential lease. */
  readContext(): SuiteReadContext;
  /** The same for a change, which runSend and runReconcile give their own deadline. */
  actionContext(): Omit<ConnectorContext, 'signal'>;
  /** For the organization's connection: as for an administrator who may read everything synced. */
  access: SuiteResourceAccess | null;
  /** How many of these addresses match an active membership here. */
  matchDirectoryEmails(emails: readonly string[]): Promise<number>;
  /** The status tally of recordingHttp. */
  take(): { status: string | null; bytes: number };
  write(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): Date;
  /** A short random token, for titles and values. */
  token(): string;
  uuid(): string;
};

const MAIL_BODY = 'Ensemus live check. Generated test content on a test tenant; safe to delete.';
/** Mail search indexes lag, so a mail's reconcile asks a few times before it says not found. */
const MAIL_RECONCILE_TRIES = 4;
const MAIL_RECONCILE_GAP_MS = 5_000;
const MAX_DIRECTORY_PAGES = 500;

type Expect = { answers: readonly string[]; tries: number };
const FOUND: Expect = { answers: ['found'], tries: 1 };

export async function runLiveSuiteCheck(
  options: LiveCheckOptions,
  connection: { connectorType: string; ownerKind: 'organization' | 'member' },
  ports: LiveCheckPorts,
): Promise<LiveCheckReport> {
  const { connector } = ports;
  const google = connection.connectorType === 'google_workspace';
  const checks: CheckRecord[] = [];
  const access =
    connection.ownerKind === 'organization'
      ? "access: organization's connection; search results filtered as for an administrator who may read everything synced"
      : "access: a member's own connection; nothing filtered, as in the product";
  ports.write(LIVE_CHECK_HEADER);
  ports.write(`provider: ${connection.connectorType}`);
  ports.write(access);

  const record = (entry: CheckRecord) => {
    checks.push(entry);
    ports.write(formatCheckLine(entry));
  };
  const skip = (tool: string, outcome: string) =>
    record({ tool, step: 'skip', outcome, status: null, items: null, bytes: null, failed: false });
  const versionOf = (tool: string) => toolManifest(tool)?.version ?? '';

  async function read(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<SuiteReadResult | null> {
    ports.take();
    try {
      const output = await connector.suiteReads.read(
        ports.readContext(),
        { id: tool, version: versionOf(tool) },
        { connection_id: options.connectionId, ...args },
        ports.access,
      );
      const seen = ports.take();
      record({
        tool,
        step: 'read',
        outcome: 'ok',
        status: seen.status,
        items: itemCount(output),
        bytes: output.bytes.length,
        failed: false,
      });
      return output;
    } catch (error) {
      const seen = ports.take();
      record({
        tool,
        step: 'read',
        outcome: errorCode(error),
        status: seen.status,
        items: null,
        bytes: null,
        failed: true,
      });
      return null;
    }
  }

  const requestFor = (tool: string, payload: Record<string, unknown>): ActionRequest => ({
    // A synthetic intent: no row anywhere holds it.
    externalActionId: ports.uuid(),
    attemptId: ports.uuid(),
    attemptNo: 1,
    toolName: tool,
    toolVersion: versionOf(tool),
    idempotencyKey: `live-check-${ports.uuid()}`,
    requestHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    payload,
  });

  async function send(request: ActionRequest, step: CheckStep) {
    ports.take();
    const sent = await runSend({ connector, context: ports.actionContext(), request });
    const seen = ports.take();
    const accepted = sent.outcome === 'accepted';
    record({
      tool: request.toolName,
      step,
      outcome: accepted ? 'ok' : `${sent.outcome}:${sent.code}`,
      status: seen.status,
      items: sent.externalId ? 1 : 0,
      bytes: seen.bytes,
      failed: !accepted,
    });
    return sent;
  }

  async function reconcile(request: ActionRequest, expect: Expect) {
    ports.take();
    let answer = 'cannot_answer';
    for (let attempt = 0; attempt < expect.tries; attempt++) {
      if (attempt > 0) await ports.sleep(MAIL_RECONCILE_GAP_MS);
      answer = (await runReconcile({ connector, context: ports.actionContext(), request })).answer;
      if (answer === 'found') break;
    }
    const seen = ports.take();
    record({
      tool: request.toolName,
      step: 'reconcile',
      outcome: answer,
      status: seen.status,
      items: answer === 'found' ? 1 : 0,
      bytes: seen.bytes,
      failed: !expect.answers.includes(answer),
    });
  }

  /**
   * One change, as the worker's gateway makes it, then asked about. Null when nothing went out or the
   * provider said no. With `expect` null the caller asks itself, after whatever else it sends first.
   */
  async function change(tool: string, payload: Record<string, unknown>, expect: Expect | null) {
    if (!connector.actions || !connector.manifest.capabilities.actions.includes(tool)) {
      record({
        tool,
        step: 'send',
        outcome: 'CONNECTOR_UNAVAILABLE',
        status: null,
        items: null,
        bytes: null,
        failed: true,
      });
      return null;
    }
    const request = requestFor(tool, payload);
    const sent = await send(request, 'send');
    // Nothing went out, or the provider said no: there is nothing to ask about.
    if (sent.outcome === 'not_sent' || sent.outcome === 'rejected') return null;
    if (expect) await reconcile(request, expect);
    return { request, sent };
  }

  // Reads, every one this provider has, with conservative arguments.
  const now = ports.now();
  const mail = await read(google ? 'gmail.search' : 'outlook.search', {
    query: LIVE_CHECK_TAG,
    max_results: 5,
  });
  const thread = fieldOf(
    mail,
    (value: { messages?: { thread_id?: unknown; conversation_id?: unknown }[] }) =>
      google ? value.messages?.[0]?.thread_id : value.messages?.[0]?.conversation_id,
  );
  const threadTool = google ? 'gmail.read_thread' : 'outlook.read_thread';
  if (typeof thread === 'string') {
    await read(threadTool, google ? { thread_id: thread } : { conversation_id: thread });
  } else {
    skip(threadTool, 'SKIPPED_NO_THREAD');
  }
  await read('calendar.list_events', {
    calendar_id: 'primary',
    time_min: now.toISOString(),
    time_max: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    max_results: 25,
  });
  await read(google ? 'drive.search' : 'onedrive.search', {
    query: LIVE_CHECK_TAG,
    max_results: 10,
  });
  const document = options.doc ? await read('docs.read', { document_id: options.doc }) : null;
  if (options.sheet && options.range)
    await read('sheets.read_range', { spreadsheet_id: options.sheet, range: options.range });
  if (options.word)
    await read('word.read', { drive_id: options.word.driveId, item_id: options.word.itemId });
  if (options.workbook && options.range)
    await read('excel.read_range', {
      drive_id: options.workbook.driveId,
      item_id: options.workbook.itemId,
      worksheet: options.worksheet,
      range: options.range,
    });

  // One directory pass, read only: nothing is committed, and only counts come out.
  let directory: DirectoryRecord | null = null;
  if (options.directory) directory = await readDirectory(ports);

  if (options.writes && options.self) {
    const tag = `${LIVE_CHECK_TAG} ${ports.token()}`;
    const message = { to: [options.self], subject: tag, text_body: MAIL_BODY };
    await change(
      google ? 'gmail.create_draft' : 'outlook.create_draft',
      { message },
      {
        answers: ['found'],
        tries: MAIL_RECONCILE_TRIES,
      },
    );

    // An event with nobody invited, an hour from now. Graph tells attendees of any event it makes, and
    // has nobody to tell here, so `all` is the only setting it takes.
    const start = new Date(Math.ceil((now.getTime() + 3_600_000) / 60_000) * 60_000);
    const sendUpdates = google ? 'none' : 'all';
    const created = await change(
      'calendar.create_event',
      {
        calendar_id: 'primary',
        summary: tag,
        start: start.toISOString(),
        end: new Date(start.getTime() + 1_800_000).toISOString(),
        time_zone: 'UTC',
        attendees: [],
        send_updates: sendUpdates,
      },
      // Asked once both attempts are in, below.
      null,
    );
    if (created) {
      // The same intent's second attempt, with the same key: it must not make a second event.
      const again = await send(
        { ...created.request, attemptId: ports.uuid(), attemptNo: 2 },
        'resend_same_key',
      );
      const first = created.sent.externalId;
      const second = again.externalId;
      const outcome =
        first && second ? (first === second ? 'no_duplicate' : 'duplicate') : 'cannot_tell';
      record({
        tool: 'calendar.create_event',
        step: 'idempotency',
        outcome,
        status: null,
        items: null,
        bytes: null,
        failed: outcome !== 'no_duplicate',
      });
      await reconcile(created.request, FOUND);
      if (first) {
        await change(
          'calendar.update_event',
          {
            calendar_id: 'primary',
            event_id: first,
            send_updates: sendUpdates,
            changes: { summary: `${tag} updated` },
          },
          FOUND,
        );
      } else {
        skip('calendar.update_event', 'SKIPPED_NO_EVENT_ID');
      }
    } else {
      skip('calendar.update_event', 'SKIPPED_NO_EVENT');
    }

    if (google && options.doc) {
      // The revision the read above saw, as a model's edit names the one it read.
      const head = fieldOf(document, (value: DocumentHead) => value) as DocumentHead | undefined;
      if (typeof head?.revision_id === 'string') {
        // At the end of the body: before the last paragraph's own line end, which Docs counts in UTF-16
        // units from 1, as JavaScript does. A document cut short, or odd, takes the line at the start.
        const text = typeof head.text === 'string' ? head.text : '';
        const index =
          head.truncated === false && text.endsWith('\n') ? Math.max(1, text.length) : 1;
        await change(
          'docs.edit',
          {
            document_id: options.doc,
            required_revision_id: head.revision_id,
            edits: [{ kind: 'insert_text', index, text: `\n${tag}` }],
          },
          // Docs moves the revision on with the edit, so all a reconcile can say then is that it cannot.
          { answers: ['cannot_answer'], tries: 1 },
        );
      } else {
        skip('docs.edit', 'SKIPPED_NO_REVISION');
      }
    }
    const cells = options.range ? rangeDimensions(options.range) : null;
    const values = cells
      ? Array.from({ length: cells.rows }, (_, row) =>
          Array.from({ length: cells.cols }, (_, col) => `${tag} r${row + 1}c${col + 1}`),
        )
      : null;
    if (google && options.sheet && options.range && values) {
      await change(
        'sheets.write_range',
        { spreadsheet_id: options.sheet, range: options.range, values, value_input: 'raw' },
        FOUND,
      );
    }
    if (!google && options.workbook && options.range && values) {
      await change(
        'excel.write_range',
        {
          drive_id: options.workbook.driveId,
          item_id: options.workbook.itemId,
          worksheet: options.worksheet,
          range: options.range,
          values,
        },
        FOUND,
      );
    }
    if (!google && options.teams) {
      await change(
        'teams.post_message',
        {
          team_id: options.teams.teamId,
          channel_id: options.teams.channelId,
          subject: tag,
          text_body: MAIL_BODY,
        },
        // A channel message takes no key of ours, so a reconcile cannot say, by design.
        { answers: ['cannot_answer'], tries: 1 },
      );
    }
    if (options.sendToSelf) {
      // The question this asks: does the provider keep our Message-ID, so a reconcile finds the mail?
      // Each answer is the result, so none of them fails the run.
      await change(
        google ? 'gmail.send' : 'outlook.send',
        { message },
        {
          answers: ['found', 'not_found', 'cannot_answer'],
          tries: MAIL_RECONCILE_TRIES,
        },
      );
    }
  }

  const failures = checks.filter((check) => check.failed).length + (directory?.failed ? 1 : 0);
  ports.write(`failures: ${failures}`);
  return {
    header: LIVE_CHECK_HEADER,
    connectorType: connection.connectorType,
    ownerKind: connection.ownerKind,
    access,
    checks,
    directory,
    failures,
  };
}

async function readDirectory(ports: LiveCheckPorts): Promise<DirectoryRecord> {
  const { connector } = ports;
  const empty = { pages: 0, groups: 0, members: 0, nested: 0, matched: 0 };
  if (!hasDirectory(connector)) {
    const result = { outcome: 'NOT_AVAILABLE', status: null, ...empty, failed: true };
    ports.write(formatDirectoryLine(result));
    return result;
  }
  ports.take();
  const groups = new Set<string>();
  const people = new Set<string>();
  let nested = 0;
  let pages = 0;
  let result: DirectoryRecord;
  try {
    let cursor: string | null = null;
    let more = true;
    while (more && pages < MAX_DIRECTORY_PAGES) {
      const page = await connector.directory.readGroups(ports.readContext(), cursor);
      pages++;
      for (const group of page.groups) {
        groups.add(group.externalId);
        for (const member of group.members) {
          if (member.kind === 'user') people.add(member.externalId.trim().toLowerCase());
          else nested++;
        }
      }
      cursor = page.nextCursor;
      more = page.hasMore;
    }
    const matched = await ports.matchDirectoryEmails([...people]);
    result = {
      outcome: more ? 'PAGE_LIMIT' : 'ok',
      status: ports.take().status,
      pages,
      groups: groups.size,
      members: people.size,
      nested,
      matched,
      failed: more,
    };
  } catch (error) {
    result = {
      outcome: errorCode(error),
      status: ports.take().status,
      ...empty,
      pages,
      failed: true,
    };
  }
  ports.write(formatDirectoryLine(result));
  return result;
}
