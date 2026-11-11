// Workspace suites (ADR-038): connecting Google Workspace and Microsoft 365 by consent, their directory,
// and the capabilities an admin chooses. Pure rules and names, so the web tier, the connector worker and
// the database's own triggers (migration 0561) agree on every one of them.
import { createHash } from 'node:crypto';

/** The connector types a consent can create. They are M5's two manifests. */
export const SUITE_CONNECTOR_TYPES = ['google_workspace', 'microsoft_365'] as const;
export type SuiteConnectorType = (typeof SUITE_CONNECTOR_TYPES)[number];

/** Which provider each one is, for the operator's app and the token route. */
export const SUITE_PROVIDER = {
  google_workspace: 'google',
  microsoft_365: 'microsoft',
} as const satisfies Record<SuiteConnectorType, 'google' | 'microsoft'>;
export type SuiteProvider = (typeof SUITE_PROVIDER)[SuiteConnectorType];

export const isSuiteConnectorType = (value: unknown): value is SuiteConnectorType =>
  typeof value === 'string' && (SUITE_CONNECTOR_TYPES as readonly string[]).includes(value);

// --- Capabilities (ADR-038 D3). An admin chooses these, and code maps each to the narrowest scopes.

export const SUITE_CAPABILITIES = [
  'files',
  'directory',
  'mail',
  'calendar',
  'documents',
  'chat',
] as const;
export type SuiteCapability = (typeof SUITE_CAPABILITIES)[number];

/**
 * What a consent may ask for today. The rest are named so the table below is whole, and each joins this
 * list when its tools are built (ADR-038 D6), so nobody grants a scope that nothing here uses.
 */
export const CONNECTABLE_CAPABILITIES = [
  'files',
  'directory',
] as const satisfies readonly SuiteCapability[];

/** Whose connection a capability belongs on (ADR-038 D3, D5). */
export const CAPABILITY_OWNER: Readonly<
  Record<SuiteCapability, 'organization' | 'member' | 'either'>
> = {
  files: 'organization',
  directory: 'organization',
  mail: 'member',
  calendar: 'member',
  documents: 'either',
  chat: 'member',
};

const google = (scope: string) => `https://www.googleapis.com/auth/${scope}`;

/**
 * ADR-038 D3's table. Google's are full scope URLs and Microsoft's are Graph's short names, which is how
 * each one's token response reports them, so `granted ∩ requested` compares like with like. An empty list
 * means the provider has nothing for it yet. Checked against Google's Admin SDK and Microsoft Graph's
 * permission references on 2026-11-11; unqualified until the owner runs them against test tenants.
 *
 * Microsoft's directory capability carries User.Read.All as well as GroupMember.Read.All, because with
 * GroupMember.Read.All alone Graph returns a user member's ID and type and nothing else, and members are
 * matched to people here by email (ADR-038 D4). User.ReadBasic.All would give the email but not
 * `accountEnabled`, `userType` or `externalUserState`, and without those a disabled account or a guest
 * who never accepted would be matched as if they were a member in good standing.
 */
export const CAPABILITY_SCOPES: Readonly<
  Record<SuiteConnectorType, Readonly<Record<SuiteCapability, readonly string[]>>>
> = {
  google_workspace: {
    files: [google('drive.readonly'), google('drive.metadata.readonly')],
    directory: [google('admin.directory.group.readonly')],
    mail: [google('gmail.readonly'), google('gmail.compose'), google('gmail.send')],
    calendar: [google('calendar.events')],
    documents: [google('drive.file'), google('documents'), google('spreadsheets')],
    chat: [],
  },
  microsoft_365: {
    files: ['Files.Read.All', 'Sites.Read.All'],
    directory: ['GroupMember.Read.All', 'User.Read.All'],
    mail: ['Mail.ReadWrite', 'Mail.Send'],
    calendar: ['Calendars.ReadWrite'],
    documents: ['Files.ReadWrite'],
    chat: ['ChannelMessage.Send', 'Chat.ReadWrite'],
  },
};

