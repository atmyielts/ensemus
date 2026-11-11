// Microsoft 365's suite tools against a fake Graph. Every value is generated, every address is under
// example.invalid, and no real tenant, client or token is used. Wire shapes are unqualified until a live run.
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SyncUnavailable,
  type ActionRequest,
  type Connector,
  type ConnectorContext,
} from '../index';
import {
  ProviderHttpFailed,
  type ProviderHttpClient,
  type ProviderRequest,
  type ProviderResponse,
} from '../knowledge';
import { MICROSOFT_365_MANIFEST } from '../knowledge-manifests';
import { runReconcile, runSend } from '../runtime/actions';
import {
  createSuiteToolDispatch,
  SuiteReadRefused,
  type SuiteConnectionOwner,
  type SuiteResourceAccess,
} from '../suites';
import {
  clipText,
  driveResourceId,
  htmlToText,
  MICROSOFT_ACTION_HANDLERS,
  MICROSOFT_READ_HANDLERS,
  TRUNCATION_MARKER,
  wallTime,
  type MicrosoftToolDeps,
} from './tools';

// --- Fakes.

const ORGANIZATION = '00000000-0000-4000-8000-0000000000a1';
const CONNECTION = '00000000-0000-4000-8000-0000000000a2';
const ACTION_ID = '00000000-0000-4000-8000-0000000000b1';
const KEY = `ensemus-${ACTION_ID}`;
const MESSAGE_ID = `<${KEY}@ensemus.invalid>`;
const ALL_SCOPES = [
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.ReadWrite',
  'Files.Read.All',
  'Files.ReadWrite',
  'ChannelMessage.Send',
];

type Route = (request: ProviderRequest) => ProviderResponse | Promise<ProviderResponse> | undefined;

const json = (body: unknown, status = 200): ProviderResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});
const empty = (status: number, headers: Record<string, string> = {}): ProviderResponse => ({
  status,
  headers,
  body: Buffer.alloc(0),
});
const PROVIDER_TEXT = 'generated provider error text that must never leave';
const failure = (status: number) => json({ error: { message: PROVIDER_TEXT } }, status);

function fakeGraph(...routes: Route[]) {
  const calls: ProviderRequest[] = [];
  const http: ProviderHttpClient = {
    async request(request) {
      calls.push(request);
      expect(request.route).toBe('ms_graph');
      for (const route of routes) {
        const answer = await route(request);
        if (answer) return answer;
      }
      return failure(404);
    },
  };
  return { http, calls };
}

