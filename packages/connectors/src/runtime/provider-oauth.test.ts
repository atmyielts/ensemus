import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createProviderAuth } from './provider-oauth';
import type { ConnectorContext } from '../index';
import type { ProviderHttpClient } from '../knowledge';

const secret = Buffer.from(
  JSON.stringify({
    client_id: 'generated-client',
    client_secret: 'generated-secret',
    refresh_token: 'generated-refresh',
  }),
);
function context(): ConnectorContext {
  return {
    organizationId: '00000000-0000-4000-8000-000000000a01',
    connectionId: '00000000-0000-4000-8000-000000000a02',
    config: {},
    signal: new AbortController().signal,
    credentials: { withCredential: async (use) => use(Buffer.from(secret)) },
    network: {
      openRelay: async () => {
        throw new Error('NO_AMBIENT_NETWORK');
      },
    },
  };
}
const response = (rotation?: string) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(
    JSON.stringify({
      access_token: 'generated-access',
      token_type: 'Bearer',
      expires_in: 3600,
      ...(rotation ? { refresh_token: rotation } : {}),
    }),
  ),
});
describe('explicit OAuth sessions and sealed refresh rotation', () => {
  it('exchanges once inside a session, shares concurrent requests, and disposes explicitly', async () => {
    let calls = 0;
    const http: ProviderHttpClient = {
      request: async (request) => {
        calls++;
        expect(request.route).toBe('google_oauth');
        expect(request.path).toBe('/token');
        return response();
      },
    };
    const auth = createProviderAuth({ http, provider: 'google' }),
      ctx = context();
    expect(
      await Promise.all([
        auth.withToken(ctx, async (token) => token),
        auth.withToken(ctx, async (token) => token),
      ]),
    ).toEqual(['generated-access', 'generated-access']);
    expect(calls).toBe(1);
    auth.dispose(ctx.credentials);
    expect(await auth.withToken(ctx, async (token) => token)).toBe('generated-access');
    expect(calls).toBe(2);
    auth.dispose(ctx.credentials);
  });
  it('persists a rotated refresh credential before use, with an old-hash guard and wiped borrowed bytes', async () => {
    const order: string[] = [];
    let borrowed: Buffer | undefined;
    const auth = createProviderAuth({
      provider: 'google',
      http: { request: async () => response('generated-rotation') },
      rotation: {
        persist: async (input) => {
          order.push('persist');
          expect(input.expectedCredentialSha256).toBe(
            createHash('sha256').update(secret).digest('hex'),
          );
          expect(JSON.parse(input.replacement.toString()).refresh_token).toBe('generated-rotation');
          borrowed = input.replacement;
          return 'stored';
        },
      },
    });
    const ctx = context();
    await auth.withToken(ctx, async () => {
      order.push('use');
    });
    expect(order).toEqual(['persist', 'use']);
    expect(borrowed?.every((byte) => byte === 0)).toBe(true);
    auth.dispose(ctx.credentials);
  });
  it('fails closed on missing rotation persistence or a stale concurrent refresh', async () => {
    for (const stale of [false, true]) {
      let used = false;
      const auth = createProviderAuth({
        provider: 'google',
        http: { request: async () => response('generated-rotation') },
        ...(stale ? { rotation: { persist: async () => 'stale' as const } } : {}),
      });
      const ctx = context();
      await expect(
        auth.withToken(ctx, async () => {
          used = true;
        }),
      ).rejects.toMatchObject({
        code: stale ? 'CREDENTIAL_CHANGED' : 'CREDENTIAL_ROTATION_REQUIRED',
      });
      expect(used).toBe(false);
      auth.dispose(ctx.credentials);
    }
  });
  it('never returns a provider error body or accepts a tenant path injection', async () => {
    const canary = 'generated-provider-canary';
    const auth = createProviderAuth({
      provider: 'google',
      http: {
        request: async () => ({
          status: 400,
          headers: {},
          body: Buffer.from(JSON.stringify({ error: canary })),
        }),
      },
    });
    const ctx = context();
    await expect(auth.withToken(ctx, async () => undefined)).rejects.toMatchObject({
      message: 'CREDENTIAL_REJECTED',
    });
    auth.dispose(ctx.credentials);
    let calls = 0;
    const invalid = {
      ...context(),
      credentials: {
        withCredential: async <T>(use: (secret: Buffer) => Promise<T>) =>
          use(
            Buffer.from(
              JSON.stringify({
                client_id: 'generated',
                client_secret: 'generated',
                refresh_token: 'generated',
                tenant: '../attacker',
              }),
            ),
          ),
      },
    };
    await expect(
      createProviderAuth({
        provider: 'microsoft',
        http: {
          request: async () => {
            calls++;
            return response();
          },
        },
      }).withToken(invalid, async () => undefined),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
    expect(calls).toBe(0);
  });
});
