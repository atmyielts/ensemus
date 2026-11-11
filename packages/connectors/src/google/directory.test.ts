import { describe, expect, it } from 'vitest';
import { isValidDirectoryPage } from '@ensemus/domain/workspace-suites';
import {
  createGoogleWorkspaceConnector,
  DIRECTORY_SCOPES,
  type GoogleWorkspaceConfig,
} from './index';
import type { ConnectorContext, CredentialLease } from '../index';
import type { ProviderHttpClient, ProviderRequest, ProviderResponse } from '../knowledge';

const json = (body: unknown, status = 200): ProviderResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});
const lease = (): CredentialLease => ({
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
});
const context = (
  grantedScopes: readonly string[] = DIRECTORY_SCOPES,
): ConnectorContext<GoogleWorkspaceConfig> => ({
  organizationId: '00000000-0000-4000-8000-000000000a01',
  connectionId: '00000000-0000-4000-8000-000000000a02',
  config: { driveIds: [] },
  grantedScopes,
  signal: new AbortController().signal,
  credentials: lease(),
  network: {
    openRelay: async () => {
      throw new Error('NO_AMBIENT_NETWORK');
    },
  },
});

type Directory = Record<
  string,
  { name: string; members: { email: string; type: string; status?: string }[] }
>;

/** A fake Directory API over `groups`, keyed by email, recording every path it was asked for. */
function fakeDirectory(
  groups: Directory,
  options: { pageSize?: number; forbidden?: string[] } = {},
) {
  const paths: string[] = [];
  const http: ProviderHttpClient = {
    request: async (request: ProviderRequest) => {
      if (request.route === 'google_oauth')
        return json({ access_token: 'generated-access', token_type: 'Bearer', expires_in: 3600 });
      paths.push(request.path);
      const url = new URL(`https://fake.invalid${request.path}`);
      if (url.pathname === '/admin/directory/v1/groups') {
        if (url.searchParams.get('customer') !== 'my_customer') return json({}, 400);
        if (url.searchParams.get('pageToken') === 'expired') return json({}, 400);
        const all = Object.keys(groups).sort();
        const size = options.pageSize ?? all.length;
        const start = Number(url.searchParams.get('pageToken') ?? 0);
        const slice = all.slice(start, start + size);
        return json({
          groups: slice.map((email) => ({ email, name: groups[email]!.name })),
          ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}),
        });
      }
      const match = /^\/admin\/directory\/v1\/groups\/([^/]+)(\/members)?$/.exec(url.pathname);
      if (!match) return json({}, 500);
      const key = decodeURIComponent(match[1]!);
      if (options.forbidden?.includes(key)) return json({}, 403);
      const group = groups[key];
      if (!group) return json({}, 404);
      return match[2] ? json({ members: group.members }) : json({ email: key, name: group.name });
    },
  };
  return { http, paths };
}

describe('Google directory groups', () => {
  it('refuses without the directory scope before any request', async () => {
    const { http, paths } = fakeDirectory({});
    const connector = createGoogleWorkspaceConnector({ http });
    await expect(
      connector.directory.readGroups(
        context(['https://www.googleapis.com/auth/drive.readonly']),
        null,
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    expect(paths).toEqual([]);
  });

  it('reads a full pass by page, keyed by lower-case email, with nested groups in the same page', async () => {
    const { http, paths } = fakeDirectory(
      {
        'a-team@example.invalid': {
          name: 'A team',
          members: [
            { email: 'Alex@Example.invalid', type: 'USER', status: 'ACTIVE' },
            { email: 'gone@example.invalid', type: 'USER', status: 'SUSPENDED' },
            { email: 'guest@example.invalid', type: 'EXTERNAL' },
            { email: 'z-nested@example.invalid', type: 'GROUP' },
            { email: 'outside@elsewhere.invalid', type: 'GROUP' },
            { email: 'customer', type: 'CUSTOMER' },
          ],
        },
        'z-nested@example.invalid': {
          name: 'Nested\tteam',
          members: [{ email: 'sam@example.invalid', type: 'USER' }],
        },
      },
      { pageSize: 1, forbidden: ['outside@elsewhere.invalid'] },
    );
    const connector = createGoogleWorkspaceConnector({ http });
    const ctx = context();
    const first = await connector.directory.readGroups(ctx, null);
    expect(isValidDirectoryPage(first)).toBe(true);
    expect(first).toMatchObject({ fullSync: true, hasMore: true, deletedExternalIds: [] });
    expect(first.groups).toEqual([
      {
        externalId: 'a-team@example.invalid',
        displayName: 'A team',
        members: [
          { kind: 'user', externalId: 'alex@example.invalid' },
          { kind: 'user', externalId: 'guest@example.invalid' },
          { kind: 'group', externalId: 'z-nested@example.invalid' },
          { kind: 'group', externalId: 'outside@elsewhere.invalid' },
        ],
      },
      {
        externalId: 'z-nested@example.invalid',
        displayName: 'Nested team',
        members: [{ kind: 'user', externalId: 'sam@example.invalid' }],
      },
    ]);
    const second = await connector.directory.readGroups(ctx, first.nextCursor);
    expect(second).toMatchObject({ fullSync: true, hasMore: false, nextCursor: null });
    expect(second.groups.map((group) => group.externalId)).toEqual(['z-nested@example.invalid']);
    expect(paths.every((path) => path.startsWith('/admin/directory/v1/groups'))).toBe(true);
  });

  it('cuts a cycle and reads each group once per page', async () => {
    const { http, paths } = fakeDirectory({
      'a@example.invalid': { name: 'A', members: [{ email: 'b@example.invalid', type: 'GROUP' }] },
      'b@example.invalid': { name: 'B', members: [{ email: 'a@example.invalid', type: 'GROUP' }] },
    });
    const connector = createGoogleWorkspaceConnector({ http });
    const page = await connector.directory.readGroups(context(), null);
    expect(page.groups.map((group) => group.externalId)).toEqual([
      'a@example.invalid',
      'b@example.invalid',
    ]);
    expect(isValidDirectoryPage(page)).toBe(true);
    expect(paths.filter((path) => path.includes('/members')).length).toBe(2);
  });

  it('says an expired page token or a cursor it did not write is expired', async () => {
    const { http } = fakeDirectory({});
    const connector = createGoogleWorkspaceConnector({ http });
    await expect(
      connector.directory.readGroups(context(), JSON.stringify({ v: 1, page: 'expired' })),
    ).rejects.toMatchObject({ name: 'CursorExpired' });
    await expect(connector.directory.readGroups(context(), '{not json')).rejects.toMatchObject({
      name: 'CursorExpired',
    });
  });

  it('carries only a code when the provider refuses', async () => {
    const connector = createGoogleWorkspaceConnector({
      http: {
        request: async (request) =>
          request.route === 'google_oauth'
            ? json({ access_token: 'generated-access', token_type: 'Bearer', expires_in: 3600 })
            : json({ error: 'generated-provider-canary' }, 403),
      },
    });
    const failure = await connector.directory.readGroups(context(), null).catch((error) => error);
    expect(failure).toMatchObject({ code: 'CREDENTIAL_REJECTED' });
    expect(String(failure.message)).not.toContain('canary');
  });
});
