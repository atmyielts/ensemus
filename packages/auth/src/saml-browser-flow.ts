// Ordinary sign-in remains implicit-link refusing. Explicit self-link selects only the native
// source person captured after local proof, then consumes its guard in the SDK's real transaction.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  authSchema,
  readSsoProvider,
  storeNativeSamlBrowserIntent,
  type SamlLinkSource,
  type openAuthDatabase,
} from '@ensemus/database/auth';
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
  samlIntentBinding,
  SAML_BROWSER_PREFIX,
  SAML_SELF_LINK_PREFIX,
  SAML_BROWSER_TTL_SECONDS,
  type SamlBrowserIntent,
} from './saml-browser-binding';

type Database = ReturnType<typeof openAuthDatabase>['db'];
const refuse = () => new APIError('FORBIDDEN', { code: 'SSO_REFUSED' });
// These are native endpoint templates, not a browser's claimed actor or arbitrary URL field.
// A real session.create.after observation is still required. Refresh/update reads are excluded.
const PRIMARY_SESSION_PATHS = new Set([
  '/sign-in/email',
  '/sign-up/email',
  '/callback/:id',
  '/oauth2/callback/:providerId',
  '/sso/saml2/sp/acs/:providerId',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
]);
function nativePrimaryPath(path: string | undefined): boolean {
  if (typeof path !== 'string' || path.length > 2048) return false;
  if (PRIMARY_SESSION_PATHS.has(path)) return true;
  const prefix = ['/callback/', '/oauth2/callback/', '/sso/saml2/sp/acs/'].find((prefix) =>
    path.startsWith(prefix),
  );
  if (!prefix) return false;
  const segment = path.slice(prefix.length);
  if (
    !segment ||
    /[/\\?#]/.test(segment) ||
    [...segment].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    return false;
  try {
    const provider = decodeURIComponent(segment);
    return (
      provider.length > 0 &&
      provider.length <= 200 &&
      ![...provider].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    );
  } catch {
    return false;
  }
}
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
  providerPrimaryCurrent?: (receipt: string) => Promise<boolean>;
}) {
  const db = options.database,
    storage = new AsyncLocalStorage<{
      headers: Headers;
      envelope?: SamlEnvelope;
      matched: boolean;
      createdPrincipals: Set<string>;
    }>();
  const bindStart = async (
    request: Request,
    response: Response,
    source?: SamlLinkSource,
  ): Promise<Response> => {
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
      mode: source ? 'self_link' : 'signin',
      phase: 'prepared',
      requestId: redirect.requestId,
      relaySha256: redirect.relaySha256,
      providerId: provider.providerId,
      issuer,
      domain: provider.domain,
      boundary: ssoBoundary(provider),
      rawConfigSha256: samlHash(provider.samlConfig),
      browserProofSha256: samlHash(proof),
      ...(source ? { source } : {}),
    };
    const expiresAt = new Date(
      Math.min(nativeRequest.expiresAt.getTime(), now.getTime() + SAML_BROWSER_TTL_SECONDS * 1000),
    );
    // The native request record is authoritative for provider selection, not caller email or IDs.
    const stored = {
      id,
      identifier: `${source ? SAML_SELF_LINK_PREFIX : SAML_BROWSER_PREFIX}${intent.relaySha256}`,
      value: JSON.stringify(intent),
      expiresAt,
      createdAt: now,
    };
    let prepared: SamlBrowserIntent | null = intent;
    if (source) {
      const row = await storeNativeSamlBrowserIntent(db, stored, source);
      prepared = row ? parseSamlIntent(row.value) : null;
    } else await db.insert(authSchema.verification).values(stored);
    // A missing migration/guard is unavailable, never an unguarded native selection.
    if (
      !prepared ||
      (source &&
        (prepared.scopeAdmission !== 'v1' || !prepared.organizationId || !prepared.membershipId))
    )
      throw refuse();
    if (expiresAt.getTime() <= Date.now()) throw refuse();
    const cookie = issueSamlBrowserProof(options.secret, id, prepared, proof);
    return withCookie(response, samlBrowserCookie(cookie.value));
  };
  return {
    bindStart,
    /** Called only by Better Auth's actual native session.create.after hook. No selection effect. */
    observeNativeSession(path: string | undefined, userId: string) {
      if (nativePrimaryPath(path)) storage.getStore()?.createdPrincipals.add(userId);
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
        createdPrincipals: new Set<string>(),
      };
      return storage.run(scope, async () => {
        const response = await operation();
        let expire = scope.matched;
        if (!expire && scope.createdPrincipals.size) {
          const proof = readSamlBrowserProof(
            options.secret,
            samlBrowserCookieValue(scope.headers.get('cookie')),
          );
          if (proof?.mode === 'self_link') {
            try {
              const row = await db.query.verifications.findFirst({
                  where: (row, { eq }) => eq(row.id, proof.id),
                }),
                intent = row ? parseSamlIntent(row.value) : null;
              if (
                !row ||
                !intent ||
                !matchesSamlBrowserProof(proof, intent, row.id) ||
                !intent.source
              )
                expire = true;
              else if (intent.mode === 'self_link' && intent.phase === 'prepared')
                expire = [...scope.createdPrincipals].some(
                  (userId) => userId !== intent.source!.userId,
                );
            } catch {
              // A genuine new primary session cannot keep an unknown previously signed selection.
              // This expires just that purpose cookie; it does not select/revoke any native session.
              expire = true;
            }
          }
        }
        return expire ? withCookie(response, samlBrowserCookie('', 0)) : response;
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
          {
            field: 'identifier',
            value: `${proof.mode === 'self_link' ? SAML_SELF_LINK_PREFIX : SAML_BROWSER_PREFIX}${envelope.relaySha256}`,
          },
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
      if (intent.mode === 'self_link') {
        if (
          !intent.source ||
          intent.scopeAdmission !== 'v1' ||
          !intent.organizationId ||
          !intent.membershipId ||
          intent.source.email.toLowerCase() !== input.providerUser.email.toLowerCase()
        )
          return { action: 'reject', code: 'SSO_REFUSED' };
        const primary = intent.source.primary;
        if (primary.kind === 'provider') {
          // The native adapter is transaction-local. 0421 locks this exact receipt and source
          // account/provider again while consuming; operator OIDC trust has no SQL body authority.
          const receipt = await context.database.findOne<{ value: string }>({
            model: 'verification',
            where: [{ field: 'id', value: primary.proofId }],
          });
          if (
            !receipt ||
            samlHash(receipt.value) !== primary.fingerprint ||
            !(await options.providerPrimaryCurrent?.(receipt.value))
          )
            return { action: 'reject', code: 'SSO_REFUSED' };
        }
      }
      scope.matched = true;
      const changed = await context.database.update<{ value: string; expiresAt: Date }>({
        model: 'verification',
        where: [
          { field: 'id', value: row.id },
          { field: 'value', value: row.value },
          { field: 'expiresAt', value: row.expiresAt },
        ],
        update: {
          value: JSON.stringify({
            ...intent,
            phase: 'consumed',
            ...(intent.mode === 'self_link'
              ? { subject: input.accountKey.accountId, signedEmail: input.providerUser.email }
              : {}),
          }),
        },
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
      if (intent.mode === 'self_link') {
        if (
          !consumed.source ||
          consumed.finalizationAdmission !== 'v1' ||
          !consumed.finalizationTransaction ||
          samlIntentBinding(consumed) !== samlIntentBinding(intent) ||
          consumed.organizationId !== intent.organizationId ||
          consumed.membershipId !== intent.membershipId ||
          consumed.subject !== input.accountKey.accountId ||
          consumed.signedEmail !== input.providerUser.email
        )
          throw refuse();
        return { action: 'link', userId: consumed.source.userId, profile: 'preserve' };
      }
      return { action: 'continue' };
    },
  };
}
