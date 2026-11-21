// The part of every business connector that decides whether a repeat is safe (ADR-033 D2, ADR-027 D2), against
// a local fake of the adapter protocol. Nothing here opens a socket. TLS over a real socket is in the
// connectors' integration tests, which need the stack's certificates.
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { CRM_CONNECTOR_TYPE, CRM_RECORD_UPDATE_TOOL } from '@ensemus/domain/business-connector';
import { describe, expect, it, vi } from 'vitest';
import { recordUpdatePayloadSchema } from '@ensemus/contracts/business-records';
import type { BusinessConnectorConfig } from '@ensemus/contracts/business-records';
import { CursorExpired, NotSent, SyncUnavailable } from '../index';
import type { ActionRequest, ConnectorContext } from '../index';
import { CRM_CONNECTOR_MANIFEST } from '../manifest-business';
import {
  createFakeAdapter,
  type FakeAdapter,
  type FakeAdapterOptions,
} from '../testing/business-adapter';
import { adapterExchange, AdapterNoAnswer, AdapterNotContacted } from './http';
import { createBusinessConnector, type BusinessRecordSink } from './kit';
import { routeConnector } from './route';

const config: BusinessConnectorConfig = {
  streams: ['crm.deals'],
  scopes: ['crm_http.read', 'crm_http.write'],
};

function setUp(options: FakeAdapterOptions = {}, kit: { tls?: 'none' | 'required' } = {}) {
  const adapter = createFakeAdapter(options);
  const applied: Parameters<BusinessRecordSink['applyPage']>[0][] = [];
  const connector = createBusinessConnector(
    {
      type: CRM_CONNECTOR_TYPE,
      manifest: CRM_CONNECTOR_MANIFEST,
      tools: {
        [CRM_RECORD_UPDATE_TOOL]: {
          version: '1',
          parsePayload: (raw) => recordUpdatePayloadSchema.parse(raw),
        },
      },
    },
    {
      tls: kit.tls ?? 'none',
      beforeCommitMs: 200,
      answerMs: 200,
      sink: { applyPage: async (page) => void applied.push(page) },
    },
  );
  return { adapter, connector, applied };
}

const contextFor = (
  adapter: FakeAdapter,
  overrides: Partial<ConnectorContext<BusinessConnectorConfig>> = {},
): ConnectorContext<BusinessConnectorConfig> => ({
  organizationId: randomUUID(),
  connectionId: randomUUID(),
  config,
  credentials: adapter.credentials,
  network: adapter.network,
  signal: new AbortController().signal,
  ...overrides,
});

const updateRequest = (id = randomUUID()): ActionRequest => ({
  externalActionId: id,
  attemptId: randomUUID(),
  attemptNo: 1,
  toolName: CRM_RECORD_UPDATE_TOOL,
  toolVersion: '1',
  idempotencyKey: `ensemus-${id}`,
  requestHash: 'test-hash',
  payload: {
    record: { stream: 'crm.deals', external_id: 'deal-1', expected_version: '3' },
    changes: { stage: 'won' },
  },
});

const readDeals = (
  connector: ReturnType<typeof setUp>['connector'],
  context: ConnectorContext<BusinessConnectorConfig>,
  cursor: string | null = null,
) =>
  connector.sync!.readPage(context, {
    stream: 'crm.deals',
    cursor,
    fullSync: cursor === null,
    pageSize: 2,
  });

const deal = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  version: '1',
  fields: { name: `Deal ${id}`, stage: 'open', amount: '100.50', ...fields },
  acl: [
    {
      principal_kind: 'user' as const,
      principal_external_id: 'person@example.invalid',
      access: 'read' as const,
    },
  ],
});

describe('settings', () => {
  it('takes selected streams and granted scopes, and nothing about where to connect', () => {
    const { connector } = setUp();
    expect(connector.parseConfig({ streams: ['crm.deals'], scopes: ['crm_http.read'] })).toEqual({
      streams: ['crm.deals'],
      scopes: ['crm_http.read'],
    });
    for (const raw of [
      { scopes: [], host: 'adapter.example.invalid' },
      { scopes: [], port: 443 },
      { scopes: [], url: 'https://adapter.example.invalid/' },
      { scopes: [], password: 'CANARY' },
      { scopes: ['ticketing_http.read'] },
      { scopes: [], streams: ['ticketing.tickets'] },
      null,
      [],
    ]) {
      expect(() => connector.parseConfig(raw)).toThrow('CONFIG_INVALID');
    }
  });

  it('selects no stream unless someone chose it', () => {
    const { connector } = setUp();
    expect(connector.parseConfig({ scopes: [] }).streams).toEqual([]);
  });
});

