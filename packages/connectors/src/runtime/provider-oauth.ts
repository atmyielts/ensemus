// Session-scoped provider authorization. No module-global token, tenant cache or durable plaintext.
import { createHash } from 'node:crypto';
import { oauthCredentialSchema } from '@ensemus/contracts/knowledge';
import {
  MICROSOFT_PLATFORM_AUTHORITY,
  MICROSOFT_TENANT_PATTERN,
  PKCE_VERIFIER_PATTERN,
  type OAuthErrorCode,
} from '@ensemus/domain/workspace-suites';
import {
  CursorExpired,
  SyncUnavailable,
  type ConnectorContext,
  type CredentialLease,
} from '../index';
import type { ProviderHttpClient, ProviderRequest, ProviderResponse } from '../knowledge';
import { ContentUnavailable } from '../knowledge';
import type { PlatformOAuthClient, PlatformOAuthClients } from '../suites';

export interface OAuthRotationPort {
  /** Seal before returning stored. The binding locks the connection/secret, verifies the old plaintext
   * hash, and writes with the current expected secret version. Stale concurrent refreshes must refuse.
   * replacement is borrowed only until this promise resolves, and is wiped by the caller afterwards. */
  persist(input: {
    organizationId: string;
    connectionId: string;
    expectedCredentialSha256: string;
    replacement: Buffer;
  }): Promise<'stored' | 'stale'>;
}

/**
 * Hears the scopes a refresh reported, before the token is used (ADR-038 D3). An admin who narrows access
 * at the provider narrows it here at the next refresh. The scopes come normalized by
 * `parseReportedScopes`, and the implementation may only ever take scopes away.
 */
export interface OAuthScopesPort {
  reported(input: {
    organizationId: string;
    connectionId: string;
    reportedScopes: readonly string[];
  }): Promise<void>;
}

type Provider = 'google' | 'microsoft';

const tokenRoute = (provider: Provider) => (provider === 'google' ? 'google_oauth' : 'ms_login');
const tokenPath = (provider: Provider, authority: string) =>
  provider === 'google' ? '/token' : `/${encodeURIComponent(authority)}/oauth2/v2.0/token`;

/** The answer every token response has to give, the same for a refresh and for a code. */
function checkTokenResponse(
  response: Record<string, unknown>,
  invalid: () => Error,
): { access: string; expires: number; refresh: string | undefined } {
  const access = response.access_token,
    expires = response.expires_in,
    refresh = response.refresh_token;
  if (
    typeof access !== 'string' ||
    !/^[a-z0-9\-._~+/]+=*$/i.test(access) ||
    access.length > 16384 ||
    typeof response.token_type !== 'string' ||
    response.token_type.toLowerCase() !== 'bearer' ||
    typeof expires !== 'number' ||
    !Number.isInteger(expires) ||
    expires < 1 ||
    expires > 86400 ||
    (refresh !== undefined && (typeof refresh !== 'string' || !refresh || refresh.length > 4096))
  )
    throw invalid();
  return { access, expires, refresh: refresh as string | undefined };
}

const GRAPH_RESOURCE = 'https://graph.microsoft.com/';
/** Google reports the OpenID scopes it was asked for by these names. */
const GOOGLE_IDENTITY_ALIASES: Readonly<Record<string, string>> = {
  'https://www.googleapis.com/auth/userinfo.email': 'email',
  'https://www.googleapis.com/auth/userinfo.profile': 'profile',
};

/**
 * A token response's `scope`, in the spelling `CAPABILITY_SCOPES` uses: Graph's resource prefix dropped,
 * and Google's names for the OpenID scopes mapped back. Null when the response did not say, which for
 * Microsoft means the token has what was first asked for. Microsoft's own examples show the value
 * percent-encoded, so an encoded one is decoded first. Throws for anything that is not a scope list.
 */
