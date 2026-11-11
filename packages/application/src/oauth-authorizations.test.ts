// CONNECT-07, the web half's pure pieces and every refusal made before the database is touched. The
// database's own half is in tests/integration/oauth-authorizations.test.ts. Generated values only.
import { randomBytes } from 'node:crypto';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import {
  formatOAuthState,
  oauthStateSha256,
  pkceChallenge,
  PKCE_VERIFIER_PATTERN,
} from '@ensemus/domain/workspace-suites';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizeUrlFor,
  newPkceVerifier,
  receiveCallback,
  startAuthorization,
  stateMatchesHash,
  suiteConfigOf,
  type OAuthWebSide,
  type StartAuthorizationInput,
} from './oauth-authorizations';

const ORG = '6f1c2c6e-1111-4111-8111-111111111111';
const OTHER_ORG = '6f1c2c6e-3333-4333-8333-333333333333';
const ID = '6f1c2c6e-2222-4222-8222-222222222222';
const REDIRECT = 'https://ensemus.example.invalid/api/v1/oauth/callback';
const GOOGLE_CLIENT = 'generated-client.apps.googleusercontent.com';
const MICROSOFT_CLIENT = '6f1c2c6e-4444-4444-8444-444444444444';
const TENANT = '6f1c2c6e-5555-4555-8555-555555555555';

const paramsOf = (url: string) => Object.fromEntries(new URL(url).searchParams);
const code = (name: string) => expect.objectContaining({ code: name });

describe('the PKCE verifier', () => {
  it('is 43 characters RFC 7636 accepts, and new each time', () => {
    const verifiers = new Set(Array.from({ length: 50 }, newPkceVerifier));
    expect(verifiers.size).toBe(50);
    for (const verifier of verifiers) {
      expect(verifier).toHaveLength(43);
      expect(verifier).toMatch(PKCE_VERIFIER_PATTERN);
    }
  });
});

describe('the state check', () => {
  const state = formatOAuthState(ORG, ID, randomBytes(32));

  it('accepts the state whose hash the row keeps', () => {
    expect(stateMatchesHash(state, oauthStateSha256(state))).toBe(true);
  });

  it('refuses another state, a changed one and a stored value that is not a hash', () => {
    const other = formatOAuthState(ORG, ID, randomBytes(32));
    expect(stateMatchesHash(other, oauthStateSha256(state))).toBe(false);
    const changed = `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`;
    expect(stateMatchesHash(changed, oauthStateSha256(state))).toBe(false);
    expect(stateMatchesHash(state, oauthStateSha256(state).toUpperCase())).toBe(false);
    expect(stateMatchesHash(state, '')).toBe(false);
    expect(stateMatchesHash(state, oauthStateSha256(state).slice(2))).toBe(false);
  });
});

describe('the provider page', () => {
  const verifier = newPkceVerifier();
  const base = {
    redirectUri: REDIRECT,
    state: formatOAuthState(ORG, ID, randomBytes(32)),
    codeChallenge: pkceChallenge(verifier),
  };

  it('asks Google for offline access with consent, PKCE S256 and exactly these scopes', () => {
    const scopes = ['email', 'https://www.googleapis.com/auth/drive.readonly', 'openid'];
    const url = authorizeUrlFor({
      ...base,
      connectorType: 'google_workspace',
      clientId: GOOGLE_CLIENT,
      scopes,
    });
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    // Spaces are %20, never +, which a provider might not read as a space.
    expect(url).toContain('scope=email%20https%3A%2F%2Fwww.googleapis.com');
    expect(paramsOf(url)).toEqual({
      client_id: GOOGLE_CLIENT,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: scopes.join(' '),
      state: base.state,
      code_challenge: base.codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });
  });

  it('asks Microsoft through the organizations authority for the operator’s app', () => {
    const scopes = ['Files.Read.All', 'offline_access', 'openid'];
    const url = authorizeUrlFor({
      ...base,
      connectorType: 'microsoft_365',
      clientId: MICROSOFT_CLIENT,
      scopes,
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://login.microsoftonline.com');
    expect(parsed.pathname).toBe('/organizations/oauth2/v2.0/authorize');
    expect(paramsOf(url)).toEqual({
      client_id: MICROSOFT_CLIENT,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: scopes.join(' '),
      state: base.state,
      code_challenge: base.codeChallenge,
      code_challenge_method: 'S256',
      response_mode: 'query',
    });
  });

  it('asks Microsoft through the customer’s own directory for their own app', () => {
    const url = authorizeUrlFor({
      ...base,
      connectorType: 'microsoft_365',
      clientId: MICROSOFT_CLIENT,
      scopes: ['openid'],
      microsoftTenant: TENANT,
    });
    expect(new URL(url).pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
  });

  it('refuses a directory that could leave the path, and any directory for Google', () => {
    for (const microsoftTenant of ['../common', 'a/b', 'organizations?x=1', '']) {
      expect(() =>
        authorizeUrlFor({
          ...base,
          connectorType: 'microsoft_365',
          clientId: MICROSOFT_CLIENT,
          scopes: ['openid'],
          microsoftTenant,
        }),
      ).toThrow(code('INVALID_INPUT'));
    }
    expect(() =>
      authorizeUrlFor({
        ...base,
        connectorType: 'google_workspace',
        clientId: GOOGLE_CLIENT,
        scopes: ['openid'],
        microsoftTenant: TENANT,
      }),
    ).toThrow(code('INVALID_INPUT'));
  });
});

describe('the settings a suite connection takes', () => {
  it('reads nothing as every drive, and keeps each drive once', () => {
    expect(suiteConfigOf({})).toEqual({ drive_ids: [] });
    expect(suiteConfigOf({ drive_ids: ['b!abc', 'b!abc', '0A1'] })).toEqual({
      drive_ids: ['b!abc', '0A1'],
    });
  });

  it('refuses a host, an unknown key, a path escape and anything not an object', () => {
    expect(suiteConfigOf({ host: 'example.invalid' })).toBeNull();
    expect(suiteConfigOf({ drive_ids: [], extra: true })).toBeNull();
    expect(suiteConfigOf({ drive_ids: ['..'] })).toBeNull();
    expect(suiteConfigOf({ drive_ids: ['a/b'] })).toBeNull();
    expect(suiteConfigOf(null)).toBeNull();
    expect(suiteConfigOf([])).toBeNull();
  });
});

// A database that fails the test if anything reaches it, so each refusal below is proved to come first.
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('the database was reached');
    },
  },
) as AppDatabase;

