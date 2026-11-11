// The code exchange and the operator's app (ADR-038 D1, D2), against a scripted token endpoint. Generated
// values only: no real Google or Microsoft client, code or token has been used.
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ConnectorContext } from '../index';
import type { ProviderHttpClient, ProviderRequest } from '../knowledge';
import {
  createProviderAuth,
  exchangeAuthorizationCode,
  matchReportedScopes,
  parseReportedScopes,
  type CodeExchangeRequest,
} from './provider-oauth';

const canary = `canary-${randomBytes(12).toString('hex')}`;
const client = { client_id: `client-${randomUUID()}`, client_secret: `${canary}-secret` };
const tid = randomUUID();
const verifier = randomBytes(48).toString('base64url');

const jwt = (claims: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'generated-signature',
  ].join('.');

const googleClaims = {
  iss: 'https://accounts.google.com',
  aud: client.client_id,
  email: 'admin@example.invalid',
  email_verified: true,
};
const microsoftClaims = {
  iss: `https://login.microsoftonline.com/${tid}/v2.0`,
  aud: client.client_id,
  tid,
  preferred_username: 'admin@example.invalid',
};

function endpoint(status: number, body: unknown) {
  const seen: ProviderRequest[] = [];
  const http: ProviderHttpClient = {
    request: async (request) => {
      seen.push(request);
      return { status, headers: {}, body: Buffer.from(JSON.stringify(body)) };
    },
  };
  return { http, seen };
}

const tokens = (extra: Record<string, unknown>) => ({
  access_token: `${canary}-access`,
  token_type: 'Bearer',
  expires_in: 3599,
  refresh_token: `${canary}-refresh`,
  ...extra,
});

const request = (
  provider: 'google' | 'microsoft',
  overrides: Partial<CodeExchangeRequest> = {},
): CodeExchangeRequest => ({
  provider,
  client,
  authority: provider === 'microsoft' ? 'organizations' : null,
  code: `${canary}-code`,
  verifier,
  redirectUri: 'https://ensemus.example.invalid/api/v1/oauth/callback',
  scopes: ['openid', 'email', 'offline_access', 'Files.Read.All', 'Sites.Read.All'],
  signal: new AbortController().signal,
  ...overrides,
});