export function parseReportedScopes(
  provider: Provider,
  raw: unknown,
  invalid: () => Error = () => new SyncUnavailable('PROVIDER_RESPONSE_INVALID'),
): readonly string[] | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw.length > 16384) throw invalid();
  let text = raw;
  if (/%[0-9a-f]{2}/i.test(text)) {
    try {
      text = decodeURIComponent(text);
    } catch {
      throw invalid();
    }
  }
  const scopes = new Set<string>();
  for (const part of text.split(' ')) {
    if (!part) continue;
    if (!/^[\x21-\x7e]{1,512}$/.test(part)) throw invalid();
    let scope = part;
    if (provider === 'microsoft' && scope.toLowerCase().startsWith(GRAPH_RESOURCE))
      scope = scope.slice(GRAPH_RESOURCE.length);
    if (provider === 'google') scope = GOOGLE_IDENTITY_ALIASES[scope] ?? scope;
    if (!scope) throw invalid();
    scopes.add(scope);
  }
  if (scopes.size > 128) throw invalid();
  return [...scopes];
}

/**
 * The scopes in `against` that the provider reported, spelled as `against` spells them. Google's scopes
 * are case-sensitive. Graph's permission names are not, and Microsoft's own examples lower-case them.
 */
export function matchReportedScopes(
  provider: Provider,
  reported: readonly string[],
  against: readonly string[],
): readonly string[] {
  const fold = (scope: string) => (provider === 'microsoft' ? scope.toLowerCase() : scope);
  const said = new Set(reported.map(fold));
  return [...new Set(against.filter((scope) => said.has(fold(scope))))].sort();
}

/** The operator's app for this credential, or the customer's own from inside it (ADR-038 D2). */
function clientOf(
  credential: ReturnType<typeof oauthCredentialSchema.parse>,
  provider: Provider,
  platformClients: PlatformOAuthClients | undefined,
): PlatformOAuthClient {
  if ('client_id' in credential)
    return { client_id: credential.client_id, client_secret: credential.client_secret };
  const platform = platformClients?.get(provider);
  if (!platform) throw new SyncUnavailable('CREDENTIAL_INVALID');
  return platform;
}

