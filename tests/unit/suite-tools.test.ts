// ADR-038 D6's suite tools as data: the invariants every manifest keeps, the intent path that accepts a
// declared action and refuses any other, and the connector side that only ever runs what it declares.
// No database, no network, generated values only.
import { createConnectorGateway } from '@ensemus/workflows/external-action-activities';
import type { PreparedAttempt } from '@ensemus/application';
import {
  actionPayloadOf,
  parseSuiteActionPayload,
  SUITE_TOOL_ARGS_SCHEMAS,
  TOOL_ARGS_SCHEMAS,
} from '@ensemus/contracts/ai-tools';
import { NotSent, type Connector, type ConnectorRegistry } from '@ensemus/connectors';
import { EMAIL_CONNECTOR_MANIFEST } from '@ensemus/connectors/manifest';
import {
  GOOGLE_WORKSPACE_MANIFEST,
  MICROSOFT_365_MANIFEST,
} from '@ensemus/connectors/knowledge-manifests';
import { GOOGLE_ACTION_HANDLERS, GOOGLE_READ_HANDLERS } from '@ensemus/connectors/google/tools';
import {
  MICROSOFT_ACTION_HANDLERS,
  MICROSOFT_READ_HANDLERS,
} from '@ensemus/connectors/microsoft/tools';
import {
  createSuiteToolDispatch,
  notImplemented,
  NotImplementedSend,
  parseMailIdDomain,
  resolveMailIdDomain,
  SuiteReadRefused,
} from '@ensemus/connectors/suites';
import { driveResourceId } from '@ensemus/connectors/microsoft/tools';
import { suitePayloadFits } from '@ensemus/contracts/suite-tools';
import {
  actionToolsFor,
  FORBIDDEN_TOOL_PREFIXES,
  isActionTool,
  isSuiteRule,
  TOOL_IDS,
  TOOL_MANIFESTS,
  toolManifest,
  type ToolConnectorType,
  type ToolManifest,
} from '@ensemus/domain/ai-tools';
import { ACTION_CONNECTOR_TYPES } from '@ensemus/domain/external-action';
import {
  CAPABILITY_OWNER,
  CAPABILITY_SCOPES,
  MEMBER_CONNECTABLE_CAPABILITIES,
} from '@ensemus/domain/workspace-suites';
import { changeNeedsApproval, resourceIdOf } from '@ensemus/policy';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { repoRoot } from '../helpers/stack';

const manifests = TOOL_MANIFESTS as readonly ToolManifest[];
const withConnection = manifests.filter((tool) => tool.connection !== undefined);
const suite = withConnection.filter((tool) => isSuiteRule(tool.connection!));
const CONNECTION = '6f1c2c6e-3333-4333-8333-333333333333';

describe('every tool manifest', () => {
  it('has arguments, and an ID the tables accept and no forbidden prefix allows', () => {
    expect(Object.keys(TOOL_ARGS_SCHEMAS).sort()).toEqual([...TOOL_IDS].sort());
    for (const id of TOOL_IDS) {
      expect(id).toMatch(/^[a-z][a-z0-9_.]{1,63}$/);
      for (const prefix of FORBIDDEN_TOOL_PREFIXES) expect(id.startsWith(prefix)).toBe(false);
    }
    expect(new Set(TOOL_IDS).size).toBe(TOOL_IDS.length);
  });

  it('asks a person before every external write', () => {
    for (const tool of manifests) {
      if (tool.class !== 'external_write') continue;
      expect(tool.requiresApproval, tool.id).toBe(true);
      expect(changeNeedsApproval(tool), tool.id).toBe(true);
    }
  });

  it('keeps email.send exactly as M3 shipped it, now as the first entry on the rule', () => {
    expect(toolManifest('email.send')).toMatchObject({
      id: 'email.send',
      version: '1',
      class: 'external_write',
      requiresApproval: true,
      connection: { connectorTypes: ['email_smtp'], owner: 'organization', resourceAccess: null },
    });
    expect(toolManifest('email.send')?.connection?.bindings.email_smtp).toEqual({
      scopes: [],
      reconcile: 'none',
      nativeIdempotency: false,
    });
  });
});

