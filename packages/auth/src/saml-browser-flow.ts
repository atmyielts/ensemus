// Correlation only: this module never selects a user or enables implicit account linking.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { authSchema, readSsoProvider, type openAuthDatabase } from '@ensemus/database/auth';
import type {
  SSOSAMLUserResolutionInput,
  SSOUserResolution,
  SSOUserResolutionContext,
} from '@better-auth/sso';
import { APIError } from 'better-auth/api';
import type { SamlEnvelope } from './sso-request';
import { ssoBoundary, ssoIdpIssuer, trustedSamlProvider } from './sso-flow';
import type { SsoProviderState } from './sso';
import {
  matchesSamlBrowserProof,
  nativeSamlRedirect,
  parseSamlIntent,
  issueSamlBrowserProof,
  readSamlBrowserProof,
  samlBrowserCookie,
  samlBrowserCookieValue,
  samlHash,
  SAML_BROWSER_PREFIX,
  SAML_BROWSER_TTL_SECONDS,
  type SamlBrowserIntent,
} from './saml-browser-binding';

type Database = ReturnType<typeof openAuthDatabase>['db'];
const refuse = () => new APIError('FORBIDDEN', { code: 'SSO_REFUSED' });
function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(Array.from(response.headers.entries()));
  headers.append('set-cookie', cookie);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