export function createProviderAuth(options: {
  http: ProviderHttpClient;
  provider: Provider;
  rotation?: OAuthRotationPort;
  /** The operator's apps, from the connector worker's configuration only. */
  platformClients?: PlatformOAuthClients;
  scopes?: OAuthScopesPort;
}) {
  const sessions = new WeakMap<
    CredentialLease,
    {
      token: Promise<string>;
      timer: ReturnType<typeof setTimeout>;
      organizationId: string;
      connectionId: string;
    }
  >();
  const dispose = (credentials: CredentialLease) => {
    const entry = sessions.get(credentials);
    if (entry) {
      clearTimeout(entry.timer);
      sessions.delete(credentials);
    }
  };
  return {
    dispose,
    async withToken<T>(context: ConnectorContext, use: (token: string) => Promise<T>): Promise<T> {
      if (context.signal.aborted) throw new SyncUnavailable('PROVIDER_TIMEOUT');
      let entry = sessions.get(context.credentials);
      if (
        entry &&
        (entry.organizationId !== context.organizationId ||
          entry.connectionId !== context.connectionId)
      )
        throw new SyncUnavailable('CREDENTIAL_CONTEXT_MISMATCH');
      if (!entry) {
        const timer = setTimeout(() => dispose(context.credentials), 600_000);
        timer.unref();
        const token = Promise.resolve().then(() =>
          context.credentials.withCredential(async (secret) => {
            let credential: ReturnType<typeof oauthCredentialSchema.parse>;
            try {
              credential = oauthCredentialSchema.parse(
                JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(secret)),
              );
            } catch {
              throw new SyncUnavailable('CREDENTIAL_INVALID');
            }
            const client = clientOf(credential, options.provider, options.platformClients);
            const tenant = credential.tenant;
            if (
              options.provider === 'microsoft' &&
              (!tenant || !MICROSOFT_TENANT_PATTERN.test(tenant))
            )
              throw new SyncUnavailable('CREDENTIAL_INVALID');
            const body = new URLSearchParams({
              client_id: client.client_id,
              client_secret: client.client_secret,
              refresh_token: credential.refresh_token,
              grant_type: 'refresh_token',
            });
            const response = await requestJson(options.http, {
              route: tokenRoute(options.provider),
              method: 'POST',
              path: tokenPath(options.provider, tenant ?? ''),
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: Buffer.from(body.toString()),
              timeoutMs: 30_000,
              maxResponseBytes: 65_536,
              signal: context.signal,
            });
            const invalid = () => new SyncUnavailable('PROVIDER_RESPONSE_INVALID');
            const { access, expires, refresh: rotation } = checkTokenResponse(response, invalid);
            const reportedScopes = parseReportedScopes(options.provider, response.scope, invalid);
            if (typeof rotation === 'string' && rotation !== credential.refresh_token) {
              if (!options.rotation) throw new SyncUnavailable('CREDENTIAL_ROTATION_REQUIRED');
              // The same shape back, so the operator's app stays a name and never becomes a secret here.
              const replacement = Buffer.from(
                JSON.stringify({ ...credential, refresh_token: rotation }),
              );
              try {
                const result = await options.rotation.persist({
                  organizationId: context.organizationId,
                  connectionId: context.connectionId,
                  expectedCredentialSha256: createHash('sha256').update(secret).digest('hex'),
                  replacement,
                });
                if (result !== 'stored') throw new SyncUnavailable('CREDENTIAL_CHANGED');
              } catch (error) {
                throw error instanceof SyncUnavailable
                  ? error
                  : new SyncUnavailable('CREDENTIAL_ROTATION_FAILED');
              } finally {
                replacement.fill(0);
              }
            }
            // Before the token is used, so a pass never reads with more than the provider now allows
            // without the row saying so first.
            if (reportedScopes && options.scopes) {
              try {
                await options.scopes.reported({
                  organizationId: context.organizationId,
                  connectionId: context.connectionId,
                  reportedScopes,
                });
              } catch {
                throw new SyncUnavailable('CREDENTIAL_SCOPES_UNRECORDED');
              }
            }
            const current = sessions.get(context.credentials);
            if (current) {
              clearTimeout(current.timer);
              current.timer = setTimeout(
                () => dispose(context.credentials),
                Math.min(600_000, Math.max(1, (expires - 30) * 1000)),
              );
              current.timer.unref();
            }
            return access;
          }),
        );
        entry = {
          token,
          timer,
          organizationId: context.organizationId,
          connectionId: context.connectionId,
        };
        sessions.set(context.credentials, entry);
      }
      try {
        return await use(await entry.token);
      } catch (error) {
        dispose(context.credentials);
        throw error instanceof SyncUnavailable ||
          error instanceof CursorExpired ||
          error instanceof ContentUnavailable
          ? error
          : new SyncUnavailable('PROVIDER_UNAVAILABLE');
      }
    },
  };
}

// --- The code exchange (ADR-038 D1). Runs once per consent, in the connector worker, which alone holds
// the operator's secret. Nothing here retries: a code is single use, and a second try could only fail
// at the provider or look like a replay.

/** Says why an exchange ended, with a code from OAUTH_ERROR_CODES and never a provider's text. */
export class OAuthExchangeRefused extends Error {
  override name = 'OAuthExchangeRefused';
  constructor(readonly code: OAuthErrorCode) {
    super(code);
  }
}

export type CodeExchangeRequest = {
  provider: Provider;
  client: PlatformOAuthClient;
  /** Microsoft only: `organizations` for the operator's app, the customer's directory for theirs. */
  authority: string | null;
  code: string;
  verifier: string;
  /** Exactly the one the authorize URL named. Providers require the same value here. */
  redirectUri: string;
  /** What the consent asked for. Microsoft names them again when the code is redeemed. */
  scopes: readonly string[];
  signal: AbortSignal;
};

export type CodeExchangeResult = {
  refreshToken: string;
  /** Normalized by parseReportedScopes. The caller keeps only what was asked for. */
  reportedScopes: readonly string[];
  /** The ID token's email, to label the connection. Never logged. */
  account: string;
  /** Microsoft's directory (`tid`), which every later refresh goes to. Null for Google. */
  tenant: string | null;
};

