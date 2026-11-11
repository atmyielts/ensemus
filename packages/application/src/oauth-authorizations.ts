// Connecting Google Workspace and Microsoft 365 by consent (CONNECT-07, ADR-038 D1, D2). The web half starts
// an attempt and stores what the provider sends back, sealed. The worker half exchanges the code. Both
// halves share one role, so migration 0561 holds the state machine and who may move it.
//
// The web half never unseals anything. It seals the PKCE verifier, a customer's own client and the code as
// each arrives, and keeps only the state's hash, so nothing in its rows can be replayed.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  appendAudit,
  oauthAuthorizations,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { driveConnectorConfigSchema } from '@ensemus/contracts/knowledge';
import { isSafeConnectorConfig } from '@ensemus/domain/connector';
import { can } from '@ensemus/domain/policy';
import {
  AGGREGATE_OAUTH_AUTHORIZATION,
  CAPABILITY_OWNER,
  deniedCodeFor,
  formatOAuthState,
  GOOGLE_AUTHORIZE_URL,
  isOAuthErrorCode,
  isSuiteConnectorType,
  MICROSOFT_PLATFORM_AUTHORITY,
  MICROSOFT_TENANT_PATTERN,
  microsoftAuthorizeUrl,
  OAUTH_AUTHORIZATION_CODE_RECEIVED,
  OAUTH_AUTHORIZATION_ENDED,
  OAUTH_CALLBACK_PATH,
  OAUTH_STATE_TTL_SECONDS,
  oauthAuthorizationRef,
  oauthBrowserBinding,
  oauthStateSha256,
  parseOAuthState,
  pkceChallenge,
  scopesFor,
  SECRET_PURPOSE_OAUTH_AUTHORIZATION_CODE,
  SECRET_PURPOSE_OAUTH_CUSTOMER_CLIENT,
  SECRET_PURPOSE_OAUTH_PKCE_VERIFIER,
  SUITE_CAPABILITIES,
  SUITE_PROVIDER,
  type OAuthClientKind,
  type OAuthErrorCode,
  type OAuthStatus,
  type SuiteCapability,
  type SuiteConnectorType,
  type SuiteProvider,
} from '@ensemus/domain/workspace-suites';
import { desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, foreignReference, pgCode } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import { assertInteractivePrivilege, withPrivilegeTx } from './product/privileged';

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

export type StartedAuthorization = {
  authorizationId: string;
  authorizeUrl: string;
  /**
   * What the starting browser keeps in OAUTH_BROWSER_COOKIE, so the callback is bound to that browser as
   * well as to the member (ADR-038 D1). A hash of the state, never the state.
   */
  browserBinding: string;
};

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

// The worker's half lives in oauth-exchange.ts, so the two halves are written and reviewed apart.
export type { CompleteExchangeInput, SealedCredential } from './oauth-exchange';

// --- The web half (CONNECT-07). Starting a consent, and storing what the provider sends back.

const FOREIGN_KEY_VIOLATION = '23503';
/** 0561's refusals of a start that could not have been made this way, and of a move it does not allow. */
const START_REFUSED = 'EN121';
const TRANSITION_REFUSED = 'EN122';
/** The most recent attempts are what the connections page shows. Older ones stay as the record. */
const LIST_LIMIT = 50;

const noControl = (value: string) => !/\p{Cc}/u.test(value);
const displayNameSchema = z.string().trim().min(1).max(120).refine(noControl);
const clientIdSchema = z.string().trim().min(1).max(512).refine(noControl);
const clientSecretSchema = z.string().min(1).max(2048).refine(noControl);

type OAuthRow = typeof oauthAuthorizations.$inferSelect;

/** One answer for every way a callback can fail, so the response tells an attacker nothing (ADR-038 D1). */
const stateInvalid = () => new AppError('OAUTH_STATE_INVALID');

/** RFC 7636's verifier: 32 random bytes as base64url, which is 43 characters from its alphabet. */
export function newPkceVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Whether a state is the one whose SHA-256 the row keeps. The comparison is on the two hashes, in constant
 * time, so neither the stored value nor how much of it matched can leak through timing.
 */
export function stateMatchesHash(state: string, storedSha256: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(storedSha256)) return false;
  return timingSafeEqual(
    Buffer.from(oauthStateSha256(state), 'hex'),
    Buffer.from(storedSha256, 'hex'),
  );
}