/**
 * Asked for on every consent, so the connection records who connected and, for Microsoft, the directory
 * the credential belongs to. Microsoft returns a refresh token only for offline_access. Google's comes
 * from `access_type=offline`, which is a parameter and not a scope.
 */
export const IDENTITY_SCOPES: Readonly<Record<SuiteConnectorType, readonly string[]>> = {
  google_workspace: ['openid', 'email'],
  microsoft_365: ['openid', 'email', 'offline_access'],
};

/**
 * The exact scopes a consent asks for: the identity scopes and every chosen capability's, once each, in
 * a fixed order. Null when a capability is not connectable yet or the provider has nothing for it, so a
 * caller refuses rather than asking for less than the admin chose.
 */
export function scopesFor(
  connectorType: SuiteConnectorType,
  capabilities: readonly SuiteCapability[],
): readonly string[] | null {
  if (capabilities.length === 0 || new Set(capabilities).size !== capabilities.length) return null;
  const scopes = new Set<string>(IDENTITY_SCOPES[connectorType]);
  for (const capability of capabilities) {
    if (!(CONNECTABLE_CAPABILITIES as readonly string[]).includes(capability)) return null;
    const own = CAPABILITY_SCOPES[connectorType][capability];
    if (own.length === 0) return null;
    for (const scope of own) scopes.add(scope);
  }
  return [...scopes].sort();
}

/**
 * What a connection may record as granted: what the provider said it granted, kept only where it was
 * asked for (ADR-038 D3). A provider adding a scope nobody asked for adds nothing here.
 */
export function grantedScopesOf(
  reported: readonly string[],
  requested: readonly string[],
): readonly string[] {
  const asked = new Set(requested);
  return [...new Set(reported)].filter((scope) => asked.has(scope)).sort();
}

/** Whether every scope a capability needs was granted. A stream or tool missing one refuses first. */
export function capabilityGranted(
  connectorType: SuiteConnectorType,
  capability: SuiteCapability,
  granted: readonly string[],
): boolean {
  const own = CAPABILITY_SCOPES[connectorType][capability];
  return own.length > 0 && own.every((scope) => granted.includes(scope));
}

// --- Consent attempts (ADR-038 D1, D2).

export const OAUTH_CLIENT_KINDS = ['platform', 'customer'] as const;
export type OAuthClientKind = (typeof OAUTH_CLIENT_KINDS)[number];

export const OAUTH_STATUSES = [
  'pending',
  'code_received',
  'exchanging',
  'connected',
  'denied',
  'failed',
  'expired',
] as const;
export type OAuthStatus = (typeof OAUTH_STATUSES)[number];

/**
 * The state machine. Migration 0561 holds the same arrows, and a test keeps the two equal. There is no way
 * out of `connected`, `denied`, `failed` or `expired`: trying again is a new consent with a new state.
 */
export const OAUTH_TRANSITIONS: Readonly<Record<OAuthStatus, readonly OAuthStatus[]>> = {
  pending: ['code_received', 'denied', 'expired', 'failed'],
  code_received: ['exchanging', 'failed', 'expired'],
  exchanging: ['connected', 'failed'],
  connected: [],
  denied: [],
  failed: [],
  expired: [],
};

/** The shape 0560 holds every stored refusal code to. */
const OAUTH_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

export function canTransitionOAuth(from: OAuthStatus, to: OAuthStatus): boolean {
  return OAUTH_TRANSITIONS[from].includes(to);
}

export function isSettledOAuth(status: OAuthStatus): boolean {
  return OAUTH_TRANSITIONS[status].length === 0;
}

/**
 * Whether a move, with the row as it would be after it, is one the database accepts, apart from who is
 * moving it and the clock, which only the database can check (0561): the code arrives with
 * `code_received` and with nothing else, a connection only with `connected`, and a refusal code exactly
 * with `denied` and `failed`.
 */