const EMAIL = /^[^\s@\p{Cc}]{1,64}@(?!.*\.\.)[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/u;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ID token's claims, read without checking its signature. OpenID Connect allows that for a token
 * that came straight from the token endpoint over TLS, and the TLS name here is fixed in code
 * (ROUTE_TLS_NAMES). The claims only label the connection and give Microsoft's directory.
 */
function idTokenClaims(value: unknown): Record<string, unknown> {
  const identity = () => new OAuthExchangeRefused('OAUTH_IDENTITY_INVALID');
  if (typeof value !== 'string' || value.length > 16384) throw identity();
  const parts = value.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{2,}$/.test(parts[1]!)) throw identity();
  try {
    const claims: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(parts[1]!, 'base64url')),
    );
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw identity();
    return claims as Record<string, unknown>;
  } catch {
    throw identity();
  }
}

function identityOf(
  request: CodeExchangeRequest,
  claims: Record<string, unknown>,
): { account: string; tenant: string | null } {
  const identity = () => new OAuthExchangeRefused('OAUTH_IDENTITY_INVALID');
  const audience = claims.aud;
  if (
    !(audience === request.client.client_id) &&
    !(Array.isArray(audience) && audience.includes(request.client.client_id))
  )
    throw identity();
  if (request.provider === 'google') {
    if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com')
      throw identity();
    const email = claims.email;
    if (claims.email_verified !== true || typeof email !== 'string' || !EMAIL.test(email))
      throw identity();
    return { account: email, tenant: null };
  }
  const tid = claims.tid;
  if (typeof tid !== 'string' || !GUID.test(tid)) throw identity();
  if (claims.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) throw identity();
  // A customer's app that named its directory by ID must have been consented to in that directory.
  if (
    request.authority &&
    GUID.test(request.authority) &&
    request.authority.toLowerCase() !== tid.toLowerCase()
  )
    throw identity();
  // A work account often has no `email` claim. Its sign-in name is an address in the directory's domain.
  const email = typeof claims.email === 'string' ? claims.email : claims.preferred_username;
  if (typeof email !== 'string' || !EMAIL.test(email)) throw identity();
  return { account: email, tenant: tid.toLowerCase() };
}

/** RFC 6749's error names, as a fixed code. Anything else is a plain failure. */
function refusalFor(status: number, body: Buffer): OAuthErrorCode {
  if (status === 401) return 'OAUTH_CLIENT_REJECTED';
  let error: unknown;
  try {
    error = (JSON.parse(body.toString('utf8')) as { error?: unknown }).error;
  } catch {
    return 'OAUTH_EXCHANGE_FAILED';
  }
  switch (error) {
    case 'invalid_client':
    case 'unauthorized_client':
      return 'OAUTH_CLIENT_REJECTED';
    case 'invalid_scope':
      return 'OAUTH_SCOPE_REFUSED';
    case 'consent_required':
    case 'interaction_required':
      return 'OAUTH_CONSENT_REQUIRED';
    default:
      return 'OAUTH_EXCHANGE_FAILED';
  }
}

/**
 * Redeems an authorization code with its PKCE verifier, once, through the provider's token route. The
 * answer is checked the way a refresh's is, and must also carry a refresh token, the granted scopes and
 * an ID token. Throws OAuthExchangeRefused with a code, and nothing the provider wrote.
 */