describe('every tool that works through a connection', () => {
  it('lists exactly the connector types it has terms for, each with its scopes', () => {
    for (const tool of withConnection) {
      const rule = tool.connection!;
      expect(Object.keys(rule.bindings).sort(), tool.id).toEqual([...rule.connectorTypes].sort());
      for (const type of rule.connectorTypes) {
        const binding = rule.bindings[type]!;
        expect(Array.isArray(binding.scopes), tool.id).toBe(true);
        if (type !== 'email_smtp') expect(binding.scopes.length, tool.id).toBeGreaterThan(0);
      }
      expect(rule.maxOutputBytes).toBeGreaterThan(0);
      expect(rule.maxOutputBytes).toBeLessThanOrEqual(1_048_576);
    }
  });

  it('asks only for scopes its capability grants, as ADR-038 D3 maps them', () => {
    for (const tool of suite) {
      const rule = tool.connection!;
      expect(rule.capability, tool.id).not.toBeNull();
      for (const type of rule.connectorTypes) {
        const granted =
          CAPABILITY_SCOPES[type as 'google_workspace' | 'microsoft_365'][rule.capability!];
        for (const scope of rule.bindings[type]!.scopes) expect(granted, tool.id).toContain(scope);
      }
    }
  });

  it('may be owned only as its capability may, and a member-only one never by the organization', () => {
    for (const tool of suite) {
      const rule = tool.connection!;
      const owner = CAPABILITY_OWNER[rule.capability!];
      if (owner === 'member') expect(rule.owner, tool.id).toBe('member');
      if (owner === 'organization') expect(rule.owner, tool.id).toBe('organization');
    }
    for (const capability of MEMBER_CONNECTABLE_CAPABILITIES) {
      expect(CAPABILITY_OWNER[capability]).not.toBe('organization');
    }
  });

  it('names a resource argument only where its arguments have one', () => {
    for (const tool of suite) {
      const rule = tool.connection!;
      if (rule.resourceArg === null) continue;
      expect(rule.resourceAccess, tool.id).not.toBeNull();
      const schema = SUITE_TOOL_ARGS_SCHEMAS[tool.id as keyof typeof SUITE_TOOL_ARGS_SCHEMAS];
      const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
      const names = typeof rule.resourceArg === 'string' ? [rule.resourceArg] : rule.resourceArg;
      for (const name of names) expect(shape && name in shape, `${tool.id} ${name}`).toBe(true);
    }
  });

  it('names each resource exactly as its connector’s sync stores it', () => {
    // Google's Drive sync keys a file by its Drive ID, and a document or sheet is a Drive file.
    for (const tool of ['docs.read', 'docs.edit', 'sheets.read_range', 'sheets.write_range']) {
      const rule = toolManifest(tool)!.connection!;
      const arg = rule.resourceArg as string;
      expect(resourceIdOf(rule, { [arg]: '1GeneratedFileId_x-Y' }), tool).toBe(
        '1GeneratedFileId_x-Y',
      );
    }
    // Microsoft's drive sync keys an item by its drive and ID together.
    for (const tool of ['word.read', 'excel.read_range', 'excel.write_range']) {
      expect(
        resourceIdOf(toolManifest(tool)!.connection!, {
          drive_id: 'b!generatedDrive',
          item_id: '01GENERATEDITEM',
        }),
        tool,
      ).toBe(driveResourceId('b!generatedDrive', '01GENERATEDITEM'));
    }
  });

  it('requires the connection it means, and refuses an extra argument', () => {
    for (const tool of suite) {
      const schema = SUITE_TOOL_ARGS_SCHEMAS[tool.id as keyof typeof SUITE_TOOL_ARGS_SCHEMAS];
      const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
      expect(Object.keys(shape), tool.id).toContain('connection_id');
      expect(schema.safeParse({ connection_id: CONNECTION, approver: 'x' }).success).toBe(false);
    }
  });

  it('sends to anyone only as an external write a person approves; a draft sends nothing', () => {
    const reachesPeople = [
      'gmail.send',
      'outlook.send',
      'calendar.create_event',
      'teams.post_message',
    ];
    for (const id of reachesPeople) {
      expect(toolManifest(id)).toMatchObject({ class: 'external_write', requiresApproval: true });
    }
    for (const tool of suite.filter((each) => each.class === 'draft_only')) {
      expect(tool.id).toMatch(/\.create_draft$/);
      expect(tool.requiresApproval).toBe(false);
    }
  });

  it('never claims a Teams post can be looked up: a timeout is for a person', () => {
    expect(toolManifest('teams.post_message')!.connection!.bindings.microsoft_365).toEqual({
      scopes: ['ChannelMessage.Send'],
      reconcile: 'none',
      nativeIdempotency: false,
    });
  });

  it('refuses at proposal what Microsoft cannot do: an event change that tells nobody', () => {
    const event = { attendees: ['ana@example.invalid'] };
    for (const value of ['none', 'external_only']) {
      expect(
        suitePayloadFits('calendar.create_event', 'microsoft_365', {
          ...event,
          send_updates: value,
        }),
      ).toBe(false);
      expect(
        suitePayloadFits('calendar.update_event', 'microsoft_365', { send_updates: value }),
      ).toBe(false);
      expect(
        suitePayloadFits('calendar.create_event', 'google_workspace', {
          ...event,
          send_updates: value,
        }),
      ).toBe(true);
    }
    expect(
      suitePayloadFits('calendar.create_event', 'microsoft_365', { ...event, send_updates: 'all' }),
    ).toBe(true);
    expect(
      suitePayloadFits('calendar.create_event', 'microsoft_365', {
        attendees: [],
        send_updates: 'none',
      }),
    ).toBe(true);
  });

  it('declares ADR-038 D6’s reconcile and idempotency for calendar creates', () => {
    const create = toolManifest('calendar.create_event')!.connection!.bindings;
    expect(create.google_workspace).toMatchObject({
      reconcile: 'authoritative',
      nativeIdempotency: true,
    });
    expect(create.microsoft_365).toMatchObject({
      reconcile: 'best_effort',
      nativeIdempotency: true,
    });
    expect(toolManifest('gmail.send')!.connection!.bindings.google_workspace?.reconcile).toBe(
      'best_effort',
    );
  });
});

