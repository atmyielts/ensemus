// This native endpoint selects no browser-supplied user, session, organization or provider ID.
// The source is the authoritative native session, re-proved against the locked actual credential.
import {
  prepareNativeSamlLinkSource,
  type SamlLinkPrimaryProof,
  type SamlLinkSource,
  type openAuthDatabase,
} from '@ensemus/database/auth';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, sensitiveSessionMiddleware } from 'better-auth/api';
import { samlHash } from './saml-browser-binding';

export type SamlSelfLinkBody = { password: string; callbackURL: string; consent: 'connect' };
export function parseSamlSelfLinkBody(input: unknown): SamlSelfLinkBody | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  return Object.keys(body).every((key) => ['password', 'callbackURL', 'consent'].includes(key)) &&
    typeof body.password === 'string' &&
    body.password.length <= 128 &&
    typeof body.callbackURL === 'string' &&
    body.callbackURL.length <= 2048 &&
    body.consent === 'connect'
    ? { password: body.password, callbackURL: body.callbackURL, consent: 'connect' }
    : null;
}
export function selfLinkCallback(value: string, baseURL: string): string | null {
  try {
    const url = new URL(value),
      base = new URL(baseURL);
    if (
      base.protocol !== 'https:' ||
      url.origin !== base.origin ||
      url.pathname !== '/sso/complete' ||
      url.username ||
      url.password ||
      url.hash ||
      Array.from(url.searchParams.keys()).some((key) => key !== 'next') ||
      url.searchParams.getAll('next').length > 1
    )
      return null;
    const next = url.searchParams.get('next');
    // Same-origin destination only; no authority or private draft data is carried here.
    if (
      next &&
      (!next.startsWith('/') ||
        next.startsWith('//') ||
        next.includes('\\') ||
        [...next].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        new URL(next, base).origin !== base.origin)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
const bodySchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'ensemus',
    types: undefined as { input: unknown; output: SamlSelfLinkBody } | undefined,
    validate(value: unknown) {
      const parsed = parseSamlSelfLinkBody(value);
      return parsed ? { value: parsed } : { issues: [{ message: 'SSO_SELF_LINK_REFUSED' }] };
    },
  },
};
export function createSamlSelfLinkPlugin(options: {
  database: ReturnType<typeof openAuthDatabase>['db'];
  baseURL: string;
  primary: (input: { userId: string; sessionId: string }) => Promise<SamlLinkPrimaryProof | null>;
  nativeStart: (request: Request) => Promise<Response>;
  bindStart: (request: Request, response: Response, source: SamlLinkSource) => Promise<Response>;
}): BetterAuthPlugin {
  return {
    id: 'ensemus-saml-self-link',
    endpoints: {
      connectSamlSelf: createAuthEndpoint(
        '/sso/link-self',
        {
          method: 'POST',
          requireHeaders: true,
          body: bodySchema,
          use: [sensitiveSessionMiddleware],
        },
        async (context) => {
          const callbackURL = selfLinkCallback(context.body.callbackURL, options.baseURL);
          if (!callbackURL) throw new APIError('BAD_REQUEST', { code: 'SSO_REFUSED' });
          const native = context.context.session;
          if (native.session.userId !== native.user.id)
            throw new APIError('FORBIDDEN', { code: 'SSO_REFUSED' });
          const source = await prepareNativeSamlLinkSource(
            options.database,
            {
              userId: native.user.id,
              sessionId: native.session.id,
              sessionTokenSha256: samlHash(native.session.token),
            },
            (hash) => context.context.password.verify({ hash, password: context.body.password }),
            () => options.primary({ userId: native.user.id, sessionId: native.session.id }),
          );
          if (!source) throw new APIError('FORBIDDEN', { code: 'SSO_REFUSED' });
          const headers = new Headers({
            'content-type': 'application/json',
            origin: new URL(options.baseURL).origin,
          });
          for (const key of ['cookie', 'user-agent', 'x-forwarded-for']) {
            const value = context.headers?.get(key);
            if (value) headers.set(key, value);
          }
          const request = new Request(new URL('/api/auth/sign-in/sso', options.baseURL), {
            method: 'POST',
            headers,
            body: JSON.stringify({
              email: source.email,
              providerType: 'saml',
              callbackURL,
              errorCallbackURL: new URL('/sign-in/sso?error=refused', options.baseURL).href,
            }),
          });
          return options.bindStart(request, await options.nativeStart(request), source);
        },
      ),
    },
  };
}
