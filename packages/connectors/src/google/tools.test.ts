// Google suite tools against a fake ProviderHttpClient. Generated values only: no real account, client,
// token or address. Wire shapes follow Google's references and are unqualified until a live run.
import { describe, expect, it } from 'vitest';
import { idempotencyKeyFor } from '@ensemus/domain/external-action';
import { createGoogleWorkspaceConnector, type GoogleWorkspaceConfig } from './index';
import type { ActionRequest, ConnectorContext } from '../index';
import {
  ProviderHttpFailed,
  type ProviderHttpClient,
  type ProviderRequest,
  type ProviderResponse,
} from '../knowledge';
import { runReconcile, runSend } from '../runtime/actions';
import type { SuiteConnectionOwner, SuiteResourceAccess } from '../suites';
import {
  buildGmailMessage,
  gmailMessageId,
  htmlToText,
  messageText,
  UnsafeGmailMessage,
} from './gmail-message';
import { calendarEventId, DRIVE_INTENT_PROPERTY } from './tools';
import { cutText, TRUNCATION_MARKER } from './tool-support';

const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
const ALL_SCOPES = [
  'gmail.readonly',
  'gmail.compose',
  'gmail.send',
  'calendar.events',
  'drive.metadata.readonly',
  'drive.file',
  'documents',
  'spreadsheets',
].map(scope);

const ORGANIZATION = '00000000-0000-4000-8000-000000000b01';
const CONNECTION = '00000000-0000-4000-8000-000000000b02';
const INTENT = '00000000-0000-4000-8000-000000000b03';
const MAIL_DOMAIN = 'mail.example.invalid';
const messageId = () => gmailMessageId(INTENT, MAIL_DOMAIN);

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): ProviderResponse => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: Buffer.from(JSON.stringify(body)),
});
const googleError = (status: number, reason: string, headers: Record<string, string> = {}) =>
  json(
    {
      error: { code: status, message: 'provider words that must not leave', errors: [{ reason }] },
    },
    status,
    headers,
  );

type Handler = (request: ProviderRequest, url: URL) => ProviderResponse | Promise<ProviderResponse>;

/** A fake Google: a token for any refresh, and `handler` for everything else, which it records. */
function google(
  handler: Handler,
  scopes: readonly string[] = ALL_SCOPES,
  options: { ownerKind?: SuiteConnectionOwner; messageIdDomain?: string | null } = {},
) {
  const requests: { request: ProviderRequest; url: URL; body: string }[] = [];
  const http: ProviderHttpClient = {
    request: async (request) => {
      if (request.route === 'google_oauth')
        return json({ access_token: 'generated-access', token_type: 'Bearer', expires_in: 3600 });
      const url = new URL(`https://fake.invalid${request.path}`);
      requests.push({ request, url, body: request.body?.toString('utf8') ?? '' });
      return handler(request, url);
    },
  };
  const connector = createGoogleWorkspaceConnector({
    http,
    messageIdDomain: options.messageIdDomain === undefined ? MAIL_DOMAIN : options.messageIdDomain,
  });
  const context: ConnectorContext<GoogleWorkspaceConfig> = {
    organizationId: ORGANIZATION,
    connectionId: CONNECTION,
    config: { driveIds: [] },
    grantedScopes: scopes,
    signal: new AbortController().signal,
    credentials: {
      withCredential: async (use) =>
        use(
          Buffer.from(
            JSON.stringify({
              client_id: 'generated',
              client_secret: 'generated-secret',
              refresh_token: 'generated-refresh',
            }),
          ),
        ),
    },
    network: {
      openRelay: async () => {
        throw new Error('NO_AMBIENT_NETWORK');
      },
    },
  };
  const read = (
    id: string,
    args: Record<string, unknown>,
    access: SuiteResourceAccess | null = null,
  ) =>
    connector.suiteReads.read(
      { ...context, ownerKind: options.ownerKind ?? 'organization' },
      { id, version: '1' },
      { connection_id: CONNECTION, ...args },
      access,
    );
  const call = (request: ActionRequest) => {
    const { signal: _signal, ...rest } = context;
    return { connector, context: rest, request };
  };
  const send = (request: ActionRequest) => runSend(call(request));
  const reconcile = (request: ActionRequest) => runReconcile(call(request));
  return { requests, read, send, reconcile, connector, context };
}

const intent = (toolName: string, payload: unknown): ActionRequest => ({
  externalActionId: INTENT,
  attemptId: '00000000-0000-4000-8000-000000000b04',
  attemptNo: 1,
  toolName,
  toolVersion: '1',
  idempotencyKey: idempotencyKeyFor(INTENT),
  requestHash: 'generated-hash',
  payload,
});

const decodeJson = (bytes: Buffer) => JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
const rawOf = (body: string) => {
  const parsed = JSON.parse(body) as { raw?: string; message?: { raw: string } };
  return Buffer.from(parsed.raw ?? parsed.message!.raw, 'base64url').toString('utf8');
};

const MAIL = {
  message: {
    to: ['ana@example.invalid'],
    cc: ['ben@example.invalid'],
    subject: 'Hello',
    text_body: 'Body text',
  },
};
const EVENT = {
  calendar_id: 'primary',
  summary: 'Review',
  description: 'Agenda',
  start: '2026-11-12T10:00:00Z',
  end: '2026-11-12T11:00:00Z',
  time_zone: 'Europe/London',
  attendees: ['ana@example.invalid'],
  send_updates: 'all',
};
const UPDATE = {
  calendar_id: 'primary',
  event_id: 'evt123',
  send_updates: 'all',
  changes: { summary: 'Moved', start: '2026-11-12T12:00:00Z', end: '2026-11-12T13:00:00Z' },
};
const FILE = { name: 'notes.txt', media_type: 'text/plain', text: 'hello' };
const EDIT = {
  document_id: 'doc1',
  required_revision_id: 'rev1',
  edits: [
    { kind: 'insert_text', index: 1, text: 'Hi' },
    { kind: 'replace_all_text', find: 'a', replace: 'b', match_case: true },
    { kind: 'delete_range', start_index: 2, end_index: 4 },
  ],
};
const WRITE = {
  spreadsheet_id: 'sheet1',
  range: "'My Sheet'!A1:B2",
  values: [
    ['a', 1],
    [true, null],
  ],
  value_input: 'raw',
};

