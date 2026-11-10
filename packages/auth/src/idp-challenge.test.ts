import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { generateRandomString } from 'better-auth/crypto';
import {
  createIdpChallenges,
  nativeFactorChallengeIdentifier,
  type IdpBridgePayload,
} from './idp-challenge';
import { mfaPlugins } from './mfa';

function fixture() {
  const userId = randomUUID(),
    sessionId = randomUUID(),
    payload: IdpBridgePayload = {
      version: 1,
      kind: 'oidc',
      userId,
      sourceSessionId: randomUUID(),
      providerId: 'generated-operator',
      issuer: 'https://generated.example.invalid',
      accountId: randomUUID(),
      subjectSha256: 'a'.repeat(64),
      sourceSha256: 'b'.repeat(64),
      payloadSha256: 'c'.repeat(64),
      authenticatedAt: Date.now() - 1000,
    };
  const findFirst = vi.fn(async (): Promise<{ id: string; value: string } | undefined> => ({
      id: randomUUID(),
      value: JSON.stringify(payload),
    })),
    finish = vi.fn(async () => true),
    prepare = vi.fn(async () => null);
  // Only the bridge's read port is doubled here. Native crypto/challenge behavior is covered by
  // real-role SAML/OIDC integration tests, never by these isolated boundary tests.
  const db = { query: { verifications: { findFirst } } } as unknown as Parameters<
    typeof createIdpChallenges
  >[0];
  return {
    payload,
    userId,
    sessionId,
    findFirst,
    finish,
    prepare,
    bridge: createIdpChallenges(
      db,
      'generated-test-key',
      'https://ensemus.invalid',
      'generated-operator',
      { finish, prepare },
    ),
  };
}
const incoming = (value: string) =>
  new Headers({ cookie: `__Secure-better-auth.two_factor=${value}.generated-signature` });
describe('required IdP factor bridge boundary', () => {
  it('accepts the pinned native generator including its URL-safe alphabet', () => {
    const challenges = [
      `2fa-${'A'.repeat(18)}-_`,
      ...Array.from({ length: 128 }, () => `2fa-${generateRandomString(20)}`),
    ];
    expect(challenges.every(nativeFactorChallengeIdentifier)).toBe(true);
  });
  it('does not confuse native challenges with malformed, signed or promoted identifiers', () => {
    for (const value of [
      undefined,
      null,
      `2fa-${'a'.repeat(19)}`,
      `2fa-${'a'.repeat(21)}`,
      `2fa-${'a'.repeat(18)}/a`,
      `2fa-${'a'.repeat(18)} a`,
      `2fa-${'a'.repeat(20)}.signature`,
      `2fa-idp-${'a'.repeat(32)}`,
      `reset-${'a'.repeat(20)}`,
    ])
      expect(nativeFactorChallengeIdentifier(value)).toBe(false);
  });
  it('preserves the exact native factor handler while widening only its callback matcher', () => {
    const f = fixture(),
      native = mfaPlugins()[0]!,
      joined = mfaPlugins(f.bridge)[0]!,
      original = native.hooks!.after![0]!,
      wrapped = joined.hooks!.after![1]!;
    expect(wrapped.handler.toString()).toBe(original.handler.toString());
    for (const path of ['/sign-in/email', '/callback/:id', '/sso/saml2/sp/acs/:providerId'])
      expect(
        wrapped.matcher({
          path,
          method: 'POST',
          params: { id: 'generated-operator' },
        } as unknown as Parameters<typeof wrapped.matcher>[0]),
      ).toBe(true);
    expect(
      wrapped.matcher({
        path: '/callback/:id',
        method: 'POST',
        params: { id: 'other-provider' },
      } as unknown as Parameters<typeof wrapped.matcher>[0]),
    ).toBe(false);
  });
  it('does not require provider discovery or a bridge for an actual native credential challenge', async () => {
    const f = fixture();
    expect(
      await f.bridge.complete({
        userId: f.userId,
        sessionId: f.sessionId,
        headers: incoming('2fa-generatedcredential'),
      }),
    ).toBe(true);
    expect(f.findFirst).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled();
  });
  it('never downgrades missing or malformed IdP bridge state into a credential challenge', async () => {
    const f = fixture();
    f.findFirst.mockResolvedValue(undefined);
    expect(
      await f.bridge.complete({
        userId: f.userId,
        sessionId: f.sessionId,
        headers: incoming(`2fa-idp-${'1'.repeat(32)}`),
      }),
    ).toBe(false);
    expect(
      await f.bridge.complete({
        userId: f.userId,
        sessionId: f.sessionId,
        headers: incoming('2fa-idp-malformed'),
      }),
    ).toBe(false);
    expect(f.finish).not.toHaveBeenCalled();
  });
  it('requires the same actual factor-verified account and passes the exact protected row to atomic consumption', async () => {
    const f = fixture(),
      headers = incoming(`2fa-idp-${'2'.repeat(32)}`);
    expect(await f.bridge.complete({ userId: randomUUID(), sessionId: f.sessionId, headers })).toBe(
      false,
    );
    expect(f.finish).not.toHaveBeenCalled();
    expect(await f.bridge.complete({ userId: f.userId, sessionId: f.sessionId, headers })).toBe(
      true,
    );
    expect(f.finish).toHaveBeenCalledWith({
      payload: f.payload,
      userId: f.userId,
      sessionId: f.sessionId,
      consume: { id: expect.any(String), value: JSON.stringify(f.payload) },
    });
  });
  it.each([
    null,
    { version: 0 },
    { authenticatedAt: Date.now() + 120000 },
    { payloadSha256: 'unbounded-unverified-text' },
  ])('refuses malformed stored bridge data: %j', async (alteration) => {
    const f = fixture();
    f.findFirst.mockResolvedValue({
      id: randomUUID(),
      value: JSON.stringify(alteration === null ? null : { ...f.payload, ...alteration }),
    });
    expect(
      await f.bridge.complete({
        userId: f.userId,
        sessionId: f.sessionId,
        headers: incoming(`2fa-idp-${'3'.repeat(32)}`),
      }),
    ).toBe(false);
    expect(f.finish).not.toHaveBeenCalled();
  });
});
