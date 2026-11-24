// The live suite check's arguments, guards and output, over a scripted dispatch with no provider, database
// or broker behind it. Every value here is generated.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SuiteActionHandler, SuiteReadHandler } from '@ensemus/connectors/suites';
import {
  GOOGLE_WORKSPACE_MANIFEST,
  MICROSOFT_365_MANIFEST,
} from '@ensemus/connectors/knowledge-manifests';
import { createSuiteToolDispatch, type SuiteCapableConnector } from '@ensemus/connectors/suites';
import type { DirectoryPage } from '@ensemus/domain/workspace-suites';
import { describe, expect, it, vi } from 'vitest';
import {
  CHECK_FIELDS,
  connectionRefusal,
  DIRECTORY_FIELDS,
  LIVE_CHECK_HEADER,
  liveCheckEnabled,
  optionRefusal,
  parseLiveCheckArgs,
  rangeDimensions,
  recordingHttp,
  runLiveSuiteCheck,
  type LiveCheckOptions,
  type LiveCheckPorts,
} from './live-suite-check-core';

const organization = randomUUID();
const connection = randomUUID();
const base = ['--organization', organization, '--connection', connection];

// Content a provider could return. None of it may reach a line or the report.
const SECRET = {
  subject: 'Quarterly numbers SECRET-SUBJECT',
  name: 'Generated Person SECRET-NAME',
  address: 'secret.person@example.invalid',
  self: 'own.account@example.invalid',
  body: 'SECRET-BODY text of a message',
  thread: 'thread-SECRET-ID',
  event: 'event-SECRET-ID',
  revision: 'revision-SECRET-ID',
  group: 'group-SECRET-ID',
  groupName: 'SECRET-GROUP-NAME',
};

describe('parseLiveCheckArgs', () => {
  it('takes the reads-only form', () => {
    const parsed = parseLiveCheckArgs(base);
    expect(parsed).toEqual({
      ok: true,
      options: expect.objectContaining({
        organizationId: organization,
        connectionId: connection,
        out: null,
        directory: false,
        writes: false,
        sendToSelf: false,
        worksheet: 'Sheet1',
      }),
    });
  });

  it('takes every option', () => {
    const parsed = parseLiveCheckArgs([
      ...base,
      '--out',
      '/tmp/live-check.json',
      '--directory',
      '--writes',
      '--self',
      SECRET.self,
      '--send-to-self',
      '--teams',
      '00000000-1111-2222-3333-444444444444:19:generated@thread.tacv2',
      '--workbook',
      'b!generatedDrive:01GENERATEDITEM',
      '--word',
      'b!generatedDrive:01GENERATEDWORD',
      '--range',
      'A1:C3',
      '--worksheet',
      'Data',
    ]);
    if (!parsed.ok) throw new Error(parsed.code);
    expect(parsed.options).toMatchObject({
      out: '/tmp/live-check.json',
      directory: true,
      writes: true,
      sendToSelf: true,
      self: SECRET.self,
      teams: {
        teamId: '00000000-1111-2222-3333-444444444444',
        channelId: '19:generated@thread.tacv2',
      },
      workbook: { driveId: 'b!generatedDrive', itemId: '01GENERATEDITEM' },
      word: { driveId: 'b!generatedDrive', itemId: '01GENERATEDWORD' },
      range: 'A1:C3',
      worksheet: 'Data',
    });
  });

  it.each([
    [[], 'ORGANIZATION_INVALID'],
    [['--organization', 'not-a-uuid', '--connection', connection], 'ORGANIZATION_INVALID'],
    [['--organization', organization], 'CONNECTION_INVALID'],
    [[...base, '--unknown'], 'ARGS_INVALID'],
    [[...base, 'positional'], 'ARGS_INVALID'],
    [[...base, '--send-to-self'], 'SEND_TO_SELF_NEEDS_WRITES'],
    [[...base, '--teams', 'team:channel'], 'TEAMS_NEEDS_WRITES'],
    [[...base, '--writes'], 'SELF_REQUIRED'],
    [[...base, '--writes', '--self', 'not an address'], 'SELF_INVALID'],
    [[...base, '--sheet', 'generatedSheet'], 'RANGE_REQUIRED'],
    [[...base, '--sheet', 'generatedSheet', '--range', 'A:A'], 'RANGE_INVALID'],
    [[...base, '--sheet', 'generatedSheet', '--range', 'A1:Z10'], 'RANGE_INVALID'],
    [[...base, '--doc', 'has/slash'], 'ID_INVALID'],
    [[...base, '--word', 'no-colon'], 'DRIVE_ITEM_INVALID'],
    [[...base, '--writes', '--self', SECRET.self, '--teams', ':channel'], 'TEAMS_INVALID'],
  ])('refuses %j with %s', (argv, code) => {
    expect(parseLiveCheckArgs(argv)).toEqual({ ok: false, code });
  });

  it('measures bounded ranges only', () => {
    expect(rangeDimensions('A1')).toEqual({ rows: 1, cols: 1 });
    expect(rangeDimensions('Sheet1!B2:D3')).toEqual({ rows: 2, cols: 3 });
    expect(rangeDimensions("'My Sheet'!A1:A10")).toEqual({ rows: 10, cols: 1 });
    expect(rangeDimensions('C3:A1')).toBeNull();
    expect(rangeDimensions('A0')).toBeNull();
    expect(rangeDimensions('A1:J11')).toBeNull();
  });
});

