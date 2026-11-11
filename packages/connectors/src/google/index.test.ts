import { describe, expect, it } from 'vitest';
import { createGoogleWorkspaceConnector, type GoogleWorkspaceConfig } from './index';
import type { ConnectorContext } from '../index';
import type { ProviderHttpClient, ProviderResponse } from '../knowledge';

const json = (body: unknown, status = 200): ProviderResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});
const context = (
  grantedScopes: readonly string[] = ['https://www.googleapis.com/auth/drive.readonly'],
): ConnectorContext<GoogleWorkspaceConfig> => ({
  organizationId: '00000000-0000-4000-8000-000000000a01',
  connectionId: '00000000-0000-4000-8000-000000000a02',
  config: { driveIds: [] },
  grantedScopes,
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
});
const file = { id: 'generated_file', name: 'Generated file', mimeType: 'text/plain', version: '1' };
describe('Google Drive v3 adapter', () => {
  it('denies missing consent and host-bearing configuration before requesting a credential', async () => {
    let called = 0;
    const connector = createGoogleWorkspaceConnector({
      http: {
        request: async () => {
          called++;
          return json({});
        },
      },
    });
    expect(() => connector.parseConfig({ drive_ids: [], host: 'attacker.invalid' })).toThrow();
    await expect(
      connector.sync!.readPage(context([]), {
        stream: 'drive_files',
        cursor: null,
        fullSync: true,
        pageSize: 100,
      }),
    ).rejects.toMatchObject({ code: 'SCOPES_MISSING' });
    expect(called).toBe(0);
  });
  it('uses one auth session across full pages and then reports removed grants and deletion', async () => {
    let oauth = 0,
      changed = false,
      deleted = false;
    const http: ProviderHttpClient = {
      request: async (request) => {
        if (request.route === 'google_oauth') {
          oauth++;
          return json({ access_token: 'generated-access', token_type: 'Bearer', expires_in: 3600 });
        }
        if (request.path.includes('/changes/startPageToken'))
          return json({ startPageToken: 'start_1' });
        if (request.path.startsWith('/drive/v3/files?'))
          return request.path.includes('pageToken=full_2')
            ? json({ files: [] })
            : json({ files: [file], nextPageToken: 'full_2' });
        if (request.path.includes('/permissions'))
          return json({
            permissions: changed
              ? []
              : [
                  {
                    id: 'user-id',
                    type: 'user',
                    emailAddress: 'person@example.invalid',
                    role: 'reader',
                  },
                  { id: 'group-id', type: 'group', role: 'reader' },
                  {
                    id: 'finance-permission-id',
                    type: 'group',
                    emailAddress: 'Finance@Example.invalid',
                    role: 'writer',
                  },
                  { id: 'domain-id', type: 'domain', domain: 'example.invalid', role: 'reader' },
                ],
          });
        if (request.path.startsWith('/drive/v3/changes?'))
          return json({
            changes: deleted
              ? [{ fileId: file.id, removed: true }]
              : [{ fileId: file.id, file: { ...file, version: '2' } }],
            newStartPageToken: deleted ? 'start_3' : 'start_2',
          });
        throw new Error('UNEXPECTED_REQUEST');
      },
    };
    const connector = createGoogleWorkspaceConnector({ http }),
      ctx = context();
    const first = await connector.sync!.readPage(ctx, {
      stream: 'drive_files',
      cursor: null,
      fullSync: true,
      pageSize: 100,
    });
    expect(first.hasMore).toBe(true);
    expect(first.resources[0]?.acl).toMatchObject([
      { principalKind: 'user', principalExternalId: 'person@example.invalid' },
      { principalKind: 'group', principalExternalId: 'group-id' },
      // Keyed by the group's email, as the directory keys the group's team.
      { principalKind: 'group', principalExternalId: 'finance@example.invalid', access: 'write' },
      { principalKind: 'domain' },
    ]);
    const second = await connector.sync!.readPage(ctx, {
      stream: 'drive_files',
      cursor: first.nextCursor,
      fullSync: true,
      pageSize: 100,
    });
    expect(second.hasMore).toBe(false);
    expect(oauth).toBe(1);
    changed = true;
    const third = await connector.sync!.readPage(ctx, {
      stream: 'drive_files',
      cursor: second.nextCursor,
      fullSync: false,
      pageSize: 100,
    });
    expect(third.resources[0]?.acl).toEqual([]);
    deleted = true;
    expect(
      (
        await connector.sync!.readPage(ctx, {
          stream: 'drive_files',
          cursor: third.nextCursor,
          fullSync: false,
          pageSize: 100,
        })
      ).deletedExternalIds,
    ).toEqual([file.id]);
    connector.disposeAuthSession!(ctx.credentials);
  });
  it('exports supported Workspace text and refuses a version that changes during the read', async () => {
    for (const changes of [false, true]) {
      let metadata = 0;
      const connector = createGoogleWorkspaceConnector({
        http: {
          request: async (request) => {
            if (request.route === 'google_oauth')
              return json({
                access_token: 'generated-access',
                token_type: 'Bearer',
                expires_in: 3600,
              });
            if (request.path.includes('/export?'))
              return {
                status: 200,
                headers: { 'content-type': 'text/plain' },
                body: Buffer.from('Generated export'),
              };
            metadata++;
            return json({
              ...file,
              mimeType: 'application/vnd.google-apps.document',
              version: changes && metadata > 1 ? '2' : '1',
              webViewLink: 'https://example.invalid/source',
            });
          },
        },
      });
      const reading = connector.content.readContent(context(), {
        externalId: file.id,
        resourceType: 'application/vnd.google-apps.document',
        maxBytes: 1024,
      });
      if (changes) await expect(reading).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
      else
        expect(await reading).toMatchObject({
          mediaType: 'text/plain',
          sourceVersion: '1',
          title: file.name,
          sourceUrl: 'https://example.invalid/source',
        });
    }
  });
  it('carries only codes on credential rejection, throttling, server failure and malformed JSON', async () => {
    for (const status of [400, 429, 500]) {
      const connector = createGoogleWorkspaceConnector({
        http: { request: async () => json({ error: 'generated-provider-canary' }, status) },
      });
      await expect(
        connector.sync!.readPage(context(), {
          stream: 'drive_files',
          cursor: null,
          fullSync: true,
          pageSize: 100,
        }),
      ).rejects.toMatchObject({
        message:
          status === 400
            ? 'CREDENTIAL_REJECTED'
            : status === 429
              ? 'RATE_LIMITED'
              : 'PROVIDER_UNAVAILABLE',
      });
    }
    const connector = createGoogleWorkspaceConnector({
      http: {
        request: async () => ({
          status: 200,
          headers: {},
          body: Buffer.from('{malformed generated token'),
        }),
      },
    });
    await expect(
      connector.sync!.readPage(context(), {
        stream: 'drive_files',
        cursor: null,
        fullSync: true,
        pageSize: 100,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
  });
});