const on =
  (
    method: ProviderRequest['method'],
    match: string | RegExp,
    answer: (r: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>,
  ): Route =>
  (request) =>
    request.method === method &&
    (typeof match === 'string' ? request.path === match : match.test(request.path))
      ? answer(request)
      : undefined;

/** Mimics the real withToken: an error it does not know becomes PROVIDER_UNAVAILABLE. */
function depsFor(
  http: ProviderHttpClient,
  extra: Partial<MicrosoftToolDeps> = {},
): MicrosoftToolDeps {
  return {
    http,
    async withToken(_context, use) {
      try {
        return await use('generated-access-token');
      } catch (error) {
        throw error instanceof SyncUnavailable
          ? error
          : new SyncUnavailable('PROVIDER_UNAVAILABLE');
      }
    },
    messageIdDomain: 'ensemus.invalid',
    ...extra,
  };
}

/** Null means the row recorded no scopes at all. */
const contextFor = (
  scopes: readonly string[] | null = ALL_SCOPES,
  config: unknown = { driveIds: [] },
): ConnectorContext => ({
  organizationId: ORGANIZATION,
  connectionId: CONNECTION,
  config,
  ...(scopes ? { grantedScopes: scopes } : {}),
  signal: new AbortController().signal,
  credentials: { withCredential: async () => Promise.reject(new Error('NOT_USED')) },
  network: { openRelay: async () => Promise.reject(new Error('NO_NETWORK')) },
});

const toolsFor = (deps: MicrosoftToolDeps) =>
  createSuiteToolDispatch({
    deps,
    connectorType: 'microsoft_365',
    reads: MICROSOFT_READ_HANDLERS,
    actions: MICROSOFT_ACTION_HANDLERS,
  });

const read = (
  deps: MicrosoftToolDeps,
  id: string,
  args: Record<string, unknown>,
  options: {
    scopes?: readonly string[];
    config?: unknown;
    access?: SuiteResourceAccess | null;
    ownerKind?: SuiteConnectionOwner;
  } = {},
) =>
  toolsFor(deps).suiteReads.read(
    {
      ...contextFor(options.scopes ?? ALL_SCOPES, options.config ?? { driveIds: [] }),
      ownerKind: options.ownerKind ?? 'organization',
    },
    { id, version: '1' },
    { connection_id: CONNECTION, ...args },
    options.access ?? null,
  );

/** Parsed test output, read loosely: each test states the exact shape it expects. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
const outputOf = (bytes: Buffer) => JSON.parse(bytes.toString('utf8')) as Loose;

const requestFor = (
  toolName: string,
  payload: unknown,
  overrides: Partial<ActionRequest> = {},
): ActionRequest => ({
  externalActionId: ACTION_ID,
  attemptId: '00000000-0000-4000-8000-0000000000b2',
  attemptNo: 1,
  toolName,
  toolVersion: '1',
  idempotencyKey: KEY,
  requestHash: 'generated-request-hash',
  payload,
  ...overrides,
});

const connectorFor = (deps: MicrosoftToolDeps): Connector => ({
  manifest: MICROSOFT_365_MANIFEST,
  parseConfig: (raw) => raw,
  actions: toolsFor(deps).actions,
});

const send = (
  deps: MicrosoftToolDeps,
  toolName: string,
  payload: unknown,
  options: {
    scopes?: readonly string[] | null;
    config?: unknown;
    request?: Partial<ActionRequest>;
    deadlineMs?: number;
  } = {},
) => {
  const { signal: _signal, ...context } = contextFor(
    options.scopes === undefined ? ALL_SCOPES : options.scopes,
    options.config ?? { driveIds: [] },
  );
  return runSend({
    connector: connectorFor(deps),
    context,
    request: requestFor(toolName, payload, options.request),
    ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
  });
};

const reconcile = (
  deps: MicrosoftToolDeps,
  toolName: string,
  payload: unknown,
  options: { scopes?: readonly string[]; config?: unknown } = {},
) => {
  const { signal: _signal, ...context } = contextFor(
    options.scopes ?? ALL_SCOPES,
    options.config ?? { driveIds: [] },
  );
  return runReconcile({
    connector: connectorFor(deps),
    context,
    request: requestFor(toolName, payload),
  });
};

const bodyOf = (request: ProviderRequest | undefined) =>
  JSON.parse(request?.body?.toString('utf8') ?? 'null') as Loose;

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).message).not.toContain(PROVIDER_TEXT);
    if (error instanceof SuiteReadRefused) return `refused:${error.code}`;
    if (error instanceof SyncUnavailable) return `unavailable:${error.code}`;
    return `other:${(error as Error).name}`;
  }
  return 'ok';
}

function zipOf(entries: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = deflateRawSync(content);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// --- Payloads, every one generated.

const mail = {
  message: {
    to: ['recipient@example.invalid'],
    cc: ['copy@example.invalid'],
    subject: 'Generated subject',
    text_body: 'Generated body text.',
  },
};
const newEvent = {
  calendar_id: 'primary',
  summary: 'Generated meeting',
  description: 'Generated agenda',
  location: 'Generated room',
  start: '2026-11-12T14:00:00Z',
  end: '2026-11-12T15:00:00Z',
  time_zone: 'America/New_York',
  attendees: ['guest@example.invalid'],
  send_updates: 'all',
};
const eventChange = {
  calendar_id: 'generated_calendar',
  event_id: 'generated_event',
  send_updates: 'all',
  changes: {
    summary: 'Generated new title',
    start: '2026-11-13T09:00:00Z',
    end: '2026-11-13T10:00:00Z',
    attendees: ['guest@example.invalid'],
  },
};
const newFile = { name: 'Generated note.txt', media_type: 'text/plain', text: 'Generated text.' };
const rangeWrite = {
  drive_id: 'generated_drive',
  item_id: 'generated_item',
  worksheet: 'Sheet1',
  range: 'A1:C1',
  values: [['generated', 42, null]],
};
const channelPost = {
  team_id: 'generated-team',
  channel_id: '19:generated@thread.tacv2',
  subject: 'Generated subject',
  text_body: 'Generated message.',
};

/** For each change: its payload, a payload its schema refuses, and how to spot its commit request. */
const ACTIONS: {
  tool: string;
  payload: unknown;
  broken: unknown;
  commit: (request: ProviderRequest) => boolean;
  prepare?: Route;
}[] = [
  {
    tool: 'outlook.create_draft',
    payload: mail,
    broken: { message: { ...mail.message, subject: 'Injected\r\nBcc: x@example.invalid' } },
    commit: (r) => r.method === 'POST' && r.path === '/v1.0/me/messages',
  },
  {
    tool: 'outlook.send',
    payload: mail,
    broken: { message: { ...mail.message, to: [] } },
    commit: (r) => r.method === 'POST' && r.path.endsWith('/send'),
    prepare: on('POST', '/v1.0/me/messages', () => json({ id: 'generated_draft' }, 201)),
  },
  {
    tool: 'calendar.create_event',
    payload: newEvent,
    broken: { ...newEvent, end: '2026-11-12T13:00:00Z' },
    commit: (r) => r.method === 'POST',
  },
  {
    tool: 'calendar.update_event',
    payload: eventChange,
    broken: { ...eventChange, changes: {} },
    commit: (r) => r.method === 'PATCH',
  },
  {
    tool: 'onedrive.create_file',
    payload: newFile,
    broken: { ...newFile, name: 'nested/name.txt' },
    commit: (r) => r.method === 'PUT',
  },
  {
    tool: 'excel.write_range',
    payload: rangeWrite,
    broken: { ...rangeWrite, values: [] },
    commit: (r) => r.method === 'PATCH',
  },
  {
    tool: 'teams.post_message',
    payload: channelPost,
    broken: { ...channelPost, extra: true },
    commit: (r) => r.method === 'POST',
  },
];

// --- Every change.

describe.each(ACTIONS)(
  '$tool, as every change must',
  ({ tool, payload, broken, commit, prepare }) => {
    it('refuses without contact when a scope is missing', async () => {
      const graph = fakeGraph(() => json({ id: 'generated' }, 201));
      const result = await send(depsFor(graph.http), tool, payload, { scopes: ['User.Read'] });
      expect(result).toMatchObject({ outcome: 'not_sent', code: 'AUTH_FAILED', retryable: false });
      expect(graph.calls).toHaveLength(0);
    });

    it('refuses without contact when no scopes are recorded at all', async () => {
      const graph = fakeGraph(() => json({ id: 'generated' }, 201));
      const result = await send(depsFor(graph.http), tool, payload, { scopes: null });
      expect(result).toMatchObject({ outcome: 'not_sent', code: 'AUTH_FAILED' });
      expect(graph.calls).toHaveLength(0);
    });

    it("is NotSent('PAYLOAD_CHANGED') for a payload its schema refuses", async () => {
      const graph = fakeGraph(() => json({ id: 'generated' }, 201));
      const result = await send(depsFor(graph.http), tool, broken);
      expect(result).toEqual({ outcome: 'not_sent', code: 'PAYLOAD_CHANGED', retryable: false });
      expect(graph.calls).toHaveLength(0);
    });

    it('is indeterminate when the commit times out', async () => {
      const graph = fakeGraph(...(prepare ? [prepare] : []), (request) => {
        if (commit(request)) throw new ProviderHttpFailed('PROVIDER_TIMEOUT');
        return undefined;
      });
      const result = await send(depsFor(graph.http), tool, payload);
      expect(result).toEqual({ outcome: 'indeterminate', code: 'TIMEOUT_AFTER_COMMIT' });
      expect(graph.calls.some(commit)).toBe(true);
    });

    it('is indeterminate when the deadline passes while the commit hangs', async () => {
      const graph = fakeGraph(...(prepare ? [prepare] : []), (request) =>
        commit(request) ? new Promise<ProviderResponse>(() => undefined) : undefined,
      );
      const result = await send(depsFor(graph.http), tool, payload, { deadlineMs: 50 });
      expect(result).toEqual({ outcome: 'indeterminate', code: 'TIMEOUT_AFTER_COMMIT' });
    });

    it('is indeterminate on a 5xx once the commit was written, keeping only the status', async () => {
      const graph = fakeGraph(...(prepare ? [prepare] : []), (request) =>
        commit(request) ? failure(503) : undefined,
      );
      const result = await send(depsFor(graph.http), tool, payload);
      expect(result).toEqual({
        outcome: 'indeterminate',
        code: 'CONNECTION_LOST_AFTER_COMMIT',
        providerStatus: 503,
      });
    });

    it('is a certain, retryable not_sent when the connection never opened', async () => {
      const graph = fakeGraph(...(prepare ? [prepare] : []), (request) => {
        if (commit(request)) throw new ProviderHttpFailed('PROVIDER_CONNECT_FAILED');
        return undefined;
      });
      const result = await send(depsFor(graph.http), tool, payload);
      expect(result).toEqual({ outcome: 'not_sent', code: 'CONNECT_FAILED', retryable: true });
    });

    it('is a retryable not_sent on 429, honouring no Retry-After itself', async () => {
      const graph = fakeGraph(...(prepare ? [prepare] : []), (request) =>
        commit(request) ? { ...failure(429), headers: { 'retry-after': '86400' } } : undefined,
      );
      const result = await send(depsFor(graph.http), tool, payload);
      expect(result).toEqual({
        outcome: 'not_sent',
        code: 'RELAY_BUSY',
        retryable: true,
        providerStatus: 429,
      });
    });

    it('is not_sent, not retryable, when Graph says 401 to the commit', async () => {
      const graph = fakeGraph(...(prepare ? [prepare] : []), (request) =>
        commit(request) ? failure(401) : undefined,
      );
      const result = await send(depsFor(graph.http), tool, payload);
      expect(result).toMatchObject({ outcome: 'not_sent', code: 'AUTH_FAILED', retryable: false });
    });

    it('is rejected when Graph refuses with 4xx', async () => {
      const graph = fakeGraph(...(prepare ? [prepare] : []), (request) =>
        commit(request) ? failure(400) : undefined,
      );
      const result = await send(depsFor(graph.http), tool, payload);
      expect(result).toEqual({
        outcome: 'rejected',
        code: 'REFUSED_BY_PROVIDER',
        providerStatus: 400,
      });
    });

    it('is a certain not_sent when the token never came', async () => {
      const graph = fakeGraph();
      const deps: MicrosoftToolDeps = {
        http: graph.http,
        withToken: async () => {
          throw new SyncUnavailable('CREDENTIAL_REJECTED');
        },
      };
      const result = await send(deps, tool, payload);
      expect(result).toEqual({
        outcome: 'not_sent',
        code: 'CREDENTIAL_UNAVAILABLE',
        retryable: false,
      });
      expect(graph.calls).toHaveLength(0);
    });

    it('cannot answer a reconcile without its scope, and asks nobody', async () => {
      const graph = fakeGraph(() => json({ value: [] }));
      expect(await reconcile(depsFor(graph.http), tool, payload, { scopes: [] })).toEqual({
        answer: 'cannot_answer',
      });
      expect(graph.calls).toHaveLength(0);
    });
  },
);

// --- Mail.

describe('outlook.send', () => {
  it('writes a draft carrying our Message-ID, then sends it', async () => {
    const graph = fakeGraph(
      on('POST', '/v1.0/me/messages', () => json({ id: 'generated_draft' }, 201)),
      on('POST', '/v1.0/me/messages/generated_draft/send', () => empty(202)),
    );
    const result = await send(depsFor(graph.http), 'outlook.send', mail);
    expect(result).toEqual({
      outcome: 'accepted',
      code: 'ACCEPTED_BY_PROVIDER',
      providerStatus: 202,
      externalId: MESSAGE_ID,
    });
    expect(graph.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /v1.0/me/messages',
      'POST /v1.0/me/messages/generated_draft/send',
    ]);
    expect(bodyOf(graph.calls[0])).toEqual({
      subject: 'Generated subject',
      body: { contentType: 'text', content: 'Generated body text.' },
      toRecipients: [{ emailAddress: { address: 'recipient@example.invalid' } }],
      ccRecipients: [{ emailAddress: { address: 'copy@example.invalid' } }],
      bccRecipients: [],
      internetMessageId: MESSAGE_ID,
      internetMessageHeaders: [{ name: 'x-ensemus-intent', value: KEY }],
    });
    expect(graph.calls[1]?.body?.length).toBe(0);
    expect(graph.calls[0]?.headers?.authorization).toBe('Bearer generated-access-token');
  });

  it('threads a reply through createReply with the exact recipients', async () => {
    const graph = fakeGraph(
      on('POST', '/v1.0/me/messages/generated_original%3D/createReply', () =>
        json({ id: 'generated_reply' }, 201),
      ),
      on('POST', '/v1.0/me/messages/generated_reply/send', () => empty(202)),
    );
    const payload = { message: { ...mail.message, in_reply_to: 'generated_original=' } };
    expect(await send(depsFor(graph.http), 'outlook.send', payload)).toMatchObject({
      outcome: 'accepted',
    });
    const created = bodyOf(graph.calls[0]).message;
    expect(created.internetMessageId).toBe(MESSAGE_ID);
    expect(created.toRecipients).toEqual([
      { emailAddress: { address: 'recipient@example.invalid' } },
    ]);
    expect(created.internetMessageHeaders).toBeUndefined();
  });

  it('is a certain not_sent when the draft fails, and never calls /send', async () => {
    for (const status of [503, 429]) {
      const graph = fakeGraph(on('POST', '/v1.0/me/messages', () => failure(status)));
      expect(await send(depsFor(graph.http), 'outlook.send', mail)).toMatchObject({
        outcome: 'not_sent',
        retryable: true,
      });
      expect(graph.calls).toHaveLength(1);
    }
    const timeout = fakeGraph(() => {
      throw new ProviderHttpFailed('PROVIDER_TIMEOUT');
    });
    expect(await send(depsFor(timeout.http), 'outlook.send', mail)).toEqual({
      outcome: 'not_sent',
      code: 'CONNECT_FAILED',
      retryable: true,
    });
  });

  it('is rejected, with nothing sent, when Graph refuses the draft', async () => {
    const graph = fakeGraph(on('POST', '/v1.0/me/messages', () => failure(400)));
    expect(await send(depsFor(graph.http), 'outlook.send', mail)).toEqual({
      outcome: 'rejected',
      code: 'REFUSED_BY_PROVIDER',
      providerStatus: 400,
    });
    expect(graph.calls).toHaveLength(1);
  });

  it('refuses a line break in any header value before contact', async () => {
    const graph = fakeGraph(() => json({ id: 'generated' }, 201));
    // A domain that is not a host name, or none at all, sends nothing: there is no Message-ID to give.
    for (const messageIdDomain of ['example.invalid\r\nBcc: x', null]) {
      expect(await send(depsFor(graph.http, { messageIdDomain }), 'outlook.send', mail)).toEqual({
        outcome: 'not_sent',
        code: 'CONNECTOR_UNAVAILABLE',
        retryable: false,
      });
    }
    expect(
      await send(depsFor(graph.http), 'outlook.send', mail, {
        request: { idempotencyKey: 'ensemus-generated\r\nX-Injected: 1' },
      }),
    ).toEqual({ outcome: 'not_sent', code: 'PAYLOAD_CHANGED', retryable: false });
    expect(graph.calls).toHaveLength(0);
  });

  it('reconciles by our Message-ID in Sent Items only', async () => {
    const found = fakeGraph(
      on('GET', /^\/v1\.0\/me\/mailFolders\/sentitems\/messages\?/, () =>
        json({ value: [{ id: 'generated_sent', internetMessageId: MESSAGE_ID }] }),
      ),
    );
    expect(await reconcile(depsFor(found.http), 'outlook.send', mail)).toEqual({
      answer: 'found',
      externalId: 'generated_sent',
    });
    const filter = new URL(`https://graph.invalid${found.calls[0]!.path}`).searchParams.get(
      '$filter',
    );
    expect(filter).toBe(`internetMessageId eq '${MESSAGE_ID}'`);

    const missing = fakeGraph(() => json({ value: [] }));
    expect(await reconcile(depsFor(missing.http), 'outlook.send', mail)).toEqual({
      answer: 'not_found',
    });
    const other = fakeGraph(() =>
      json({ value: [{ id: 'generated_other', internetMessageId: '<other@example.invalid>' }] }),
    );
    expect(await reconcile(depsFor(other.http), 'outlook.send', mail)).toEqual({
      answer: 'not_found',
    });
    const down = fakeGraph(() => failure(500));
    expect(await reconcile(depsFor(down.http), 'outlook.send', mail)).toEqual({
      answer: 'cannot_answer',
    });
  });
});