export async function exchangeAuthorizationCode(
  http: ProviderHttpClient,
  request: CodeExchangeRequest,
): Promise<CodeExchangeResult> {
  const failed = () => new OAuthExchangeRefused('OAUTH_EXCHANGE_FAILED');
  if (
    !request.code ||
    request.code.length > 4096 ||
    !/^[\x21-\x7e]+$/.test(request.code) ||
    !PKCE_VERIFIER_PATTERN.test(request.verifier) ||
    !request.client.client_id ||
    !request.client.client_secret
  )
    throw failed();
  try {
    const redirect = new URL(request.redirectUri);
    if (!['https:', 'http:'].includes(redirect.protocol) || redirect.username || redirect.password)
      throw new Error('REDIRECT_INVALID');
  } catch {
    throw failed();
  }
  let authority = '';
  if (request.provider === 'microsoft') {
    authority = request.authority ?? MICROSOFT_PLATFORM_AUTHORITY;
    if (authority !== MICROSOFT_PLATFORM_AUTHORITY && !MICROSOFT_TENANT_PATTERN.test(authority))
      throw new OAuthExchangeRefused('OAUTH_CLIENT_NOT_CONFIGURED');
  }
  const form = new URLSearchParams({
    client_id: request.client.client_id,
    client_secret: request.client.client_secret,
    code: request.code,
    code_verifier: request.verifier,
    grant_type: 'authorization_code',
    redirect_uri: request.redirectUri,
  });
  if (request.provider === 'microsoft') form.set('scope', request.scopes.join(' '));
  const body = Buffer.from(form.toString());
  let response: ProviderResponse;
  try {
    response = await http.request({
      route: tokenRoute(request.provider),
      method: 'POST',
      path: tokenPath(request.provider, authority),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs: 30_000,
      maxResponseBytes: 65_536,
      signal: request.signal,
    });
  } catch {
    throw failed();
  } finally {
    body.fill(0);
  }
  if (response.status === 400 || response.status === 401)
    throw new OAuthExchangeRefused(refusalFor(response.status, response.body));
  let answer: Record<string, unknown>;
  try {
    answer = jsonResponse(response);
  } catch {
    throw failed();
  }
  const { refresh } = checkTokenResponse(answer, failed);
  if (refresh === undefined) throw failed();
  const reportedScopes = parseReportedScopes(request.provider, answer.scope, failed);
  // D3: what was granted is what the provider says. An answer that does not say is not believed.
  if (reportedScopes === null) throw failed();
  const { account, tenant } = identityOf(request, idTokenClaims(answer.id_token));
  return { refreshToken: refresh, reportedScopes, account, tenant };
}

export async function requestJson(
  http: ProviderHttpClient,
  request: ProviderRequest,
  expiredCursor = false,
): Promise<Record<string, unknown>> {
  let response: ProviderResponse;
  try {
    response = await http.request(request);
  } catch {
    throw new SyncUnavailable(request.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE');
  }
  if ((request.route === 'google_oauth' || request.route === 'ms_login') && response.status === 400)
    throw new SyncUnavailable('CREDENTIAL_REJECTED');
  return jsonResponse(response, expiredCursor);
}
export function jsonResponse(
  response: ProviderResponse,
  expiredCursor = false,
): Record<string, unknown> {
  if (expiredCursor && (response.status === 400 || response.status === 410))
    throw new CursorExpired();
  if (response.status >= 300 && response.status < 400)
    throw new SyncUnavailable('PROVIDER_REDIRECT');
  if (response.status === 401 || response.status === 403)
    throw new SyncUnavailable('CREDENTIAL_REJECTED');
  if (response.status === 400) throw new SyncUnavailable('PROVIDER_RESPONSE_INVALID');
  if (response.status === 429) throw new SyncUnavailable('RATE_LIMITED');
  if (response.status < 200 || response.status >= 300)
    throw new SyncUnavailable('PROVIDER_UNAVAILABLE');
  try {
    const body: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(response.body),
    );
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_JSON');
    return body as Record<string, unknown>;
  } catch {
    throw new SyncUnavailable('PROVIDER_RESPONSE_INVALID');
  }
}
export function providerId(value: unknown): string {
  if (typeof value !== 'string' || !/^(?!\.+$)[A-Za-z0-9_!.-]{1,256}$/.test(value))
    throw new SyncUnavailable('PROVIDER_RESPONSE_INVALID');
  return value;
}
export function requiredText(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\r\n\0]/.test(value))
    throw new SyncUnavailable('PROVIDER_RESPONSE_INVALID');
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SyncUnavailable('PROVIDER_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}
export function array(value: unknown, max = 1000): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new SyncUnavailable('PROVIDER_RESPONSE_INVALID');
  return value;
}
export function sourceUrl(value: unknown): string | null {
  try {
    if (typeof value !== 'string' || value.length > 4096) return null;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}
export function sourceDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result : null;
}