/** Every change, with its tool's scope and the route and method of the one request that changes. */
const CHANGES = [
  {
    tool: 'gmail.send',
    payload: MAIL,
    scope: 'gmail.send',
    write: 'POST /gmail/v1/users/me/messages/send',
  },
  {
    tool: 'gmail.create_draft',
    payload: MAIL,
    scope: 'gmail.compose',
    write: 'POST /gmail/v1/users/me/drafts',
  },
  {
    tool: 'calendar.create_event',
    payload: EVENT,
    scope: 'calendar.events',
    write: 'POST /calendar/v3/calendars/primary/events',
  },
  {
    tool: 'calendar.update_event',
    payload: UPDATE,
    scope: 'calendar.events',
    write: 'PATCH /calendar/v3/calendars/primary/events/evt123',
  },
  {
    tool: 'drive.create_file',
    payload: FILE,
    scope: 'drive.file',
    write: 'POST /upload/drive/v3/files',
  },
  {
    tool: 'docs.edit',
    payload: EDIT,
    scope: 'documents',
    write: 'POST /v1/documents/doc1:batchUpdate',
  },
  {
    tool: 'sheets.write_range',
    payload: WRITE,
    scope: 'spreadsheets',
    write: "PUT /v4/spreadsheets/sheet1/values/'My%20Sheet'!A1%3AB2",
  },
] as const;

const writeKey = (request: ProviderRequest, url: URL) => `${request.method} ${url.pathname}`;

describe('Google suite changes: the rules every one follows', () => {
  for (const change of CHANGES) {
    describe(change.tool, () => {
      it('is accepted when Google answers 2xx, after exactly one change request', async () => {
        const fake = google((request, url) =>
          writeKey(request, url) === change.write
            ? json({ id: 'created1', message: { id: 'msg1' } })
            : json({}, 500),
        );
        const result = await fake.send(intent(change.tool, change.payload));
        expect(result).toMatchObject({
          outcome: 'accepted',
          code: 'ACCEPTED_BY_PROVIDER',
          providerStatus: 200,
        });
        expect(fake.requests.filter((r) => r.request.method !== 'GET')).toHaveLength(1);
      });

      it('is not sent, and contacts nobody, without its scope', async () => {
        const fake = google(
          () => json({}),
          ALL_SCOPES.filter((each) => each !== scope(change.scope)),
        );
        expect(await fake.send(intent(change.tool, change.payload))).toEqual({
          outcome: 'not_sent',
          code: 'AUTH_FAILED',
          retryable: false,
        });
        expect(fake.requests).toHaveLength(0);
      });

      it('is not sent as PAYLOAD_CHANGED when the payload no longer fits the schema', async () => {
        const fake = google(() => json({}));
        for (const payload of [
          { ...change.payload, extra: 'field' },
          { ...change.payload, connection_id: CONNECTION },
          'not an object',
        ]) {
          expect(await fake.send(intent(change.tool, payload))).toEqual({
            outcome: 'not_sent',
            code: 'PAYLOAD_CHANGED',
            retryable: false,
          });
        }
        expect(
          await fake.send({ ...intent(change.tool, change.payload), toolVersion: '2' }),
        ).toMatchObject({
          outcome: 'not_sent',
          code: 'PAYLOAD_CHANGED',
        });
        expect(fake.requests).toHaveLength(0);
      });

      it('is indeterminate when the change request times out after it was written', async () => {
        const fake = google((request, url) => {
          if (writeKey(request, url) === change.write)
            throw new ProviderHttpFailed('PROVIDER_TIMEOUT');
          return json({}, 500);
        });
        expect(await fake.send(intent(change.tool, change.payload))).toEqual({
          outcome: 'indeterminate',
          code: 'TIMEOUT_AFTER_COMMIT',
        });
      });

      it('is indeterminate when the runtime deadline passes while Google holds the request', async () => {
        const fake = google(
          (request) =>
            new Promise((_, reject) =>
              request.signal.addEventListener('abort', () =>
                reject(new ProviderHttpFailed('PROVIDER_TIMEOUT')),
              ),
            ),
        );
        const { signal: _signal, ...context } = fake.context;
        const result = await runSend({
          connector: fake.connector,
          context,
          request: intent(change.tool, change.payload),
          deadlineMs: 50,
        });
        expect(result).toEqual({ outcome: 'indeterminate', code: 'TIMEOUT_AFTER_COMMIT' });
      });

      it('is certain nothing went when the connection or TLS failed before the request', async () => {
        for (const code of ['PROVIDER_CONNECT_FAILED', 'PROVIDER_TLS_FAILED'] as const) {
          const fake = google(() => {
            throw new ProviderHttpFailed(code);
          });
          expect(await fake.send(intent(change.tool, change.payload))).toMatchObject({
            outcome: 'not_sent',
            retryable: true,
          });
        }
      });

      it('maps Google statuses to codes, never to provider text', async () => {
        const cases: [ProviderResponse, Record<string, unknown>][] = [
          [
            googleError(401, 'authError'),
            { outcome: 'not_sent', code: 'AUTH_FAILED', retryable: true },
          ],
          [
            googleError(403, 'insufficientPermissions', {
              'www-authenticate': 'Bearer error="insufficient_scope"',
            }),
            { outcome: 'not_sent', code: 'AUTH_FAILED', retryable: false },
          ],
          [
            googleError(403, 'userRateLimitExceeded'),
            { outcome: 'not_sent', code: 'RELAY_BUSY', retryable: true },
          ],
          [
            googleError(429, 'rateLimitExceeded'),
            { outcome: 'not_sent', code: 'RELAY_BUSY', retryable: true },
          ],
          [googleError(403, 'forbidden'), { outcome: 'rejected', code: 'REFUSED_BY_PROVIDER' }],
          [googleError(400, 'badRequest'), { outcome: 'rejected', code: 'REFUSED_BY_PROVIDER' }],
          [
            googleError(503, 'backendError'),
            { outcome: 'indeterminate', code: 'CONNECTION_LOST_AFTER_COMMIT' },
          ],
        ];
        for (const [response, expected] of cases) {
          const fake = google(() => response);
          const result = await fake.send(intent(change.tool, change.payload));
          expect(result).toMatchObject({ ...expected, providerStatus: response.status });
          expect(JSON.stringify(result)).not.toContain('provider words');
        }
      });

      it('reconciles to cannot_answer when Google is unavailable', async () => {
        const fake = google(() => json({}, 503));
        expect(await fake.reconcile(intent(change.tool, change.payload))).toEqual({
          answer: 'cannot_answer',
        });
      });
    });
  }
});