describe('outlook.create_draft', () => {
  it('creates a draft only, and never sends it', async () => {
    const graph = fakeGraph(
      on('POST', '/v1.0/me/messages', () => json({ id: 'generated_draft' }, 201)),
    );
    expect(await send(depsFor(graph.http), 'outlook.create_draft', mail)).toEqual({
      outcome: 'accepted',
      code: 'ACCEPTED_BY_PROVIDER',
      providerStatus: 201,
      externalId: 'generated_draft',
    });
    expect(graph.calls).toHaveLength(1);
    expect(bodyOf(graph.calls[0]).internetMessageId).toBe(MESSAGE_ID);
  });

  it('reconciles by Message-ID anywhere in the mailbox', async () => {
    const graph = fakeGraph(
      on('GET', /^\/v1\.0\/me\/messages\?/, () =>
        json({ value: [{ id: 'generated_draft', internetMessageId: MESSAGE_ID }] }),
      ),
    );
    expect(await reconcile(depsFor(graph.http), 'outlook.create_draft', mail)).toEqual({
      answer: 'found',
      externalId: 'generated_draft',
    });
  });
});

// --- Calendar.

describe('calendar.create_event', () => {
  it('sends the exact event as wall time in its zone, with transactionId from the intent', async () => {
    const graph = fakeGraph(
      on('POST', '/v1.0/me/calendar/events', () => json({ id: 'generated_event' }, 201)),
    );
    expect(await send(depsFor(graph.http), 'calendar.create_event', newEvent)).toEqual({
      outcome: 'accepted',
      code: 'ACCEPTED_BY_PROVIDER',
      providerStatus: 201,
      externalId: 'generated_event',
    });
    expect(bodyOf(graph.calls[0])).toEqual({
      subject: 'Generated meeting',
      body: { contentType: 'text', content: 'Generated agenda' },
      location: { displayName: 'Generated room' },
      start: { dateTime: '2026-11-12T09:00:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-11-12T10:00:00', timeZone: 'America/New_York' },
      attendees: [{ emailAddress: { address: 'guest@example.invalid' }, type: 'required' }],
      transactionId: KEY,
    });
  });

  it('uses the named calendar when it is not primary', async () => {
    const graph = fakeGraph(() => json({ id: 'generated_event' }, 201));
    await send(depsFor(graph.http), 'calendar.create_event', {
      ...newEvent,
      calendar_id: 'generated_calendar',
    });
    expect(graph.calls[0]?.path).toBe('/v1.0/me/calendars/generated_calendar/events');
  });

  it('refuses, unsent, an event that says attendees are not told, which Graph cannot honour', async () => {
    const graph = fakeGraph(() => json({ id: 'generated_event' }, 201));
    for (const send_updates of ['none', 'external_only']) {
      expect(
        await send(depsFor(graph.http), 'calendar.create_event', { ...newEvent, send_updates }),
      ).toEqual({ outcome: 'not_sent', code: 'PAYLOAD_CHANGED', retryable: false });
      expect(
        await send(depsFor(graph.http), 'calendar.update_event', { ...eventChange, send_updates }),
      ).toEqual({ outcome: 'not_sent', code: 'PAYLOAD_CHANGED', retryable: false });
    }
    expect(graph.calls).toHaveLength(0);
    // With nobody invited there is nobody to tell, so saying so is true.
    expect(
      await send(depsFor(graph.http), 'calendar.create_event', {
        ...newEvent,
        attendees: [],
        send_updates: 'none',
      }),
    ).toMatchObject({ outcome: 'accepted' });
  });

  it('reconciles by transactionId in the event window, best effort', async () => {
    const found = fakeGraph(
      on('GET', /^\/v1\.0\/me\/calendar\/calendarView\?/, () =>
        json({
          value: [
            { id: 'generated_other', transactionId: 'ensemus-other' },
            { id: 'generated_event', transactionId: KEY },
          ],
        }),
      ),
    );
    expect(await reconcile(depsFor(found.http), 'calendar.create_event', newEvent)).toEqual({
      answer: 'found',
      externalId: 'generated_event',
    });
    const view = new URL(`https://graph.invalid${found.calls[0]!.path}`).searchParams;
    expect(view.get('startDateTime')).toBe(newEvent.start);
    expect(view.get('endDateTime')).toBe(newEvent.end);

    const none = fakeGraph(() => json({ value: [{ id: 'generated_other' }] }));
    expect(await reconcile(depsFor(none.http), 'calendar.create_event', newEvent)).toEqual({
      answer: 'not_found',
    });
    const paged = fakeGraph(() =>
      json({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next' }),
    );
    expect(await reconcile(depsFor(paged.http), 'calendar.create_event', newEvent)).toEqual({
      answer: 'cannot_answer',
    });
  });

  it('refuses a zone this runtime does not know, before contact', () => {
    expect(() => wallTime('2026-11-12T14:00:00Z', 'Generated/Nowhere')).toThrow('PAYLOAD_CHANGED');
    expect(wallTime('2026-07-01T12:30:00.250Z', 'Europe/London')).toBe('2026-07-01T13:30:00.250');
  });
});

describe('calendar.update_event', () => {
  it('patches exactly the changed fields', async () => {
    const graph = fakeGraph(
      on('PATCH', '/v1.0/me/calendars/generated_calendar/events/generated_event', () =>
        json({ id: 'generated_event' }),
      ),
    );
    expect(await send(depsFor(graph.http), 'calendar.update_event', eventChange)).toMatchObject({
      outcome: 'accepted',
      externalId: 'generated_event',
    });
    expect(bodyOf(graph.calls[0])).toEqual({
      subject: 'Generated new title',
      start: { dateTime: '2026-11-13T09:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-11-13T10:00:00', timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: 'guest@example.invalid' }, type: 'required' }],
    });
  });

  it('refuses a time zone change with no times, which Graph cannot be told exactly', async () => {
    const graph = fakeGraph(() => json({}));
    const payload = { ...eventChange, changes: { time_zone: 'Europe/London' } };
    expect(await send(depsFor(graph.http), 'calendar.update_event', payload)).toEqual({
      outcome: 'not_sent',
      code: 'PAYLOAD_CHANGED',
      retryable: false,
    });
    expect(graph.calls).toHaveLength(0);
  });

  it('reconciles by reading the event back', async () => {
    const event = {
      id: 'generated_event',
      subject: 'Generated new title',
      start: { dateTime: '2026-11-13T09:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-11-13T10:00:00.0000000', timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: 'Guest@example.invalid' } }],
    };
    const same = fakeGraph(() => json(event));
    expect(await reconcile(depsFor(same.http), 'calendar.update_event', eventChange)).toEqual({
      answer: 'found',
      externalId: 'generated_event',
    });
    expect(same.calls[0]?.headers?.prefer).toContain('outlook.timezone="UTC"');
    const differs = fakeGraph(() => json({ ...event, subject: 'Generated old title' }));
    expect(await reconcile(depsFor(differs.http), 'calendar.update_event', eventChange)).toEqual({
      answer: 'cannot_answer',
    });
    const gone = fakeGraph(() => failure(404));
    expect(await reconcile(depsFor(gone.http), 'calendar.update_event', eventChange)).toEqual({
      answer: 'cannot_answer',
    });
  });
});

