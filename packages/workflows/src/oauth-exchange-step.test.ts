// The order oauthExchangeWorkflow takes, and the rules its Activity follows, against scripted answers. The
// integration tests run the same code against PostgreSQL. Generated values only.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  credentialFor,
  ExchangeStopped,
  narrowedScopes,
  stopCodeOf,
  tokenAuthority,
} from './oauth-exchange-decisions';
import { runOAuthExchange } from './oauth-exchange-step';
import type { OAuthExchangeOutcome } from './schemas';

describe('runOAuthExchange', () => {
  it('passes the exchange’s own answer through and abandons nothing', async () => {
    const calls: string[] = [];
    const answer: OAuthExchangeOutcome = { outcome: 'connected', connectionId: randomUUID() };
    expect(
      await runOAuthExchange({
        exchange: async () => {
          calls.push('exchange');
          return answer;
        },
        abandon: async () => {
          calls.push('abandon');
        },
      }),
    ).toBe(answer);
    expect(calls).toEqual(['exchange']);
  });

  it('never tries a code twice: a lost answer abandons the attempt once', async () => {
    const calls: string[] = [];
    expect(
      await runOAuthExchange({
        exchange: async () => {
          calls.push('exchange');
          throw new Error('OAUTH_EXCHANGE_STORE_UNAVAILABLE');
        },
        abandon: async () => {
          calls.push('abandon');
        },
      }),
    ).toEqual({ outcome: 'failed', connectionId: null });
    expect(calls).toEqual(['exchange', 'abandon']);
  });

  it('lets an abandon that never lands fail the run, rather than claim the attempt ended', async () => {
    await expect(
      runOAuthExchange({
        exchange: async () => {
          throw new Error('lost');
        },
        abandon: async () => {
          throw new Error('OAUTH_EXCHANGE_STORE_UNAVAILABLE');
        },
      }),
    ).rejects.toThrow('OAUTH_EXCHANGE_STORE_UNAVAILABLE');
  });
});

describe('exchange decisions', () => {
  const tid = randomUUID();

  it('sends Microsoft’s request to organizations for the operator app and to the customer’s directory', () => {
    expect(tokenAuthority('google_workspace', 'platform', undefined)).toBeNull();
    expect(tokenAuthority('microsoft_365', 'platform', tid)).toBe('organizations');
    expect(tokenAuthority('microsoft_365', 'customer', tid)).toBe(tid);
    expect(tokenAuthority('microsoft_365', 'customer', undefined)).toBe('organizations');
  });

  it('stores the operator app by name only, and a customer app whole', () => {
    const exchanged = { refreshToken: 'generated-refresh', tenant: tid };
    expect(credentialFor('microsoft_365', { kind: 'platform' }, exchanged)).toEqual({
      client: 'platform',
      refresh_token: 'generated-refresh',
      tenant: tid,
    });
    expect(
      credentialFor(
        'google_workspace',
        { kind: 'customer', clientId: 'generated-id', clientSecret: 'generated-secret' },
        { refreshToken: 'generated-refresh', tenant: null },
      ),
    ).toEqual({
      client_id: 'generated-id',
      client_secret: 'generated-secret',
      refresh_token: 'generated-refresh',
    });
  });

  it('refuses a Microsoft credential with no directory, and one that would not parse at refresh', () => {
    expect(() =>
      credentialFor('microsoft_365', { kind: 'platform' }, { refreshToken: 'x', tenant: null }),
    ).toThrow(ExchangeStopped);
    expect(() =>
      credentialFor(
        'google_workspace',
        { kind: 'platform' },
        { refreshToken: 'x'.repeat(4097), tenant: null },
      ),
    ).toThrow('OAUTH_EXCHANGE_FAILED');
  });

  it('keeps a refusal’s own code, and makes everything else a plain failed exchange', () => {
    expect(stopCodeOf(new ExchangeStopped('OAUTH_CLIENT_NOT_CONFIGURED'))).toBe(
      'OAUTH_CLIENT_NOT_CONFIGURED',
    );
    expect(stopCodeOf(Object.assign(new Error('x'), { code: 'OAUTH_SCOPES_INSUFFICIENT' }))).toBe(
      'OAUTH_SCOPES_INSUFFICIENT',
    );
    expect(stopCodeOf(Object.assign(new Error('x'), { code: 'SOMETHING_ELSE' }))).toBe(
      'OAUTH_EXCHANGE_FAILED',
    );
    expect(stopCodeOf('generated')).toBe('OAUTH_EXCHANGE_FAILED');
  });

  it('only ever narrows on a refresh, and keeps the identity scopes Microsoft does not repeat', () => {
    const granted = ['Files.Read.All', 'Sites.Read.All', 'offline_access', 'openid'];
    expect(narrowedScopes('microsoft_365', granted, ['Files.Read.All', 'Mail.Send'])).toEqual([
      'Files.Read.All',
      'offline_access',
      'openid',
    ]);
    expect(narrowedScopes('microsoft_365', granted, granted)).toEqual(granted);
  });
});