describe('connectors declare exactly the changes their tools name', () => {
  it.each([
    ['email_smtp', EMAIL_CONNECTOR_MANIFEST],
    ['google_workspace', GOOGLE_WORKSPACE_MANIFEST],
    ['microsoft_365', MICROSOFT_365_MANIFEST],
  ] as const)('%s', (type, manifest) => {
    expect([...manifest.capabilities.actions].sort()).toEqual([...actionToolsFor(type)].sort());
    expect(ACTION_CONNECTOR_TYPES).toContain(type);
  });

  it('has a handler, written or not, for every suite tool on each provider', () => {
    const forType = (type: ToolConnectorType, kind: 'read' | 'action') =>
      suite
        .filter((tool) => (tool.connection!.connectorTypes as readonly string[]).includes(type))
        .filter((tool) => (kind === 'read') === (tool.class === 'read_only'))
        .map((tool) => tool.id)
        .sort();
    expect(Object.keys(GOOGLE_READ_HANDLERS).sort()).toEqual(forType('google_workspace', 'read'));
    expect(Object.keys(GOOGLE_ACTION_HANDLERS).sort()).toEqual(
      forType('google_workspace', 'action'),
    );
    expect(Object.keys(MICROSOFT_READ_HANDLERS).sort()).toEqual(forType('microsoft_365', 'read'));
    expect(Object.keys(MICROSOFT_ACTION_HANDLERS).sort()).toEqual(
      forType('microsoft_365', 'action'),
    );
  });
});