export function oauthTransitionAllowed(
  from: OAuthStatus,
  to: OAuthStatus,
  before: { codeSecretId: string | null; connectionId: string | null },
  after: { codeSecretId: string | null; connectionId: string | null; errorCode: string | null },
): boolean {
  if (!canTransitionOAuth(from, to)) return false;
  if ((after.codeSecretId !== before.codeSecretId) !== (to === 'code_received')) return false;
  if (to === 'code_received' && after.codeSecretId === null) return false;
  if ((after.connectionId !== before.connectionId) !== (to === 'connected')) return false;
  if ((to === 'connected') !== (after.connectionId !== null)) return false;
  const refused = to === 'denied' || to === 'failed';
  if (refused !== (after.errorCode !== null)) return false;
  return after.errorCode === null || OAUTH_ERROR_CODE_PATTERN.test(after.errorCode);
}

/**
 * Why an attempt ended `denied` or `failed`. A fixed list, because a provider's own text could hold
 * anything, and the page shows only these, in plain words.
 */
export const OAUTH_ERROR_CODES = [
  /** The admin said no on the provider's page. */
  'OAUTH_DENIED',
  /** The provider wants an administrator's consent that this admin cannot give. */
  'OAUTH_CONSENT_REQUIRED',
  /** The provider refused the scopes asked for. */
  'OAUTH_SCOPE_REFUSED',
  /** The provider does not accept this app, or the customer's client ID or secret. */
  'OAUTH_CLIENT_REJECTED',
  /** The provider reported some other error. Its text is never kept. */
  'OAUTH_PROVIDER_ERROR',
  /** The token request failed or its answer was not one we accept. Never retried: a code is single use. */
  'OAUTH_EXCHANGE_FAILED',
  /** Granted, but without a scope a chosen capability needs. Nothing partial is connected. */
  'OAUTH_SCOPES_INSUFFICIENT',
  /** The ID token did not say who connected, or for Microsoft which directory. */
  'OAUTH_IDENTITY_INVALID',
  /** The operator's app is not configured on this deployment, or a customer's sealed client is gone. */
  'OAUTH_CLIENT_NOT_CONFIGURED',
] as const;
export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

export const isOAuthErrorCode = (value: unknown): value is OAuthErrorCode =>
  typeof value === 'string' && (OAUTH_ERROR_CODES as readonly string[]).includes(value);

/**
 * The provider's `error` on the callback, as a code from the list. Both providers use RFC 6749's names,
 * and Microsoft adds a few of OpenID Connect's. Anything else is a plain provider error.
 */
export function deniedCodeFor(providerError: unknown): OAuthErrorCode {
  switch (providerError) {
    case 'access_denied':
      return 'OAUTH_DENIED';
    case 'consent_required':
    case 'interaction_required':
    case 'login_required':
      return 'OAUTH_CONSENT_REQUIRED';
    case 'invalid_scope':
      return 'OAUTH_SCOPE_REFUSED';
    case 'unauthorized_client':
    case 'invalid_client':
      return 'OAUTH_CLIENT_REJECTED';
    default:
      return 'OAUTH_PROVIDER_ERROR';
  }
}

/** ADR-038 D1. The database sets the same window on insert, from its own clock. */
export const OAUTH_STATE_TTL_SECONDS = 600;

/** The one registered redirect URI's path. Providers require an exact match. */
export const OAUTH_CALLBACK_PATH = '/api/v1/oauth/callback';

/** Where the admin consents. Both reached by the admin's own browser, never by a server here. */
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const MICROSOFT_AUTHORIZE_HOST = 'https://login.microsoftonline.com';
/** The operator's app is multi-tenant, so it consents through the `organizations` authority. */
export const MICROSOFT_PLATFORM_AUTHORITY = 'organizations';
/** A customer's own app names its directory: a GUID or a verified domain. It goes in a path. */
export const MICROSOFT_TENANT_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|(?!.*\.\.)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})$/i;
export const microsoftAuthorizeUrl = (authority: string) =>
  `${MICROSOFT_AUTHORIZE_HOST}/${encodeURIComponent(authority)}/oauth2/v2.0/authorize`;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** 32 random bytes, base64url without padding. */
