// Local TLS provider and real M3/M5 joins. No Microsoft account, tenant or credential has been used.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitSyncPage, leaseSyncStream, resolveSourcePrincipal } from '@ensemus/application';
import { ingestDocument, recordConnectorContent } from '@ensemus/application/knowledge/ingest';
import { searchLexical } from '@ensemus/application/knowledge/retrieval';
import {
  connections,
  createOrganization,
  externalResources,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  createMicrosoft365Connector,
  type Microsoft365Config,
} from '@ensemus/connectors/microsoft';
import { createProviderHttpClient } from '@ensemus/connectors/provider-http';
import { mapSourceGrants } from '@ensemus/connectors/runtime';
import { describeConnectorConformance } from '@ensemus/connectors/testing';
import type { Connector, ConnectorContext, SyncPage } from '@ensemus/connectors';
import { parseDocument } from '@ensemus/knowledge/parsing';
import { eq } from 'drizzle-orm';
import { fakeJson, fakeProvider } from '../helpers/fake-provider';
import { knowledgeCanary } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

const credential = () =>
  Buffer.from(
    JSON.stringify({
      client_id: 'generated',
      client_secret: 'generated-secret',
      refresh_token: 'generated-refresh',
      tenant: '00000000-0000-4000-8000-000000000a03',
    }),
  );
const json = (body: unknown) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});
function conformanceConnector(): Connector {
  const connector = createMicrosoft365Connector({
    http: {
      request: async (request) =>
        request.route === 'ms_login'
          ? json({ access_token: 'generated-access', token_type: 'Bearer', expires_in: 3600 })
          : json({
              value: [],
              '@odata.deltaLink':
                'https://graph.microsoft.com/v1.0/drives/generated_drive/root/delta?token=generated',
            }),
    },
  });
  return {
    ...connector,
    sync: {
      readPage: (context, request) =>
        connector.sync!.readPage(
          {
            ...context,
            config: context.config as Microsoft365Config,
            grantedScopes: ['Files.Read.All'],
            credentials: {
              withCredential: (use) => context.credentials.withCredential(() => use(credential())),
            },
          },
          request,
        ),
    },
  };
}
describeConnectorConformance('Microsoft 365', conformanceConnector, {
  config: { drive_ids: ['generated_drive'] },
});