describe('gmail.send and gmail.create_draft', () => {
  it('sends RFC 5322 with the intent Message-ID as base64url raw, and nothing a reviewer did not approve', async () => {
    const fake = google(() => json({ id: 'sent1' }));
    const result = await fake.send(
      intent('gmail.send', {
        message: { ...MAIL.message, bcc: ['cy@example.invalid'], subject: 'Grüße' },
      }),
    );
    expect(result).toMatchObject({ outcome: 'accepted', externalId: 'sent1' });
    const { request, body } = fake.requests[0]!;
    expect(request.route).toBe('google_gmail');
    expect(JSON.parse(body)).toEqual({ raw: expect.stringMatching(/^[A-Za-z0-9_-]+$/) });
    const raw = rawOf(body);
    expect(raw).toContain(`Message-ID: ${messageId()}\r\n`);
    expect(raw).toContain('To: ana@example.invalid\r\n');
    expect(raw).toContain('Cc: ben@example.invalid\r\n');
    expect(raw).toContain('Bcc: cy@example.invalid\r\n');
    expect(raw).toContain('Subject: =?utf-8?B?');
    expect(raw).not.toMatch(/^From:/m);
    const [, encoded] = raw.split('\r\n\r\n');
    expect(Buffer.from(encoded!.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Body text');
  });

  it('refuses header injection: any line-breaking character in a header value is PAYLOAD_CHANGED, unsent', async () => {
    const fake = google(() => json({ id: 'sent1' }));
    for (const subject of ['Hi\u000bBcc: x@example.invalid', 'Hi there', 'Hi\fthere']) {
      expect(
        await fake.send(intent('gmail.send', { message: { ...MAIL.message, subject } })),
      ).toEqual({
        outcome: 'not_sent',
        code: 'PAYLOAD_CHANGED',
        retryable: false,
      });
    }
    // The schema refuses CR and LF before the builder sees them, and the builder refuses them again.
    expect(
      await fake.send(
        intent('gmail.send', { message: { ...MAIL.message, subject: 'a\r\nBcc: b' } }),
      ),
    ).toMatchObject({
      outcome: 'not_sent',
      code: 'PAYLOAD_CHANGED',
    });
    expect(() =>
      buildGmailMessage({
        payload: {
          to: ['ana@example.invalid'],
          subject: 'a\r\nBcc: evil@example.invalid',
          text_body: 'x',
        },
        messageId: messageId(),
        date: new Date(0),
      }),
    ).toThrow(UnsafeGmailMessage);
    expect(() =>
      buildGmailMessage({
        payload: {
          to: ['ana@example.invalid>, evil@example.invalid'],
          subject: 'a',
          text_body: 'x',
        },
        messageId: messageId(),
        date: new Date(0),
      }),
    ).toThrow(UnsafeGmailMessage);
    expect(fake.requests).toHaveLength(0);
  });

  it('threads a reply from the answered message, and a gone message is PAYLOAD_CHANGED before any send', async () => {
    const fake = google((request, url) => {
      if (request.method === 'GET' && url.pathname.endsWith('/messages/orig1'))
        return json({
          id: 'orig1',
          threadId: 'thread1',
          payload: {
            headers: [
              { name: 'Message-ID', value: '<orig@example.invalid>' },
              { name: 'References', value: '<root@example.invalid>' },
            ],
          },
        });
      if (request.method === 'GET') return json({}, 404);
      return json({ id: 'sent2' });
    });
    await fake.send(intent('gmail.send', { message: { ...MAIL.message, in_reply_to: 'orig1' } }));
    const sent = fake.requests.find((r) => r.request.method === 'POST')!;
    expect(JSON.parse(sent.body).threadId).toBe('thread1');
    const raw = rawOf(sent.body);
    expect(raw).toContain('In-Reply-To: <orig@example.invalid>\r\n');
    expect(raw).toContain('References: <root@example.invalid> <orig@example.invalid>\r\n');

    const gone = google((request) =>
      request.method === 'GET' ? json({}, 404) : json({ id: 'x' }),
    );
    expect(
      await gone.send(
        intent('gmail.send', { message: { ...MAIL.message, in_reply_to: 'missing' } }),
      ),
    ).toEqual({
      outcome: 'not_sent',
      code: 'PAYLOAD_CHANGED',
      retryable: false,
    });
    expect(gone.requests.every((r) => r.request.method === 'GET')).toBe(true);
  });

  it('sends nothing, and contacts nobody, without a Message-ID domain', async () => {
    const fake = google(() => json({ id: 'sent1' }), ALL_SCOPES, { messageIdDomain: null });
    for (const tool of ['gmail.send', 'gmail.create_draft']) {
      expect(await fake.send(intent(tool, MAIL))).toEqual({
        outcome: 'not_sent',
        code: 'CONNECTOR_UNAVAILABLE',
        retryable: false,
      });
    }
    expect(fake.requests).toHaveLength(0);
    expect(() =>
      createGoogleWorkspaceConnector({
        http: { request: async () => json({}) },
        messageIdDomain: 'bad domain',
      }),
    ).toThrow('MAIL_ID_DOMAIN_INVALID');
  });

  it('creates a draft only: drafts.create, never messages.send', async () => {
    const fake = google(() => json({ id: 'draft1', message: { id: 'm1' } }));
    expect(await fake.send(intent('gmail.create_draft', MAIL))).toMatchObject({
      outcome: 'accepted',
      externalId: 'draft1',
    });
    expect(fake.requests.map((r) => r.url.pathname)).toEqual(['/gmail/v1/users/me/drafts']);
    expect(rawOf(fake.requests[0]!.body)).toContain(`Message-ID: ${messageId()}`);
  });

  it('reconciles a send by searching Sent for its Message-ID, and a draft by searching Drafts', async () => {
    const term = `rfc822msgid:${INTENT}@${MAIL_DOMAIN}`;
    const found = google(() => json({ messages: [{ id: 'sent9', threadId: 't' }] }));
    expect(await found.reconcile(intent('gmail.send', MAIL))).toEqual({
      answer: 'found',
      externalId: 'sent9',
    });
    expect(found.requests[0]!.url.searchParams.get('q')).toBe(`in:sent ${term}`);
    const missing = google(() => json({ resultSizeEstimate: 0 }));
    expect(await missing.reconcile(intent('gmail.send', MAIL))).toEqual({ answer: 'not_found' });

    const draft = google(() => json({ drafts: [{ id: 'draft9' }] }));
    expect(await draft.reconcile(intent('gmail.create_draft', MAIL))).toEqual({
      answer: 'found',
      externalId: 'draft9',
    });
    expect(draft.requests[0]!.url.pathname).toBe('/gmail/v1/users/me/drafts');
    expect(draft.requests[0]!.url.searchParams.get('q')).toBe(term);
  });
});

describe('calendar.create_event', () => {
  const id = calendarEventId(idempotencyKeyFor(INTENT));

  it('derives an event ID in Calendar base32hex alphabet, the same on every attempt', () => {
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(calendarEventId(idempotencyKeyFor(INTENT))).toBe(id);
    expect(calendarEventId(idempotencyKeyFor('00000000-0000-4000-8000-000000000b09'))).not.toBe(id);
  });

  it('sends the exact event with the derived ID, and tells the attendees', async () => {
    const fake = google(() => json({ id }));
    expect(await fake.send(intent('calendar.create_event', EVENT))).toMatchObject({
      outcome: 'accepted',
      externalId: id,
    });
    const { url, body, request } = fake.requests[0]!;
    expect(request.route).toBe('google_api');
    expect(url.searchParams.get('sendUpdates')).toBe('all');
    expect(JSON.parse(body)).toEqual({
      id,
      summary: 'Review',
      description: 'Agenda',
      start: { dateTime: '2026-11-12T10:00:00Z', timeZone: 'Europe/London' },
      end: { dateTime: '2026-11-12T11:00:00Z', timeZone: 'Europe/London' },
      attendees: [{ email: 'ana@example.invalid' }],
    });
    // Exactly as the approved payload says, whoever is on the event.
    for (const [value, wire] of [
      ['none', 'none'],
      ['external_only', 'externalOnly'],
    ] as const) {
      const quiet = google(() => json({ id }));
      await quiet.send(intent('calendar.create_event', { ...EVENT, send_updates: value }));
      expect(quiet.requests[0]!.url.searchParams.get('sendUpdates')).toBe(wire);
    }
  });

  it('treats a 409 for its own ID as accepted once the event is read back, and unknown if it is not', async () => {
    const exists = google((request) =>
      request.method === 'POST' ? googleError(409, 'duplicate') : json({ id }),
    );
    expect(await exists.send(intent('calendar.create_event', EVENT))).toEqual({
      outcome: 'accepted',
      code: 'ACCEPTED_BY_PROVIDER',
      providerStatus: 409,
      externalId: id,
    });
    expect(exists.requests[1]!.url.pathname).toBe(`/calendar/v3/calendars/primary/events/${id}`);

    const unclear = google((request) =>
      request.method === 'POST' ? googleError(409, 'duplicate') : json({}, 503),
    );
    expect(await unclear.send(intent('calendar.create_event', EVENT))).toMatchObject({
      outcome: 'indeterminate',
    });
  });

  it('reconciles authoritatively: found by ID, a 404 for that ID is not_found, a deleted one was made', async () => {
    const found = google(() => json({ id, status: 'confirmed' }));
    expect(await found.reconcile(intent('calendar.create_event', EVENT))).toEqual({
      answer: 'found',
      externalId: id,
    });
    expect(found.requests[0]!.url.pathname).toBe(`/calendar/v3/calendars/primary/events/${id}`);
    const missing = google(() => googleError(404, 'notFound'));
    expect(await missing.reconcile(intent('calendar.create_event', EVENT))).toEqual({
      answer: 'not_found',
    });
    const deleted = google(() => googleError(410, 'deleted'));
    expect(await deleted.reconcile(intent('calendar.create_event', EVENT))).toEqual({
      answer: 'found',
      externalId: id,
    });
    const timeout = google(() => {
      throw new ProviderHttpFailed('PROVIDER_TIMEOUT');
    });
    expect(await timeout.reconcile(intent('calendar.create_event', EVENT))).toEqual({
      answer: 'cannot_answer',
    });
  });
});

describe('calendar.update_event', () => {
  it('patches exactly the fields in the payload', async () => {
    const fake = google(() => json({ id: 'evt123' }));
    expect(await fake.send(intent('calendar.update_event', UPDATE))).toMatchObject({
      outcome: 'accepted',
      externalId: 'evt123',
    });
    expect(JSON.parse(fake.requests[0]!.body)).toEqual({
      summary: 'Moved',
      start: { dateTime: '2026-11-12T12:00:00Z' },
      end: { dateTime: '2026-11-12T13:00:00Z' },
    });
    const zone = google(() => json({ id: 'evt123' }));
    await zone.send(
      intent('calendar.update_event', {
        ...UPDATE,
        changes: { time_zone: 'Asia/Tokyo', attendees: [] },
      }),
    );
    expect(JSON.parse(zone.requests[0]!.body)).toEqual({
      start: { timeZone: 'Asia/Tokyo' },
      end: { timeZone: 'Asia/Tokyo' },
      attendees: [],
    });
  });

  it('tells attendees of the change exactly as the payload says', async () => {
    for (const [value, wire] of [
      ['all', 'all'],
      ['external_only', 'externalOnly'],
      ['none', 'none'],
    ] as const) {
      const fake = google(() => json({ id: 'evt123' }));
      await fake.send(intent('calendar.update_event', { ...UPDATE, send_updates: value }));
      expect(fake.requests[0]!.url.searchParams.get('sendUpdates')).toBe(wire);
    }
  });

  it('a 404 for the event is rejected, final', async () => {
    const fake = google(() => googleError(404, 'notFound'));
    expect(await fake.send(intent('calendar.update_event', UPDATE))).toMatchObject({
      outcome: 'rejected',
    });
  });

  it('reconciles by reading the event: found when it carries every change, not_found otherwise', async () => {
    const after = {
      id: 'evt123',
      summary: 'Moved',
      start: { dateTime: '2026-11-12T12:00:00.000Z' },
      end: { dateTime: '2026-11-12T13:00:00Z' },
    };
    expect(
      await google(() => json(after)).reconcile(intent('calendar.update_event', UPDATE)),
    ).toEqual({
      answer: 'found',
      externalId: 'evt123',
    });
    expect(
      await google(() => json({ ...after, summary: 'Old' })).reconcile(
        intent('calendar.update_event', UPDATE),
      ),
    ).toEqual({
      answer: 'not_found',
    });
  });
});

describe('drive.create_file', () => {
  it('uploads multipart with the intent ID in an app property', async () => {
    const fake = google(() => json({ id: 'file1' }));
    expect(
      await fake.send(intent('drive.create_file', { ...FILE, parent_id: 'folder1' })),
    ).toMatchObject({
      outcome: 'accepted',
      externalId: 'file1',
    });
    const { request, url, body } = fake.requests[0]!;
    expect(url.searchParams.get('uploadType')).toBe('multipart');
    const boundary = /boundary=(\S+)/.exec(request.headers!['content-type']!)![1]!;
    const [, metadata, media] = body.split(`--${boundary}`);
    expect(JSON.parse(metadata!.split('\r\n\r\n')[1]!)).toEqual({
      name: 'notes.txt',
      mimeType: 'text/plain',
      parents: ['folder1'],
      appProperties: { [DRIVE_INTENT_PROPERTY]: INTENT },
    });
    expect(media).toContain('\r\n\r\nhello\r\n');
  });

  it('refuses a body over the request limit before any contact', async () => {
    const fake = google(() => json({ id: 'file1' }));
    expect(
      await fake.send(intent('drive.create_file', { ...FILE, text: '€'.repeat(400_000) })),
    ).toEqual({
      outcome: 'not_sent',
      code: 'PAYLOAD_CHANGED',
      retryable: false,
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('reconciles by searching for the app property', async () => {
    const found = google(() => json({ files: [{ id: 'file7' }] }));
    expect(await found.reconcile(intent('drive.create_file', FILE))).toEqual({
      answer: 'found',
      externalId: 'file7',
    });
    expect(found.requests[0]!.url.searchParams.get('q')).toBe(
      `appProperties has { key='${DRIVE_INTENT_PROPERTY}' and value='${INTENT}' }`,
    );
    expect(
      await google(() => json({ files: [] })).reconcile(intent('drive.create_file', FILE)),
    ).toEqual({
      answer: 'not_found',
    });
  });
});

describe('docs.edit', () => {
  it('sends batchUpdate with writeControl.requiredRevisionId from the payload', async () => {
    const fake = google(() =>
      json({ documentId: 'doc1', writeControl: { requiredRevisionId: 'rev2' } }),
    );
    expect(await fake.send(intent('docs.edit', EDIT))).toMatchObject({
      outcome: 'accepted',
      externalId: 'doc1',
    });
    expect(fake.requests[0]!.request.route).toBe('google_docs');
    expect(JSON.parse(fake.requests[0]!.body)).toEqual({
      requests: [
        { insertText: { location: { index: 1 }, text: 'Hi' } },
        { replaceAllText: { containsText: { text: 'a', matchCase: true }, replaceText: 'b' } },
        { deleteContentRange: { range: { startIndex: 2, endIndex: 4 } } },
      ],
      writeControl: { requiredRevisionId: 'rev1' },
    });
  });

  it('a refused revision (400) is rejected, which is final and never retried', async () => {
    const fake = google(() => googleError(400, 'failedPrecondition'));
    expect(await fake.send(intent('docs.edit', EDIT))).toEqual({
      outcome: 'rejected',
      code: 'REFUSED_BY_PROVIDER',
      providerStatus: 400,
    });
  });

  it('refuses an empty delete range before any contact', async () => {
    const fake = google(() => json({}));
    const edits = [{ kind: 'delete_range', start_index: 4, end_index: 4 }];
    expect(await fake.send(intent('docs.edit', { ...EDIT, edits }))).toMatchObject({
      outcome: 'not_sent',
      code: 'PAYLOAD_CHANGED',
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('reconciles by reading the revision: unchanged is not_found, moved on cannot say', async () => {
    expect(
      await google(() => json({ revisionId: 'rev1' })).reconcile(intent('docs.edit', EDIT)),
    ).toEqual({ answer: 'not_found' });
    expect(
      await google(() => json({ revisionId: 'rev2' })).reconcile(intent('docs.edit', EDIT)),
    ).toEqual({
      answer: 'cannot_answer',
    });
  });
});

describe('sheets.write_range', () => {
  it('writes values.update with valueInputOption from the payload', async () => {
    const raw = google(() => json({ updatedCells: 3 }));
    expect(await raw.send(intent('sheets.write_range', WRITE))).toMatchObject({
      outcome: 'accepted',
      externalId: 'sheet1',
    });
    expect(raw.requests[0]!.request.method).toBe('PUT');
    expect(raw.requests[0]!.url.searchParams.get('valueInputOption')).toBe('RAW');
    expect(JSON.parse(raw.requests[0]!.body)).toEqual({
      majorDimension: 'ROWS',
      values: WRITE.values,
    });
    const typed = google(() => json({ updatedCells: 3 }));
    await typed.send(intent('sheets.write_range', { ...WRITE, value_input: 'user_entered' }));
    expect(typed.requests[0]!.url.searchParams.get('valueInputOption')).toBe('USER_ENTERED');
  });

  it('reconciles by reading the range back, skipping cells written as null', async () => {
    const same = google(() =>
      json({
        values: [
          ['a', 1],
          [true, 'anything'],
        ],
      }),
    );
    expect(await same.reconcile(intent('sheets.write_range', WRITE))).toEqual({
      answer: 'found',
      externalId: 'sheet1',
    });
    expect(same.requests[0]!.url.searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE');
    expect(
      await google(() => json({ values: [['a', 2]] })).reconcile(
        intent('sheets.write_range', WRITE),
      ),
    ).toEqual({
      answer: 'not_found',
    });
  });
});

// --- Reads.

const READS = [
  { tool: 'gmail.search', args: { query: 'from:ana', max_results: 5 }, scope: 'gmail.readonly' },
  { tool: 'gmail.read_thread', args: { thread_id: 'thread1' }, scope: 'gmail.readonly' },
  {
    tool: 'calendar.list_events',
    args: {
      calendar_id: 'primary',
      time_min: '2026-11-12T00:00:00Z',
      time_max: '2026-11-13T00:00:00Z',
      max_results: 10,
    },
    scope: 'calendar.events',
  },
  {
    tool: 'drive.search',
    args: { query: 'budget', max_results: 5 },
    scope: 'drive.metadata.readonly',
  },
  { tool: 'docs.read', args: { document_id: 'doc1' }, scope: 'documents' },
  {
    tool: 'sheets.read_range',
    args: { spreadsheet_id: 'sheet1', range: 'A1:B2' },
    scope: 'spreadsheets',
  },
] as const;

describe('Google suite reads: the rules every one follows', () => {
  for (const read of READS) {
    describe(read.tool, () => {
      it('refuses SCOPE_NOT_GRANTED, contacting nobody, without its scope', async () => {
        const fake = google(
          () => json({}),
          ALL_SCOPES.filter((each) => each !== scope(read.scope)),
        );
        await expect(fake.read(read.tool, read.args)).rejects.toMatchObject({
          name: 'SuiteReadRefused',
          code: 'SCOPE_NOT_GRANTED',
        });
        expect(fake.requests).toHaveLength(0);
      });

      it('refuses arguments that do not fit the schema', async () => {
        const fake = google(() => json({}));
        await expect(fake.read(read.tool, { ...read.args, extra: true })).rejects.toMatchObject({
          code: 'TOOL_ARGS_INVALID',
        });
      });

      it('maps Google statuses to a refusal or a retry, with codes only', async () => {
        const cases: [ProviderResponse, string, string][] = [
          [googleError(403, 'insufficientPermissions'), 'SuiteReadRefused', 'SCOPE_NOT_GRANTED'],
          [googleError(403, 'forbidden'), 'SuiteReadRefused', 'PROVIDER_REFUSED'],
          [googleError(404, 'notFound'), 'SuiteReadRefused', 'PROVIDER_NOT_FOUND'],
          [googleError(400, 'invalid'), 'SuiteReadRefused', 'PROVIDER_REFUSED'],
          [googleError(401, 'authError'), 'SyncUnavailable', 'CREDENTIAL_REJECTED'],
          [googleError(429, 'rateLimitExceeded'), 'SyncUnavailable', 'RATE_LIMITED'],
          [googleError(403, 'userRateLimitExceeded'), 'SyncUnavailable', 'RATE_LIMITED'],
          [googleError(500, 'backendError'), 'SyncUnavailable', 'PROVIDER_UNAVAILABLE'],
        ];
        for (const [response, name, code] of cases) {
          const error = await google(() => response)
            .read(read.tool, read.args)
            .catch((caught: Error) => caught);
          expect(error).toMatchObject({ name, code });
          expect((error as Error).message).toBe(code);
        }
      });

      it('refuses TOOL_OUTPUT_TOO_LARGE when the response is over the client limit', async () => {
        const fake = google(() => {
          throw new ProviderHttpFailed('PROVIDER_RESPONSE_TOO_LARGE');
        });
        await expect(fake.read(read.tool, read.args)).rejects.toMatchObject({
          code: 'TOOL_OUTPUT_TOO_LARGE',
        });
      });
    });
  }
});

describe('gmail.search', () => {
  it('lists then reads metadata, member mail is confidential with no resource IDs', async () => {
    const fake = google((_request, url) => {
      if (url.pathname === '/gmail/v1/users/me/messages')
        return json({
          messages: [
            { id: 'm1', threadId: 't1' },
            { id: 'gone', threadId: 't2' },
          ],
        });
      if (url.pathname.endsWith('/gone')) return json({}, 404);
      return json({
        id: 'm1',
        threadId: 't1',
        snippet: 'It&#39;s ready &amp; waiting',
        payload: {
          headers: [
            { name: 'From', value: 'Ana <ana@example.invalid>' },
            { name: 'Subject', value: 'Plan\r\nInjected: header' },
          ],
        },
      });
    });
    const result = await fake.read('gmail.search', { query: 'plan', max_results: 2 });
    expect(result.classification).toBe('confidential');
    expect(result.resourceExternalIds).toEqual([]);
    expect(result.mediaType).toBe('application/json');
    expect(decodeJson(result.bytes)).toEqual({
      messages: [
        {
          id: 'm1',
          thread_id: 't1',
          from: 'Ana <ana@example.invalid>',
          to: '',
          subject: 'Plan Injected: header',
          date: '',
          snippet: "It's ready & waiting",
        },
      ],
      truncated: false,
    });
    expect(fake.requests[0]!.url.searchParams.get('q')).toBe('plan');
    expect(fake.requests[1]!.url.searchParams.getAll('metadataHeaders')).toEqual([
      'From',
      'To',
      'Subject',
      'Date',
    ]);
  });
});

describe('gmail.read_thread', () => {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

  it('keeps plain text, turns HTML into text, skips attachments and fetches nothing else', async () => {
    const fake = google(() =>
      json({
        id: 'thread1',
        messages: [
          {
            id: 'm1',
            payload: {
              mimeType: 'multipart/mixed',
              headers: [{ name: 'From', value: 'ana@example.invalid' }],
              parts: [
                {
                  mimeType: 'multipart/alternative',
                  parts: [
                    {
                      mimeType: 'text/html',
                      body: {
                        data: b64(
                          '<p>Hi <a href="https://x.invalid/track">there</a></p><script>bad()</script>',
                        ),
                      },
                    },
                  ],
                },
                {
                  mimeType: 'text/plain',
                  filename: 'secret.txt',
                  body: { attachmentId: 'att1', size: 10 },
                },
              ],
            },
          },
          { id: 'm2', payload: { mimeType: 'text/plain', body: { data: b64('Plain reply') } } },
        ],
      }),
    );
    const result = await fake.read('gmail.read_thread', { thread_id: 'thread1' });
    const output = decodeJson(result.bytes) as { messages: { body: string }[]; truncated: boolean };
    expect(output.messages.map((m) => m.body)).toEqual(['Hi there', 'Plain reply']);
    expect(JSON.stringify(output)).not.toContain('x.invalid');
    expect(output.truncated).toBe(false);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.url.searchParams.get('format')).toBe('full');
    expect(result.classification).toBe('confidential');
  });

  it('cuts long bodies at a clean boundary with a marker so the output fits the tool limit', async () => {
    const long = 'word '.repeat(400_000);
    const fake = google(() =>
      json({
        messages: [{ id: 'm1', payload: { mimeType: 'text/plain', body: { data: b64(long) } } }],
      }),
    );
    const result = await fake.read('gmail.read_thread', { thread_id: 'thread1' });
    expect(result.bytes.length).toBeLessThanOrEqual(1_048_576);
    expect(result.bytes.length).toBeGreaterThan(1_000_000);
    const output = decodeJson(result.bytes) as { messages: { body: string }[]; truncated: boolean };
    expect(output.truncated).toBe(true);
    expect(output.messages[0]!.body.endsWith(`word${TRUNCATION_MARKER}`)).toBe(true);
  });
});

describe('calendar.list_events', () => {
  it('lists single events in the window with HTML descriptions as text', async () => {
    const fake = google(() =>
      json({
        items: [
          {
            id: 'e1',
            status: 'confirmed',
            summary: 'Standup',
            description: '<b>Agenda</b><br>Notes',
            start: { dateTime: '2026-11-12T09:00:00Z', timeZone: 'UTC' },
            end: { dateTime: '2026-11-12T09:15:00Z' },
            attendees: [{ email: 'ana@example.invalid', responseStatus: 'accepted' }],
          },
        ],
      }),
    );
    const result = await fake.read('calendar.list_events', READS[2].args);
    const output = decodeJson(result.bytes) as { events: Record<string, unknown>[] };
    expect(output.events[0]).toMatchObject({
      id: 'e1',
      description: 'Agenda\nNotes',
      start: { at: '2026-11-12T09:00:00Z', time_zone: 'UTC' },
      attendees: [{ email: 'ana@example.invalid', response: 'accepted' }],
    });
    const url = fake.requests[0]!.url;
    expect(url.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.get('timeMin')).toBe('2026-11-12T00:00:00Z');
    expect(result.classification).toBe('confidential');
  });
});

describe('drive.search', () => {
  const files = {
    files: [
      { id: 'f1', name: 'Budget' },
      { id: 'f2', name: 'Secret budget' },
      { id: 'f3', name: 'Budget 2' },
    ],
  };

  it('through the organization connection keeps only what the initiator may read, and names each kept', async () => {
    const asked: string[][] = [];
    const access: SuiteResourceAccess = {
      permitted: async (ids) => {
        asked.push([...ids]);
        return new Set(ids.filter((id) => id !== 'f2'));
      },
    };
    const fake = google(() => json(files));
    const result = await fake.read(
      'drive.search',
      { query: "Q3 'plan' \\ x", max_results: 5 },
      access,
    );
    expect(asked).toEqual([['f1', 'f2', 'f3']]);
    expect(result.resourceExternalIds).toEqual(['f1', 'f3']);
    expect(result.classification).toBe('internal');
    expect(JSON.stringify(decodeJson(result.bytes))).not.toContain('Secret');
    expect(fake.requests[0]!.url.searchParams.get('q')).toBe(
      "fullText contains 'Q3 \\'plan\\' \\\\ x' and trashed = false",
    );
  });

  it('drops past max_results after filtering', async () => {
    const access: SuiteResourceAccess = { permitted: async (ids) => new Set(ids) };
    const result = await google(() => json(files)).read(
      'drive.search',
      { query: 'b', max_results: 2 },
      access,
    );
    expect(result.resourceExternalIds).toEqual(['f1', 'f2']);
  });
});

describe('docs.read', () => {
  it('returns the text, the revision for docs.edit, and the document ID', async () => {
    const fake = google(() =>
      json({
        documentId: 'doc1',
        title: 'Plan',
        revisionId: 'rev9',
        body: {
          content: [
            {
              paragraph: {
                elements: [{ textRun: { content: 'Hello ' } }, { textRun: { content: 'world\n' } }],
              },
            },
            {
              table: {
                tableRows: [
                  {
                    tableCells: [
                      { content: [{ paragraph: { elements: [{ textRun: { content: 'a\n' } }] } }] },
                      { content: [{ paragraph: { elements: [{ textRun: { content: 'b\n' } }] } }] },
                    ],
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const result = await fake.read('docs.read', { document_id: 'doc1' });
    expect(decodeJson(result.bytes)).toEqual({
      document_id: 'doc1',
      title: 'Plan',
      revision_id: 'rev9',
      text: 'Hello world\na\tb\n',
      truncated: false,
    });
    expect(result.resourceExternalIds).toEqual(['doc1']);
    expect(result.classification).toBe('internal');
    expect(fake.requests[0]!.request.route).toBe('google_docs');
  });

  it("classes a member's own document and sheet as confidential", async () => {
    const own = { ownerKind: 'member' as const };
    const doc = google(() => json({ title: 'Mine', body: { content: [] } }), ALL_SCOPES, own);
    expect((await doc.read('docs.read', { document_id: 'doc1' })).classification).toBe(
      'confidential',
    );
    const sheet = google(() => json({ range: 'A1', values: [] }), ALL_SCOPES, own);
    expect(
      (await sheet.read('sheets.read_range', { spreadsheet_id: 'sheet1', range: 'A1' }))
        .classification,
    ).toBe('confidential');
  });
});

describe('sheets.read_range', () => {
  it('reads the range and cuts whole rows to fit', async () => {
    const fake = google(() => json({ range: 'Sheet1!A1:B2', values: [['a', 1], [true]] }));
    const result = await fake.read('sheets.read_range', {
      spreadsheet_id: 'sheet1',
      range: 'Sheet1!A1:B2',
    });
    expect(decodeJson(result.bytes)).toEqual({
      spreadsheet_id: 'sheet1',
      range: 'Sheet1!A1:B2',
      values: [['a', 1], [true]],
      truncated: false,
    });
    expect(fake.requests[0]!.url.pathname).toBe('/v4/spreadsheets/sheet1/values/Sheet1!A1%3AB2');
    expect(result.resourceExternalIds).toEqual(['sheet1']);

    const rows = Array.from({ length: 2_000 }, () => ['x'.repeat(1_000)]);
    const big = await google(() => json({ values: rows })).read('sheets.read_range', {
      spreadsheet_id: 'sheet1',
      range: 'A:A',
    });
    const output = decodeJson(big.bytes) as { values: unknown[]; truncated: boolean };
    expect(big.bytes.length).toBeLessThanOrEqual(1_048_576);
    expect(output.truncated).toBe(true);
    expect(output.values.length).toBeGreaterThan(1_000);
    expect(output.values.length).toBeLessThan(2_000);
  });
});

describe('text helpers', () => {
  it('htmlToText keeps visible words only and decodes entities', () => {
    expect(
      htmlToText('<style>p{}</style><p>A&nbsp;&lt;b&gt;</p><!-- c --><ul><li>one</li></ul>'),
    ).toBe('A <b>\n- one');
  });

  it('messageText prefers a plain part', () => {
    const data = (text: string) => Buffer.from(text).toString('base64url');
    expect(
      messageText({
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: data('plain') } },
          { mimeType: 'text/html', body: { data: data('<p>html</p>') } },
        ],
      }),
    ).toBe('plain');
  });

  it('cutText never splits a character and marks the cut', () => {
    expect(cutText('ab😀cd', 3)).toEqual({ text: `ab${TRUNCATION_MARKER}`, cut: true });
    expect(cutText('short', 10)).toEqual({ text: 'short', cut: false });
  });
});