const STATE_NONCE = '[A-Za-z0-9_-]{43}';
const STATE_PATTERN = new RegExp(`^(${UUID})\\.(${UUID})\\.(${STATE_NONCE})$`);

/**
 * `<organization id>.<authorization id>.<32 random bytes>`. The callback reads the tenant from it only to
 * open the tenant transaction. Everything else is checked against the stored hash.
 */
export function formatOAuthState(organizationId: string, authorizationId: string, nonce: Buffer) {
  if (nonce.length !== 32) throw new Error('OAUTH_STATE_NONCE_INVALID');
  const state = `${organizationId}.${authorizationId}.${nonce.toString('base64url')}`;
  if (!STATE_PATTERN.test(state)) throw new Error('OAUTH_STATE_INVALID');
  return state;
}

/** Null for anything that is not exactly a state we could have made. */
export function parseOAuthState(
  state: unknown,
): { organizationId: string; authorizationId: string } | null {
  if (typeof state !== 'string' || state.length > 200) return null;
  const match = STATE_PATTERN.exec(state);
  if (!match) return null;
  return { organizationId: match[1]!, authorizationId: match[2]! };
}

/** What the row keeps: the state's SHA-256, hex. Compare it in constant time. */
export const oauthStateSha256 = (state: string) =>
  createHash('sha256').update(state, 'utf8').digest('hex');

