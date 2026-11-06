// The suite has to catch what it says it catches, so each rule is run here against a connector breaking
// it, and the suite itself is run against connectors that pass.
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import type { SyncPage } from '@ensemus/domain/connector';
import { describe, expect, it } from 'vitest';
import { MalformedWebhook, NotSent, type Connector } from '../index';
import {
  conformanceChecks,
  createFakeConnector,
  describeConnectorConformance,
  type ConformanceFixtures,
} from './index';

const page: SyncPage = {
  resources: [{ externalId: 'one', resourceType: 'files', externalVersion: '1', acl: [] }],
  deletedExternalIds: [],
  nextCursor: null,
  hasMore: false,
};

const syncing = () => createFakeConnector({ pages: { files: [page] } });
const acting = () =>
  createFakeConnector({
    actions: {
      send: async (context) => {
        if (context.signal.aborted) throw new NotSent('TIMEOUT_BEFORE_COMMIT', true);
        const relay = await context.network
          .openRelay({ timeoutMs: 100, signal: context.signal })
          .catch(() => {
            throw new NotSent('CONNECT_FAILED', true);
          });
        return new Promise((_resolve, reject) => {
          const stop = () => {
            relay.destroy();
            reject(new NotSent('TIMEOUT_BEFORE_COMMIT', true));
          };
          if (context.signal.aborted) stop();
          context.signal.addEventListener('abort', stop, { once: true });
        });
      },
      reconcile: async () => ({ answer: 'cannot_answer' }),
    },
    network: 'egress_gateway',
  });

describeConnectorConformance('a fake that syncs', syncing, { config: {} });
describeConnectorConformance('a fake that acts', acting, { config: {} });
describeConnectorConformance('a fake with nothing to offer', () => createFakeConnector({}), {
  config: {},
});

/** Runs every rule and names the ones that fail. */
async function broken(
  make: () => Connector,
  fixtures: ConformanceFixtures = { config: {}, abortGraceMs: 200 },
) {
  const failed: string[] = [];
  for (const check of conformanceChecks(make, fixtures)) {
    try {
      await check.run();
    } catch {
      failed.push(check.name);
    }
  }
  return failed;
}

const failing = (patch: Partial<Connector>, base: () => Connector = syncing) => ({
  ...base(),
  ...patch,
});

