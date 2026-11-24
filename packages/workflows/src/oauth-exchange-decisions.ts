// What the code exchange decides, apart from anything it touches (CONNECT-07, ADR-038 D1 to D3). Pure, so
// each rule is tested on its own: which directory a token request goes to, what the stored credential
// holds, which code a failure ends with, and how far a refresh narrows a connection's scopes.
import {
  IDENTITY_SCOPES,
  isOAuthErrorCode,
  MICROSOFT_PLATFORM_AUTHORITY,
  MICROSOFT_TENANT_PATTERN,
  type OAuthClientKind,
  type OAuthErrorCode,
  type SuiteConnectorType,
} from '@ensemus/domain/workspace-suites';
import { z } from 'zod';

/**
 * A customer's own app, as the web tier seals it with SECRET_PURPOSE_OAUTH_CUSTOMER_CLIENT: the same
 * names the stored credential uses, without a token yet. Strict, so nothing else rides along.
 */
export const customerClientSchema = z.strictObject({
  client_id: z.string().min(1).max(512),
  client_secret: z.string().min(1).max(2048),
  tenant: z.string().regex(MICROSOFT_TENANT_PATTERN).max(128).optional(),
});
export type CustomerClient = z.infer<typeof customerClientSchema>;

/**
 * oauthCredentialSchema's two shapes, which this package cannot import. The connector parses the stored
 * value with that schema at every refresh, and these hold the same limits, so one never stores what the
 * other refuses.
 */
const storedCredentialSchema = z.union([
  z.strictObject({
    client_id: z.string().min(1).max(512),
    client_secret: z.string().min(1).max(2048),
    refresh_token: z.string().min(1).max(4096),
    tenant: z
      .string()
      .regex(/^(?!\.+$)[A-Za-z0-9.-]{1,128}$/)
      .optional(),
  }),
  z.strictObject({
    client: z.literal('platform'),
    refresh_token: z.string().min(1).max(4096),
    tenant: z
      .string()
      .regex(/^(?!\.+$)[A-Za-z0-9.-]{1,128}$/)
      .optional(),
  }),
]);
export type StoredCredential = z.infer<typeof storedCredentialSchema>;

/** Stops an exchange with a code from OAUTH_ERROR_CODES. Carries nothing else. */
export class ExchangeStopped extends Error {
  override name = 'ExchangeStopped';
  constructor(readonly code: OAuthErrorCode) {
    super(code);
  }
}

/**
 * Where Microsoft's token request goes. The operator's app is multi-tenant and consents through
 * `organizations`. A customer's app goes to its own directory when it named one. Google has one endpoint.
 */
export function tokenAuthority(
  connectorType: SuiteConnectorType,
  clientKind: OAuthClientKind,
  customerTenant: string | undefined,
): string | null {
  if (connectorType === 'google_workspace') return null;
  if (clientKind === 'platform') return MICROSOFT_PLATFORM_AUTHORITY;
  return customerTenant ?? MICROSOFT_PLATFORM_AUTHORITY;
}

/**
 * The credential the connection keeps (ADR-038 D2). The operator's app is only named, so its secret never
 * sits in a tenant's row. Microsoft's directory comes from the ID token, which is where every refresh goes.
 */
export function credentialFor(
  connectorType: SuiteConnectorType,
  client: { kind: 'platform' } | { kind: 'customer'; clientId: string; clientSecret: string },
  exchanged: { refreshToken: string; tenant: string | null },
): StoredCredential {
  if (connectorType === 'microsoft_365' && !exchanged.tenant)
    throw new ExchangeStopped('OAUTH_IDENTITY_INVALID');
  const tenant =
    connectorType === 'microsoft_365' && exchanged.tenant ? { tenant: exchanged.tenant } : {};
  const credential =
    client.kind === 'platform'
      ? { client: 'platform' as const, refresh_token: exchanged.refreshToken, ...tenant }
      : {
          client_id: client.clientId,
          client_secret: client.clientSecret,
          refresh_token: exchanged.refreshToken,
          ...tenant,
        };
  const parsed = storedCredentialSchema.safeParse(credential);
  if (!parsed.success) throw new ExchangeStopped('OAUTH_EXCHANGE_FAILED');
  return parsed.data;
}

/**
 * The code an exchange ends with. A refusal that named one keeps it, and everything else, such as a
 * sealed value that would not open, is a plain failed exchange. No error's text is ever looked at.
 */
export function stopCodeOf(error: unknown): OAuthErrorCode {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return isOAuthErrorCode(code) ? code : 'OAUTH_EXCHANGE_FAILED';
}

/**
 * What a connection keeps after a refresh reported its scopes: only what it already had and the provider
 * still reports, so a refresh can take access away and never add it (0561 allows nothing else). The
 * identity scopes stay, because Microsoft reports only the resource's scopes on a refresh.
 * `stillReported` is already in the connection's spelling (matchReportedScopes).
 */
export function narrowedScopes(
  connectorType: SuiteConnectorType,
  granted: readonly string[],
  stillReported: readonly string[],
): readonly string[] {
  const keep = new Set([...IDENTITY_SCOPES[connectorType], ...stillReported]);
  return granted.filter((scope) => keep.has(scope));
}
