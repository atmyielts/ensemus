// An IdP callback never skips the account's native local second factor. Only an opaque signed
// challenge reaches the browser; immutable source IDs/hashes/time remain in an auth-role bridge.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomUUID } from 'node:crypto';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import {
  deleteSessionCookie,
  parseCookies,
  parseSetCookieHeader,
  splitSetCookieHeader,
} from 'better-auth/cookies';
import type { BetterAuthPlugin, GenericEndpointContext } from 'better-auth';
import { promoteIdpChallenge, type openAuthDatabase } from '@ensemus/database/auth';
type Database = ReturnType<typeof openAuthDatabase>['db'];
type Hook = NonNullable<NonNullable<BetterAuthPlugin['hooks']>['after']>[number];
type Context = GenericEndpointContext & { context: { responseHeaders?: Headers | undefined } };
export type IdpBridgePayload = {
  version: 1;
  kind: 'saml' | 'oidc';
  userId: string;
  sourceSessionId: string;
  providerId: string;
  issuer: string;
  accountId: string;
  subjectSha256: string;
  sourceSha256: string;
  payloadSha256: string;
  authenticatedAt: number | null;
};
export type IdpBridgePrepared = { payload: IdpBridgePayload; subject: string };
type Dependencies = {
  prepare: (input: {
    kind: 'saml' | 'oidc';
    providerId: string;
    userId: string;
    sourceSessionId: string;
  }) => Promise<IdpBridgePrepared | null>;
  finish: (input: {
    payload: IdpBridgePayload;
    consume: { id: string; value: string };
    sessionId: string;
    userId: string;
  }) => Promise<boolean>;
};
function receiptIdentity(key: string, identifier: string) {
  const bytes = createHmac('sha256', key)
      .update(JSON.stringify(['ensemus-idp-factor:v1', identifier]))
      .digest(),
    uuid = Buffer.from(bytes.subarray(0, 16));
  uuid[6] = (uuid[6]! & 15) | 128;
  uuid[8] = (uuid[8]! & 63) | 128;
  const hex = uuid.toString('hex');
  return {
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    identifier: `ensemus-idp-factor:v1:${bytes.toString('hex')}`,
  };
}
function parsePayload(value: string): IdpBridgePayload | null {
  if (value.length > 8192) return null;
  try {
    const row = JSON.parse(value) as IdpBridgePayload | null;
    if (
      !row ||
      row.version !== 1 ||
      !['saml', 'oidc'].includes(row.kind) ||
      !['userId', 'sourceSessionId', 'accountId'].every(
        (key) =>
          typeof row[key as keyof IdpBridgePayload] === 'string' &&
          /^[0-9a-f-]{36}$/.test(row[key as keyof IdpBridgePayload] as string),
      ) ||
      typeof row.providerId !== 'string' ||
      !row.providerId ||
      row.providerId.length > 200 ||
      typeof row.issuer !== 'string' ||
      !row.issuer ||
      row.issuer.length > 2048 ||
      ![row.subjectSha256, row.sourceSha256, row.payloadSha256].every(
        (hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash),
      ) ||
      (row.authenticatedAt !== null &&
        (!Number.isFinite(row.authenticatedAt) || row.authenticatedAt > Date.now() + 60000))
    )
      return null;
    return row;
  } catch {
    return null;
  }
}
function coalesceCookies(context: Context, omit: ReadonlySet<string>) {
  const response = context.context.responseHeaders;
  if (!(response instanceof Headers)) return;
  // Preserve native encoding and every cookie attribute. Only deduplicate by the native name;
  // decoding/re-serializing a signed value here would change the verifier's cookie semantics.
  const cookies = new Map(
    splitSetCookieHeader(response.get('set-cookie') ?? '').map(
      (value) => [value.slice(0, value.indexOf('=')), value] as const,
    ),
  );
  response.delete('set-cookie');
  for (const [name, cookie] of cookies) if (!omit.has(name)) response.append('set-cookie', cookie);
}
async function withhold(context: Context, session: { token: string } | undefined): Promise<never> {
  // Hook dispatch continues after APIError. Remove earlier full/challenge cookie headers and clear
  // newSession before any later proof/framework hook sees this refused callback.
  context.context.responseHeaders?.delete('set-cookie');
  deleteSessionCookie(context, true);
  context.context.setNewSession(null);
  if (session)
    await context.context.internalAdapter.deleteSession(session.token).catch(() => undefined);
  throw new APIError('FORBIDDEN', { code: 'SSO_REFUSED' });
}
export function createIdpChallenges(
  db: Database,
  key: string,
  baseURL: string,
  operatorProviderId: string | undefined,
  deps: Dependencies,
) {
  const storage = new AsyncLocalStorage<{
    prepared?: IdpBridgePrepared;
    sourceSession?: { token: string };
  }>();
  const match: Hook['matcher'] = (context) =>
    (context.path === '/sso/saml2/sp/acs/:providerId' && context.method === 'POST') ||
    (context.path === '/callback/:id' &&
      typeof operatorProviderId === 'string' &&
      context.params?.id === operatorProviderId);
  const before: Hook = {
    matcher: match,
    handler: createAuthMiddleware(async (context) => {
      const current = context.context.newSession;
      if (!current?.user.twoFactorEnabled) return;
      const scope = storage.getStore();
      if (!scope) return withhold(context, current.session);
      const kind = context.path === '/callback/:id' ? 'oidc' : 'saml',
        providerId = kind === 'oidc' ? context.params?.id : context.params?.providerId;
      if (typeof providerId !== 'string') return withhold(context, current.session);
      const prepared = await deps.prepare({
        kind,
        providerId,
        userId: current.user.id,
        sourceSessionId: current.session.id,
      });
      if (!prepared) return withhold(context, current.session);
      scope.prepared = prepared;
      scope.sourceSession = current.session;
    }),
  };
  const after: Hook = {
    matcher: match,
    handler: createAuthMiddleware(async (context) => {
      const scope = storage.getStore();
      if (!scope?.prepared) return;
      if (context.context.newSession) {
        const returned = context.context.returned;
        if (returned instanceof APIError && returned.statusCode >= 400)
          return withhold(context, scope.sourceSession);
        return;
      }
      const cookie = context.context.createAuthCookie('two_factor', { maxAge: 600 }),
        response = context.context.responseHeaders,
        parsed = parseSetCookieHeader(response?.get('set-cookie') ?? ''),
        signed = parsed.get(cookie.name)?.value,
        oldIdentifier = signed?.slice(0, signed.lastIndexOf('.'));
      if (!oldIdentifier || !/^2fa-[A-Za-z0-9]{20}$/.test(oldIdentifier))
        return withhold(context, scope.sourceSession);
      // Keep each native cookie's final value only. The browser never sees the normal-prefix IdP
      // challenge, so deleting/expiring its required bridge cannot turn it into a credential challenge.
      const location = response?.get('location');
      coalesceCookies(context, new Set([cookie.name]));
      const identifier = `2fa-idp-${randomUUID().replaceAll('-', '')}`,
        bridge = {
          ...receiptIdentity(key, identifier),
          value: JSON.stringify(scope.prepared.payload),
        };
      const promoted = await promoteIdpChallenge(db, {
        oldIdentifier,
        newIdentifier: identifier,
        userId: scope.prepared.payload.userId,
        providerId: scope.prepared.payload.providerId,
        accountId: scope.prepared.payload.accountId,
        subject: scope.prepared.subject,
        ...(scope.prepared.payload.kind === 'saml'
          ? { expectedSamlSha256: scope.prepared.payload.sourceSha256 }
          : {}),
        bridge,
      });
      if (!promoted) return withhold(context, scope.sourceSession);
      await context.setSignedCookie(
        cookie.name,
        identifier,
        context.context.secret,
        cookie.attributes,
      );
      let next = '/';
      try {
        const target = new URL(location ?? '/', baseURL);
        if (target.origin === new URL(baseURL).origin && !target.pathname.includes('\\'))
          next = `${target.pathname}${target.search}`;
      } catch {
        /* The real code form also validates its return path. */
      }
      throw context.redirect(`/sign-in/two-factor?next=${encodeURIComponent(next)}`);
    }),
  };
  return {
    before,
    after,
    run<T>(operation: () => Promise<T>): Promise<T> {
      return storage.run({}, operation);
    },
    async complete(input: {
      sessionId: string;
      userId: string;
      headers: Headers;
    }): Promise<boolean> {
      const cookieName = `${baseURL.startsWith('https:') ? '__Secure-' : ''}better-auth.two_factor`,
        signed = parseCookies(input.headers.get('cookie') ?? '').get(cookieName),
        identifier = signed?.slice(0, signed.lastIndexOf('.'));
      if (!identifier?.startsWith('2fa-idp-')) return true;
      if (!/^2fa-idp-[0-9a-f]{32}$/.test(identifier)) return false;
      const identity = receiptIdentity(key, identifier),
        row = await db.query.verifications.findFirst({
          where: (table, { and, eq, gt }) =>
            and(eq(table.id, identity.id), gt(table.expiresAt, new Date())),
        });
      if (!row) return false;
      const payload = parsePayload(row.value);
      if (!payload || payload.userId !== input.userId) return false;
      return deps.finish({
        payload,
        consume: { id: row.id, value: row.value },
        sessionId: input.sessionId,
        userId: input.userId,
      });
    },
  };
}