describe('the intent path', () => {
  const message = { to: ['someone@example.invalid'], subject: 'Hello', text_body: 'Synthetic.' };

  it('accepts a change its manifest declares, and freezes everything but the connection', () => {
    expect(isActionTool(toolManifest('gmail.send'))).toBe(true);
    expect(isActionTool(toolManifest('gmail.create_draft'))).toBe(true);
    const payload = actionPayloadOf('gmail.send', { connection_id: CONNECTION, message });
    expect(payload).toEqual({ message });
    expect(parseSuiteActionPayload('gmail.send', CONNECTION, payload)).toEqual({ message });
  });

  it('refuses a tool no manifest declares as a change, and a payload that names a connection', () => {
    for (const id of ['gmail.search', 'work.read', 'artifact.draft.create', 'made.up']) {
      expect(isActionTool(toolManifest(id)), id).toBe(false);
    }
    expect(parseSuiteActionPayload('gmail.search', CONNECTION, { query: 'x' })).toBeNull();
    expect(
      parseSuiteActionPayload('gmail.send', CONNECTION, { message, connection_id: CONNECTION }),
    ).toBeNull();
    expect(parseSuiteActionPayload('made.up', CONNECTION, {})).toBeNull();
  });

  it('leaves email.send’s payload where M3 always found it', () => {
    const email = { to: ['someone@example.invalid'], subject: 's', text_body: 't' };
    expect(actionPayloadOf('email.send', { connection_id: CONNECTION, email })).toEqual(email);
  });
});