// --- Files.

describe('onedrive.create_file', () => {
  it('puts the approved name with conflictBehavior=fail', async () => {
    const graph = fakeGraph(() => json({ id: 'generated_file' }, 201));
    expect(await send(depsFor(graph.http), 'onedrive.create_file', newFile)).toMatchObject({
      outcome: 'accepted',
      externalId: 'generated_file',
    });
    expect(graph.calls[0]?.method).toBe('PUT');
    expect(graph.calls[0]?.path).toBe(
      '/v1.0/me/drive/root:/Generated%20note.txt:/content?@microsoft.graph.conflictBehavior=fail',
    );
    expect(graph.calls[0]?.headers?.['content-type']).toBe('text/plain; charset=utf-8');
    expect(graph.calls[0]?.body?.toString('utf8')).toBe('Generated text.');
  });

  it('puts it under the named parent', async () => {
    const graph = fakeGraph(() => json({ id: 'generated_file' }, 201));
    await send(depsFor(graph.http), 'onedrive.create_file', {
      ...newFile,
      parent_id: 'generated!1',
    });
    expect(graph.calls[0]?.path).toMatch(
      /^\/v1\.0\/me\/drive\/items\/generated%211:\/Generated%20note\.txt:\/content\?/,
    );
  });

  it('is rejected when a file of that name exists, never replacing it', async () => {
    const graph = fakeGraph(() => failure(409));
    expect(await send(depsFor(graph.http), 'onedrive.create_file', newFile)).toMatchObject({
      outcome: 'rejected',
      providerStatus: 409,
    });
  });

  it('refuses text too large for one request before contact', async () => {
    const graph = fakeGraph(() => json({ id: 'generated_file' }, 201));
    const large = { ...newFile, text: 'é'.repeat(600_000) };
    expect(await send(depsFor(graph.http), 'onedrive.create_file', large)).toEqual({
      outcome: 'not_sent',
      code: 'PAYLOAD_CHANGED',
      retryable: false,
    });
    expect(graph.calls).toHaveLength(0);
  });

  it('reconciles by path, believing only the same bytes', async () => {
    const bytes = Buffer.from(newFile.text);
    const sha256 = createHash('sha256').update(bytes).digest('hex').toUpperCase();
    const item = { id: 'generated_file', name: newFile.name, size: bytes.length };
    const hashed = fakeGraph(() => json({ ...item, file: { hashes: { sha256Hash: sha256 } } }));
    expect(await reconcile(depsFor(hashed.http), 'onedrive.create_file', newFile)).toEqual({
      answer: 'found',
      externalId: 'generated_file',
    });
    expect(hashed.calls[0]?.path).toBe(
      '/v1.0/me/drive/root:/Generated%20note.txt:?$select=id%2Cname%2Csize%2Cfile',
    );

    const readBack = fakeGraph(
      on('GET', /\/content$/, () => ({ status: 200, headers: {}, body: bytes })),
      () => json({ ...item, file: { hashes: { quickXorHash: 'generated' } } }),
    );
    expect(await reconcile(depsFor(readBack.http), 'onedrive.create_file', newFile)).toEqual({
      answer: 'found',
      externalId: 'generated_file',
    });

    const someoneElse = fakeGraph(() => json({ ...item, size: 3, file: {} }));
    expect(await reconcile(depsFor(someoneElse.http), 'onedrive.create_file', newFile)).toEqual({
      answer: 'cannot_answer',
    });
    const redirected = fakeGraph(
      on('GET', /\/content$/, () => empty(302, { location: 'https://download.example.invalid/x' })),
      () => json({ ...item, file: {} }),
    );
    expect(await reconcile(depsFor(redirected.http), 'onedrive.create_file', newFile)).toEqual({
      answer: 'cannot_answer',
    });
    const absent = fakeGraph(() => failure(404));
    expect(await reconcile(depsFor(absent.http), 'onedrive.create_file', newFile)).toEqual({
      answer: 'not_found',
    });
  });
});