describe('guards', () => {
  it('runs only when ENSEMUS_LIVE_CHECK is exactly 1', () => {
    expect(liveCheckEnabled({ ENSEMUS_LIVE_CHECK: '1' })).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1'])
      expect(liveCheckEnabled({ ENSEMUS_LIVE_CHECK: value })).toBe(false);
  });

  const target = {
    displayName: 'TEST Generated workspace',
    state: 'active',
    connectorType: 'google_workspace',
    credentialSecretId: randomUUID(),
  };

  it('touches only an active suite connection named "TEST ..."', () => {
    expect(connectionRefusal(target)).toBeNull();
    expect(connectionRefusal(null)).toBe('CONNECTION_NOT_FOUND');
    for (const displayName of [
      'Generated workspace',
      'Test Generated',
      'TESTING x',
      ' TEST x',
      'TEST',
    ])
      expect(connectionRefusal({ ...target, displayName })).toBe('CONNECTION_NOT_TEST');
    expect(connectionRefusal({ ...target, connectorType: 'email_smtp' })).toBe(
      'CONNECTOR_NOT_SUITE',
    );
    expect(connectionRefusal({ ...target, state: 'revoked' })).toBe('CONNECTION_NOT_ACTIVE');
    expect(connectionRefusal({ ...target, credentialSecretId: null })).toBe(
      'CREDENTIAL_UNAVAILABLE',
    );
  });

  it("refuses another provider's options", () => {
    const options = (argv: string[]) => {
      const parsed = parseLiveCheckArgs([...base, ...argv]);
      if (!parsed.ok) throw new Error(parsed.code);
      return parsed.options;
    };
    expect(optionRefusal(options(['--doc', 'generatedDoc']), 'microsoft_365')).toBe(
      'OPTION_NOT_FOR_PROVIDER',
    );
    expect(optionRefusal(options(['--word', 'drive:item']), 'google_workspace')).toBe(
      'OPTION_NOT_FOR_PROVIDER',
    );
    expect(optionRefusal(options(['--doc', 'generatedDoc']), 'google_workspace')).toBeNull();
  });
});

describe('recordingHttp', () => {
  it('keeps status classes and byte counts of tool routes, and nothing of the body', async () => {
    const statuses = [200, 200, 404, 201];
    const inner = {
      request: vi.fn(async () => ({
        status: statuses.shift() ?? 500,
        headers: {},
        body: Buffer.from(SECRET.body),
      })),
    };
    const recorder = recordingHttp(inner);
    const request = (route: 'google_api' | 'google_oauth') =>
      recorder.http.request({
        route,
        method: 'GET',
        path: '/generated',
        timeoutMs: 1000,
        maxResponseBytes: 1000,
        signal: AbortSignal.timeout(1000),
      });
    await request('google_oauth');
    await request('google_api');
    await request('google_api');
    const seen = recorder.take();
    expect(seen).toEqual({ status: '2xx+4xx', bytes: SECRET.body.length * 2 });
    expect(JSON.stringify(seen)).not.toContain('SECRET');
    expect(recorder.take()).toEqual({ status: null, bytes: 0 });
  });
});