describe('the connector side', () => {
  const context = {
    organizationId: '6f1c2c6e-4444-4444-8444-444444444444',
    connectionId: CONNECTION,
    ownerKind: 'member' as const,
    config: {},
    credentials: {
      withCredential: () => Promise.reject(new Error('no credential in a unit test')),
    },
    network: { openRelay: () => Promise.reject(new Error('no network in a unit test')) },
    signal: new AbortController().signal,
  };
  const request = (toolName: string, payload: unknown) => ({
    externalActionId: '6f1c2c6e-5555-4555-8555-555555555555',
    attemptId: '6f1c2c6e-6666-4666-8666-666666666666',
    attemptNo: 1,
    toolName,
    toolVersion: '1',
    idempotencyKey: 'ensemus-x',
    requestHash: 'a'.repeat(64),
    payload,
  });

  it('runs only a declared change, and only on a payload that still fits its tool', async () => {
    const send = vi.fn(async () => ({
      outcome: 'accepted' as const,
      code: 'ACCEPTED_BY_PROVIDER' as const,
    }));
    const tools = createSuiteToolDispatch({
      deps: {},
      connectorType: 'google_workspace',
      reads: {},
      actions: { 'gmail.send': { send, reconcile: vi.fn() } },
    });
    const message = { to: ['someone@example.invalid'], subject: 'Hi', text_body: 'x' };
    await expect(
      tools.actions.send(context, request('gmail.send', { message })),
    ).resolves.toMatchObject({
      outcome: 'accepted',
    });
    for (const [tool, payload] of [
      ['outlook.send', { message }],
      ['gmail.send', { message: { ...message, to: [] } }],
      ['gmail.send', { message, connection_id: CONNECTION }],
    ] as const) {
      await expect(tools.actions.send(context, request(tool, payload))).rejects.toBeInstanceOf(
        NotSent,
      );
    }
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses a read of a tool it has no handler for, or with arguments its schema refuses', async () => {
    const tools = createSuiteToolDispatch({
      deps: {},
      connectorType: 'google_workspace',
      reads: {},
      actions: {},
    });
    await expect(
      tools.suiteReads.read(context, { id: 'gmail.search', version: '1' }, {}, null),
    ).rejects.toBeInstanceOf(SuiteReadRefused);
  });

  it('has an unwritten change end as not sent, so nobody is asked about an effect that never was', async () => {
    // Stubs, as a provider's handler map holds them until each is written. The dispatch passes a valid
    // payload through to the stub, and what comes back is a certain NotSent, never an unknown.
    const reconcile = vi.fn(notImplemented);
    const tools = createSuiteToolDispatch({
      deps: {},
      connectorType: 'google_workspace',
      reads: { 'gmail.search': notImplemented },
      actions: {
        'gmail.send': {
          send: async () => {
            throw new NotImplementedSend();
          },
          reconcile,
        },
      },
    });
    const message = { to: ['someone@example.invalid'], subject: 'Hi', text_body: 'x' };
    const refused = await tools.actions.send(context, request('gmail.send', { message })).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(NotImplementedSend);
    expect(refused).toBeInstanceOf(NotSent);
    expect(refused).toMatchObject({ code: 'CONNECTOR_UNAVAILABLE', retryable: false });
    expect(reconcile).not.toHaveBeenCalled();
    await expect(
      tools.suiteReads.read(
        context,
        { id: 'gmail.search', version: '1' },
        { connection_id: CONNECTION, query: 'x', max_results: 1 },
        null,
      ),
    ).rejects.toThrow('NOT_IMPLEMENTED');
  });

  it('refuses a change its provider cannot do exactly before any handler runs', async () => {
    const send = vi.fn();
    const tools = createSuiteToolDispatch({
      deps: {},
      connectorType: 'microsoft_365',
      reads: {},
      actions: { 'calendar.create_event': { send, reconcile: vi.fn() } },
    });
    const event = {
      calendar_id: 'primary',
      summary: 'Review',
      start: '2026-11-12T10:00:00Z',
      end: '2026-11-12T11:00:00Z',
      time_zone: 'Europe/London',
      attendees: ['ana@example.invalid'],
      send_updates: 'none',
    };
    await expect(
      tools.actions.send(context, request('calendar.create_event', event)),
    ).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a read whose connection owner was not said', async () => {
    const read = vi.fn();
    const tools = createSuiteToolDispatch({
      deps: {},
      connectorType: 'google_workspace',
      reads: { 'gmail.search': read },
      actions: {},
    });
    const { ownerKind: _owner, ...unsaid } = context;
    await expect(
      tools.suiteReads.read(
        unsaid as never,
        { id: 'gmail.search', version: '1' },
        { connection_id: CONNECTION, query: 'x', max_results: 1 },
        null,
      ),
    ).rejects.toBeInstanceOf(SuiteReadRefused);
    expect(read).not.toHaveBeenCalled();
  });

  it('never hands a connector an action its manifest does not declare, and reconciles per tool', async () => {
    const send = vi.fn();
    const connector = {
      manifest: { ...GOOGLE_WORKSPACE_MANIFEST },
      parseConfig: (raw: unknown) => raw,
      actions: { send, reconcile: vi.fn() },
    } as unknown as Connector;
    const registry: ConnectorRegistry = {
      get: (type) => (type === 'google_workspace' ? connector : undefined),
      manifests: () => [GOOGLE_WORKSPACE_MANIFEST],
    };
    const gateway = createConnectorGateway({
      database: {} as never,
      registry,
      secrets: { withSecret: vi.fn() } as never,
      network: context.network,
    });
    const attempt = (toolName: string) =>
      ({
        externalActionId: 'x',
        attemptId: 'y',
        attemptNo: 1,
        toolName,
        toolVersion: '1',
        idempotencyKey: 'k',
        requestHash: 'h',
        payload: {},
        connection: {
          id: CONNECTION,
          connectorType: 'google_workspace',
          config: {},
          credentialSecretId: '6f1c2c6e-7777-4777-8777-777777777777',
          grantedScopes: ['https://www.googleapis.com/auth/gmail.send'],
          ownerKind: 'member',
        },
      }) as PreparedAttempt;
    await expect(gateway.send('org', attempt('email.send'))).resolves.toMatchObject({
      outcome: 'not_sent',
      code: 'CONNECTOR_UNAVAILABLE',
    });
    expect(send).not.toHaveBeenCalled();
    // The connection's provider-confirmed scopes reach the handler, which refuses unsent without them.
    send.mockResolvedValueOnce({ outcome: 'accepted', code: 'ACCEPTED_BY_PROVIDER' });
    await expect(gateway.send('org', attempt('gmail.send'))).resolves.toMatchObject({
      outcome: 'accepted',
    });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      grantedScopes: ['https://www.googleapis.com/auth/gmail.send'],
    });
    expect(gateway.lookupOf('google_workspace', 'calendar.create_event')).toBe('authoritative');
    expect(gateway.lookupOf('google_workspace', 'gmail.send')).toBe('best_effort');
    expect(gateway.lookupOf('google_workspace', 'email.send')).toBe('best_effort');
  });
});