describe('authorization code exchange', () => {
  it('redeems a Google code once, with the verifier, and reads the granted scopes and the email', async () => {
    const { http, seen } = endpoint(
      200,
      tokens({
        scope:
          'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.readonly',
        id_token: jwt(googleClaims),
      }),
    );
    const result = await exchangeAuthorizationCode(http, request('google'));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ route: 'google_oauth', method: 'POST', path: '/token' });
    // The request body holds the code, the verifier and the client secret, so it is wiped once sent.
    expect(seen[0]!.body!.every((byte) => byte === 0)).toBe(true);
    expect(result).toEqual({
      refreshToken: `${canary}-refresh`,
      reportedScopes: ['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly'],
      account: 'admin@example.invalid',
      tenant: null,
    });
  });

  it('sends what the provider needs and nothing it does not', async () => {
    let form: URLSearchParams | undefined;
    const http: ProviderHttpClient = {
      request: async (sent) => {
        form = new URLSearchParams(Buffer.from(sent.body!).toString());
        return {
          status: 200,
          headers: {},
          body: Buffer.from(
            JSON.stringify(
              tokens({
                scope: 'https%3A%2F%2Fgraph.microsoft.com%2Ffiles.read.all openid',
                id_token: jwt(microsoftClaims),
              }),
            ),
          ),
        };
      },
    };
    const result = await exchangeAuthorizationCode(http, request('microsoft'));
    expect(Object.fromEntries(form!)).toEqual({
      client_id: client.client_id,
      client_secret: client.client_secret,
      code: `${canary}-code`,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: 'https://ensemus.example.invalid/api/v1/oauth/callback',
      scope: 'openid email offline_access Files.Read.All Sites.Read.All',
    });
    expect(result.tenant).toBe(tid);
    expect(result.reportedScopes).toEqual(['files.read.all', 'openid']);
    // Graph's names compare without case, and come back in the spelling that was asked for.
    expect(
      matchReportedScopes('microsoft', result.reportedScopes, ['Files.Read.All', 'Sites.Read.All']),
    ).toEqual(['Files.Read.All']);
  });

  it('goes to the organizations authority for the operator app and to the directory for a customer app', async () => {
    for (const authority of ['organizations', tid]) {
      const { http, seen } = endpoint(
        200,
        tokens({ scope: 'Files.Read.All', id_token: jwt(microsoftClaims) }),
      );
      await exchangeAuthorizationCode(http, request('microsoft', { authority }));
      expect(seen[0]).toMatchObject({
        route: 'ms_login',
        path: `/${authority}/oauth2/v2.0/token`,
      });
    }
    const { http, seen } = endpoint(200, {});
    await expect(
      exchangeAuthorizationCode(http, request('microsoft', { authority: '../evil' })),
    ).rejects.toMatchObject({ code: 'OAUTH_CLIENT_NOT_CONFIGURED' });
    expect(seen).toHaveLength(0);
  });

  it.each([
    [400, { error: 'invalid_grant', error_description: canary }, 'OAUTH_EXCHANGE_FAILED'],
    [400, { error: 'invalid_client', error_description: canary }, 'OAUTH_CLIENT_REJECTED'],
    [400, { error: 'invalid_scope' }, 'OAUTH_SCOPE_REFUSED'],
    [401, { error: canary }, 'OAUTH_CLIENT_REJECTED'],
    [500, { error: canary }, 'OAUTH_EXCHANGE_FAILED'],
    [302, {}, 'OAUTH_EXCHANGE_FAILED'],
  ])('maps a %i refusal to a fixed code with none of its text', async (status, body, code) => {
    const { http } = endpoint(status, body);
    const error = await exchangeAuthorizationCode(http, request('google')).catch((e: Error) => e);
    expect(error).toMatchObject({ code, message: code });
    expect(JSON.stringify(error) + String(error) + (error as Error).stack).not.toContain(canary);
  });

  it.each([
    ['no refresh token', { refresh_token: undefined }, 'OAUTH_EXCHANGE_FAILED'],
    ['no scope', { scope: undefined }, 'OAUTH_EXCHANGE_FAILED'],
    ['a broken scope', { scope: 'a\u0000b' }, 'OAUTH_EXCHANGE_FAILED'],
    ['not a bearer token', { token_type: 'mac' }, 'OAUTH_EXCHANGE_FAILED'],
    ['no ID token', { id_token: undefined }, 'OAUTH_IDENTITY_INVALID'],
    [
      'another app’s ID token',
      { id_token: jwt({ ...googleClaims, aud: 'x' }) },
      'OAUTH_IDENTITY_INVALID',
    ],
    [
      'an unverified email',
      { id_token: jwt({ ...googleClaims, email_verified: false }) },
      'OAUTH_IDENTITY_INVALID',
    ],
    [
      'another issuer',
      { id_token: jwt({ ...googleClaims, iss: 'https://evil.invalid' }) },
      'OAUTH_IDENTITY_INVALID',
    ],
    ['an ID token that is not one', { id_token: 'a.b' }, 'OAUTH_IDENTITY_INVALID'],
  ])('refuses %s', async (_name, change, code) => {
    const { http } = endpoint(
      200,
      tokens({ scope: 'openid', id_token: jwt(googleClaims), ...change }),
    );
    await expect(exchangeAuthorizationCode(http, request('google'))).rejects.toMatchObject({
      code,
    });
  });

  it('refuses a Microsoft ID token without a directory, or from another directory than the customer named', async () => {
    for (const [claims, authority] of [
      [{ ...microsoftClaims, tid: undefined }, 'organizations'],
      [microsoftClaims, randomUUID()],
      [
        { ...microsoftClaims, iss: 'https://login.microsoftonline.com/common/v2.0' },
        'organizations',
      ],
    ] as const) {
      const { http } = endpoint(200, tokens({ scope: 'openid', id_token: jwt(claims) }));
      await expect(
        exchangeAuthorizationCode(http, request('microsoft', { authority })),
      ).rejects.toMatchObject({ code: 'OAUTH_IDENTITY_INVALID' });
    }
  });

  it('refuses a malformed code or verifier before any request', async () => {
    const { http, seen } = endpoint(200, {});
    for (const change of [{ code: '' }, { code: 'a b' }, { verifier: 'short' }]) {
      await expect(
        exchangeAuthorizationCode(http, request('google', change)),
      ).rejects.toMatchObject({ code: 'OAUTH_EXCHANGE_FAILED' });
    }
    expect(seen).toHaveLength(0);
  });
});

