import { describe, expect, it } from 'vitest';
import { createMicrosoft365Connector, type Microsoft365Config } from './index';
import type { ConnectorContext } from '../index';
import type { ProviderHttpClient, ProviderResponse } from '../knowledge';

const json = (body: unknown, status = 200): ProviderResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});
const ctx = (
  grantedScopes: readonly string[] = ['Files.Read.All'],
): ConnectorContext<Microsoft365Config> => ({
  organizationId: '00000000-0000-4000-8000-000000000a01',
  connectionId: '00000000-0000-4000-8000-000000000a02',
  config: { driveIds: ['generated_drive'] },
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
            tenant: '00000000-0000-4000-8000-000000000a03',
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
const item = {
  id: 'generated_item',
  name: 'Generated file',
  eTag: 'version-1',
  file: { mimeType: 'text/plain' },
  webUrl: 'https://example.invalid/source',
};
describe('Microsoft Graph drive adapter', () => {
  it('requires trusted consent and never parses a host from settings', async () => {
    let calls = 0;
    const connector = createMicrosoft365Connector({
      http: {
        request: async () => {
          calls++;
          return json({});
        },
      },
    });
    expect(() => connector.parseConfig({ drive_ids: [], host: 'attacker.invalid' })).toThrow();
    await expect(
      connector.sync!.readPage(ctx([]), {
        stream: 'drive_items',
        cursor: null,
        fullSync: true,
        pageSize: 100,
      }),
    ).rejects.toMatchObject({ code: 'SCOPES_MISSING' });
    expect(calls).toBe(0);
  });
  it('maps effective principals, removed grants and duplicate delta entries using their last state', async () => {
    let revoked = false,
      deleted = false;
    const connector = createMicrosoft365Connector({
        http: {
          request: async (request) => {
            if (request.route === 'ms_login')
              return json({
                access_token: 'generated-access',
                token_type: 'Bearer',
                expires_in: 3600,
              });
            if (request.path.includes('/permissions'))
              return json({
                value: revoked
                  ? []
                  : [
                      {
                        id: 'generated_permission',
                        roles: ['read'],
                        grantedToIdentitiesV2: [
                          {
                            user: { id: 'user-id' },
                            siteUser: { email: 'person@example.invalid' },
                          },
                          { group: { id: 'group-id' } },
                        ],
                      },
                    ],
              });
            return json({
              value: deleted ? [item, { id: item.id, deleted: { state: 'deleted' } }] : [item],
              '@odata.deltaLink':
                'https://graph.microsoft.com/v1.0/drives/generated_drive/root/delta?token=' +
                String(Number(revoked) + Number(deleted)),
            });
          },
        },
      }),
      context = ctx();
    const first = await connector.sync!.readPage(context, {
      stream: 'drive_items',
      cursor: null,
      fullSync: true,
      pageSize: 100,
    });
    expect(first.resources[0]?.acl).toMatchObject([
      { principalKind: 'user', principalExternalId: 'person@example.invalid' },
      { principalKind: 'group', principalExternalId: 'group-id' },
    ]);
    revoked = true;
    const second = await connector.sync!.readPage(context, {
      stream: 'drive_items',
      cursor: first.nextCursor,
      fullSync: false,
      pageSize: 100,
    });
    expect(second.resources[0]?.acl).toEqual([]);
    deleted = true;
    const third = await connector.sync!.readPage(context, {
      stream: 'drive_items',
      cursor: second.nextCursor,
      fullSync: false,
      pageSize: 100,
    });
    expect(third.resources).toEqual([]);
    expect(third.deletedExternalIds).toEqual([JSON.stringify(['generated_drive', item.id])]);
  });
  it('refuses provider links to another host or drive', async () => {
    for (const link of [
      'https://attacker.invalid/delta',
      'https://graph.microsoft.com/v1.0/drives/another_drive/root/delta',
    ]) {
      const connector = createMicrosoft365Connector({
        http: {
          request: async (request) =>
            request.route === 'ms_login'
              ? json({ access_token: 'generated-access', token_type: 'Bearer', expires_in: 3600 })
              : json({ value: [], '@odata.nextLink': link }),
        },
      });
      await expect(
        connector.sync!.readPage(ctx(), {
          stream: 'drive_items',
          cursor: null,
          fullSync: true,
          pageSize: 100,
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
    }
  });
  it('uses only the credential-free download port for one redirect and refuses a second hop', async () => {
    for (const secondHop of [false, true]) {
      let downloads = 0;
      const http: ProviderHttpClient = {
        request: async (request) => {
          if (request.route === 'ms_login')
            return json({
              access_token: 'generated-access',
              token_type: 'Bearer',
              expires_in: 3600,
            });
          if (request.path.endsWith('/content'))
            return {
              status: 302,
              headers: { location: 'https://cdn.example.invalid/generated?temporary=canary' },
              body: Buffer.alloc(0),
            };
          return json(item);
        },
        download: async (request) => {
          downloads++;
          expect(Object.hasOwn(request, 'headers')).toBe(false);
          return secondHop
            ? {
                status: 302,
                headers: { location: 'https://attacker.invalid/second' },
                body: Buffer.alloc(0),
              }
            : {
                status: 200,
                headers: { 'content-type': 'text/plain' },
                body: Buffer.from('Generated body'),
              };
        },
      };
      const reading = createMicrosoft365Connector({ http }).content.readContent(ctx(), {
        externalId: JSON.stringify(['generated_drive', item.id]),
        resourceType: 'text/plain',
        maxBytes: 1024,
      });
      if (secondHop) await expect(reading).rejects.toMatchObject({ code: 'PROVIDER_REDIRECT' });
      else
        expect(await reading).toMatchObject({ mediaType: 'text/plain', sourceVersion: item.eTag });
      expect(downloads).toBe(1);
    }
  });
});