/** RFC 7636: 43 to 128 unreserved characters. */
export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/** RFC 7636 S256: base64url of the verifier's SHA-256, without padding. */
export function pkceChallenge(verifier: string): string {
  if (!PKCE_VERIFIER_PATTERN.test(verifier)) throw new Error('PKCE_VERIFIER_INVALID');
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** What each sealed value is for. The broker refuses to open one for anything else. */
export const SECRET_PURPOSE_OAUTH_AUTHORIZATION_CODE = 'oauth_authorization_code';
export const SECRET_PURPOSE_OAUTH_PKCE_VERIFIER = 'oauth_pkce_verifier';
export const SECRET_PURPOSE_OAUTH_CUSTOMER_CLIENT = 'oauth_customer_client';
/** The sealed values a consent attempt makes, and so the ones the sweep looks after. */
export const OAUTH_ATTEMPT_SECRET_PURPOSES = [
  SECRET_PURPOSE_OAUTH_PKCE_VERIFIER,
  SECRET_PURPOSE_OAUTH_AUTHORIZATION_CODE,
  SECRET_PURPOSE_OAUTH_CUSTOMER_CLIENT,
] as const;

/**
 * How old a sealed attempt value may be with no attempt naming it before the sweep revokes it. A start
 * seals its verifier and client before it inserts the row, so a start refused after sealing leaves them
 * named by nothing. Longer than the ten-minute window, so a start still under way is never caught.
 */
export const OAUTH_ORPHAN_SECRET_AFTER_MS = 15 * 60_000;

/** One sealed attempt value that is not yet revoked: what the broker can say without opening it. */
export type LiveAttemptSecret = { id: string; purpose: string; createdAt: Date };

/**
 * Which live attempt values to revoke (ADR-038 D1). One an attempt in a final status names is spent,
 * whichever way the attempt ended. One no attempt names, past OAUTH_ORPHAN_SECRET_AFTER_MS, came from a
 * start that never wrote its row. One an attempt still under way names is left alone.
 */
export function attemptSecretsToRevoke(input: {
  live: readonly LiveAttemptSecret[];
  /** The status of the attempt naming each secret, for every live secret some attempt names. */
  namedBy: ReadonlyMap<string, OAuthStatus>;
  now: Date;
}): string[] {
  const purposes: readonly string[] = OAUTH_ATTEMPT_SECRET_PURPOSES;
  return input.live
    .filter((secret) => {
      if (!purposes.includes(secret.purpose)) return false;
      const status = input.namedBy.get(secret.id);
      if (status !== undefined) return isSettledOAuth(status);
      return input.now.getTime() - secret.createdAt.getTime() >= OAUTH_ORPHAN_SECRET_AFTER_MS;
    })
    .map((secret) => secret.id);
}

/**
 * The cookie that binds a callback to the browser that started the consent, beside the signed-in member
 * (ADR-038 D1). `__Host-` makes the browser refuse it unless it is Secure, host-only and on `/`. It lives
 * as long as the attempt does.
 */
export const OAUTH_BROWSER_COOKIE = '__Host-ensemus_oauth';
export const OAUTH_BROWSER_COOKIE_MAX_AGE_SECONDS = OAUTH_STATE_TTL_SECONDS;

/**
 * What the cookie holds: a SHA-256 of the state, under its own label so it is never the value the row
 * keeps. Holding the state's hash proves the browser saw the start's answer, and says nothing of the state.
 */
export const oauthBrowserBinding = (state: string) =>
  createHash('sha256').update('ensemus.oauth.browser:', 'utf8').update(state, 'utf8').digest('hex');

/**
 * Transaction settings the 0561 triggers read. Each names the one row the transaction may act for, and is
 * honoured only in a service context: the exchange's attempt, and the directory pass's connection.
 */
export const OAUTH_EXCHANGE_SETTING = 'ensemus.oauth_exchange';
export const DIRECTORY_SYNC_SETTING = 'ensemus.directory_sync';

/**
 * What 0561 raises, by SQLSTATE. EN121: a consent attempt, or a member's own connection, that could not
 * have started this way. EN122: a consent attempt moving in a way ADR-038 D1 does not allow. EN123: a
 * directory team, its members or its group changed by anything but its own directory pass. 0562 adds
 * EN124: a sealed value replaced other than by the broker resealing a live connector credential in place.
 */
export const SUITE_SQLSTATES = {
  oauthStartRefused: 'EN121',
  oauthTransitionRefused: 'EN122',
  directoryTeamSyncOnly: 'EN123',
  credentialResealRefused: 'EN124',
} as const;

// --- Events. Payloads are IDs only, and the dispatcher works from the type and aggregate ID alone.

export const AGGREGATE_OAUTH_AUTHORIZATION = 'oauth_authorization';
/** The callback stored the code. The dispatcher starts the exchange on the connector queue. */
export const OAUTH_AUTHORIZATION_CODE_RECEIVED = 'oauth_authorization.code_received';
/** Facts for the connections page. Nothing outside PostgreSQL consumes these yet. */
export const OAUTH_AUTHORIZATION_CONNECTED = 'oauth_authorization.connected';
export const OAUTH_AUTHORIZATION_FAILED = 'oauth_authorization.failed';
/**
 * The web tier ended an attempt `denied` or `expired`. The dispatcher starts the suite upkeep for the
 * tenant, so the attempt's sealed verifier and client are revoked now rather than at the next sweep.
 */
export const OAUTH_AUTHORIZATION_ENDED = 'oauth_authorization.ended';
export const oauthAuthorizationRef = (id: string) => `oauth_authorization:${id}`;

// --- Directory (ADR-038 D4).

/** The stream a directory pass reads, beside a connection's file streams. */
export const DIRECTORY_STREAM = 'directory_groups';
/** Nested groups are flattened this many levels down, and cycles are cut. */
export const DIRECTORY_MAX_NESTING = 5;
/** Generous for one page, and small enough that one transaction stays short. */
export const DIRECTORY_MAX_GROUPS_PER_PAGE = 200;
export const DIRECTORY_MAX_MEMBERS_PER_GROUP = 5000;
export const DIRECTORY_MAX_ID_LENGTH = 1024;
export const DIRECTORY_MAX_NAME_LENGTH = 500;

/**
 * How long a directory is believed without a completed full pass (ADR-038 D4). Past it, or once its last
 * pass failed, its teams lose the members it gave them, so a group grant reaches nobody until a full pass
 * says who is in each group again. A Microsoft directory starts a full pass well inside this.
 */
export const DIRECTORY_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a connection's directory may still be believed, from its directory stream's cursor row: when
 * the last full pass completed, the stream's state, and when that state was written.
 *
 * Not fresh means every directory team whose members were last written at or before `emptyThrough` loses
 * them: those written before the failure when the last pass failed, and those older than the bound
 * otherwise. Members written since came from a pass that read the provider after that, so they stay.
 * `restart` asks for a new full pass, because an incremental one would only restore the groups it happened
 * to change.
 */
export function directoryFreshness(input: {
  lastFullPassAt: Date | null;
  state: string;
  stateAt: Date;
  now: Date;
}): { fresh: true } | { fresh: false; emptyThrough: Date; restart: boolean } {
  const bound = new Date(input.now.getTime() - DIRECTORY_STALE_AFTER_MS);
  if (input.state === 'failed') {
    return {
      fresh: false,
      emptyThrough: input.stateAt.getTime() > bound.getTime() ? input.stateAt : bound,
      restart: true,
    };
  }
  if (input.lastFullPassAt === null || input.lastFullPassAt.getTime() < bound.getTime()) {
    return { fresh: false, emptyThrough: bound, restart: false };
  }
  return { fresh: true };
}

export type DirectoryMember = { kind: 'user' | 'group'; externalId: string };

/**
 * One provider group as a page reports it. A user member's `externalId` is their email, which is how
 * they are matched to people here. A group member's is that group's own external ID, flattened later.
 */
export type DirectoryGroup = {
  externalId: string;
  displayName: string;
  members: readonly DirectoryMember[];
};

/** One page of a directory pass. It commits whole, with the cursor it moves to, like a sync page. */
export type DirectoryPage = {
  groups: readonly DirectoryGroup[];
  /** Gone at the provider, for providers that report it. A full pass finds the rest by absence. */
  deletedExternalIds: readonly string[];
  /** Opaque, and kept only in PostgreSQL. */
  nextCursor: string | null;
  hasMore: boolean;
  /** This page belongs to a full pass, so a group a completed one did not see has gone. */
  fullSync: boolean;
};

const isText = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && !/\p{Cc}/u.test(value);

/** Whether a page is one a directory stream could have produced. Each group appears once. */
export function isValidDirectoryPage(page: DirectoryPage, maxCursorLength = 8192): boolean {
  if (!Array.isArray(page.groups) || page.groups.length > DIRECTORY_MAX_GROUPS_PER_PAGE)
    return false;
  if (
    !Array.isArray(page.deletedExternalIds) ||
    page.deletedExternalIds.length > DIRECTORY_MAX_GROUPS_PER_PAGE
  )
    return false;
  if (page.nextCursor !== null && !isText(page.nextCursor, maxCursorLength)) return false;
  if (typeof page.hasMore !== 'boolean' || typeof page.fullSync !== 'boolean') return false;
  if (!page.deletedExternalIds.every((id) => isText(id, DIRECTORY_MAX_ID_LENGTH))) return false;
  for (const group of page.groups) {
    if (
      !isText(group.externalId, DIRECTORY_MAX_ID_LENGTH) ||
      !isText(group.displayName, DIRECTORY_MAX_NAME_LENGTH) ||
      !Array.isArray(group.members) ||
      group.members.length > DIRECTORY_MAX_MEMBERS_PER_GROUP ||
      !group.members.every(
        (member: DirectoryMember) =>
          (member.kind === 'user' || member.kind === 'group') &&
          isText(member.externalId, DIRECTORY_MAX_ID_LENGTH),
      )
    )
      return false;
  }
  const ids = [...page.groups.map((group) => group.externalId), ...page.deletedExternalIds];
  return new Set(ids).size === ids.length;
}
