// Connecting Google Workspace and Microsoft 365 by consent (CONNECT-07, ADR-038 D1, D2). The web half starts
// an attempt and stores what the provider sends back, sealed. The worker half exchanges the code. Both
// halves share one role, so migration 0561 holds the state machine and who may move it.
//
// Stage 1a stubs: these are the exact signatures stage 1b implements, and each refuses until then.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type {
  OAuthClientKind,
  OAuthErrorCode,
  OAuthStatus,
  SuiteCapability,
  SuiteConnectorType,
  SuiteProvider,
} from '@ensemus/domain/workspace-suites';
import type { SecretLease } from './integration-ports';

export type OAuthAuthorizationView = {
  id: string;
  connectorType: SuiteConnectorType;
  displayName: string;
  clientKind: OAuthClientKind;
  capabilities: readonly SuiteCapability[];
  /** What the admin consented to. Public, and shown beside the capabilities. */
  scopes: readonly string[];
  status: OAuthStatus;
  /** From OAUTH_ERROR_CODES, when `denied` or `failed`. Never a provider's text. */
  errorCode: OAuthErrorCode | null;
  connectionId: string | null;
  ownerMembershipId: string | null;
  startedByMembershipId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type StartAuthorizationInput = {
  connectorType: SuiteConnectorType;
  displayName: string;
  /** Checked against the connector's own settings. Never a secret and never a host. */
  config: unknown;
  capabilities: readonly SuiteCapability[];
  client:
    | { kind: 'platform' }
    /** Sealed at once as one value, with SECRET_PURPOSE_OAUTH_CUSTOMER_CLIENT. */
    | { kind: 'customer'; clientId: string; clientSecret: string; tenant?: string };
};

/**
 * What only the web tier has. It can seal and cannot unseal (ADR-024 D5), and it knows the operator's
 * public client IDs, never their secrets (ADR-038 D2).
 */
export type OAuthWebSide = {
  /** Seals one value for this tenant with that purpose, and answers the sealed row's ID. */
  seal(purpose: string, plaintext: Buffer): Promise<string>;
  /** This deployment's public origin joined with OAUTH_CALLBACK_PATH. Providers require an exact match. */
  redirectUri: string;
  /** The operator's app's public client ID, or null when this deployment has none for that provider. */
  platformClientId(provider: SuiteProvider): string | null;
};

export type StartedAuthorization = { authorizationId: string; authorizeUrl: string };

export type CallbackInput = {
  state: string;
  code?: string;
  /** The provider's error name, mapped by deniedCodeFor. Its text is never kept or shown. */
  error?: string;
  /** Microsoft's admin-consent answer and directory, when it sends them. */
  adminConsent?: boolean;
  tenant?: string;
};

export type CallbackResult = { authorizationId: string; status: OAuthStatus };

/** What the exchange Activity needs from the row, after it moved to `exchanging`. IDs and public values. */
export type OAuthExchangeClaim = {
  authorizationId: string;
  connectorType: SuiteConnectorType;
  displayName: string;
  config: Record<string, unknown>;
  clientKind: OAuthClientKind;
  clientId: string;
  customerClientSecretId: string | null;
  verifierSecretId: string;
  codeSecretId: string;
  requestedScopes: readonly string[];
  ownerMembershipId: string | null;
  startedByMembershipId: string;
};

export type CompleteExchangeInput = {
  authorizationId: string;
  /** The sealed credential: `{client: 'platform', ...}` or a customer's own, per oauthCredentialSchema. */
  credentialSecretId: string;
  /** What the provider reported, before `granted ∩ requested`, which this applies. */
  reportedScopes: readonly string[];
  /** The ID token's email, used only to label the connection. */
  connectedAccount: string | null;
};

const notImplemented = () => Promise.reject(new Error('NOT_IMPLEMENTED'));

/** connection.manage, interactively. Inserts a `pending` attempt and answers the provider's page. */
export const startAuthorization: (
  database: AppDatabase,
  context: TenantContext,
  input: StartAuthorizationInput,
  web: OAuthWebSide,
) => Promise<StartedAuthorization> = notImplemented;

/**
 * The callback, in the session of the member who started it. Every failure of tenant, member, state,
 * status or expiry is the same OAUTH_STATE_INVALID. Seals the code, moves to `code_received` and emits
 * OAUTH_AUTHORIZATION_CODE_RECEIVED in one transaction, or records `denied` with a fixed code.
 */
export const receiveCallback: (
  database: AppDatabase,
  context: TenantContext,
  input: CallbackInput,
  web: Pick<OAuthWebSide, 'seal'>,
) => Promise<CallbackResult> = notImplemented;

export const getAuthorization: (
  database: AppDatabase,
  context: TenantContext,
  input: { authorizationId: string },
) => Promise<OAuthAuthorizationView> = notImplemented;

export const listAuthorizations: (
  database: AppDatabase,
  context: TenantContext,
) => Promise<readonly OAuthAuthorizationView[]> = notImplemented;

/**
 * The worker's service context only. Locks the attempt and moves `code_received` to `exchanging`, or an
 * expired one to `expired`. Null when there is nothing to exchange: another run or the expiry got there.
 */
export const claimForExchange: (
  database: AppDatabase,
  context: TenantContext,
  input: { authorizationId: string },
) => Promise<OAuthExchangeClaim | null> = notImplemented;

/**
 * In one transaction naming the attempt in OAUTH_EXCHANGE_SETTING: creates the connection with
 * `granted ∩ requested`, moves to `connected`, and revokes the code and the verifier. Refuses
 * OAUTH_SCOPES_INSUFFICIENT, through failExchange, when a chosen capability's scopes are missing.
 */
export const completeExchange: (
  database: AppDatabase,
  context: TenantContext,
  input: CompleteExchangeInput,
  secrets: Pick<SecretLease, 'revoke'>,
) => Promise<{ connectionId: string }> = notImplemented;

/** Ends the attempt `failed` with a fixed code and revokes the code and the verifier. Never retried. */
export const failExchange: (
  database: AppDatabase,
  context: TenantContext,
  input: { authorizationId: string; errorCode: OAuthErrorCode },
  secrets: Pick<SecretLease, 'revoke'>,
) => Promise<void> = notImplemented;