// --- The run, over createSuiteToolDispatch with scripted handlers that return content.

const json = (value: unknown) => ({
  bytes: Buffer.from(JSON.stringify(value)),
  mediaType: 'application/json' as const,
  classification: 'confidential' as const,
  resourceExternalIds: [],
});

const message = {
  id: 'message-SECRET-ID',
  thread_id: SECRET.thread,
  conversation_id: SECRET.thread,
  subject: SECRET.subject,
  from: `${SECRET.name} <${SECRET.address}>`,
  snippet: SECRET.body,
};

const reads: Record<string, SuiteReadHandler<unknown>> = {
  'gmail.search': async () => json({ messages: [message], truncated: false }),
  'outlook.search': async () => json({ messages: [message], truncated: false }),
  'gmail.read_thread': async () => json({ thread_id: SECRET.thread, messages: [message] }),
  'outlook.read_thread': async () => json({ conversation_id: SECRET.thread, messages: [message] }),
  'calendar.list_events': async () =>
    json({ events: [{ id: SECRET.event, summary: SECRET.subject, organizer: SECRET.address }] }),
  'drive.search': async (_deps, _context, _args, access) => {
    await access?.permitted(['file-SECRET-ID']);
    return json({ files: [{ id: 'file-SECRET-ID', name: SECRET.name }], truncated: false });
  },
  'onedrive.search': async () => json({ files: [{ name: SECRET.name }], truncated: false }),
  'docs.read': async () =>
    json({
      title: SECRET.subject,
      revision_id: SECRET.revision,
      text: `${SECRET.body}\n`,
      truncated: false,
    }),
  'sheets.read_range': async () => json({ values: [[SECRET.name, SECRET.address]] }),
  'word.read': async () => json({ text: SECRET.body }),
  'excel.read_range': async () => json({ values: [[SECRET.name]] }),
};

function scriptedActions(seen: { toolName: string; payload: unknown; key: string }[]) {
  const handler = (tool: string): SuiteActionHandler<unknown> => ({
    async send(_deps, _context, request) {
      seen.push({
        toolName: request.toolName,
        payload: request.payload,
        key: request.idempotencyKey,
      });
      return { outcome: 'accepted', code: 'ACCEPTED_BY_PROVIDER', externalId: SECRET.event };
    },
    async reconcile() {
      return tool === 'docs.edit' || tool === 'teams.post_message'
        ? { answer: 'cannot_answer' }
        : { answer: 'found', externalId: SECRET.event };
    },
  });
  return Object.fromEntries(
    [
      'gmail.create_draft',
      'gmail.send',
      'outlook.create_draft',
      'outlook.send',
      'calendar.create_event',
      'calendar.update_event',
      'docs.edit',
      'sheets.write_range',
      'excel.write_range',
      'teams.post_message',
    ].map((tool) => [tool, handler(tool)]),
  );
}

const directoryPage: DirectoryPage = {
  groups: [
    {
      externalId: SECRET.group,
      displayName: SECRET.groupName,
      members: [
        { kind: 'user', externalId: SECRET.address },
        { kind: 'user', externalId: SECRET.self },
        { kind: 'group', externalId: 'nested-SECRET-ID' },
      ],
    },
  ],
  deletedExternalIds: [],
  nextCursor: null,
  hasMore: false,
  fullSync: true,
};

