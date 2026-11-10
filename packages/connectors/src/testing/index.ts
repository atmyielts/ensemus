// Test doubles and the conformance suite, which lint keeps out of every worker and web entry point, so
// none of this can reach a shipped image.
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import {
  CONNECTOR_TYPE_PATTERN,
  isValidSyncPage,
  SECRET_PURPOSE_CONNECTOR_CREDENTIAL,
  SYNC_STREAM_PATTERN,
  type SyncPage,
} from '@ensemus/domain/connector';
import { describe, it } from 'vitest';
import {
  CursorExpired,
  MalformedWebhook,
  SyncUnavailable,
  type ActionConnector,
  type ActionRequest,
  type Connector,
  type ConnectorContext,
  type ConnectorNetwork,
  type CredentialLease,
  type SyncConnector,
  type WebhookConnector,
} from '../index';
import { manifestFor, type ConnectorCapabilities } from '../manifest';

export type FakeConnectorScript = {
  /** What each stream's pages are, in order. The cursor it hands back is the next page's number. */
  pages?: Readonly<Record<string, readonly SyncPage[]>>;
  /** Replaces reading from `pages`, to script a failure or a misbehaving source. */
  readPage?: SyncConnector['readPage'];
  /** Gives it an action, declared as the tool `fake.act`. */
  actions?: ActionConnector;
  webhooks?: WebhookConnector;
  /** Defaults to true, since the fake's pages can state any grants. */
  aclMapping?: boolean;
  /** Defaults to `none`. */
  network?: ConnectorCapabilities['network'];
  /** Defaults to a type no shipped connector uses. */
  type?: string;
};

export type FakeConnectorConfig = Record<string, never>;

const parseEmptyConfig = (raw: unknown): FakeConnectorConfig => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length) {
    throw new Error('This connector takes no settings');
  }
  return {};
};

/** Serves scripted pages, so sync can be tested with no provider. */
export function createFakeConnector(script: FakeConnectorScript): Connector<FakeConnectorConfig> {
  const pages = script.pages ?? {};
  const streams = Object.keys(pages);
  const scripted: SyncConnector['readPage'] = async (_context, request) => {
    const stream = pages[request.stream];
    if (!stream) throw new SyncUnavailable('SYNC_UNAVAILABLE');
    if (request.cursor === 'expired') throw new CursorExpired();
    const index = Number(request.cursor ?? 0);
    const page = stream[index];
    if (!page) {
      return {
        resources: [],
        deletedExternalIds: [],
        nextCursor: request.cursor,
        hasMore: false,
      };
    }
    return { ...page, nextCursor: String(index + 1), hasMore: index + 1 < stream.length };
  };
  return {
    manifest: {
      type: script.type ?? 'fake_connector',
      version: '1',
      displayName: 'Fake connector',
      capabilities: {
        actions: script.actions ? ['fake.act'] : [],
        reconcile: 'none',
        nativeIdempotency: false,
        sync: streams.length ? { streams, pageSize: 100 } : null,
        aclMapping: script.aclMapping ?? true,
        webhooks: script.webhooks ? { scheme: 'ensemus_hmac_sha256_v1' } : null,
        network: script.network ?? 'none',
      },
      credential: { required: false, purpose: SECRET_PURPOSE_CONNECTOR_CREDENTIAL },
    },
    parseConfig: parseEmptyConfig,
    ...(streams.length ? { sync: { readPage: script.readPage ?? scripted } } : {}),
    ...(script.actions ? { actions: script.actions } : {}),
    ...(script.webhooks ? { webhooks: script.webhooks } : {}),
  };
}

export type ConformanceFixtures = {
  /** Settings this connector accepts. */
  config: unknown;
  /** What one of its tools is asked to do. Email and the fake have a default. */
  payload?: unknown;
  /** How long a send has to stop after being aborted. */
  abortGraceMs?: number;
};