describe('refreshing with the operator app and reporting scopes', () => {
  const context = (secret: object): ConnectorContext => ({
    organizationId: randomUUID(),
    connectionId: randomUUID(),
    config: {},
    signal: new AbortController().signal,
    credentials: {
      withCredential: async (use) => use(Buffer.from(JSON.stringify(secret))),
    },
    network: {
      openRelay: async () => {
        throw new Error('NO_AMBIENT_NETWORK');
      },
    },
  });
  const platform = { client: 'platform', refresh_token: `${canary}-refresh`, tenant: tid };

  it('takes the operator secret from the port, never from the credential', async () => {
    let form: URLSearchParams | undefined;
    const auth = createProviderAuth({
      provider: 'microsoft',
      platformClients: { get: (provider) => (provider === 'microsoft' ? client : null) },
      http: {
        request: async (sent) => {
          form = new URLSearchParams(sent.body!.toString());
          expect(sent.path).toBe(`/${tid}/oauth2/v2.0/token`);
          return {
            status: 200,
            headers: {},
            body: Buffer.from(JSON.stringify({ ...tokens({}), refresh_token: undefined })),
          };
        },
      },
    });
    const ctx = context(platform);
    expect(await auth.withToken(ctx, async (token) => token)).toBe(`${canary}-access`);
    expect(form?.get('client_secret')).toBe(client.client_secret);
    auth.dispose(ctx.credentials);
  });

  it('refuses an operator credential when this worker has no operator app', async () => {
    let calls = 0;
    const auth = createProviderAuth({
      provider: 'google',
      platformClients: { get: () => null },
      http: {
        request: async () => {
          calls++;
          return { status: 200, headers: {}, body: Buffer.from('{}') };
        },
      },
    });
    const ctx = context({ client: 'platform', refresh_token: 'generated' });
    await expect(auth.withToken(ctx, async () => undefined)).rejects.toMatchObject({
      code: 'CREDENTIAL_INVALID',
    });
    expect(calls).toBe(0);
  });

  it('reports scopes before the token is used, and stops if they cannot be recorded', async () => {
    for (const recorded of [true, false]) {
      const order: string[] = [];
      const auth = createProviderAuth({
        provider: 'google',
        platformClients: { get: () => client },
        scopes: {
          reported: async (input) => {
            order.push(`scopes:${input.reportedScopes.join(',')}`);
            if (!recorded) throw new Error(canary);
          },
        },
        http: {
          request: async () => ({
            status: 200,
            headers: {},
            body: Buffer.from(
              JSON.stringify({
                ...tokens({ scope: 'https://www.googleapis.com/auth/drive.readonly' }),
                refresh_token: undefined,
              }),
            ),
          }),
        },
      });
      const ctx = context({ client: 'platform', refresh_token: 'generated' });
      const run = auth.withToken(ctx, async () => {
        order.push('use');
      });
      if (recorded) {
        await run;
        expect(order).toEqual(['scopes:https://www.googleapis.com/auth/drive.readonly', 'use']);
      } else {
        const error = await run.catch((e: Error) => e);
        expect(error).toMatchObject({ code: 'CREDENTIAL_SCOPES_UNRECORDED' });
        expect(String(error)).not.toContain(canary);
        expect(order).toEqual(['scopes:https://www.googleapis.com/auth/drive.readonly']);
      }
      auth.dispose(ctx.credentials);
    }
  });

  it('reads no scopes from a response that does not report them', () => {
    expect(parseReportedScopes('microsoft', undefined)).toBeNull();
    expect(
      parseReportedScopes('microsoft', 'https://graph.microsoft.com/Sites.Read.All offline_access'),
    ).toEqual(['Sites.Read.All', 'offline_access']);
  });
});