describe('the suite catches', () => {
  it('nothing in connectors that follow the rules', async () => {
    await expect(broken(syncing)).resolves.toEqual([]);
    await expect(broken(acting)).resolves.toEqual([]);
  });

  it('a type that does not match the database check', async () => {
    const connector = syncing();
    const failed = await broken(() =>
      failing({ manifest: { ...connector.manifest, type: 'Has Capitals' } }),
    );
    expect(failed).toContain('manifest shape and type format');
  });

  it('a manifest that is not plain data', async () => {
    const connector = syncing();
    const manifest = { ...connector.manifest, version: new Date() as unknown as string };
    const failed = await broken(() => failing({ manifest }));
    expect(failed).toContain('manifest is plain data, as the web tier reads it');
  });

  it('a stream name the database would refuse', async () => {
    const connector = syncing();
    const failed = await broken(() =>
      failing({
        manifest: {
          ...connector.manifest,
          capabilities: {
            ...connector.manifest.capabilities,
            sync: { streams: ['Not Valid!'], pageSize: 10 },
          },
        },
      }),
    );
    expect(failed).toContain('manifest shape and type format');
  });

  it('a settings parser that accepts a host or a credential', async () => {
    const failed = await broken(() => failing({ parseConfig: (raw) => raw }));
    expect(failed).toContain('parseConfig refuses what it should');
  });

  it('a settings parser that accepts nothing', async () => {
    const failed = await broken(() =>
      failing({
        parseConfig: () => {
          throw new Error('no');
        },
      }),
    );
    expect(failed).toContain('parseConfig accepts the fixture');
  });

  it('a settings parser whose error repeats what it was given', async () => {
    const failed = await broken(() =>
      failing({
        parseConfig: (raw) => {
          throw new Error(`Bad settings: ${JSON.stringify(raw)}`);
        },
      }),
    );
    expect(failed).toContain('parseConfig refuses without repeating what it was given');
  });

  it('a capability that is declared and absent', async () => {
    const { sync: _sync, ...rest } = syncing();
    expect(await broken(() => rest)).toContain('a declared capability exists');
  });

  it('a capability that is present and undeclared', async () => {
    const connector = syncing();
    const failed = await broken(() => ({
      ...connector,
      actions: acting().actions as NonNullable<Connector['actions']>,
    }));
    expect(failed).toContain('an undeclared capability is absent');
  });

  it('a send that ignores its abort', async () => {
    const failed = await broken(() =>
      failing(
        {
          actions: {
            send: () => new Promise(() => undefined),
            reconcile: async () => ({ answer: 'cannot_answer' }),
          },
        },
        acting,
      ),
    );
    expect(failed).toContain('send honours abort');
  });

  it('a send whose answer or error repeats what the provider said', async () => {
    const leak = (message: string) =>
      failing(
        {
          actions: {
            send: async (context) => {
              const relay = await context.network.openRelay({ timeoutMs: 100 });
              const said = await new Promise<string>((resolve) =>
                relay.once('data', (bytes: Buffer) => resolve(bytes.toString())),
              );
              relay.destroy();
              throw new Error(`${message}: ${said}`);
            },
            reconcile: async () => ({ answer: 'cannot_answer' }),
          },
        },
        acting,
      );
    await expect(broken(() => leak('The relay said'))).resolves.toContain(
      'errors carry no provider text',
    );
  });

  it('a send that shows its credential', async () => {
    const failed = await broken(() =>
      failing(
        {
          actions: {
            send: async (context) =>
              context.credentials.withCredential(async (secret) => {
                throw new Error(secret.toString());
              }),
            reconcile: async () => ({ answer: 'cannot_answer' }),
          },
        },
        acting,
      ),
    );
    expect(failed).toContain('errors carry no credential');
  });

  it('a reconcile that claims more than the manifest does', async () => {
    const failed = await broken(() =>
      failing(
        {
          actions: {
            send: acting().actions!.send,
            reconcile: async () => ({ answer: 'found' }),
          },
        },
        acting,
      ),
    );
    expect(failed).toContain("reconcile: 'none' never claims an answer or makes contact");
  });

  it('a connector declaring no network that opens one', async () => {
    const failed = await broken(() =>
      createFakeConnector({
        actions: {
          send: async (context) => {
            await context.network.openRelay({ timeoutMs: 10 });
            return { outcome: 'accepted', code: 'ACCEPTED_BY_PROVIDER' };
          },
          reconcile: async () => ({ answer: 'cannot_answer' }),
        },
      }),
    );
    expect(failed).toContain("network: 'none' never opens a connection");
  });

  it('a connector needing no credential that asks for one', async () => {
    const failed = await broken(() =>
      createFakeConnector({
        actions: {
          send: async (context) =>
            context.credentials.withCredential(async () => ({
              outcome: 'rejected',
              code: 'REFUSED_BY_PROVIDER',
            })),
          reconcile: async () => ({ answer: 'cannot_answer' }),
        },
      }),
    );
    expect(failed).toContain('credential: not required is never asked for');
  });

  it('a stream read that changes between two tries', async () => {
    let times = 0;
    const failed = await broken(() =>
      createFakeConnector({
        pages: { files: [page] },
        readPage: async () => ({ ...page, nextCursor: String((times += 1)) }),
      }),
    );
    expect(failed).toContain('sync: reading the same page twice gives the same page');
  });

  it('a stream that answers for a name it never declared', async () => {
    const failed = await broken(() =>
      createFakeConnector({ pages: { files: [page] }, readPage: async () => page }),
    );
    expect(failed).toContain('sync: an undeclared stream is refused');
  });

  it('source grants from a connector that says it reports none', async () => {
    const withGrant: SyncPage = {
      ...page,
      resources: [
        {
          externalId: 'one',
          resourceType: 'files',
          externalVersion: '1',
          acl: [{ principalKind: 'anyone', principalExternalId: 'anyone', access: 'read' }],
        },
      ],
    };
    const failed = await broken(() =>
      createFakeConnector({ pages: { files: [withGrant] }, aclMapping: false }),
    );
    expect(failed).toContain('sync: a connector reporting no permissions has no grants');
  });

  it('a page its own stream could not have produced', async () => {
    const elsewhere: SyncPage = {
      ...page,
      resources: [{ externalId: 'one', resourceType: 'other', externalVersion: '1', acl: [] }],
    };
    const failed = await broken(() => createFakeConnector({ pages: { files: [elsewhere] } }));
    expect(failed).toContain('sync: pages are valid for their stream');
  });

  it('a webhook interpreter that lets nonsense through', async () => {
    const failed = await broken(() => createFakeConnector({ webhooks: { interpret: () => [] } }));
    expect(failed).toContain('webhooks: anything unrecognized is MalformedWebhook');
  });

  it('a webhook interpreter that passes, when it refuses properly', async () => {
    const failed = await broken(() =>
      createFakeConnector({
        webhooks: {
          interpret: () => {
            throw new MalformedWebhook();
          },
        },
      }),
    );
    expect(failed).toEqual([]);
  });

  it('a shipped type that says something other than what the web tier shows', async () => {
    const connector = createFakeConnector({ type: 'email_smtp' });
    const failed = await broken(() => connector);
    expect(failed).toContain('a shipped connector matches the manifest the web tier reads');
  });
});

describe('the fake connector', () => {
  it('refuses settings, as it takes none', () => {
    expect(() => syncing().parseConfig({ host: 'example.invalid' })).toThrow();
    expect(syncing().parseConfig({})).toEqual({});
  });

  it('hands back the next page number as its cursor', async () => {
    const connector = createFakeConnector({ pages: { files: [page, page] } });
    const context = {
      organizationId: randomUUID(),
      connectionId: randomUUID(),
      config: {},
      credentials: { withCredential: async () => Promise.reject(new Error('unused')) },
      network: { openRelay: async () => new Duplex() },
      signal: new AbortController().signal,
    };
    const read = (cursor: string | null) =>
      connector.sync!.readPage(context, { stream: 'files', cursor, fullSync: false, pageSize: 10 });
    await expect(read(null)).resolves.toMatchObject({ nextCursor: '1', hasMore: true });
    await expect(read('1')).resolves.toMatchObject({ nextCursor: '2', hasMore: false });
    // Past the end there is nothing new, and the cursor stays where it is.
    await expect(read('2')).resolves.toMatchObject({
      resources: [],
      nextCursor: '2',
      hasMore: false,
    });
  });
});