describe('excel.write_range', () => {
  const path =
    "/v1.0/drives/generated_drive/items/generated_item/workbook/worksheets/Sheet1/range(address='A1:C1')";

  it('patches the range sessionless, with the exact values', async () => {
    const graph = fakeGraph(on('PATCH', path, () => json({ address: 'Sheet1!A1:C1' })));
    expect(await send(depsFor(graph.http), 'excel.write_range', rangeWrite)).toMatchObject({
      outcome: 'accepted',
      externalId: 'generated_item',
    });
    expect(bodyOf(graph.calls[0])).toEqual({ values: [['generated', 42, null]] });
    expect(graph.calls[0]?.headers?.['workbook-session-id']).toBeUndefined();
  });

  it('accepts its own sheet in the range and refuses another before contact', async () => {
    const graph = fakeGraph(on('PATCH', path, () => json({})));
    expect(
      await send(depsFor(graph.http), 'excel.write_range', {
        ...rangeWrite,
        range: 'Sheet1!A1:C1',
      }),
    ).toMatchObject({ outcome: 'accepted' });
    const other = fakeGraph(() => json({}));
    expect(
      await send(depsFor(other.http), 'excel.write_range', { ...rangeWrite, range: 'Other!A1:C1' }),
    ).toEqual({ outcome: 'not_sent', code: 'PAYLOAD_CHANGED', retryable: false });
    expect(other.calls).toHaveLength(0);
  });

  it('writes to the named drive only when the connection reaches it, and else sends nothing', async () => {
    const found = fakeGraph(
      on('PATCH', /^\/v1\.0\/drives\/generated_drive\/items\/generated_item\/workbook\//, () =>
        json({}),
      ),
    );
    expect(
      await send(depsFor(found.http), 'excel.write_range', rangeWrite, {
        config: { driveIds: ['generated_drive'] },
      }),
    ).toMatchObject({ outcome: 'accepted' });
    expect(found.calls).toHaveLength(1);
    const elsewhere = fakeGraph(() => json({}));
    expect(
      await send(depsFor(elsewhere.http), 'excel.write_range', rangeWrite, {
        config: { driveIds: ['generated_other'] },
      }),
    ).toEqual({ outcome: 'not_sent', code: 'REFUSED_BY_PROVIDER', retryable: false });
    expect(elsewhere.calls).toHaveLength(0);
  });

  it('reconciles by reading the range back', async () => {
    const same = fakeGraph(() => json({ formulas: [['generated', 42, '=A1']] }));
    expect(await reconcile(depsFor(same.http), 'excel.write_range', rangeWrite)).toEqual({
      answer: 'found',
      externalId: 'generated_item',
    });
    const differs = fakeGraph(() => json({ formulas: [['generated', 41, '']] }));
    expect(await reconcile(depsFor(differs.http), 'excel.write_range', rangeWrite)).toEqual({
      answer: 'cannot_answer',
    });
  });
});

// --- Teams.

