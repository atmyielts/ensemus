// Session-scoped provider authorization. No module-global token, tenant cache or durable plaintext.
import { createHash } from 'node:crypto';
import { oauthCredentialSchema } from '@ensemus/contracts/knowledge';
import {
  CursorExpired,
  SyncUnavailable,
  type ConnectorContext,
  type CredentialLease,
} from '../index';
import type { ProviderHttpClient, ProviderRequest, ProviderResponse } from '../knowledge';
import { ContentUnavailable } from '../knowledge';

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

export function createProviderAuth(options: {
  http: ProviderHttpClient;
  provider: 'google' | 'microsoft';
  rotation?: OAuthRotationPort;
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
            const tenant = credential.tenant;
            if (
              options.provider === 'microsoft' &&
              (!tenant ||
                !(
                  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                    tenant,
                  ) || /^(?!.*\.\.)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(tenant)
                ))
            )
              throw new SyncUnavailable('CREDENTIAL_INVALID');
            const body = new URLSearchParams({
              client_id: credential.client_id,
              client_secret: credential.client_secret,
              refresh_token: credential.refresh_token,
              grant_type: 'refresh_token',
            });
            const response = await requestJson(options.http, {
              route: options.provider === 'google' ? 'google_oauth' : 'ms_login',
              method: 'POST',
              path:
                options.provider === 'google'
                  ? '/token'
                  : `/${encodeURIComponent(tenant!)}/oauth2/v2.0/token`,
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: Buffer.from(body.toString()),
              timeoutMs: 30_000,
              maxResponseBytes: 65_536,
              signal: context.signal,
            });
            const access = response.access_token,
              expires = response.expires_in,
              rotation = response.refresh_token;
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
              (rotation !== undefined &&
                (typeof rotation !== 'string' || !rotation || rotation.length > 4096))
            )
              throw new SyncUnavailable('PROVIDER_RESPONSE_INVALID');
            if (typeof rotation === 'string' && rotation !== credential.refresh_token) {
              if (!options.rotation) throw new SyncUnavailable('CREDENTIAL_ROTATION_REQUIRED');
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