export function createSamlBrowserFlow(options: {
  database: Database;
  secret: string;
  baseURL: string;
}) {
  const db = options.database,
    storage = new AsyncLocalStorage<{
      headers: Headers;
      envelope?: SamlEnvelope;
      matched: boolean;
    }>();
  return {
    async bindStart(request: Request, response: Response): Promise<Response> {
      if (
        request.method !== 'POST' ||
        new URL(request.url).pathname !== '/api/auth/sign-in/sso' ||
        !response.ok
      )
        return response;
      if (new URL(options.baseURL).protocol !== 'https:') throw refuse();
      let payload: { url?: unknown };
      try {
        payload = (await response.clone().json()) as { url?: unknown };
      } catch {
        throw refuse();
      }
      const redirect = nativeSamlRedirect(payload.url);
      if (!redirect) throw refuse();
      const nativeRequests = await db.query.verifications.findMany({
        where: (row, { eq }) => eq(row.identifier, `saml-authn-request:${redirect.requestId}`),
        limit: 2,
      });
      const nativeRequest = nativeRequests[0];
      if (
        nativeRequests.length !== 1 ||
        !nativeRequest ||
        nativeRequest.expiresAt.getTime() <= Date.now()
      )
        throw refuse();
      let recorded: { id?: unknown; providerId?: unknown };
      try {
        recorded = JSON.parse(nativeRequest.value) as typeof recorded;
      } catch {
        throw refuse();
      }
      if (recorded.id !== redirect.requestId || typeof recorded.providerId !== 'string')
        throw refuse();
      const provider = await readSsoProvider(db, recorded.providerId),
        issuer = provider ? ssoIdpIssuer(provider) : null;
      if (
        !provider?.domainVerified ||
        !trustedSamlProvider(provider) ||
        !provider.samlConfig ||
        !issuer
      )
        throw refuse();
      const proof = randomBytes(32).toString('base64url'),
        id = randomUUID(),
        now = new Date();
      const intent: SamlBrowserIntent = {
        version: 1,
        mode: 'signin',
        phase: 'prepared',
        requestId: redirect.requestId,
        relaySha256: redirect.relaySha256,
        providerId: provider.providerId,
        issuer,
        domain: provider.domain,
        boundary: ssoBoundary(provider),
        rawConfigSha256: samlHash(provider.samlConfig),
        browserProofSha256: samlHash(proof),
      };
      const expiresAt = new Date(
        Math.min(
          nativeRequest.expiresAt.getTime(),
          now.getTime() + SAML_BROWSER_TTL_SECONDS * 1000,
        ),
      );
      // The native request record is authoritative for provider selection, not caller email or IDs.
      await db
        .insert(authSchema.verification)
        .values({
          id,
          identifier: `${SAML_BROWSER_PREFIX}${intent.relaySha256}`,
          value: JSON.stringify(intent),
          expiresAt,
          createdAt: now,
        });
      if (expiresAt.getTime() <= Date.now()) throw refuse();
      const cookie = issueSamlBrowserProof(options.secret, id, intent, proof);
      return withCookie(response, samlBrowserCookie(cookie.value));
    },
    run(
      request: Request,
      envelope: SamlEnvelope | undefined,
      operation: () => Promise<Response>,
    ): Promise<Response> {
      const scope = {
        headers: new Headers(Array.from(request.headers.entries())),
        ...(envelope ? { envelope } : {}),
        matched: false,
      };
      return storage.run(scope, async () => {
        const response = await operation();
        return scope.matched ? withCookie(response, samlBrowserCookie('', 0)) : response;
      });
    },
    async resolve(
      input: SSOSAMLUserResolutionInput,
      context: SSOUserResolutionContext,
      provider: SsoProviderState,
    ): Promise<SSOUserResolution> {
      const scope = storage.getStore(),
        envelope = scope?.envelope;
      if (!scope || !envelope?.requestId || !envelope.relaySha256)
        return { action: 'reject', code: 'SSO_REFUSED' };
      const proof = readSamlBrowserProof(
        options.secret,
        samlBrowserCookieValue(scope.headers.get('cookie')),
      );
      if (!proof) return { action: 'reject', code: 'SSO_REFUSED' };
      const row = await context.database.findOne<{
        id: string;
        value: string;
        identifier: string;
        expiresAt: Date;
      }>({
        model: 'verification',
        where: [
          { field: 'id', value: proof.id },
          { field: 'identifier', value: `${SAML_BROWSER_PREFIX}${envelope.relaySha256}` },
        ],
      });
      const intent = row ? parseSamlIntent(row.value) : null;
      const expiry = row ? new Date(row.expiresAt).getTime() : NaN;
      if (
        !row ||
        !intent ||
        intent.phase !== 'prepared' ||
        !Number.isFinite(expiry) ||
        expiry <= Date.now() ||
        !matchesSamlBrowserProof(proof, intent, row.id) ||
        intent.requestId !== envelope.requestId ||
        intent.relaySha256 !== envelope.relaySha256 ||
        intent.providerId !== input.providerId ||
        intent.issuer !== input.accountKey.issuer ||
        provider.providerId !== input.providerId ||
        provider.domain !== intent.domain ||
        !provider.domainVerified ||
        !trustedSamlProvider(provider) ||
        ssoIdpIssuer(provider) !== intent.issuer ||
        envelope.issuer !== input.accountKey.issuer ||
        envelope.subject !== input.accountKey.accountId ||
        intent.boundary !== ssoBoundary(provider) ||
        !provider.samlConfig ||
        intent.rawConfigSha256 !== samlHash(provider.samlConfig)
      )
        return { action: 'reject', code: 'SSO_REFUSED' };
      scope.matched = true;
      const changed = await context.database.update<{ value: string; expiresAt: Date }>({
        model: 'verification',
        where: [
          { field: 'id', value: row.id },
          { field: 'value', value: row.value },
          { field: 'expiresAt', value: row.expiresAt },
        ],
        update: { value: JSON.stringify({ ...intent, phase: 'consumed' }) },
      });
      const consumed = changed ? parseSamlIntent(changed.value) : null;
      const consumedExpiry = changed ? new Date(changed.expiresAt).getTime() : NaN;
      // Check the clock after acquiring the native UPDATE lock, not only before a possible wait.
      if (
        !consumed ||
        consumed.phase !== 'consumed' ||
        !Number.isFinite(consumedExpiry) ||
        consumedExpiry !== expiry ||
        consumedExpiry <= Date.now()
      )
        throw refuse();
      return { action: 'continue' };
    },
  };
}