describe('teams.post_message', () => {
  it('posts plain text to one channel', async () => {
    const graph = fakeGraph(() => json({ id: 'generated_message' }, 201));
    expect(await send(depsFor(graph.http), 'teams.post_message', channelPost)).toMatchObject({
      outcome: 'accepted',
      externalId: 'generated_message',
    });
    expect(graph.calls[0]?.path).toBe(
      '/v1.0/teams/generated-team/channels/19%3Agenerated%40thread.tacv2/messages',
    );
    expect(bodyOf(graph.calls[0])).toEqual({
      subject: 'Generated subject',
      body: { contentType: 'text', content: 'Generated message.' },
    });
  });

  it('cannot answer a reconcile, and asks nobody', async () => {
    const graph = fakeGraph(() => json({ value: [] }));
    expect(await reconcile(depsFor(graph.http), 'teams.post_message', channelPost)).toEqual({
      answer: 'cannot_answer',
    });
    expect(graph.calls).toHaveLength(0);
  });
});

// --- Reads.

const READS: { tool: string; args: Record<string, unknown> }[] = [
  { tool: 'outlook.search', args: { query: 'generated', max_results: 5 } },
  { tool: 'outlook.read_thread', args: { conversation_id: 'generated_conversation' } },
  {
    tool: 'calendar.list_events',
    args: {
      calendar_id: 'primary',
      time_min: '2026-11-12T00:00:00Z',
      time_max: '2026-11-13T00:00:00Z',
      max_results: 10,
    },
  },
  { tool: 'onedrive.search', args: { query: 'generated', max_results: 5 } },
  { tool: 'word.read', args: { drive_id: 'generated_drive', item_id: 'generated_item' } },
  {
    tool: 'excel.read_range',
    args: {
      drive_id: 'generated_drive',
      item_id: 'generated_item',
      worksheet: 'Sheet1',
      range: 'A1:B2',
    },
  },
];

describe.each(READS)('$tool, as every read must', ({ tool, args }) => {
  it('refuses without contact when a scope is missing', async () => {
    const graph = fakeGraph(() => json({ value: [] }));
    expect(await refusal(read(depsFor(graph.http), tool, args, { scopes: ['User.Read'] }))).toBe(
      'refused:SCOPE_NOT_GRANTED',
    );
    expect(graph.calls).toHaveLength(0);
  });

  it('refuses arguments its schema does not take', async () => {
    const graph = fakeGraph(() => json({ value: [] }));
    expect(await refusal(read(depsFor(graph.http), tool, { ...args, extra: 1 }))).toBe(
      'refused:TOOL_ARGS_INVALID',
    );
    expect(graph.calls).toHaveLength(0);
  });

  it('maps Graph statuses to codes, never to provider text', async () => {
    const cases: [number, string][] = [
      [401, 'unavailable:CREDENTIAL_REJECTED'],
      [403, 'refused:PROVIDER_REFUSED'],
      [404, 'refused:PROVIDER_NOT_FOUND'],
      [429, 'unavailable:RATE_LIMITED'],
      [500, 'unavailable:PROVIDER_UNAVAILABLE'],
      [503, 'unavailable:PROVIDER_UNAVAILABLE'],
    ];
    for (const [status, expected] of cases) {
      const graph = fakeGraph(() => failure(status));
      expect(await refusal(read(depsFor(graph.http), tool, args))).toBe(expected);
    }
    const timeout = fakeGraph(() => {
      throw new ProviderHttpFailed('PROVIDER_TIMEOUT');
    });
    expect(await refusal(read(depsFor(timeout.http), tool, args))).toBe(
      'unavailable:PROVIDER_TIMEOUT',
    );
    const large = fakeGraph(() => {
      throw new ProviderHttpFailed('PROVIDER_RESPONSE_TOO_LARGE');
    });
    expect(await refusal(read(depsFor(large.http), tool, args))).toBe(
      'refused:TOOL_OUTPUT_TOO_LARGE',
    );
  });
});

describe('outlook.search', () => {
  it('searches as a quoted phrase and returns classified JSON with no org resources', async () => {
    const graph = fakeGraph(() =>
      json({
        value: [
          {
            id: 'generated_message',
            conversationId: 'generated_conversation',
            subject: 'Generated subject',
            from: { emailAddress: { name: 'Generated Sender', address: 'sender@example.invalid' } },
            receivedDateTime: '2026-11-11T09:00:00Z',
            bodyPreview: 'Generated preview',
            hasAttachments: true,
          },
        ],
      }),
    );
    const result = await read(depsFor(graph.http), 'outlook.search', {
      query: 'say "hi" \\ now',
      max_results: 5,
    });
    const search = new URL(`https://graph.invalid${graph.calls[0]!.path}`).searchParams;
    expect(search.get('$search')).toBe('"say \\"hi\\" \\\\ now"');
    expect(search.get('$top')).toBe('5');
    expect(result).toMatchObject({
      mediaType: 'application/json',
      classification: 'confidential',
      resourceExternalIds: [],
    });
    expect(outputOf(result.bytes)).toEqual({
      messages: [
        {
          id: 'generated_message',
          conversation_id: 'generated_conversation',
          subject: 'Generated subject',
          from: { name: 'Generated Sender', address: 'sender@example.invalid' },
          received_at: '2026-11-11T09:00:00Z',
          preview: 'Generated preview',
          has_attachments: true,
          is_draft: false,
        },
      ],
      truncated: false,
    });
  });
});