describe('reading a stream', () => {
  it('keeps listed fields only, stores them first, and hands back the permissions', async () => {
    const { adapter, connector, applied } = setUp({
      streams: { 'crm.deals': [deal('deal-1', { secret_margin: '12%' })] },
    });
    const context = contextFor(adapter);
    const page = await readDeals(connector, context);

    expect(applied).toHaveLength(1);
    expect(applied[0]?.records[0]?.fields).toEqual({
      name: 'Deal deal-1',
      stage: 'open',
      amount: '100.50',
    });
    expect(JSON.stringify(applied)).not.toContain('secret_margin');
    expect(page.resources[0]).toMatchObject({
      externalId: 'deal-1',
      resourceType: 'crm.deals',
      externalVersion: '1',
      displayName: 'Deal deal-1',
      classification: 'internal',
      acl: [
        { principalKind: 'user', principalExternalId: 'person@example.invalid', access: 'read' },
      ],
    });
  });

  it('gives the same answer for the same page, so repeating one changes nothing', async () => {
    const { adapter, connector, applied } = setUp({
      streams: { 'crm.deals': [deal('deal-1')] },
    });
    const context = contextFor(adapter);
    expect(await readDeals(connector, context)).toEqual(await readDeals(connector, context));
    expect(applied[0]).toEqual(applied[1]);
  });

  it('makes no contact for a stream nobody selected', async () => {
    const { adapter, connector, applied } = setUp();
    const page = await connector.sync!.readPage(contextFor(adapter), {
      stream: 'crm.contacts',
      cursor: 'kept',
      fullSync: false,
      pageSize: 2,
    });
    expect(page).toEqual({
      resources: [],
      deletedExternalIds: [],
      nextCursor: 'kept',
      hasMore: false,
    });
    expect(adapter.opened()).toBe(0);
    expect(applied).toHaveLength(0);
  });

  it('refuses a stream no connector declares, with no contact', async () => {
    const { adapter, connector } = setUp();
    await expect(
      connector.sync!.readPage(contextFor(adapter), {
        stream: 'a_stream_nobody_declared',
        cursor: null,
        fullSync: true,
        pageSize: 2,
      }),
    ).rejects.toBeInstanceOf(SyncUnavailable);
    expect(adapter.opened()).toBe(0);
  });

  it('makes no contact without the read scope', async () => {
    const { adapter, connector } = setUp();
    await expect(
      readDeals(connector, contextFor(adapter, { config: { ...config, scopes: [] } })),
    ).rejects.toMatchObject({ code: 'SYNC_AUTH_FAILED' });
    expect(adapter.opened()).toBe(0);
  });

  it('refuses a whole page if one listed field is the wrong shape, and stores none of it', async () => {
    const { adapter, connector, applied } = setUp({
      streams: { 'crm.deals': [deal('good'), deal('bad', { amount: 100.5 })] },
    });
    await expect(readDeals(connector, contextFor(adapter))).rejects.toMatchObject({
      code: 'SYNC_PAGE_INVALID',
    });
    expect(applied).toHaveLength(0);
  });

  it.each([
    [401, 'SYNC_AUTH_FAILED'],
    [403, 'SYNC_AUTH_FAILED'],
    [429, 'SYNC_RATE_LIMITED'],
    [500, 'SYNC_UNAVAILABLE'],
    [503, 'SYNC_UNAVAILABLE'],
  ])('reports %i as %s, with none of its text', async (status, code) => {
    const { adapter, connector } = setUp();
    adapter.next({ status });
    await expect(readDeals(connector, contextFor(adapter))).rejects.toMatchObject({ code });
  });

  it('goes back to a full sync when the source says the cursor is gone', async () => {
    const { adapter, connector } = setUp();
    adapter.next({ status: 410 });
    await expect(readDeals(connector, contextFor(adapter))).rejects.toBeInstanceOf(CursorExpired);
  });

  it('refuses a body that is not the protocol', async () => {
    const { adapter, connector, applied } = setUp();
    adapter.next({ raw: '{"records":"CANARY-provider-text"}' });
    const failure = await readDeals(connector, contextFor(adapter)).catch((error) => error);
    expect(failure).toMatchObject({ code: 'SYNC_PAGE_INVALID' });
    expect(String(failure)).not.toContain('CANARY');
    expect(applied).toHaveLength(0);
  });

  it('never lets a source lower a class past the floor, and lets it raise one', async () => {
    const { adapter, connector } = setUp({
      streams: {
        'crm.deals': [
          { ...deal('low'), classification: 'public' },
          { ...deal('high'), classification: 'restricted' },
        ],
      },
    });
    const page = await readDeals(connector, contextFor(adapter));
    expect(page.resources.map((resource) => resource.classification)).toEqual([
      'internal',
      'restricted',
    ]);
  });
});