export type ConformanceCheck = { name: string; run: () => void | Promise<void> };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ABORT_AFTER_MS = 50;
const PROVIDER_CANARY = `CANARY-provider-text-${randomUUID()}`;
const CREDENTIAL_CANARY = `CANARY-credential-${randomUUID()}`;
const CONFIG_CANARY = `CANARY-settings-${randomUUID()}`;

/** A relay that says something a connector must not repeat, then waits. */
function chattyRelay(): Duplex {
  const relay = new Duplex({ read() {}, write: (_bytes, _encoding, done) => done() });
  setTimeout(() => relay.push(`554 ${PROVIDER_CANARY}\r\n`), 0);
  return relay;
}

/** A relay that accepts a connection and never says anything. */
const silentRelay = () => new Duplex({ read() {}, write: (_bytes, _encoding, done) => done() });

type Spies = { opened: number; leased: number };

function contextFor(
  config: unknown,
  signal: AbortSignal,
  options: {
    relay?: () => Duplex;
    network?: ConnectorNetwork;
    credentials?: CredentialLease;
    spies?: Spies;
  } = {},
): ConnectorContext {
  const spies = options.spies ?? { opened: 0, leased: 0 };
  return {
    organizationId: randomUUID(),
    connectionId: randomUUID(),
    config,
    signal,
    credentials: options.credentials ?? {
      withCredential: (use) => {
        spies.leased += 1;
        return use(Buffer.from(CREDENTIAL_CANARY));
      },
    },
    network: options.network ?? {
      openRelay: async () => {
        spies.opened += 1;
        return (options.relay ?? silentRelay)();
      },
    },
  };
}

function requestFor(tool: string, config: unknown, fixtures: ConformanceFixtures): ActionRequest {
  const id = randomUUID();
  const from = (config as { fromAddress?: unknown } | null)?.fromAddress;
  const emailPayload = {
    from: { address: typeof from === 'string' ? from : 'sender@example.invalid' },
    to: ['recipient@example.invalid'],
    subject: 'A conformance run',
    text_body: 'Nothing here is real.',
  };
  return {
    externalActionId: id,
    attemptId: randomUUID(),
    attemptNo: 1,
    toolName: tool,
    toolVersion: '1',
    idempotencyKey: `ensemus-${id}`,
    requestHash: 'conformance',
    payload: fixtures.payload ?? (tool === 'email.send' ? emailPayload : {}),
  };
}

/**
 * Runs a send with an abort coming shortly, so that a connector waiting on a silent relay stops. One that
 * never stops is reported as hung, instead of holding up every check after it.
 */
async function sendAndAbort(
  connector: Connector,
  context: (signal: AbortSignal) => ConnectorContext,
  request: ActionRequest,
  graceMs: number,
): Promise<{ result?: unknown; error?: unknown; hung?: true }> {
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), ABORT_AFTER_MS);
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<{ hung: true }>((resolve) => {
    giveUp = setTimeout(() => resolve({ hung: true }), ABORT_AFTER_MS + graceMs);
  });
  const sending = (async () => {
    try {
      return { result: await connector.actions!.send(context(controller.signal), request) };
    } catch (error) {
      return { error };
    }
  })();
  try {
    return await Promise.race([sending, hung]);
  } finally {
    clearTimeout(abort);
    clearTimeout(giveUp);
  }
}

const printable = (value: unknown): string => {
  if (value instanceof Error) {
    return JSON.stringify({ name: value.name, message: value.message, stack: value.stack });
  }
  return JSON.stringify(value) ?? String(value);
};

/**
 * Every rule as a named check, so a test can prove each one catches what it says it does. Connectors
 * register these through describeConnectorConformance.
 */
