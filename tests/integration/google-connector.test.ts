// Local TLS provider plus real SDK commit, ACL mapping, ingest and retrieval. Live qualification is owed.
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
  createGoogleWorkspaceConnector,
  type GoogleWorkspaceConfig,
} from '@ensemus/connectors/google';
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
    }),
  );
const json = (body: unknown) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});
// Conformance's generic lease is intentionally converted to a generated OAuth fixture, through that
// same lease, and consent is supplied as trusted context. No settings field can create consent.
function conformanceConnector(): Connector {
  const connector = createGoogleWorkspaceConnector({
    http: {
      request: async (request) =>
        request.route === 'google_oauth'
          ? json({ access_token: 'generated-access', token_type: 'Bearer', expires_in: 3600 })
          : request.path.includes('startPageToken')
            ? json({ startPageToken: 'generated_start' })
            : json({ files: [] }),
    },
  });
  return {
    ...connector,
    sync: {
      readPage: (context, request) =>
        connector.sync!.readPage(
          {
            ...context,
            config: context.config as GoogleWorkspaceConfig,
            grantedScopes: ['https://www.googleapis.com/auth/drive.readonly'],
            credentials: {
              withCredential: (use) => context.credentials.withCredential(() => use(credential())),
            },
          },
          request,
        ),
    },
  };
}
describeConnectorConformance('Google Workspace', conformanceConnector, {
  config: { drive_ids: [] },
});

describe('Google provider permissions join the live source ACL', () => {
  let database: ReturnType<typeof openAppDatabase>,
    auth: pg.Client,
    owner: TenantContext,
    fake: Awaited<ReturnType<typeof fakeProvider>>,
    ownerEmail: string;
  const word = knowledgeCanary('google');
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
      if (request.path === '/token') {
        fakeJson(socket, 200, {
          access_token: 'generated-access',
          token_type: 'Bearer',
          expires_in: 3600,
        });
        return;
      }
      if (request.path.includes('/changes/startPageToken')) {
        fakeJson(socket, 200, { startPageToken: 'generated_start' });
        return;
      }
      if (request.path.includes('/permissions')) {
        fakeJson(socket, 200, {
          permissions: revoked
            ? []
            : [
                {
                  id: 'generated_permission',
                  type: 'user',
                  emailAddress: ownerEmail,
                  role: 'reader',
                },
              ],
        });
        return;
      }
      const file = {
        id: 'generated_file',
        name: 'Generated file',
        mimeType: 'text/plain',
        version: '1',
        webViewLink: 'https://example.invalid/source',
      };
      if (request.path.includes('alt=media')) {
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(word)}\r\n\r\n${word}`,
        );
        return;
      }
      if (request.path.startsWith('/drive/v3/files?')) {
        fakeJson(socket, 200, { files: [file] });
        return;
      }
      if (request.path.startsWith('/drive/v3/changes?')) {
        fakeJson(socket, 200, {
          changes: deleted ? [{ fileId: file.id, removed: true }] : [{ fileId: file.id, file }],
          newStartPageToken: deleted ? 'generated_end_3' : 'generated_end_2',
        });
        return;
      }
      fakeJson(socket, 200, file);
    });
  });
  afterAll(async () => {
    await fake.close();
    await auth.end();
    await database.close();
  });
  it('publishes through the SDK, then removes access on an unchanged-version ACL removal before purge', async () => {
    const connectionId = randomUUID(),
      service = createServiceContext(owner.organizationId);
    await withTenantTx(database.db, owner, (tx) =>
      tx.insert(connections).values({
        organizationId: owner.organizationId,
        id: connectionId,
        connectorType: 'google_workspace',
        displayName: 'Generated drive',
        grantedScopes: ['https://www.googleapis.com/auth/drive.readonly'],
      }),
    );
    const connector = createGoogleWorkspaceConnector({
      http: createProviderHttpClient({
        routes: { google_api: fake.network, google_oauth: fake.network },
        testCa: fake.ca,
      }),
    });
    const context: ConnectorContext<GoogleWorkspaceConfig> = {
      organizationId: owner.organizationId,
      connectionId,
      config: { driveIds: [] },
      grantedScopes: ['https://www.googleapis.com/auth/drive.readonly'],
      signal: AbortSignal.timeout(30_000),
      network: fake.network,
      credentials: { withCredential: async (use) => use(credential()) },
    };
    let lease = await leaseSyncStream(database.db, service, {
      connectionId,
      stream: 'drive_files',
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
      stream: 'drive_files',
      cursor: null,
      fullSync: true,
      pageSize: 100,
    });
    await commit(first);
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
      stream: 'drive_files',
      cursor: first.nextCursor,
      fullSync: false,
      pageSize: 100,
    });
    expect(second.resources[0]?.externalVersion).toBe('1');
    await commit(second);
    expect(await searchLexical(database.db, owner, { query: word })).toEqual([]);
    deleted = true;
    await commit(
      await connector.sync!.readPage(context, {
        stream: 'drive_files',
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