/**
 * Whether a callback came back to the browser that started the consent: the cookie it was given holds
 * oauthBrowserBinding of this state. Compared in constant time. A missing cookie, or one of any other
 * shape, is a mismatch, which the callback answers OAUTH_STATE_INVALID like every other failure.
 */
export function browserBindingMatches(cookie: string | null | undefined, state: string): boolean {
  if (typeof cookie !== 'string' || !/^[0-9a-f]{64}$/.test(cookie)) return false;
  return timingSafeEqual(
    Buffer.from(oauthBrowserBinding(state), 'hex'),
    Buffer.from(cookie, 'hex'),
  );
}

export type AuthorizeRequest = {
  connectorType: SuiteConnectorType;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  /** A customer's own Microsoft app's directory. Absent for the operator's app, and always for Google. */
  microsoftTenant?: string;
};

// Spaces as %20 rather than +, which both providers read, while + is read as a space only by convention.
const queryOf = (params: ReadonlyArray<readonly [string, string]>) =>
  params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');

/**
 * The provider's own consent page, as ADR-038 D1 asks for it. Checked against Google's OAuth 2.0 for web
 * server apps and Microsoft's v2.0 authorization code flow on 2026-11-11; unqualified until the owner
 * runs it against test tenants.
 */
export function authorizeUrlFor(request: AuthorizeRequest): string {
  const common = [
    ['client_id', request.clientId],
    ['redirect_uri', request.redirectUri],
    ['response_type', 'code'],
    ['scope', request.scopes.join(' ')],
    ['state', request.state],
    ['code_challenge', request.codeChallenge],
    ['code_challenge_method', 'S256'],
  ] as const;
  if (request.connectorType === 'google_workspace') {
    if (request.microsoftTenant !== undefined) throw new AppError('INVALID_INPUT');
    // Offline so a refresh token comes back, and consent so it comes back even for an account that agreed
    // before. include_granted_scopes is left off, so the grant is exactly this request and no earlier one.
    return `${GOOGLE_AUTHORIZE_URL}?${queryOf([
      ...common,
      ['access_type', 'offline'],
      ['prompt', 'consent'],
    ])}`;
  }
  const tenant = request.microsoftTenant;
  if (tenant !== undefined && !MICROSOFT_TENANT_PATTERN.test(tenant)) {
    throw new AppError('INVALID_INPUT');
  }
  // The operator's app is multi-tenant and consents through `organizations`. A customer's own app consents
  // through its own directory. The code comes back in the query, which is all the callback reads.
  return `${microsoftAuthorizeUrl(tenant ?? MICROSOFT_PLATFORM_AUTHORITY)}?${queryOf([
    ...common,
    ['response_mode', 'query'],
  ])}`;
}

/**
 * A suite connection's settings, as the Drive and SharePoint connectors read them: which drives, by ID, or
 * none for every drive the account can see. Null for anything else, so nothing reaches the row unchecked.
 */
export function suiteConfigOf(config: unknown): { drive_ids: string[] } | null {
  if (!isSafeConnectorConfig(config)) return null;
  const parsed = driveConnectorConfigSchema.safeParse(
    Object.keys(config).length === 0 ? { drive_ids: [] } : config,
  );
  return parsed.success ? { drive_ids: [...new Set(parsed.data.drive_ids)] } : null;
}

