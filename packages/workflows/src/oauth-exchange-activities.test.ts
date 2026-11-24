// The exchange Activity against a scripted provider, broker and application layer. What reaches a log
// line, an error, the completing call or the Temporal answer is checked for a canary planted in the code,
// the verifier, the client secret and the tokens. The same run against PostgreSQL is
// tests/integration/oauth-exchange.test.ts. Generated values only.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthExchangeClaim } from '@ensemus/application';

const application = vi.hoisted(() => ({
  claimForExchange: vi.fn(),
  completeExchange: vi.fn(),
  failExchange: vi.fn(),
}));
vi.mock('@ensemus/application', () => application);

const { createOAuthExchangeActivities } = await import('./oauth-exchange-activities');

const canary = `canary-${randomBytes(12).toString('hex')}`;
const organizationId = randomUUID();
const authorizationId = randomUUID();
const platform = {
  client_id: `client-${randomUUID()}`,
  client_secret: `${canary}-platform-secret`,
};
const verifier = `${canary}-${randomBytes(32).toString('base64url')}`;

const jwt = (claims: object) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.generated-signature`;

function claim(overrides: Partial<OAuthExchangeClaim> = {}): OAuthExchangeClaim {
  return {
    authorizationId,
    connectorType: 'google_workspace',
    displayName: 'Generated',
    config: { driveIds: [] },
    clientKind: 'platform',
    clientId: platform.client_id,
    customerClientSecretId: null,
    verifierSecretId: randomUUID(),
    codeSecretId: randomUUID(),
    requestedScopes: [
      'email',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
      'openid',
    ],
    ownerMembershipId: null,
    startedByMembershipId: randomUUID(),
    ...overrides,
  };
}

function harness(
  options: {
    status?: number;
    body?: unknown;
    platform?: typeof platform | null;
    revoke?: () => Promise<never>;
  } = {},
) {
  const requests: string[] = [];
  const paths: string[] = [];
  const sealed: string[] = [];
  const opened: string[] = [];
  const activities = createOAuthExchangeActivities({
    database: {} as never,
    redirectUri: 'https://ensemus.example.invalid/api/v1/oauth/callback',
    platformClients: {
      get: () => (options.platform === undefined ? platform : options.platform),
    },
    secrets: {
      withSecret: async (binding, use) => {
        opened.push(binding.purpose);
        const value =
          binding.purpose === 'oauth_pkce_verifier'
            ? verifier.slice(0, 128)
            : binding.purpose === 'oauth_authorization_code'
              ? `${canary}-code`
              : JSON.stringify({
                  client_id: 'customer-client',
                  client_secret: `${canary}-customer-secret`,
                });
        return use(Buffer.from(value));
      },
      revoke: async () => undefined,
    },
    seal: (input) => {
      sealed.push(input.plaintext);
      return {
        keyId: 'generated-key',
        wrappedKey: randomBytes(8),
        iv: randomBytes(12),
        ciphertext: randomBytes(16),
        authTag: randomBytes(16),
      };
    },
    http: {
      request: async (request) => {
        requests.push(request.route);
        paths.push(request.path);
        if (request.path === '/revoke' && options.revoke) return options.revoke();
        return {
          status: options.status ?? 200,
          headers: {},
          body: Buffer.from(
            JSON.stringify(
              options.body ?? {
                access_token: `${canary}-access`,
                token_type: 'Bearer',
                expires_in: 3599,
                refresh_token: `${canary}-refresh`,
                scope:
                  'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.metadata.readonly',
                id_token: jwt({
                  iss: 'https://accounts.google.com',
                  aud: platform.client_id,
                  email: 'admin@example.invalid',
                  email_verified: true,
                }),
              },
            ),
          ),
        };
      },
    },
  });
  return { activities, requests, paths, sealed, opened };
}

let output: string[] = [];
beforeEach(() => {
  output = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  });
  application.claimForExchange.mockReset();
  application.completeExchange.mockReset();
  application.failExchange.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Everything that leaves the Activity, as text. */
const leaving = (...values: unknown[]) =>
  JSON.stringify([
    output,
    application.completeExchange.mock.calls.map(([, , input]) => ({
      ...input,
      sealedCredential: 'sealed',
    })),
    application.failExchange.mock.calls.map(([, , input]) => input),
    ...values.map((value) => (value instanceof Error ? [value.message, value.stack] : value)),
  ]);

describe('exchangeOAuthAuthorization', () => {
  it('connects once, hands only the sealed credential and canonical scopes on, and answers IDs', async () => {
    const connectionId = randomUUID();
    application.claimForExchange.mockResolvedValue(claim());
    application.completeExchange.mockResolvedValue({ connectionId });
    const { activities, requests, sealed } = harness();
    const outcome = await activities.exchangeOAuthAuthorization({
      organizationId,
      authorizationId,
    });
    expect(outcome).toEqual({ outcome: 'connected', connectionId });
    expect(requests).toEqual(['google_oauth']);
    expect(JSON.parse(sealed[0]!)).toEqual({
      client: 'platform',
      refresh_token: `${canary}-refresh`,
    });
    const [, , input] = application.completeExchange.mock.calls[0]!;
    expect(input).toMatchObject({
      authorizationId,
      credentialPurpose: 'connector_credential',
      connectedAccount: 'admin@example.invalid',
      reportedScopes: [
        'email',
        'https://www.googleapis.com/auth/drive.metadata.readonly',
        'https://www.googleapis.com/auth/drive.readonly',
        'openid',
      ],
    });
    expect(application.failExchange).not.toHaveBeenCalled();
    expect(leaving(outcome)).not.toContain(canary);
  });

  it('fails a used code once with a fixed code, never retries it, and leaks nothing', async () => {
    application.claimForExchange.mockResolvedValue(claim());
    const { activities, requests } = harness({
      status: 400,
      body: { error: 'invalid_grant', error_description: `${canary} code already redeemed` },
    });
    const outcome = await activities.exchangeOAuthAuthorization({
      organizationId,
      authorizationId,
    });
    expect(outcome).toEqual({ outcome: 'failed', connectionId: null });
    expect(requests).toHaveLength(1);
    expect(application.completeExchange).not.toHaveBeenCalled();
    expect(application.failExchange).toHaveBeenCalledTimes(1);
    expect(application.failExchange.mock.calls[0]![2]).toEqual({
      authorizationId,
      errorCode: 'OAUTH_EXCHANGE_FAILED',
    });
    expect(leaving(outcome)).not.toContain(canary);
  });

  it('refuses an operator app this worker does not hold before any request', async () => {
    for (const configured of [null, { ...platform, client_id: 'another-client' }]) {
      application.claimForExchange.mockResolvedValue(claim());
      application.failExchange.mockReset();
      const { activities, requests } = harness({ platform: configured });
      await activities.exchangeOAuthAuthorization({ organizationId, authorizationId });
      expect(requests).toHaveLength(0);
      expect(application.failExchange.mock.calls[0]![2].errorCode).toBe(
        'OAUTH_CLIENT_NOT_CONFIGURED',
      );
    }
  });

  it('refuses a customer client that is not the one the admin entered', async () => {
    application.claimForExchange.mockResolvedValue(
      claim({ clientKind: 'customer', clientId: 'other', customerClientSecretId: randomUUID() }),
    );
    const { activities, requests } = harness();
    await activities.exchangeOAuthAuthorization({ organizationId, authorizationId });
    expect(requests).toHaveLength(0);
    expect(application.failExchange.mock.calls[0]![2].errorCode).toBe(
      'OAUTH_CLIENT_NOT_CONFIGURED',
    );
    expect(leaving()).not.toContain(canary);
  });

  it('passes insufficient scopes through as their own code', async () => {
    application.claimForExchange.mockResolvedValue(claim());
    application.completeExchange.mockRejectedValue(
      Object.assign(new Error('OAUTH_SCOPES_INSUFFICIENT'), { code: 'OAUTH_SCOPES_INSUFFICIENT' }),
    );
    const { activities, paths } = harness();
    expect(
      await activities.exchangeOAuthAuthorization({ organizationId, authorizationId }),
    ).toEqual({ outcome: 'failed', connectionId: null });
    expect(application.failExchange.mock.calls[0]![2].errorCode).toBe('OAUTH_SCOPES_INSUFFICIENT');
    // The grant the provider made is taken back once, since nothing here will keep it.
    expect(paths).toEqual(['/token', '/revoke']);
  });

  it('takes the grant back once when completing fails, and still fails if the revoke does', async () => {
    application.claimForExchange.mockResolvedValue(claim());
    application.completeExchange.mockRejectedValue(new Error(`insert ... ${canary}`));
    const { activities, paths } = harness({
      revoke: async () => {
        throw new Error('GATEWAY_DOWN');
      },
    });
    expect(
      await activities.exchangeOAuthAuthorization({ organizationId, authorizationId }),
    ).toEqual({ outcome: 'failed', connectionId: null });
    expect(paths).toEqual(['/token', '/revoke']);
    expect(application.failExchange).toHaveBeenCalledTimes(1);
    expect(leaving()).not.toContain(canary);
  });

  it('revokes nothing once the connection has committed', async () => {
    application.claimForExchange.mockResolvedValue(claim());
    application.completeExchange.mockResolvedValue({ connectionId: randomUUID() });
    const { activities, paths } = harness();
    await activities.exchangeOAuthAuthorization({ organizationId, authorizationId });
    expect(paths).toEqual(['/token']);
  });

  it('does nothing for an attempt another run or the clock settled', async () => {
    const { activities, requests } = harness();
    application.claimForExchange.mockResolvedValueOnce(null);
    expect(
      await activities.exchangeOAuthAuthorization({ organizationId, authorizationId }),
    ).toEqual({ outcome: 'already_settled', connectionId: null });
    application.claimForExchange.mockResolvedValueOnce('expired');
    expect(
      await activities.exchangeOAuthAuthorization({ organizationId, authorizationId }),
    ).toEqual({ outcome: 'expired', connectionId: null });
    expect(requests).toHaveLength(0);
  });

  it('throws only a code when the store is away, and the workflow then abandons', async () => {
    application.claimForExchange.mockRejectedValue(new Error(`select ... ${canary}`));
    const { activities } = harness();
    const error = await activities
      .exchangeOAuthAuthorization({ organizationId, authorizationId })
      .catch((e: Error) => e);
    expect(error).toMatchObject({ message: 'OAUTH_EXCHANGE_STORE_UNAVAILABLE' });
    expect(leaving(error)).not.toContain(canary);
  });

  it('refuses anything but two IDs', async () => {
    const { activities } = harness();
    await expect(
      activities.exchangeOAuthAuthorization({
        organizationId,
        authorizationId,
        code: 'x',
      } as never),
    ).rejects.toThrow();
  });
});