describe('Graph permissions join the live source ACL', () => {
  let database: ReturnType<typeof openAppDatabase>,
    auth: pg.Client,
    owner: TenantContext,
    fake: Awaited<ReturnType<typeof fakeProvider>>,
    ownerEmail: string;
  const word = knowledgeCanary('microsoft');
  let revoked = false,
    deleted = false;
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const userId = randomUUID();
    ownerEmail = `${userId}@example.invalid`;
    await auth.query('insert into identity.users(id,name,email) values($1,$2,$3)', [
      userId,
      'Generated owner',
      ownerEmail,
    ]);
    const org = await createOrganization(database.db, {
      userId,
      name: 'Generated company',
      commercialMode: 'byom',
    });
    owner = await resolveTenantContext(database.db, userId, org.organizationId);
    fake = await fakeProvider((request, socket) => {
      if (request.path.endsWith('/oauth2/v2.0/token')) {
        fakeJson(socket, 200, {
          access_token: 'generated-access',
          token_type: 'Bearer',
          expires_in: 3600,
        });
        return;
      }
      if (request.path.includes('/permissions')) {
        fakeJson(socket, 200, {
          value: revoked
            ? []
            : [
                {
                  id: 'generated_permission',
                  roles: ['read'],
                  grantedToV2: { user: { id: 'generated_user' }, siteUser: { email: ownerEmail } },
                },
              ],
        });
        return;
      }
      const item = {
        id: 'generated_item',
        name: 'Generated file',
        file: { mimeType: 'text/plain' },
        eTag: 'version-1',
        webUrl: 'https://example.invalid/source',
      };
      if (request.path.endsWith('/content')) {
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(word)}\r\n\r\n${word}`,
        );
        return;
      }
      if (request.path.includes('/delta')) {
        fakeJson(socket, 200, {
          value: deleted ? [{ id: item.id, deleted: { state: 'deleted' } }] : [item],
          '@odata.deltaLink': `https://graph.microsoft.com/v1.0/drives/generated_drive/root/delta?token=${deleted ? '3' : revoked ? '2' : '1'}`,
        });
        return;
      }
      fakeJson(socket, 200, item);
    });
  });
  afterAll(async () => {
    await fake.close();
    await auth.end();
    await database.close();
  });
  it('publishes direct content and denies the next read after an unchanged-version permission removal', async () => {
    const connectionId = randomUUID(),
      service = createServiceContext(owner.organizationId);
    await withTenantTx(database.db, owner, (tx) =>
      tx.insert(connections).values({
        organizationId: owner.organizationId,
        id: connectionId,
        connectorType: 'microsoft_365',
        displayName: 'Generated drive',
        grantedScopes: ['Files.Read.All'],
      }),
    );
    const connector = createMicrosoft365Connector({
      http: createProviderHttpClient({
        routes: { ms_graph: fake.network, ms_login: fake.network },
        testCa: fake.ca,
      }),
    });
    const context: ConnectorContext<Microsoft365Config> = {
      organizationId: owner.organizationId,
      connectionId,
      config: { driveIds: ['generated_drive'] },
      grantedScopes: ['Files.Read.All'],
      signal: AbortSignal.timeout(30_000),
      network: fake.network,
      credentials: { withCredential: async (use) => use(credential()) },
    };
    let lease = await leaseSyncStream(database.db, service, {
      connectionId,
      stream: 'drive_items',
      leaseMs: 60_000,
    });
    if (!lease) throw new Error('MISSING_TEST_LEASE');
    const commit = async (page: SyncPage) => {
      const mappedGrants = await Promise.all(
        page.resources.map((resource) =>
          mapSourceGrants(resource.acl, {
            resolve: (principal) => resolveSourcePrincipal(database.db, service, principal),
          }),
        ),
      );
      const next = await commitSyncPage(database.db, service, {
        connectionId,
        lease: lease!,
        page: { ...page, mappedGrants },
      });
      if (!next) throw new Error('LOST_TEST_LEASE');
      lease = next;
    };
    const first = await connector.sync!.readPage(context, {
      stream: 'drive_items',
      cursor: null,
      fullSync: true,
      pageSize: 100,
    });
    await commit(first);
    expect(fake.requests.some((request) => request.path.endsWith('/content'))).toBe(false);
    const [resource] = await withTenantTx(database.db, service, (tx) =>
      tx.select().from(externalResources).where(eq(externalResources.connectionId, connectionId)),
    );
    const content = await connector.content.readContent(context, {
      externalId: resource!.externalId,
      resourceType: resource!.resourceType,
      maxBytes: 1024,
    });
    const staged = await recordConnectorContent(database.db, service, {
      externalResourceId: resource!.id,
      title: content.title,
      sourceVersion: content.sourceVersion,
      sourceUrl: content.sourceUrl,
      sourceModifiedAt: content.sourceModifiedAt,
      mediaType: content.mediaType,
      body: content.bytes,
    });
    if (!staged) throw new Error('MISSING_TEST_DOCUMENT');
    const blobs = new Map<string, Buffer>(),
      store = {
        put: async (key: string, body: Buffer) => {
          blobs.set(key, Buffer.from(body));
        },
        get: async (key: string) => Buffer.from(blobs.get(key)!),
        delete: async (key: string) => {
          blobs.delete(key);
        },
        exists: async (key: string) => blobs.has(key),
      };
    expect(
      await ingestDocument(
        database.db,
        store,
        service,
        {
          parse: async (bytes, type) => parseDocument(bytes, type),
          contentScan: { scan: () => ({ raiseTo: null, codes: [] }) },
        },
        staged,
      ),
    ).toMatchObject({ outcome: 'searchable' });
    expect(await searchLexical(database.db, owner, { query: word })).toHaveLength(1);
    revoked = true;
    const second = await connector.sync!.readPage(context, {
      stream: 'drive_items',
      cursor: first.nextCursor,
      fullSync: false,
      pageSize: 100,
    });
    expect(second.resources[0]?.externalVersion).toBe('version-1');
    await commit(second);
    expect(await searchLexical(database.db, owner, { query: word })).toEqual([]);
    deleted = true;
    await commit(
      await connector.sync!.readPage(context, {
        stream: 'drive_items',
        cursor: second.nextCursor,
        fullSync: false,
        pageSize: 100,
      }),
    );
    expect(
      (
        await withTenantTx(database.db, service, (tx) =>
          tx.select().from(externalResources).where(eq(externalResources.id, resource!.id)),
        )
      )[0]?.deletedAt,
    ).toBeInstanceOf(Date);
    connector.disposeAuthSession!(context.credentials);
  });
});