function harness(connectorType: 'google_workspace' | 'microsoft_365', failRead?: string) {
  const sent: { toolName: string; payload: unknown; key: string }[] = [];
  const dispatch = createSuiteToolDispatch({
    deps: {},
    connectorType,
    reads: failRead
      ? {
          ...reads,
          [failRead]: async () => {
            throw new Error(`provider said ${SECRET.subject}`);
          },
        }
      : reads,
    actions: scriptedActions(sent),
  });
  const connector = {
    manifest:
      connectorType === 'google_workspace' ? GOOGLE_WORKSPACE_MANIFEST : MICROSOFT_365_MANIFEST,
    parseConfig: () => ({ driveIds: [] }),
    ...dispatch,
    directory: { readGroups: async () => directoryPage },
  } as SuiteCapableConnector;
  const lines: string[] = [];
  const permitted = vi.fn(async (ids: readonly string[]) => new Set(ids));
  const matched = vi.fn(async (emails: readonly string[]) => emails.length - 1);
  const context = {
    organizationId: organization,
    connectionId: connection,
    config: { driveIds: [] },
    grantedScopes: [],
    credentials: { withCredential: async () => Promise.reject(new Error('NO_CREDENTIAL')) },
    network: { openRelay: async () => Promise.reject(new Error('NO_NETWORK')) },
  };
  const ports: LiveCheckPorts = {
    connector,
    readContext: () => ({
      ...context,
      signal: AbortSignal.timeout(10_000),
      ownerKind: 'organization',
    }),
    actionContext: () => context,
    access: { permitted },
    matchDirectoryEmails: matched,
    take: () => ({ status: '2xx', bytes: 123 }),
    write: (line) => lines.push(line),
    sleep: async () => undefined,
    now: () => new Date('2026-11-11T10:00:00.000Z'),
    token: () => 'a1b2c3d4',
    uuid: () => randomUUID(),
  };
  return { ports, lines, sent, permitted, matched };
}

const optionsOf = (argv: string[]): LiveCheckOptions => {
  const parsed = parseLiveCheckArgs([...base, ...argv]);
  if (!parsed.ok) throw new Error(parsed.code);
  return parsed.options;
};

function expectNoContent(text: string) {
  for (const value of Object.values(SECRET)) expect(text).not.toContain(value);
  expect(text).not.toMatch(/SECRET/);
}

