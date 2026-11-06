// Operator OIDC only. Preserve native profile/login behavior, then bind the exact natively-verified
// ID token to actual callback/session authority. Userinfo auth_time is never primary evidence.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { verifyProviderIdToken, type BetterAuthPlugin, type OAuthProvider } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
export type OperatorOidc = { providerId: string; clientId: string; discoveryUrl: string };
export type OidcTrust = { providerId: string; issuer: string; sourceConfigSha256: string };
export type AcceptedOidc = OidcTrust & {
  subject: string;
  authenticatedAt: number | null;
  tokenSha256: string;
};
const strong = new Set([
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
]);
export function operatorOidcTrust(
  config: OperatorOidc | undefined,
  provider: Pick<OAuthProvider, 'id' | 'idToken' | 'requiresIdTokenNonce'> | undefined,
): OidcTrust | null {
  if (
    !config ||
    !provider ||
    provider.id !== config.providerId ||
    !provider.idToken ||
    'verify' in provider.idToken ||
    provider.idToken.allowOpaqueToken ||
    provider.requiresIdTokenNonce !== true
  )
    return null;
  const policy = provider.idToken;
  if (
    typeof policy.issuer !== 'string' ||
    !policy.issuer ||
    !policy.algorithms?.some((algorithm) => strong.has(algorithm)) ||
    (policy.nonceComparison ?? 'exact') !== 'exact'
  )
    return null;
  if (
    typeof policy.audience === 'string'
      ? policy.audience !== config.clientId
      : !policy.audience.includes(config.clientId)
  )
    return null;
  const sourceConfigSha256 = createHash('sha256')
    .update(
      JSON.stringify([
        config.providerId,
        config.clientId,
        config.discoveryUrl,
        policy.issuer,
        typeof policy.audience === 'string' ? [policy.audience] : [...policy.audience].sort(),
        [...policy.algorithms].sort(),
        policy.maxTokenAge ?? null,
        policy.nonceComparison ?? 'exact',
      ]),
    )
    .digest('hex');
  return { providerId: config.providerId, issuer: policy.issuer, sourceConfigSha256 };
}
/** Decoding follows native signature/issuer/audience/nonce verification. This is never a verifier. */
function signedClaims(
  token: string,
): { claims: Record<string, unknown>; algorithm: unknown } | null {
  if (token.length > 65536) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part)))
    return null;
  try {
    const bytes = Buffer.from(parts[1]!, 'base64url'),
      header = Buffer.from(parts[0]!, 'base64url');
    if (bytes.byteLength > 32768 || header.byteLength > 4096) return null;
    const value = JSON.parse(bytes.toString('utf8')) as unknown,
      protectedHeader = JSON.parse(header.toString('utf8')) as { alg?: unknown } | null;
    return value && typeof value === 'object' && !Array.isArray(value) && protectedHeader
      ? { claims: value as Record<string, unknown>, algorithm: protectedHeader.alg }
      : null;
  } catch {
    return null;
  }
}
export function createOperatorOidcFlow(
  config: OperatorOidc | undefined,
  record: (input: AcceptedOidc & { sessionId: string; userId: string }) => Promise<boolean>,
) {
  const storage = new AsyncLocalStorage<{ accepted?: AcceptedOidc; conflicted?: boolean }>(),
    wrapped = new WeakSet<OAuthProvider>();
  function wrap(provider: OAuthProvider) {
    if (wrapped.has(provider) || provider.id !== config?.providerId) return;
    wrapped.add(provider);
    const original = provider.getUserInfo;
    provider.getUserInfo = async (tokens) => {
      const policy = operatorOidcTrust(config, provider),
        untrusted = typeof tokens.idToken === 'string' ? signedClaims(tokens.idToken) : null;
      if (policy && typeof tokens.idToken === 'string' && !untrusted) return null;
      const result = await original(tokens);
      const scope = storage.getStore(),
        trust = operatorOidcTrust(config, provider);
      if (
        !result ||
        !scope ||
        !trust ||
        typeof tokens.idToken !== 'string' ||
        tokens.idToken.length > 65536 ||
        typeof tokens.expectedIdTokenNonce !== 'string' ||
        !tokens.expectedIdTokenNonce ||
        tokens.expectedIdTokenNonce.length > 512
      )
        return result;
      // Explicit supported native verifier call prevents a missing-token/userinfo fallback from
      // ever being mistaken for signed primary evidence, even if adapter internals later change.
      try {
        if (!(await verifyProviderIdToken(provider, tokens.idToken, tokens.expectedIdTokenNonce)))
          return result;
      } catch {
        return result;
      }
      const claims = untrusted?.claims,
        profile = result.data as Record<string, unknown>;
      if (
        typeof untrusted?.algorithm !== 'string' ||
        !strong.has(untrusted.algorithm) ||
        !claims ||
        claims.iss !== trust.issuer ||
        typeof claims.sub !== 'string' ||
        !claims.sub ||
        claims.sub.length > 2048 ||
        [...claims.sub].some((character) => character.charCodeAt(0) < 32) ||
        claims.nonce !== tokens.expectedIdTokenNonce ||
        typeof profile.sub !== 'string' ||
        profile.sub !== claims.sub
      )
        return result;
      const authTime = claims.auth_time;
      let authenticatedAt: number | null = null;
      if (
        typeof authTime === 'number' &&
        Number.isSafeInteger(authTime) &&
        authTime >= 0 &&
        Number.isSafeInteger(authTime * 1000) &&
        authTime * 1000 <= Date.now() + 60000
      )
        authenticatedAt = authTime * 1000;
      const candidate = {
        ...trust,
        subject: claims.sub,
        authenticatedAt,
        tokenSha256: createHash('sha256').update(tokens.idToken).digest('hex'),
      };
      if (scope.accepted && scope.accepted.tokenSha256 !== candidate.tokenSha256) {
        scope.conflicted = true;
        return result;
      }
      scope.accepted = candidate;
      return result;
    };
  }
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      return storage.run({}, operation);
    },
    trust: (provider: OAuthProvider | undefined) => operatorOidcTrust(config, provider),
    candidate: () =>
      storage.getStore()?.conflicted ? null : (storage.getStore()?.accepted ?? null),
    plugin: {
      id: 'ensemus-operator-oidc-primary',
      hooks: {
        before: [
          {
            matcher: (context) =>
              !!config &&
              context.path === '/callback/:id' &&
              context.params?.id === config.providerId,
            handler: createAuthMiddleware(async (context) => {
              const provider = context.context.socialProviders.find(
                (candidate) => candidate.id === config?.providerId,
              );
              if (provider) wrap(provider);
            }),
          },
        ],
        after: [
          {
            matcher: (context) =>
              !!config &&
              context.path === '/callback/:id' &&
              context.params?.id === config.providerId,
            handler: createAuthMiddleware(async (context) => {
              const accepted = storage.getStore()?.accepted,
                session = context.context.newSession;
              if (
                !accepted ||
                storage.getStore()?.conflicted ||
                !session ||
                accepted.providerId !== context.params?.id
              )
                return;
              await record({ ...accepted, sessionId: session.session.id, userId: session.user.id });
            }),
          },
        ],
      },
    } satisfies BetterAuthPlugin,
  };
}