describe('the Message-ID domain a deployment sets', () => {
  it('takes a host name, lower-cased, and nothing that could carry a second header', () => {
    expect(parseMailIdDomain('Mail.Example.COM')).toBe('mail.example.com');
    expect(parseMailIdDomain('localhost')).toBe('localhost');
    for (const bad of [
      '',
      'example.com\r\nBcc: x',
      '-bad.example.com',
      'bad-.example.com',
      'a..b',
      '10.0.0.5',
      'under_score.example.com',
      `${'a'.repeat(64)}.example.com`,
      'example.com:443',
    ]) {
      expect(parseMailIdDomain(bad), bad).toBeNull();
    }
  });

  it('is the operator’s setting, else the public host, and an invalid setting stops the worker', () => {
    expect(
      resolveMailIdDomain({ explicit: 'mail.example.com', publicUrl: 'https://e.example.org' }),
    ).toBe('mail.example.com');
    expect(resolveMailIdDomain({ publicUrl: 'https://Ensemus.Example.org:8443/x' })).toBe(
      'ensemus.example.org',
    );
    expect(resolveMailIdDomain({ explicit: '  ', publicUrl: 'https://e.example.org' })).toBe(
      'e.example.org',
    );
    expect(resolveMailIdDomain({ publicUrl: 'https://10.0.0.5' })).toBeNull();
    expect(resolveMailIdDomain({ publicUrl: 'not a url' })).toBeNull();
    expect(resolveMailIdDomain({})).toBeNull();
    expect(() => resolveMailIdDomain({ explicit: 'bad domain' })).toThrow('MAIL_ID_DOMAIN_INVALID');
  });
});

describe('migration 0563 holds the same lists as the code', () => {
  const sql = readFileSync(
    join(repoRoot, 'packages/database/migrations/0563_suite_tools.sql'),
    'utf8',
  );

  it('is flagged for human security review on its first line', () => {
    expect(sql.split(/\r?\n/)[0]).toBe('-- FLAGGED FOR HUMAN SECURITY REVIEW');
  });

  it('allows members exactly the capabilities a member can own, and defaults to mail and calendar', () => {
    const owned = `ARRAY[${MEMBER_CONNECTABLE_CAPABILITIES.map((c) => `'${c}'`).join(',')}]`;
    expect(sql.split(owned).length - 1).toBe(2);
    expect(sql).toContain(`DEFAULT '{mail,calendar}'::text[]`);
    expect(sql).toContain(`allowed:=ARRAY['mail','calendar']::text[]`);
  });

  it('caps a suite read’s output at the largest any manifest allows', () => {
    const largest = Math.max(...suite.map((tool) => tool.connection!.maxOutputBytes));
    expect(sql).toContain(`octet_length("integrations"."suite_reads"."output") <= ${largest}`);
  });
});
