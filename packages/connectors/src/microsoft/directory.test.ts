import { describe, expect, it } from 'vitest';
import { isValidDirectoryPage } from '@ensemus/domain/workspace-suites';
import { createMicrosoft365Connector, DIRECTORY_SCOPES, type Microsoft365Config } from './index';
import type { ConnectorContext } from '../index';
import type { ProviderHttpClient, ProviderResponse } from '../knowledge';

const json = (body: unknown, status = 200): ProviderResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});
const context = (
  grantedScopes: readonly string[] = DIRECTORY_SCOPES,
): ConnectorContext<Microsoft365Config> => ({
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

const GRAPH = 'https://graph.microsoft.com';
const user = (id: string, mail: string | null, upn: string) => ({
  '@odata.type': '#microsoft.graph.user',
  id,
  mail,
  userPrincipalName: upn,
});
const group = (id: string, displayName = id) => ({
  '@odata.type': '#microsoft.graph.group',
  id,
  displayName,
});

type Tenant = {
  members: Record<string, unknown[]>;
  parents: Record<string, unknown[]>;
  names: Record<string, string>;
  /** What each delta link answers, by its query. */
  delta: Record<string, unknown>;
};

function fakeGraph(tenant: Tenant) {
  const paths: string[] = [];
  const http: ProviderHttpClient = {
    request: async (request) => {
      if (request.route === 'ms_login')
        return json({ access_token: 'generated-access', token_type: 'Bearer', expires_in: 3600 });
      paths.push(request.path);
      const url = new URL(`${GRAPH}${request.path}`);
      if (url.pathname === '/v1.0/groups/delta') {
        const answer = tenant.delta[url.search];
        return answer === undefined ? json({}, 410) : json(answer);
      }
      const match = /^\/v1\.0\/groups\/([^/]+)(\/members|\/memberOf)?$/.exec(url.pathname);
      if (!match) return json({}, 500);
      const id = decodeURIComponent(match[1]!);
      if (!(id in tenant.names)) return json({}, 404);
      if (match[2] === '/members') return json({ value: tenant.members[id] ?? [] });
      if (match[2] === '/memberOf') return json({ value: tenant.parents[id] ?? [] });
      return json({ id, displayName: tenant.names[id] });
    },
  };
  return { http, paths };
}

const tenant = (): Tenant => ({
  names: { finance: 'Finance', payroll: 'Payroll' },
  members: {
    finance: [
      user('u1', 'Alex@Example.invalid', 'alex@tenant.invalid'),
      user('u2', null, 'Sam@Example.invalid'),
      group('payroll', 'Payroll'),
      { '@odata.type': '#microsoft.graph.device', id: 'device1' },
    ],
    payroll: [user('u3', 'pat@example.invalid', 'pat@tenant.invalid')],
  },
  parents: { payroll: [group('finance', 'Finance')], finance: [] },
  delta: {
    '?$select=displayName,members': {
      value: [{ id: 'finance', displayName: 'Finance', 'members@delta': [{ id: 'u1' }] }],
      '@odata.nextLink': `${GRAPH}/v1.0/groups/delta?$skiptoken=page2`,
    },
    '?$skiptoken=page2': {
      value: [
        { id: 'payroll', displayName: 'Payroll' },
        { id: 'old', '@removed': { reason: 'deleted' } },
      ],
      '@odata.deltaLink': `${GRAPH}/v1.0/groups/delta?$deltatoken=round1`,
    },
    '?$deltatoken=round1': {
      value: [{ id: 'payroll', displayName: 'Payroll', 'members@delta': [{ id: 'u3' }] }],
      '@odata.deltaLink': `${GRAPH}/v1.0/groups/delta?$deltatoken=round2`,
    },
    '?$deltatoken=round2': {
      value: [{ id: 'gone', '@removed': { reason: 'changed' } }],
      '@odata.deltaLink': `${GRAPH}/v1.0/groups/delta?$deltatoken=round3`,
    },
  },
});

describe('Microsoft directory groups', () => {
  it('refuses without every directory scope before any request', async () => {
    const { http, paths } = fakeGraph(tenant());
    const connector = createMicrosoft365Connector({ http });
    await expect(
      connector.directory.readGroups(context(['GroupMember.Read.All']), null),
    ).rejects.toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    expect(paths).toEqual([]);
  });

  it('reads a full round with whole member lists, then an incremental round with the parents', async () => {
    const { http } = fakeGraph(tenant());
    const connector = createMicrosoft365Connector({ http });
    const ctx = context();

    const first = await connector.directory.readGroups(ctx, null);
    expect(isValidDirectoryPage(first)).toBe(true);
    expect(first).toMatchObject({ fullSync: true, hasMore: true });
    expect(first.groups).toEqual([
      {
        externalId: 'finance',
        displayName: 'Finance',
        members: [
          { kind: 'user', externalId: 'alex@example.invalid' },
          { kind: 'user', externalId: 'sam@example.invalid' },
          { kind: 'group', externalId: 'payroll' },
        ],
      },
      // Nested, so it rides in the same page to be flattened.
      {
        externalId: 'payroll',
        displayName: 'Payroll',
        members: [{ kind: 'user', externalId: 'pat@example.invalid' }],
      },
    ]);

    const second = await connector.directory.readGroups(ctx, first.nextCursor);
    expect(second).toMatchObject({ fullSync: true, hasMore: false, deletedExternalIds: ['old'] });
    expect(second.groups.map((group) => group.externalId)).toEqual(['payroll']);

    // Payroll changed, so Finance, which holds it, is read again in the same page.
    const third = await connector.directory.readGroups(ctx, second.nextCursor);
    expect(third).toMatchObject({ fullSync: false, hasMore: false, deletedExternalIds: [] });
    expect(third.groups.map((group) => group.externalId).sort()).toEqual(['finance', 'payroll']);

    // A deleted group's parents are never told, so only a full pass will do.
    await expect(connector.directory.readGroups(ctx, third.nextCursor)).rejects.toMatchObject({
      name: 'CursorExpired',
    });
  });

  it('sends an old or foreign cursor back to a full pass', async () => {
    const { http, paths } = fakeGraph(tenant());
    const connector = createMicrosoft365Connector({ http });
    const stale = JSON.stringify({
      v: 1,
      full: false,
      link: '/v1.0/groups/delta?$deltatoken=round1',
      since: 0,
    });
    await expect(connector.directory.readGroups(context(), stale)).rejects.toMatchObject({
      name: 'CursorExpired',
    });
    const foreign = JSON.stringify({ v: 1, full: true, link: '/v1.0/users/delta', since: null });
    await expect(connector.directory.readGroups(context(), foreign)).rejects.toMatchObject({
      name: 'CursorExpired',
    });
    expect(paths).toEqual([]);
    // The provider saying the token has expired is the same.
    const expired = JSON.stringify({
      v: 1,
      full: false,
      link: '/v1.0/groups/delta?$deltatoken=unknown',
      since: Date.now(),
    });
    await expect(connector.directory.readGroups(context(), expired)).rejects.toMatchObject({
      name: 'CursorExpired',
    });
  });

  it('refuses a continuation link to another host', async () => {
    const answers = tenant();
    answers.delta['?$select=displayName,members'] = {
      value: [],
      '@odata.nextLink': 'https://attacker.invalid/v1.0/groups/delta?$skiptoken=x',
    };
    const connector = createMicrosoft365Connector({ http: fakeGraph(answers).http });
    await expect(connector.directory.readGroups(context(), null)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE_INVALID',
    });
  });
});