function viewOf(row: OAuthRow, now: Date = new Date()): OAuthAuthorizationView {
  const status = row.status as OAuthStatus;
  return {
    id: row.id,
    connectorType: row.connectorType as SuiteConnectorType,
    displayName: row.displayName,
    clientKind: row.clientKind as OAuthClientKind,
    capabilities: row.requestedCapabilities as SuiteCapability[],
    scopes: row.requestedScopes,
    // An attempt nobody finished is over at its expiry, whether or not anything has recorded that yet.
    status: status === 'pending' && row.expiresAt.getTime() <= now.getTime() ? 'expired' : status,
    // Only codes from the fixed list are ever shown. Anything else reads as a plain provider error.
    errorCode:
      row.errorCode === null
        ? null
        : isOAuthErrorCode(row.errorCode)
          ? row.errorCode
          : 'OAUTH_PROVIDER_ERROR',
    connectionId: row.connectionId,
    ownerMembershipId: row.ownerMembershipId,
    startedByMembershipId: row.startedByMembershipId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A person, in their own session, who may manage connections. An agent or a worker never starts one. */
function requireStarter(context: TenantContext) {
  if (context.actorType !== 'user' || !can(context.role, 'connection.manage')) {
    throw new AppError('FORBIDDEN');
  }
}

type ResolvedClient = {
  kind: OAuthClientKind;
  clientId: string;
  microsoftTenant?: string;
  /** The customer's own app as one value, to be sealed. Null for the operator's. */
  sealedValue: string | null;
};

function resolveClient(
  provider: SuiteProvider,
  client: StartAuthorizationInput['client'],
  web: OAuthWebSide,
): ResolvedClient {
  if (client.kind === 'platform') {
    const clientId = web.platformClientId(provider);
    if (!clientId) throw new AppError('OAUTH_CLIENT_NOT_CONFIGURED');
    return { kind: 'platform', clientId, sealedValue: null };
  }
  if (client.kind !== 'customer') throw new AppError('INVALID_INPUT');
  const clientId = clientIdSchema.safeParse(client.clientId);
  const clientSecret = clientSecretSchema.safeParse(client.clientSecret);
  if (!clientId.success || !clientSecret.success) throw new AppError('INVALID_INPUT');
  // Google has no directory in the URL. A customer's own Microsoft app consents through its directory,
  // and its token request needs that directory too, so it is sealed with the client.
  const tenant = client.tenant;
  const tenantFits =
    provider === 'google'
      ? tenant === undefined
      : tenant !== undefined && MICROSOFT_TENANT_PATTERN.test(tenant);
  if (!tenantFits) throw new AppError('INVALID_INPUT');
  return {
    kind: 'customer',
    clientId: clientId.data,
    ...(tenant !== undefined ? { microsoftTenant: tenant } : {}),
    sealedValue: JSON.stringify({
      client_id: clientId.data,
      client_secret: clientSecret.data,
      ...(tenant !== undefined ? { tenant } : {}),
    }),
  };
}

/** connection.manage, interactively. Inserts a `pending` attempt and answers the provider's page. */
export async function startAuthorization(
  database: AppDatabase,
  context: TenantContext,
  input: StartAuthorizationInput,
  web: OAuthWebSide,
): Promise<StartedAuthorization> {
  requireStarter(context);
  if (!isSuiteConnectorType(input.connectorType)) throw new AppError('INVALID_INPUT');
  const name = displayNameSchema.safeParse(input.displayName);
  if (!name.success) throw new AppError('INVALID_INPUT');
  const config = suiteConfigOf(input.config);
  if (!config) throw new AppError('INVALID_INPUT');
  const capabilities: readonly SuiteCapability[] = input.capabilities;
  if (
    !Array.isArray(input.capabilities as unknown) ||
    !capabilities.every((capability) =>
      (SUITE_CAPABILITIES as readonly string[]).includes(capability),
    )
  ) {
    throw new AppError('INVALID_INPUT');
  }
  const scopes = scopesFor(input.connectorType, capabilities);
  // A member's own mail and calendar arrive with personal connections (ADR-038 D5). Until then every
  // consent here makes the organization's connection, so it can never carry a member's capability.
  if (!scopes || capabilities.some((capability) => CAPABILITY_OWNER[capability] === 'member')) {
    throw new AppError('OAUTH_CAPABILITY_UNAVAILABLE');
  }
  const client = resolveClient(SUITE_PROVIDER[input.connectorType], input.client, web);
  if (new URL(web.redirectUri).pathname !== OAUTH_CALLBACK_PATH) {
    // A deployment fault, not the caller's: providers match the registered address exactly.
    throw new Error('OAUTH_REDIRECT_URI_INVALID');
  }

  // Before anything is sealed, so someone refused leaves nothing behind. The insert checks again in its
  // own transaction, and 0561's trigger a third time.
  await withPrivilegeTx(database, context, (tx) =>
    assertInteractivePrivilege(tx, context, 'connection.manage'),
  );

  const id = randomUUID();
  const state = formatOAuthState(context.organizationId, id, randomBytes(32));
  const verifier = newPkceVerifier();
  const authorizeUrl = authorizeUrlFor({
    connectorType: input.connectorType,
    clientId: client.clientId,
    redirectUri: web.redirectUri,
    scopes,
    state,
    codeChallenge: pkceChallenge(verifier),
    ...(client.microsoftTenant !== undefined ? { microsoftTenant: client.microsoftTenant } : {}),
  });
  const verifierSecretId = await web.seal(
    SECRET_PURPOSE_OAUTH_PKCE_VERIFIER,
    Buffer.from(verifier, 'ascii'),
  );
  const customerClientSecretId =
    client.sealedValue === null
      ? null
      : await web.seal(
          SECRET_PURPOSE_OAUTH_CUSTOMER_CLIENT,
          Buffer.from(client.sealedValue, 'utf8'),
        );

  try {
    await withPrivilegeTx(database, context, async (tx) => {
      await assertInteractivePrivilege(tx, context, 'connection.manage');
      await tx.insert(oauthAuthorizations).values({
        organizationId: context.organizationId,
        id,
        connectorType: input.connectorType,
        displayName: name.data,
        config,
        clientKind: client.kind,
        clientId: client.clientId,
        customerClientSecretId,
        requestedCapabilities: [...capabilities],
        requestedScopes: [...scopes],
        ownerMembershipId: null,
        startedByMembershipId: context.membershipId,
        stateSha256: oauthStateSha256(state),
        verifierSecretId,
        // The database sets its own ten minutes from its own clock, whatever is sent here.
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_SECONDS * 1000),
      });
      await appendAudit(tx, {
        organizationId: context.organizationId,
        actorType: 'user',
        actorId: context.membershipId,
        action: 'oauth_authorization.started',
        targetRef: oauthAuthorizationRef(id),
        decision: 'allow',
      });
    });
  } catch (error) {
    // The keys are composite, so another tenant's sealed value fails the same as one that never was.
    if (pgCode(error) === FOREIGN_KEY_VIOLATION) throw foreignReference();
    if (pgCode(error) === START_REFUSED) throw new AppError('FORBIDDEN');
    throw error;
  }
  return { authorizationId: id, authorizeUrl, browserBinding: oauthBrowserBinding(state) };
}

type CallbackOutcome = { kind: 'invalid' } | { kind: 'done'; status: OAuthStatus };

/**
 * The callback, in the session of the member who started it. Every failure of tenant, member, state,
 * status or expiry is the same OAUTH_STATE_INVALID. Seals the code, moves to `code_received` and emits
 * OAUTH_AUTHORIZATION_CODE_RECEIVED in one transaction, or records `denied` with a fixed code.
 */
export async function receiveCallback(
  database: AppDatabase,
  context: TenantContext,
  input: CallbackInput,
  web: Pick<OAuthWebSide, 'seal'>,
): Promise<CallbackResult> {
  const parsed = parseOAuthState(input.state);
  // The tenant in the state only chose where to look. Everything else is checked against the row.
  if (!parsed || parsed.organizationId !== context.organizationId || context.actorType !== 'user') {
    throw stateInvalid();
  }
  let outcome: CallbackOutcome;
  try {
    outcome = await withPrivilegeTx(database, context, (tx) =>
      settleCallback(tx, context, parsed.authorizationId, input, web),
    );
  } catch (error) {
    // Two callbacks racing for one attempt: the loser finds it already moved.
    if (pgCode(error) === TRANSITION_REFUSED) throw stateInvalid();
    throw error;
  }
  if (outcome.kind === 'invalid') throw stateInvalid();
  return { authorizationId: parsed.authorizationId, status: outcome.status };
}

async function settleCallback(
  tx: Tx,
  context: TenantContext,
  authorizationId: string,
  input: CallbackInput,
  web: Pick<OAuthWebSide, 'seal'>,
): Promise<CallbackOutcome> {
  const [found] = await tx
    .select({
      row: getTableColumns(oauthAuthorizations),
      // The database's clock, which is the one 0561 holds the code's arrival to.
      live: sql<boolean>`${oauthAuthorizations.expiresAt} > now()`,
    })
    .from(oauthAuthorizations)
    .where(eq(oauthAuthorizations.id, authorizationId))
    .for('update');
  if (
    !found ||
    !stateMatchesHash(input.state, found.row.stateSha256) ||
    found.row.startedByMembershipId !== context.membershipId ||
    // Someone whose role changed since they started may no longer attach an account for everyone.
    (found.row.ownerMembershipId === null && !can(context.role, 'connection.manage')) ||
    found.row.status !== 'pending'
  ) {
    return { kind: 'invalid' };
  }
  const where = eq(oauthAuthorizations.id, authorizationId);
  const audit = (action: string, decision: 'allow' | 'deny', safeReason?: string) =>
    appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action,
      targetRef: oauthAuthorizationRef(authorizationId),
      decision,
      ...(safeReason ? { safeReason } : {}),
    });

  if (!found.live) {
    // Recorded, so the page says so, and then refused like any other bad state.
    await tx.update(oauthAuthorizations).set({ status: 'expired' }).where(where);
    await emitEnded(tx, context, authorizationId);
    return { kind: 'invalid' };
  }

  // A provider's error, Microsoft's admin consent refused, or no code at all. Its text is never kept.
  if (input.error !== undefined || input.adminConsent === false || input.code === undefined) {
    const errorCode: OAuthErrorCode =
      input.error !== undefined
        ? deniedCodeFor(input.error)
        : input.adminConsent === false
          ? 'OAUTH_CONSENT_REQUIRED'
          : 'OAUTH_PROVIDER_ERROR';
    await tx.update(oauthAuthorizations).set({ status: 'denied', errorCode }).where(where);
    await emitEnded(tx, context, authorizationId);
    await audit('oauth_authorization.denied', 'deny', errorCode);
    return { kind: 'done', status: 'denied' };
  }

  // Sealed only now that the state is known to be this person's, and while the row is still locked.
  const codeSecretId = await web.seal(
    SECRET_PURPOSE_OAUTH_AUTHORIZATION_CODE,
    Buffer.from(input.code, 'utf8'),
  );
  await tx.update(oauthAuthorizations).set({ status: 'code_received', codeSecretId }).where(where);
  await emit(tx, context, {
    eventType: OAUTH_AUTHORIZATION_CODE_RECEIVED,
    aggregateType: AGGREGATE_OAUTH_AUTHORIZATION,
    aggregateId: authorizationId,
    aggregateVersion: 1,
    classification: 'internal',
    payload: { authorizationId },
  });
  await audit('oauth_authorization.code_received', 'allow');
  return { kind: 'done', status: 'code_received' };
}