export function conformanceChecks(
  make: () => Connector,
  fixtures: ConformanceFixtures,
): ConformanceCheck[] {
  const capabilities = () => make().manifest.capabilities;
  const tool = () => capabilities().actions[0] ?? 'fake.act';
  const graceMs = fixtures.abortGraceMs ?? 5_000;
  const never = new AbortController().signal;

  const checks: ConformanceCheck[] = [
    {
      name: 'manifest shape and type format',
      run: () => {
        const { manifest } = make();
        assert(CONNECTOR_TYPE_PATTERN.test(manifest.type), 'The type must match migration 0012');
        assert(manifest.version, 'A version is required');
        assert(manifest.displayName, 'A display name is required');
        assert(manifest.credential.purpose, 'A credential purpose is required');
        const { sync, actions, reconcile, network } = manifest.capabilities;
        assert(['none', 'best_effort', 'authoritative'].includes(reconcile), 'Unknown lookup');
        assert(['none', 'egress_gateway'].includes(network), 'Unknown network');
        assert(actions.every(Boolean), 'A tool needs a name');
        if (sync) {
          assert(sync.streams.length > 0, 'A sync capability needs a stream');
          assert(
            sync.streams.every((stream) => SYNC_STREAM_PATTERN.test(stream)),
            'A stream name must match migration 0012',
          );
          assert(sync.pageSize > 0, 'A page size must be positive');
        }
      },
    },
    {
      name: 'manifest is plain data, as the web tier reads it',
      run: () => {
        const { manifest } = make();
        assert(
          JSON.stringify(JSON.parse(JSON.stringify(manifest))) === JSON.stringify(manifest) &&
            isPlain(manifest),
          'A manifest may hold only plain data',
        );
      },
    },
    {
      name: 'a shipped connector matches the manifest the web tier reads',
      run: () => {
        const { manifest } = make();
        const shipped = manifestFor(manifest.type);
        if (!shipped) return;
        assert(
          JSON.stringify(sorted(shipped.capabilities)) ===
            JSON.stringify(sorted(manifest.capabilities)),
          'Capabilities differ from @ensemus/connectors/manifest',
        );
        assert(
          shipped.credential.required === manifest.credential.required,
          'Credential requirement differs from @ensemus/connectors/manifest',
        );
      },
    },
    {
      name: 'parseConfig accepts the fixture',
      run: () => void make().parseConfig(fixtures.config),
    },
    {
      name: 'parseConfig refuses what it should',
      run: () => {
        const refused = [
          null,
          42,
          'text',
          [],
          // A tenant can never say where to connect, and a credential never goes in settings.
          { ...(fixtures.config as object), host: 'relay.example.invalid' },
          { ...(fixtures.config as object), port: 25 },
          { ...(fixtures.config as object), password: CONFIG_CANARY },
          { ...(fixtures.config as object), url: 'https://relay.example.invalid/' },
        ];
        for (const raw of refused) {
          let accepted = true;
          try {
            make().parseConfig(raw);
          } catch {
            accepted = false;
          }
          assert(!accepted, `parseConfig accepted ${JSON.stringify(raw)}`);
        }
      },
    },
    {
      name: 'parseConfig refuses without repeating what it was given',
      run: () => {
        try {
          make().parseConfig({ ...(fixtures.config as object), password: CONFIG_CANARY });
        } catch (error) {
          assert(!printable(error).includes(CONFIG_CANARY), 'The error repeats the value');
        }
      },
    },
    {
      name: 'a declared capability exists',
      run: () => {
        const connector = make();
        const declared = connector.manifest.capabilities;
        if (declared.actions.length) assert(connector.actions, 'Actions are declared and absent');
        if (declared.sync) assert(connector.sync, 'Sync is declared and absent');
        if (declared.webhooks) assert(connector.webhooks, 'Webhooks are declared and absent');
      },
    },
    {
      name: 'an undeclared capability is absent',
      run: () => {
        const connector = make();
        const declared = connector.manifest.capabilities;
        if (!declared.actions.length) assert(!connector.actions, 'Actions are present, undeclared');
        if (!declared.sync) assert(!connector.sync, 'Sync is present, undeclared');
        if (!declared.webhooks) assert(!connector.webhooks, 'Webhooks are present, undeclared');
      },
    },
    {
      name: 'send honours abort',
      run: async () => {
        const connector = make();
        if (!connector.actions) return;
        const config = connector.parseConfig(fixtures.config);
        const request = requestFor(tool(), fixtures.config, fixtures);
        const ended = await sendAndAbort(
          connector,
          (signal) => contextFor(config, signal),
          request,
          graceMs,
        );
        assert(!ended.hung, 'send did not stop after its abort');
      },
    },
    {
      name: 'errors carry no provider text',
      run: async () => {
        const connector = make();
        if (!connector.actions) return;
        const config = connector.parseConfig(fixtures.config);
        const request = requestFor(tool(), fixtures.config, fixtures);
        const relayed = await sendAndAbort(
          connector,
          (signal) => contextFor(config, signal, { relay: chattyRelay }),
          request,
          graceMs,
        );
        assert(!printable(relayed.result).includes(PROVIDER_CANARY), 'The result repeats it');
        assert(!printable(relayed.error).includes(PROVIDER_CANARY), 'The error repeats it');
        const refused = await sendAndAbort(
          connector,
          (signal) =>
            contextFor(config, signal, {
              network: {
                openRelay: async () => {
                  throw new Error(PROVIDER_CANARY);
                },
              },
            }),
          request,
          graceMs,
        );
        assert(!printable(refused.result).includes(PROVIDER_CANARY), 'The result repeats it');
        assert(!printable(refused.error).includes(PROVIDER_CANARY), 'The error repeats it');
      },
    },
    {
      name: 'errors carry no credential',
      run: async () => {
        const connector = make();
        if (!connector.actions) return;
        const config = connector.parseConfig(fixtures.config);
        const request = requestFor(tool(), fixtures.config, fixtures);
        const ended = await sendAndAbort(
          connector,
          (signal) => contextFor(config, signal, { relay: chattyRelay }),
          request,
          graceMs,
        );
        assert(!printable(ended.result).includes(CREDENTIAL_CANARY), 'The result shows it');
        assert(!printable(ended.error).includes(CREDENTIAL_CANARY), 'The error shows it');
      },
    },
    {
      name: "reconcile: 'none' never claims an answer or makes contact",
      run: async () => {
        const connector = make();
        if (!connector.actions || connector.manifest.capabilities.reconcile !== 'none') return;
        const spies: Spies = { opened: 0, leased: 0 };
        const answer = await connector.actions.reconcile(
          contextFor(connector.parseConfig(fixtures.config), never, { spies }),
          requestFor(tool(), fixtures.config, fixtures),
        );
        assert(answer.answer === 'cannot_answer', 'A connector with no lookup claimed an answer');
        assert(spies.opened === 0, 'A connector with no lookup opened a connection');
      },
    },
    {
      name: "network: 'none' never opens a connection",
      run: async () => {
        const connector = make();
        if (connector.manifest.capabilities.network !== 'none') return;
        const spies: Spies = { opened: 0, leased: 0 };
        const config = connector.parseConfig(fixtures.config);
        if (connector.actions) {
          await sendAndAbort(
            connector,
            (signal) => contextFor(config, signal, { spies }),
            requestFor(tool(), fixtures.config, fixtures),
            graceMs,
          );
        }
        const stream = connector.manifest.capabilities.sync?.streams[0];
        if (connector.sync && stream) {
          await connector.sync.readPage(contextFor(config, never, { spies }), {
            stream,
            cursor: null,
            fullSync: true,
            pageSize: 10,
          });
        }
        assert(spies.opened === 0, 'A connector declaring no network opened a connection');
      },
    },
    {
      name: 'credential: not required is never asked for',
      run: async () => {
        const connector = make();
        if (connector.manifest.credential.required || !connector.actions) return;
        const spies: Spies = { opened: 0, leased: 0 };
        const config = connector.parseConfig(fixtures.config);
        await sendAndAbort(
          connector,
          (signal) => contextFor(config, signal, { spies }),
          requestFor(tool(), fixtures.config, fixtures),
          graceMs,
        );
        assert(spies.leased === 0, 'A connector needing no credential asked for one');
      },
    },
  ];

  const syncChecks = syncConformanceChecks(make, fixtures);
  const webhookChecks: ConformanceCheck[] = [
    {
      name: 'webhooks: anything unrecognized is MalformedWebhook',
      run: () => {
        const connector = make();
        if (!connector.webhooks) return;
        const config = connector.parseConfig(fixtures.config);
        for (const body of ['not json', '{"type":"nothing_we_know"}', '', '[]', 'null']) {
          let thrown: unknown;
          try {
            connector.webhooks.interpret(contextFor(config, never), {
              providerEventId: randomUUID(),
              body: new TextEncoder().encode(body),
              signedAtSeconds: 1,
            });
          } catch (error) {
            thrown = error;
          }
          assert(thrown instanceof MalformedWebhook, `${body} was not refused`);
        }
      },
    },
  ];
  return [...checks, ...syncChecks, ...webhookChecks];
}

