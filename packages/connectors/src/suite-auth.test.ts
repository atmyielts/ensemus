// The suite connectors hand the worker's operator apps and scope recorder to their auth session. The
// session itself is tested in runtime/provider-oauth*.test.ts. These prove the wiring reaches it, since a
// connector that dropped either would still type-check and would fail only against a real provider.
import { describe, expect, it } from 'vitest';
import type { ConnectorContext } from './index';
import type { ProviderHttpClient, ProviderRequest, ProviderResponse } from './knowledge';
import { createGoogleWorkspaceConnector } from './google/index';
import { createMicrosoft365Connector } from './microsoft/index';
import type { OAuthScopesPort } from './runtime/provider-oauth';
import type { PlatformOAuthClient, PlatformOAuthClients } from './suites';

const ORGANIZATION = '00000000-0000-4000-8000-000000000b01';
const CONNECTION = '00000000-0000-4000-8000-000000000b02';
const TENANT = '00000000-0000-4000-8000-000000000b03';

const json = (body: unknown, status = 200): ProviderResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});

const cases = [
  {
    provider: 'google' as const,
    tokenRoute: 'google_oauth',
    stream: 'drive_files',
    grantedScopes: ['https://www.googleapis.com/auth/drive.readonly'],
    reported: 'https://www.googleapis.com/auth/drive.readonly openid',
    expectedScopes: ['https://www.googleapis.com/auth/drive.readonly', 'openid'],
    config: { driveIds: [] },
    tenant: undefined,
    create: (deps: Parameters<typeof createGoogleWorkspaceConnector>[0]) =>
      createGoogleWorkspaceConnector(deps),
  },
  {
    provider: 'microsoft' as const,
    tokenRoute: 'ms_login',
    stream: 'drive_items',
    grantedScopes: ['Files.Read.All'],
    reported: 'https://graph.microsoft.com/Files.Read.All openid',
    expectedScopes: ['Files.Read.All', 'openid'],
    config: { driveIds: ['generated_drive'] },
    tenant: TENANT,
    create: (deps: Parameters<typeof createMicrosoft365Connector>[0]) =>
      createMicrosoft365Connector(deps),
  },
];

function platformContext(
  grantedScopes: readonly string[],
  config: unknown,
  tenant: string | undefined,
): ConnectorContext<never> {
  return {
    organizationId: ORGANIZATION,
    connectionId: CONNECTION,
    config: config as never,
    grantedScopes,
    signal: new AbortController().signal,
    credentials: {
      withCredential: async (use) =>
        use(
          Buffer.from(
            JSON.stringify({
              client: 'platform',
              refresh_token: 'generated-refresh',
              ...(tenant ? { tenant } : {}),
            }),
          ),
        ),
    },
    network: {
      openRelay: async () => {
        throw new Error('NO_AMBIENT_NETWORK');
      },
    },
  };
}

/** Answers the token request and fails every read after it, which is all these tests need. */
function fakeProvider(tokenRoute: string, scope: string) {
  const tokenRequests: ProviderRequest[] = [];
  const http: ProviderHttpClient = {
    request: async (request) => {
      if (request.route === tokenRoute) {
        tokenRequests.push(request);
        return json({
          access_token: 'generated-access',
          token_type: 'Bearer',
          expires_in: 3600,
          scope,
        });
      }
      return json({ error: 'generated-provider-canary' }, 500);
    },
  };
  return { http, tokenRequests };
}

const operatorApp: PlatformOAuthClient = {
  client_id: 'generated-operator-client',
  client_secret: 'generated-operator-secret',
};
const clientsOf = (client: PlatformOAuthClient | null): PlatformOAuthClients => ({
  get: () => client,
});

describe.each(cases)('$provider connector OAuth wiring', (suite) => {
  const read = (connector: ReturnType<typeof suite.create>) =>
    connector.sync!.readPage(platformContext(suite.grantedScopes, suite.config, suite.tenant), {
      stream: suite.stream,
      cursor: null,
      fullSync: true,
      pageSize: 100,
    });

  it("refreshes a platform credential with the operator's client", async () => {
    const provider = fakeProvider(suite.tokenRoute, suite.reported);
    const connector = suite.create({
      http: provider.http,
      platformClients: clientsOf(operatorApp),
    });
    // The read after the refresh fails on purpose. The refresh is what is under test.
    await expect(read(connector)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(provider.tokenRequests).toHaveLength(1);
    const form = new URLSearchParams(provider.tokenRequests[0]!.body!.toString());
    expect(form.get('client_id')).toBe(operatorApp.client_id);
    expect(form.get('client_secret')).toBe(operatorApp.client_secret);
    expect(form.get('refresh_token')).toBe('generated-refresh');
  });

  it('refuses a platform credential as CREDENTIAL_INVALID when this worker has no operator app', async () => {
    for (const platformClients of [undefined, clientsOf(null)]) {
      const provider = fakeProvider(suite.tokenRoute, suite.reported);
      const connector = suite.create({
        http: provider.http,
        ...(platformClients ? { platformClients } : {}),
      });
      await expect(read(connector)).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
      expect(provider.tokenRequests).toHaveLength(0);
    }
  });

  it('passes the scopes a refresh reports to the callback, normalized', async () => {
    const provider = fakeProvider(suite.tokenRoute, suite.reported);
    const heard: Parameters<OAuthScopesPort['reported']>[0][] = [];
    const connector = suite.create({
      http: provider.http,
      platformClients: clientsOf(operatorApp),
      scopes: {
        reported: async (input) => {
          heard.push(input);
        },
      },
    });
    await expect(read(connector)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(heard).toEqual([
      {
        organizationId: ORGANIZATION,
        connectionId: CONNECTION,
        reportedScopes: suite.expectedScopes,
      },
    ]);
  });
});