describe('runLiveSuiteCheck', () => {
  it('prints codes and counts only, for every Google check', async () => {
    const { ports, lines, sent, permitted, matched } = harness('google_workspace');
    const options = optionsOf([
      '--directory',
      '--writes',
      '--self',
      SECRET.self,
      '--send-to-self',
      '--doc',
      'generatedDoc',
      '--sheet',
      'generatedSheet',
      '--range',
      'A1:C3',
    ]);
    const report = await runLiveSuiteCheck(
      options,
      { connectorType: 'google_workspace', ownerKind: 'organization' },
      ports,
    );

    expect(lines[0]).toBe(LIVE_CHECK_HEADER);
    expect(lines.join('\n')).toContain('administrator who may read everything synced');
    expectNoContent(lines.join('\n'));
    expectNoContent(JSON.stringify(report));
    for (const check of report.checks)
      expect(Object.keys(check).sort()).toEqual([...CHECK_FIELDS].sort());
    expect(Object.keys(report.directory ?? {}).sort()).toEqual([...DIRECTORY_FIELDS].sort());

    expect(report.failures).toBe(0);
    expect(report.directory).toMatchObject({ groups: 1, members: 2, nested: 1, matched: 1 });
    expect(matched).toHaveBeenCalledWith([SECRET.address, SECRET.self]);
    expect(permitted).toHaveBeenCalled();
    expect(report.checks.map((check) => `${check.tool} ${check.step} ${check.outcome}`)).toEqual([
      'gmail.search read ok',
      'gmail.read_thread read ok',
      'calendar.list_events read ok',
      'drive.search read ok',
      'docs.read read ok',
      'sheets.read_range read ok',
      'gmail.create_draft send ok',
      'gmail.create_draft reconcile found',
      'calendar.create_event send ok',
      'calendar.create_event resend_same_key ok',
      'calendar.create_event idempotency no_duplicate',
      'calendar.create_event reconcile found',
      'calendar.update_event send ok',
      'calendar.update_event reconcile found',
      'docs.edit send ok',
      'docs.edit reconcile cannot_answer',
      'sheets.write_range send ok',
      'sheets.write_range reconcile found',
      'gmail.send send ok',
      'gmail.send reconcile found',
    ]);

    // Each payload passed the tool's own schema in the dispatch, and the generated ones say so.
    const byTool = new Map(sent.map((item) => [item.toolName, item]));
    expect(byTool.get('calendar.create_event')?.payload).toMatchObject({
      attendees: [],
      send_updates: 'none',
      summary: 'ensemus-live-check a1b2c3d4',
    });
    expect(byTool.get('docs.edit')?.payload).toMatchObject({
      required_revision_id: SECRET.revision,
      edits: [{ kind: 'insert_text', index: SECRET.body.length + 1 }],
    });
    expect(byTool.get('gmail.send')?.payload).toMatchObject({ message: { to: [SECRET.self] } });
    const creates = sent.filter((item) => item.toolName === 'calendar.create_event');
    expect(creates).toHaveLength(2);
    expect(creates[0]?.key).toBe(creates[1]?.key);
    expect(new Set(sent.map((item) => item.key)).size).toBe(sent.length - 1);
  });

  it('runs the Microsoft checks, with send_updates all and Teams', async () => {
    const { ports, lines, sent } = harness('microsoft_365');
    const options = optionsOf([
      '--writes',
      '--self',
      SECRET.self,
      '--teams',
      '00000000-1111-2222-3333-444444444444:19:generated@thread.tacv2',
      '--workbook',
      'b!generatedDrive:01GENERATEDITEM',
      '--word',
      'b!generatedDrive:01GENERATEDWORD',
      '--range',
      'B2:C3',
    ]);
    const report = await runLiveSuiteCheck(
      options,
      { connectorType: 'microsoft_365', ownerKind: 'member' },
      ports,
    );
    expectNoContent(lines.join('\n'));
    expectNoContent(JSON.stringify(report));
    expect(report.failures).toBe(0);
    expect(report.checks.map((check) => check.tool)).toEqual(
      expect.arrayContaining([
        'outlook.search',
        'outlook.read_thread',
        'onedrive.search',
        'word.read',
        'excel.read_range',
        'outlook.create_draft',
        'excel.write_range',
        'teams.post_message',
      ]),
    );
    const byTool = new Map(sent.map((item) => [item.toolName, item]));
    expect(byTool.get('calendar.create_event')?.payload).toMatchObject({ send_updates: 'all' });
    expect(byTool.get('calendar.update_event')?.payload).toMatchObject({ send_updates: 'all' });
    expect(byTool.get('excel.write_range')?.payload).toMatchObject({
      worksheet: 'Sheet1',
      values: [
        ['ensemus-live-check a1b2c3d4 r1c1', 'ensemus-live-check a1b2c3d4 r1c2'],
        ['ensemus-live-check a1b2c3d4 r2c1', 'ensemus-live-check a1b2c3d4 r2c2'],
      ],
    });
  });

  it('counts a failed read as a failure, with its code and not its words', async () => {
    const { ports, lines } = harness('google_workspace', 'calendar.list_events');
    const report = await runLiveSuiteCheck(
      optionsOf([]),
      { connectorType: 'google_workspace', ownerKind: 'organization' },
      ports,
    );
    expect(report.failures).toBe(1);
    expect(report.checks.find((check) => check.tool === 'calendar.list_events')).toMatchObject({
      outcome: 'Error',
      failed: true,
    });
    expectNoContent(lines.join('\n'));
    expect(report.checks.some((check) => check.step === 'send')).toBe(false);
  });
});

describe('the entry', () => {
  it('is bundled on its own and imported by no other source file', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    expect(readFileSync(join(root, 'scripts/build.mjs'), 'utf8')).toContain(
      "'src/live-suite-check.ts'",
    );
    for (const name of readdirSync(join(root, 'src'))) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name === 'live-suite-check.ts')
        continue;
      const text = readFileSync(join(root, 'src', name), 'utf8');
      expect(text, name).not.toMatch(/['"]\.\/live-suite-check(?:-core)?['"]/);
    }
  });
});