const contextFor = (role: string, actorType: TenantContext['actorType'] = 'user') =>
  ({
    organizationId: ORG,
    userId: ID,
    membershipId: ID,
    role,
    actorType,
  }) as unknown as TenantContext;

function webSide(platform: string | null = GOOGLE_CLIENT) {
  const seal = vi.fn<OAuthWebSide['seal']>();
  const web: OAuthWebSide = { seal, redirectUri: REDIRECT, platformClientId: () => platform };
  return { web, seal };
}

const googleStart = (
  overrides: Partial<StartAuthorizationInput> = {},
): StartAuthorizationInput => ({
  connectorType: 'google_workspace',
  displayName: 'Generated workspace',
  config: {},
  capabilities: ['files'],
  client: { kind: 'platform' },
  ...overrides,
});

describe('starting a consent, refused before anything is sealed or written', () => {
  it('refuses a member, an agent and a worker', async () => {
    for (const context of [
      contextFor('member'),
      contextFor('admin', 'agent'),
      contextFor('admin', 'service'),
    ]) {
      const { web, seal } = webSide();
      await expect(startAuthorization(untouchable, context, googleStart(), web)).rejects.toEqual(
        code('FORBIDDEN'),
      );
      expect(seal).not.toHaveBeenCalled();
    }
  });

  it('refuses a capability nothing here uses yet, or none at all', async () => {
    for (const capabilities of [['mail'], ['calendar'], [], ['files', 'files']] as const) {
      const { web, seal } = webSide();
      await expect(
        startAuthorization(untouchable, contextFor('admin'), googleStart({ capabilities }), web),
      ).rejects.toEqual(code('OAUTH_CAPABILITY_UNAVAILABLE'));
      expect(seal).not.toHaveBeenCalled();
    }
  });

  it('says so when the operator’s app is not configured', async () => {
    const { web, seal } = webSide(null);
    await expect(
      startAuthorization(untouchable, contextFor('owner'), googleStart(), web),
    ).rejects.toEqual(code('OAUTH_CLIENT_NOT_CONFIGURED'));
    expect(seal).not.toHaveBeenCalled();
  });

  it('refuses a directory for Google, and a customer Microsoft app without one', async () => {
    const customer = {
      kind: 'customer',
      clientId: 'generated',
      clientSecret: 'generated',
    } as const;
    for (const input of [
      googleStart({ client: { ...customer, tenant: TENANT } }),
      googleStart({ connectorType: 'microsoft_365', client: customer }),
      googleStart({ connectorType: 'microsoft_365', client: { ...customer, tenant: '../x' } }),
      googleStart({ client: { ...customer, clientSecret: '' } }),
    ]) {
      const { web, seal } = webSide();
      await expect(
        startAuthorization(untouchable, contextFor('admin'), input, web),
      ).rejects.toEqual(code('INVALID_INPUT'));
      expect(seal).not.toHaveBeenCalled();
    }
  });

  it('refuses a name, a type or settings it cannot keep', async () => {
    for (const input of [
      googleStart({ displayName: ' ' }),
      googleStart({ displayName: 'a\nb' }),
      googleStart({ connectorType: 'email_smtp' as never }),
      googleStart({ config: { endpoint: 'https://example.invalid' } }),
    ]) {
      const { web } = webSide();
      await expect(
        startAuthorization(untouchable, contextFor('admin'), input, web),
      ).rejects.toEqual(code('INVALID_INPUT'));
    }
  });
});

describe('the callback, refused before the database is touched', () => {
  it('gives the one answer for a malformed state, another tenant’s, and a worker’s context', async () => {
    const { web, seal } = webSide();
    const foreign = formatOAuthState(OTHER_ORG, ID, randomBytes(32));
    const own = formatOAuthState(ORG, ID, randomBytes(32));
    for (const [state, context] of [
      ['not-a-state', contextFor('admin')],
      [`${own}x`, contextFor('admin')],
      [foreign, contextFor('admin')],
      [own, contextFor('admin', 'service')],
    ] as const) {
      await expect(
        receiveCallback(untouchable, context, { state, code: 'generated-code' }, web),
      ).rejects.toEqual(code('OAUTH_STATE_INVALID'));
    }
    expect(seal).not.toHaveBeenCalled();
  });
});