/**
 * Says the web tier ended an attempt `denied` or `expired`, in the transaction that did, so the
 * dispatcher starts the suite upkeep and the attempt's sealed verifier and client are revoked now rather
 * than at the next sweep. Both leave `pending`, the attempt's first step, so this is its second fact.
 */
async function emitEnded(tx: Tx, context: TenantContext, authorizationId: string) {
  await emit(tx, context, {
    eventType: OAUTH_AUTHORIZATION_ENDED,
    aggregateType: AGGREGATE_OAUTH_AUTHORIZATION,
    aggregateId: authorizationId,
    aggregateVersion: 2,
    classification: 'internal',
    payload: { authorizationId },
  });
}

/** Those who manage connections see every attempt. The person who started one always sees their own. */
export async function getAuthorization(
  database: AppDatabase,
  context: TenantContext,
  input: { authorizationId: string },
): Promise<OAuthAuthorizationView> {
  const id = idSchema.safeParse(input.authorizationId);
  if (!id.success) throw new AppError('NOT_FOUND');
  const [row] = await withPrivilegeTx(database, context, (tx) =>
    tx.select().from(oauthAuthorizations).where(eq(oauthAuthorizations.id, id.data)),
  );
  if (
    !row ||
    !(can(context.role, 'connection.manage') || row.startedByMembershipId === context.membershipId)
  ) {
    throw new AppError('NOT_FOUND');
  }
  return viewOf(row);
}

/** The most recent attempts, newest first, for those who manage connections. */
export async function listAuthorizations(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly OAuthAuthorizationView[]> {
  if (!can(context.role, 'connection.manage')) throw new AppError('FORBIDDEN');
  const rows = await withPrivilegeTx(database, context, (tx) =>
    tx
      .select()
      .from(oauthAuthorizations)
      .orderBy(desc(oauthAuthorizations.createdAt), desc(oauthAuthorizations.id))
      .limit(LIST_LIMIT),
  );
  const now = new Date();
  return rows.map((row) => viewOf(row, now));
}

export {
  attemptSecretStatuses,
  claimForExchange,
  completeExchange,
  expireAbandonedAttempts,
  failExchange,
} from './oauth-exchange';