describe('one send (ADR-027 D2)', () => {
  it('reports the provider accepting it, with what it called the operation', async () => {
    const { adapter, connector } = setUp();
    const request = updateRequest();
    const result = await connector.actions!.send(contextFor(adapter), request);
    expect(result).toMatchObject({
      outcome: 'accepted',
      code: 'ACCEPTED_BY_PROVIDER',
      providerStatus: 201,
      externalId: 'operation-1',
    });
    expect(adapter.requests()[0]?.headers['idempotency-key']).toBe(request.idempotencyKey);
    expect(adapter.effects()).toHaveLength(1);
  });

  it('refuses a tool or version it does not know, with no contact', async () => {
    const { adapter, connector } = setUp();
    for (const change of [{ toolName: 'crm.record.delete' }, { toolVersion: '2' }]) {
      const failure = await connector
        .actions!.send(contextFor(adapter), { ...updateRequest(), ...change })
        .catch((error) => error);
      expect(failure).toBeInstanceOf(NotSent);
      expect(failure).toMatchObject({ code: 'PAYLOAD_CHANGED', retryable: false });
    }
    expect(adapter.opened()).toBe(0);
  });

  it('refuses a payload that no longer fits, with no contact', async () => {
    const { adapter, connector } = setUp();
    await expect(
      connector.actions!.send(contextFor(adapter), {
        ...updateRequest(),
        payload: { changes: { stage: 'won' } },
      }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
    expect(adapter.opened()).toBe(0);
  });

  it('makes no contact without the write scope', async () => {
    const { adapter, connector } = setUp();
    await expect(
      connector.actions!.send(
        contextFor(adapter, { config: { ...config, scopes: ['crm_http.read'] } }),
        updateRequest(),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED', retryable: false });
    expect(adapter.opened()).toBe(0);
  });

  it('says certainly not sent when the connection never opened', async () => {
    const { adapter, connector } = setUp();
    adapter.next('refuse_connection');
    await expect(
      connector.actions!.send(contextFor(adapter), updateRequest()),
    ).rejects.toMatchObject({ code: 'CONNECT_FAILED', retryable: true });
    expect(adapter.effects()).toHaveLength(0);
  });

  it('says certainly not sent when the credential would not open, and writes nothing', async () => {
    const { adapter, connector } = setUp();
    await expect(
      connector.actions!.send(
        contextFor(adapter, {
          credentials: {
            withCredential: async () => {
              throw new Error('CANARY-unseal');
            },
          },
        }),
        updateRequest(),
      ),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE', retryable: false });
    expect(adapter.requests()).toHaveLength(0);
  });

  it('refuses a credential that would make a second header, and writes nothing', async () => {
    const { adapter, connector } = setUp();
    await expect(
      connector.actions!.send(
        contextFor(adapter, {
          credentials: {
            withCredential: (use) => use(Buffer.from('token\r\nX-Injected: yes')),
          },
        }),
        updateRequest(),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(adapter.requests()).toHaveLength(0);
  });

  // The fault the whole design exists for: it happened, and nobody here can tell.
  it('says it may have happened when the provider applies it and goes silent', async () => {
    const { adapter, connector } = setUp();
    adapter.next('silent_after_effect');
    const result = await connector.actions!.send(contextFor(adapter), updateRequest());
    expect(result).toEqual({ outcome: 'indeterminate', code: 'TIMEOUT_AFTER_COMMIT' });
    expect(adapter.effects()).toHaveLength(1);
  });

  it('says it may have happened when the connection drops after the request', async () => {
    const { adapter, connector } = setUp();
    adapter.next('drop_after_effect');
    const result = await connector.actions!.send(contextFor(adapter), updateRequest());
    expect(result).toEqual({ outcome: 'indeterminate', code: 'CONNECTION_LOST_AFTER_COMMIT' });
  });

  it.each([500, 502, 504])('says it may have happened on a %i', async (status) => {
    const { adapter, connector } = setUp();
    adapter.next({ status });
    expect(await connector.actions!.send(contextFor(adapter), updateRequest())).toEqual({
      outcome: 'indeterminate',
      code: 'CONNECTION_LOST_AFTER_COMMIT',
      providerStatus: status,
    });
  });

  it('says it may have happened on a 2xx it cannot read, with none of its text', async () => {
    const { adapter, connector } = setUp();
    adapter.next({ raw: 'CANARY-provider-text' });
    const result = await connector.actions!.send(contextFor(adapter), updateRequest());
    expect(result.outcome).toBe('indeterminate');
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it.each([429, 503])('says not done, try later, on a %i', async (status) => {
    const { adapter, connector } = setUp();
    adapter.next({ status });
    await expect(
      connector.actions!.send(contextFor(adapter), updateRequest()),
    ).rejects.toMatchObject({ code: 'RELAY_BUSY', retryable: true });
  });

  it.each([
    [400, 'REFUSED_BY_PROVIDER'],
    [409, 'REFUSED_BY_PROVIDER'],
    [422, 'REFUSED_BY_PROVIDER'],
    [401, 'AUTH_FAILED'],
    [403, 'AUTH_FAILED'],
  ])('reports %i as refused', async (status, code) => {
    const { adapter, connector } = setUp();
    adapter.next({ status });
    expect(await connector.actions!.send(contextFor(adapter), updateRequest())).toEqual({
      outcome: 'rejected',
      code,
      providerStatus: status,
    });
  });

  it('reports the provider saying no in a 200', async () => {
    const { adapter, connector } = setUp({ decideOperation: () => 'rejected' });
    expect(await connector.actions!.send(contextFor(adapter), updateRequest())).toMatchObject({
      outcome: 'rejected',
      code: 'REFUSED_BY_PROVIDER',
    });
  });

  it('stops when the deadline aborts it', async () => {
    const { adapter, connector } = setUp();
    adapter.next('silent_without_effect');
    const controller = new AbortController();
    const sending = connector.actions!.send(
      contextFor(adapter, { signal: controller.signal }),
      updateRequest(),
    );
    setTimeout(() => controller.abort(), 10);
    expect(await sending).toEqual({ outcome: 'indeterminate', code: 'TIMEOUT_AFTER_COMMIT' });
  });
});

describe('asking what happened', () => {
  it('believes a lookup that finds it', async () => {
    const { adapter, connector } = setUp();
    const request = updateRequest();
    adapter.next('silent_after_effect');
    await connector.actions!.send(contextFor(adapter), request);
    expect(await connector.actions!.reconcile(contextFor(adapter), request)).toEqual({
      answer: 'found',
      providerStatus: 200,
      externalId: 'operation-1',
    });
  });

  it('reports a lookup that finds nothing, without claiming that is proof', async () => {
    const { adapter, connector } = setUp();
    expect(CRM_CONNECTOR_MANIFEST.capabilities.reconcile).toBe('best_effort');
    expect(await connector.actions!.reconcile(contextFor(adapter), updateRequest())).toEqual({
      answer: 'not_found',
    });
  });

  it('never sends anything, however often it is asked', async () => {
    const { adapter, connector } = setUp();
    const request = updateRequest();
    for (let time = 0; time < 3; time += 1) {
      await connector.actions!.reconcile(contextFor(adapter), request);
    }
    expect(adapter.effects()).toHaveLength(0);
    expect(adapter.requests().every((seen) => seen.method === 'GET')).toBe(true);
  });

  it.each([[500], [401], [429]])('cannot answer on a %i', async (status) => {
    const { adapter, connector } = setUp();
    adapter.next({ status });
    expect(await connector.actions!.reconcile(contextFor(adapter), updateRequest())).toEqual({
      answer: 'cannot_answer',
    });
  });

  it('cannot answer when the connection fails', async () => {
    const { adapter, connector } = setUp();
    adapter.next('refuse_connection');
    expect(await connector.actions!.reconcile(contextFor(adapter), updateRequest())).toEqual({
      answer: 'cannot_answer',
    });
  });
});

describe('a signed notice', () => {
  const notice = (text: string) => ({
    providerEventId: randomUUID(),
    body: new TextEncoder().encode(text),
    signedAtSeconds: 1,
  });

  it('can only ask for a sync', () => {
    const { adapter, connector } = setUp();
    expect(
      connector.webhooks!.interpret(contextFor(adapter), notice('{"type":"records_changed"}')),
    ).toEqual([{ kind: 'sync_requested' }]);
  });

  it.each(['not json', '{"type":"nothing_we_know"}', '{"type":"records_changed","x":1}', '[]'])(
    'refuses %s',
    (text) => {
      const { adapter, connector } = setUp();
      expect(() => connector.webhooks!.interpret(contextFor(adapter), notice(text))).toThrow(
        'MALFORMED_PAYLOAD',
      );
    },
  );
});

describe('the transport', () => {
  const request = { method: 'GET', path: '/x', serverName: null } as const;
  const transport = { tls: 'none', beforeCommitMs: 50, answerMs: 50 } as const;

  it('refuses to run with no name to check a certificate against, with no contact', async () => {
    const { adapter } = setUp();
    await expect(
      adapterExchange(contextFor(adapter), { ...transport, tls: 'required' }, request),
    ).rejects.toMatchObject({ code: 'TLS_REQUIRED', retryable: false });
    expect(adapter.opened()).toBe(0);
  });

  it('does not lend the credential until a connection is open', async () => {
    const { adapter } = setUp();
    adapter.next('refuse_connection');
    const lease = vi.fn();
    await expect(
      adapterExchange(
        contextFor(adapter, { credentials: { withCredential: lease } }),
        transport,
        request,
      ),
    ).rejects.toBeInstanceOf(AdapterNotContacted);
    expect(lease).not.toHaveBeenCalled();
  });

  it('gives up before the first byte on a gateway that never opens, and says nothing went', async () => {
    const { adapter } = setUp();
    await expect(
      adapterExchange(
        contextFor(adapter, { network: { openRelay: () => new Promise(() => undefined) } }),
        transport,
        request,
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT_BEFORE_COMMIT', retryable: true });
  });

  it('closes a connection that opens after it gave up', async () => {
    const { adapter } = setUp();
    const late = new Duplex({ read() {}, write: (_bytes, _encoding, done) => done() });
    let open: (stream: Duplex) => void = () => undefined;
    const opening = new Promise<Duplex>((resolve) => {
      open = resolve;
    });
    await expect(
      adapterExchange(
        contextFor(adapter, { network: { openRelay: () => opening } }),
        transport,
        request,
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT_BEFORE_COMMIT' });
    open(late);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(late.destroyed).toBe(true);
  });

  it('stops reading an answer past the limit and says the connection was lost', async () => {
    const { adapter } = setUp();
    const flood = (): Duplex =>
      new Duplex({
        read() {},
        write(_bytes, _encoding, done) {
          done();
          this.push('HTTP/1.1 200 OK\r\nContent-Length: 99999999\r\n\r\n');
          this.push(Buffer.alloc(9 * 1024 * 1024));
        },
      });
    await expect(
      adapterExchange(
        contextFor(adapter, { network: { openRelay: async () => flood() } }),
        transport,
        request,
      ),
    ).rejects.toBeInstanceOf(AdapterNoAnswer);
  });

  it('reads a chunked answer', async () => {
    const { adapter } = setUp();
    const chunked = (): Duplex =>
      new Duplex({
        read() {},
        write(_bytes, _encoding, done) {
          done();
          this.push(
            'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{"a":1}\r\n0\r\n\r\n',
          );
        },
      });
    expect(
      await adapterExchange(
        contextFor(adapter, { network: { openRelay: async () => chunked() } }),
        transport,
        request,
      ),
    ).toEqual({ status: 200, json: { a: 1 } });
  });

  it('never puts a credential in an error', async () => {
    const { adapter } = setUp();
    adapter.next('silent_without_effect');
    const failure = await adapterExchange(contextFor(adapter), transport, request).catch(
      (error: Error) => error,
    );
    expect(
      JSON.stringify({ message: String(failure), stack: (failure as Error).stack }),
    ).not.toContain('generated-test-credential');
  });
});

describe('going through one gateway instance', () => {
  it('uses the network it was bound to, whatever its context holds', async () => {
    const { adapter, connector } = setUp({ streams: { 'crm.deals': [deal('deal-1')] } });
    const elsewhere = vi.fn();
    const routed = routeConnector(connector, adapter.network);
    await routed.sync!.readPage(contextFor(adapter, { network: { openRelay: elsewhere } }), {
      stream: 'crm.deals',
      cursor: null,
      fullSync: true,
      pageSize: 2,
    });
    await routed.actions!.send(
      contextFor(adapter, { network: { openRelay: elsewhere } }),
      updateRequest(),
    );
    expect(elsewhere).not.toHaveBeenCalled();
    expect(adapter.opened()).toBe(2);
  });

  it('declares the same capabilities', () => {
    const { adapter, connector } = setUp();
    expect(routeConnector(connector, adapter.network).manifest).toBe(connector.manifest);
  });
});