describe('outlook.read_thread', () => {
  it('asks for text bodies, turns HTML into text, and follows no link or attachment', async () => {
    const graph = fakeGraph(() =>
      json({
        value: [
          {
            id: 'generated_second',
            receivedDateTime: '2026-11-11T10:00:00Z',
            hasAttachments: true,
            body: {
              contentType: 'html',
              content:
                '<html><head><style>p{}</style></head><body><p>Hello &amp; welcome</p><script>alert(1)</script><a href="https://tracker.example.invalid/x">Open</a><img src="https://pixel.example.invalid/y"></body></html>',
            },
          },
          {
            id: 'generated_first',
            receivedDateTime: '2026-11-11T09:00:00Z',
            body: { contentType: 'text', content: 'First\r\nline' },
          },
        ],
      }),
    );
    const result = await read(depsFor(graph.http), 'outlook.read_thread', {
      conversation_id: 'generated_conversation',
    });
    expect(graph.calls).toHaveLength(1);
    expect(graph.calls[0]?.headers?.prefer).toBe('outlook.body-content-type="text"');
    expect(
      new URL(`https://graph.invalid${graph.calls[0]!.path}`).searchParams.get('$filter'),
    ).toBe("conversationId eq 'generated_conversation'");
    const output = outputOf(result.bytes);
    expect(output.messages.map((m: { id: string }) => m.id)).toEqual([
      'generated_first',
      'generated_second',
    ]);
    expect(output.messages[0].text).toBe('First\nline');
    expect(output.messages[1].text).toBe('Hello & welcome\nOpen');
    expect(result.bytes.toString()).not.toContain('example.invalid/');
    expect(result.classification).toBe('confidential');
  });

  it('cuts long bodies cleanly to fit, with the marker', async () => {
    const graph = fakeGraph(() =>
      json({
        value: [
          {
            id: 'generated_a',
            receivedDateTime: '1',
            body: { contentType: 'text', content: 'é'.repeat(700_000) },
          },
          {
            id: 'generated_b',
            receivedDateTime: '2',
            body: { contentType: 'text', content: 'short' },
          },
        ],
      }),
    );
    const result = await read(depsFor(graph.http), 'outlook.read_thread', {
      conversation_id: 'generated_conversation',
    });
    expect(result.bytes.length).toBeLessThanOrEqual(1_048_576);
    const output = outputOf(result.bytes);
    expect(output.truncated).toBe(true);
    expect(output.messages[0].text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(output.messages[0].text).not.toContain('�');
    expect(output.messages[1].text).toBe('short');
  });

  it('refuses an empty conversation as not found', async () => {
    const graph = fakeGraph(() => json({ value: [] }));
    expect(
      await refusal(
        read(depsFor(graph.http), 'outlook.read_thread', { conversation_id: 'generated_none' }),
      ),
    ).toBe('refused:PROVIDER_NOT_FOUND');
  });
});

describe('calendar.list_events', () => {
  it('reads the calendar view in UTC and marks a further page as truncated', async () => {
    const graph = fakeGraph(() =>
      json({
        value: [
          {
            id: 'generated_event',
            subject: 'Generated meeting',
            start: { dateTime: '2026-11-12T09:00:00.0000000', timeZone: 'UTC' },
            end: { dateTime: '2026-11-12T10:00:00.0000000', timeZone: 'UTC' },
            location: { displayName: 'Generated room' },
            attendees: [{ emailAddress: { address: 'guest@example.invalid' } }],
          },
        ],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next',
      }),
    );
    const result = await read(depsFor(graph.http), 'calendar.list_events', READS[2]!.args);
    expect(graph.calls[0]?.path).toMatch(/^\/v1\.0\/me\/calendar\/calendarView\?/);
    expect(graph.calls[0]?.headers?.prefer).toContain('outlook.timezone="UTC"');
    const output = outputOf(result.bytes);
    expect(output.truncated).toBe(true);
    expect(output.events[0]).toMatchObject({
      id: 'generated_event',
      summary: 'Generated meeting',
      start: { date_time: '2026-11-12T09:00:00.0000000', time_zone: 'UTC' },
      location: 'Generated room',
    });
    // A person's calendar is their correspondence, whoever's connection it is.
    expect(result.classification).toBe('confidential');
  });
});

describe('onedrive.search', () => {
  const hit = (drive: string, item: string) => ({
    id: item,
    name: `${item}.txt`,
    size: 10,
    file: { mimeType: 'text/plain' },
    parentReference: { driveId: drive },
  });

  it('searches each synced drive and drops what the initiator may not have', async () => {
    const graph = fakeGraph(
      on('GET', /^\/v1\.0\/drives\/generated_drive\/root\/search\(q='it''s%20generated'\)\?/, () =>
        json({
          value: [
            hit('generated_drive', 'generated_allowed'),
            hit('generated_drive', 'generated_denied'),
            {
              id: 'generated_folder',
              name: 'Folder',
              folder: {},
              parentReference: { driveId: 'generated_drive' },
            },
          ],
        }),
      ),
    );
    const asked: string[][] = [];
    const access: SuiteResourceAccess = {
      async permitted(ids) {
        asked.push([...ids]);
        return new Set([driveResourceId('generated_drive', 'generated_allowed')]);
      },
    };
    const result = await read(
      depsFor(graph.http),
      'onedrive.search',
      { query: "it's generated", max_results: 5 },
      { access, config: { driveIds: ['generated_drive'] } },
    );
    expect(asked).toEqual([
      [
        driveResourceId('generated_drive', 'generated_allowed'),
        driveResourceId('generated_drive', 'generated_denied'),
      ],
    ]);
    const output = outputOf(result.bytes);
    expect(output.files.map((file: { item_id: string }) => file.item_id)).toEqual([
      'generated_allowed',
    ]);
    expect(result.resourceExternalIds).toEqual([
      driveResourceId('generated_drive', 'generated_allowed'),
    ]);
    expect(result.bytes.toString()).not.toContain('generated_denied');
  });

  it('names a synced drive as the connection does, so the sync finds the same row', async () => {
    const graph = fakeGraph(() => json({ value: [hit('B!GENERATED_DRIVE', 'generated_item')] }));
    const result = await read(
      depsFor(graph.http),
      'onedrive.search',
      { query: 'generated', max_results: 5 },
      { config: { driveIds: ['b!generated_drive'] } },
    );
    expect(outputOf(result.bytes).files[0].drive_id).toBe('b!generated_drive');
    expect(result.resourceExternalIds).toEqual([
      driveResourceId('b!generated_drive', 'generated_item'),
    ]);
  });

  it("searches the person's own drive when no drive is configured", async () => {
    const graph = fakeGraph(() => json({ value: [hit('generated_own', 'generated_item')] }));
    const result = await read(depsFor(graph.http), 'onedrive.search', {
      query: 'generated',
      max_results: 5,
    });
    expect(graph.calls[0]?.path).toMatch(/^\/v1\.0\/me\/drive\/root\/search\(/);
    expect(result.resourceExternalIds).toEqual([
      driveResourceId('generated_own', 'generated_item'),
    ]);
  });
});

describe('word.read', () => {
  const docx = zipOf({
    '[Content_Types].xml': Buffer.from('<Types/>'),
    'word/document.xml': Buffer.from(
      '<w:document><w:body><w:p><w:r><w:t>Generated &amp; title</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t xml:space="preserve">Line </w:t><w:tab/><w:t>two</w:t></w:r></w:p></w:body></w:document>',
    ),
  });
  const meta = (mimeType: string) =>
    on('GET', /^\/v1\.0\/drives\/generated_drive\/items\/generated_item\?/, () =>
      json({
        id: 'generated_item',
        name: 'Generated.docx',
        file: { mimeType },
        parentReference: { driveId: 'generated_drive' },
      }),
    );
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const ITEM = { drive_id: 'generated_drive', item_id: 'generated_item' };

  it("reads a Word document's words and names the resource as the drive sync does", async () => {
    const graph = fakeGraph(
      meta(DOCX),
      on('GET', '/v1.0/drives/generated_drive/items/generated_item/content', () => ({
        status: 200,
        headers: {},
        body: docx,
      })),
    );
    const result = await read(depsFor(graph.http), 'word.read', ITEM);
    expect(outputOf(result.bytes)).toEqual({
      item_id: 'generated_item',
      name: 'Generated.docx',
      media_type: DOCX,
      text: 'Generated & title\nLine \ttwo',
      truncated: false,
    });
    expect(result.resourceExternalIds).toEqual([
      driveResourceId('generated_drive', 'generated_item'),
    ]);
    expect(result.classification).toBe('internal');
    expect(graph.calls.every((call) => call.path.startsWith('/v1.0/drives/generated_drive/'))).toBe(
      true,
    );
  });

  it("classes a member's own document as confidential, the organization's as internal", async () => {
    const graph = () =>
      fakeGraph(
        meta('text/plain'),
        on('GET', '/v1.0/drives/generated_drive/items/generated_item/content', () => ({
          status: 200,
          headers: {},
          body: Buffer.from('Generated words'),
        })),
      );
    const mine = await read(depsFor(graph().http), 'word.read', ITEM, { ownerKind: 'member' });
    expect(mine.classification).toBe('confidential');
    const ours = await read(depsFor(graph().http), 'word.read', ITEM);
    expect(ours.classification).toBe('internal');
  });

  it('reaches only a drive the connection syncs, and nothing elsewhere', async () => {
    const graph = fakeGraph(() => json({ id: 'generated_item' }));
    expect(
      await refusal(
        read(depsFor(graph.http), 'word.read', ITEM, {
          config: { driveIds: ['generated_other'] },
        }),
      ),
    ).toBe('refused:PROVIDER_NOT_FOUND');
    expect(graph.calls).toHaveLength(0);
  });

  it('takes the download redirect only through the operator download hop', async () => {
    const redirect = on('GET', '/v1.0/drives/generated_drive/items/generated_item/content', () =>
      empty(302, { location: 'https://download.example.invalid/generated' }),
    );
    const without = fakeGraph(meta(DOCX), redirect);
    expect(await refusal(read(depsFor(without.http), 'word.read', ITEM))).toBe(
      'refused:PROVIDER_UNAVAILABLE',
    );
    const withHop = fakeGraph(meta(DOCX), redirect);
    const downloads: string[] = [];
    withHop.http.download = async (request) => {
      downloads.push(request.url);
      return { status: 200, headers: {}, body: docx };
    };
    const result = await read(depsFor(withHop.http), 'word.read', ITEM);
    expect(downloads).toEqual(['https://download.example.invalid/generated']);
    expect(outputOf(result.bytes).text).toContain('Generated & title');
  });

  it('cuts a long text cleanly to the limit with the marker', async () => {
    const graph = fakeGraph(
      meta('text/plain'),
      on('GET', '/v1.0/drives/generated_drive/items/generated_item/content', () => ({
        status: 200,
        headers: {},
        body: Buffer.from('ü'.repeat(800_000)),
      })),
    );
    const result = await read(depsFor(graph.http), 'word.read', ITEM);
    expect(result.bytes.length).toBeLessThanOrEqual(1_048_576);
    const output = outputOf(result.bytes);
    expect(output.truncated).toBe(true);
    expect(output.text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(output.text).not.toContain('�');
  });

  it('refuses a file whose words it cannot read, and a broken document', async () => {
    const image = fakeGraph(meta('image/png'));
    expect(await refusal(read(depsFor(image.http), 'word.read', ITEM))).toBe(
      'refused:TOOL_ARGS_INVALID',
    );
    const broken = fakeGraph(
      meta(DOCX),
      on('GET', '/v1.0/drives/generated_drive/items/generated_item/content', () => ({
        status: 200,
        headers: {},
        body: Buffer.from('not a zip'),
      })),
    );
    expect(await refusal(read(depsFor(broken.http), 'word.read', ITEM))).toBe(
      'refused:PROVIDER_REFUSED',
    );
  });
});

describe('excel.read_range', () => {
  it('reads the range sessionless from the synced drive it names', async () => {
    const graph = fakeGraph(
      on('GET', /^\/v1\.0\/drives\/generated_second\/items\/generated_item\?/, () =>
        json({ id: 'generated_item', parentReference: { driveId: 'generated_second' } }),
      ),
      on(
        'GET',
        /^\/v1\.0\/drives\/generated_second\/items\/generated_item\/workbook\/worksheets\/Sheet%201\/range\(address='A1:B2'\)\?/,
        () =>
          json({
            address: "'Sheet 1'!A1:B2",
            values: [
              ['a', 1],
              [true, null],
            ],
          }),
      ),
    );
    const result = await read(
      depsFor(graph.http),
      'excel.read_range',
      {
        drive_id: 'generated_second',
        item_id: 'generated_item',
        worksheet: 'Sheet 1',
        range: "'Sheet 1'!A1:B2",
      },
      { config: { driveIds: ['generated_first', 'generated_second'] } },
    );
    expect(outputOf(result.bytes)).toEqual({
      item_id: 'generated_item',
      worksheet: 'Sheet 1',
      address: "'Sheet 1'!A1:B2",
      values: [
        ['a', 1],
        [true, null],
      ],
      truncated: false,
    });
    expect(result.resourceExternalIds).toEqual([
      driveResourceId('generated_second', 'generated_item'),
    ]);
    expect(graph.calls.every((call) => !call.headers?.['workbook-session-id'])).toBe(true);
    expect(graph.calls.some((call) => call.path.includes('generated_first'))).toBe(false);
    expect(result.classification).toBe('internal');
    const mine = await read(
      depsFor(graph.http),
      'excel.read_range',
      {
        drive_id: 'generated_second',
        item_id: 'generated_item',
        worksheet: 'Sheet 1',
        range: 'A1:B2',
      },
      { ownerKind: 'member' },
    );
    expect(mine.classification).toBe('confidential');
  });

  it('drops trailing rows to fit, marked truncated', async () => {
    const row = Array.from({ length: 100 }, () => 'x'.repeat(30));
    const graph = fakeGraph(
      on('GET', /^\/v1\.0\/drives\/generated_drive\/items\/generated_item\?/, () =>
        json({ id: 'generated_item', parentReference: { driveId: 'generated_drive' } }),
      ),
      () => json({ address: 'Sheet1!A1:CV1000', values: Array.from({ length: 1000 }, () => row) }),
    );
    const result = await read(depsFor(graph.http), 'excel.read_range', READS[5]!.args);
    expect(result.bytes.length).toBeLessThanOrEqual(1_048_576);
    const output = outputOf(result.bytes);
    expect(output.truncated).toBe(true);
    expect(output.values.length).toBeGreaterThan(0);
    expect(output.values.length).toBeLessThan(1000);
  });

  it('refuses a range naming another sheet', async () => {
    const graph = fakeGraph(() => json({}));
    expect(
      await refusal(
        read(depsFor(graph.http), 'excel.read_range', {
          drive_id: 'generated_drive',
          item_id: 'generated_item',
          worksheet: 'Sheet1',
          range: 'Other!A1',
        }),
      ),
    ).toBe('refused:TOOL_ARGS_INVALID');
    expect(graph.calls).toHaveLength(0);
  });
});

describe('text helpers', () => {
  it('clips on a character boundary', () => {
    const clipped = clipText('a😀bcdefghijklmnop', 3 + Buffer.byteLength(TRUNCATION_MARKER));
    expect(clipped).toBe(`a${TRUNCATION_MARKER}`);
    expect(clipText('short', 100)).toBe('short');
  });

  it('turns HTML into text without links, scripts or numeric control characters', () => {
    expect(
      htmlToText(
        '<div>One<br>Two</div><!-- c --><a href="https://x.example.invalid">Three</a>&#0;&#65;',
      ),
    ).toBe('One\nTwo\nThreeA');
  });
});