function syncConformanceChecks(
  make: () => Connector,
  fixtures: ConformanceFixtures,
): ConformanceCheck[] {
  const signal = new AbortController().signal;
  const firstRead = (connector: Connector, stream: string) =>
    connector.sync!.readPage(contextFor(connector.parseConfig(fixtures.config), signal), {
      stream,
      cursor: null,
      fullSync: true,
      pageSize: 10,
    });
  const streamsOf = (connector: Connector) =>
    connector.sync ? (connector.manifest.capabilities.sync?.streams ?? []) : [];
  return [
    {
      name: 'sync: reading the same page twice gives the same page',
      run: async () => {
        const connector = make();
        for (const stream of streamsOf(connector)) {
          const [one, two] = [
            await firstRead(connector, stream),
            await firstRead(connector, stream),
          ];
          assert(JSON.stringify(one) === JSON.stringify(two), 'Two reads of a page differ');
        }
      },
    },
    {
      name: 'sync: an undeclared stream is refused',
      run: async () => {
        const connector = make();
        if (!streamsOf(connector).length) return;
        let answered = true;
        try {
          await firstRead(connector, 'a_stream_nobody_declared');
        } catch {
          answered = false;
        }
        assert(!answered, 'A stream nobody declared was answered');
      },
    },
    {
      name: 'sync: pages are valid for their stream',
      run: async () => {
        const connector = make();
        for (const stream of streamsOf(connector)) {
          assert(
            isValidSyncPage(stream, await firstRead(connector, stream)),
            `A page of ${stream} would be refused`,
          );
        }
      },
    },
    {
      name: 'sync: a connector reporting no permissions has no grants',
      run: async () => {
        const connector = make();
        if (connector.manifest.capabilities.aclMapping) return;
        for (const stream of streamsOf(connector)) {
          const page = await firstRead(connector, stream);
          assert(
            page.resources.every((resource) => resource.acl.length === 0),
            'A connector declaring no permissions reported some',
          );
        }
      },
    },
  ];
}

function isPlain(value: unknown): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isPlain);
  if (typeof value !== 'object') return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(isPlain);
}

/** The same value with its keys in one order, so that two manifests compare by what they say. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, inner]) => [key, sorted(inner)]),
  );
}

/**
 * Registers the suite every connector has to pass, in the caller's test file: manifest shape, errors
 * that carry no text, and for each capability it declares, the rules in ADR-027 D3.
 */
export function describeConnectorConformance(
  name: string,
  make: () => Connector,
  fixtures: ConformanceFixtures,
): void {
  describe(`connector conformance: ${name}`, () => {
    for (const check of conformanceChecks(make, fixtures)) {
      it(check.name, check.run, (fixtures.abortGraceMs ?? 5_000) * 3);
    }
  });
}
