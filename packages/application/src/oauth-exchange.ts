// The worker's half of connecting by consent (CONNECT-07, ADR-038 D1). Only the connector worker's service
// context reaches these, and 0561 holds them to it as well, because the web and the worker share a role.
// Each one says what it did with IDs and codes. The code, the verifier, a client secret and a token never
// pass through here in the clear: the credential arrives sealed, and the rest arrive as references.
import { idSchema } from './ids';
import { randomUUID } from 'node:crypto';
import {
  appendAudit,
  connections,
  oauthAuthorizations,
  sealedSecrets,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { connectionRef } from '@ensemus/domain/external-action';
import {
  AGGREGATE_CONNECTION,
  CONNECTION_CREATED,
  CONNECTOR_SYNC_REQUESTED,
} from '@ensemus/domain/integration-events';
import {
  AGGREGATE_OAUTH_AUTHORIZATION,
  capabilityGranted,
  grantedScopesOf,
  isOAuthErrorCode,
  isSuiteConnectorType,
  OAUTH_AUTHORIZATION_CONNECTED,
  OAUTH_AUTHORIZATION_FAILED,
  OAUTH_EXCHANGE_SETTING,
  oauthAuthorizationRef,
  SUITE_CAPABILITIES,
  type OAuthClientKind,
  type OAuthErrorCode,
  type SuiteCapability,
} from '@ensemus/domain/workspace-suites';
import { eq, sql } from 'drizzle-orm';
import { AppError } from './errors';
import { emit } from './events';
import type { SecretLease } from './integration-ports';
import type { OAuthExchangeClaim } from './oauth-authorizations';

/** What sealSecret answers, as the worker made it. Stored as it comes, in the completing transaction. */
export type SealedCredential = {
  keyId: string;
  wrappedKey: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
};

export type CompleteExchangeInput = {
  authorizationId: string;
  /** The ID the credential was sealed under. The seal covers it, so it cannot be stored under another. */
  credentialSecretId: string;
  /**
   * `{client: 'platform', ...}` or a customer's own, per oauthCredentialSchema. Written in the same
   * transaction as the connection, so a refused or failed completion leaves no credential behind.
   */
  sealedCredential: SealedCredential;
  /** The connector's credential purpose, which the seal covers too. */
  credentialPurpose: string;
  /** What the provider reported, in CAPABILITY_SCOPES' spelling, before `granted ∩ requested`. */
  reportedScopes: readonly string[];
  /**
   * The ID token's email. Nothing stores it yet: 0560 gave the connection no column for it, and 0561
   * requires the connection's name and settings to be the attempt's own, so it cannot go there.
   */
  connectedAccount: string | null;
};

const uuid = idSchema;
const PURPOSE = /^[a-z][a-z0-9_]{1,63}$/;
type AuthorizationRow = typeof oauthAuthorizations.$inferSelect;

/** The attempt's fourth step (pending, code received, exchanging, settled), so its facts sort in order. */
const SETTLED_VERSION = 4;

function requireService(context: TenantContext) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
}

/** Spent once the exchange ends, whichever way: the code, the verifier and a customer's sealed client. */
function spentSecretIds(row: AuthorizationRow): string[] {
  return [row.codeSecretId, row.verifierSecretId, row.customerClientSecretId].filter(
    (id): id is string => id !== null,
  );
}

async function revokeAll(
  organizationId: string,
  secretIds: readonly string[],
  secrets: Pick<SecretLease, 'revoke'>,
) {
  for (const secretId of secretIds) await secrets.revoke(organizationId, secretId);
}

async function lockAttempt(tx: Tx, authorizationId: string) {
  const [row] = await tx
    .select({
      row: oauthAuthorizations,
      // The database's clock, which is the one 0561 checks the expiry against.
      expired: sql<boolean>`now() >= ${oauthAuthorizations.expiresAt}`,
    })
    .from(oauthAuthorizations)
    .where(eq(oauthAuthorizations.id, authorizationId))
    .for('update');
  return row ?? null;
}

/**
 * The worker's service context only. Locks the attempt and moves `code_received` to `exchanging`. An
 * attempt past its ten minutes moves to `expired` instead, and its code and verifier are revoked. Null
 * when there is nothing to exchange, because another run got there first.
 */
export async function claimForExchange(
  database: AppDatabase,
  context: TenantContext,
  input: { authorizationId: string },
  secrets: Pick<SecretLease, 'revoke'>,
): Promise<OAuthExchangeClaim | 'expired' | null> {
  requireService(context);
  if (!uuid.safeParse(input.authorizationId).success) return null;
  return withTenantTx(database, context, async (tx) => {
    const locked = await lockAttempt(tx, input.authorizationId);
    if (!locked || locked.row.status !== 'code_received') return null;
    const { row } = locked;
    if (locked.expired) {
      await tx
        .update(oauthAuthorizations)
        .set({ status: 'expired', updatedAt: sql`now()` })
        .where(eq(oauthAuthorizations.id, row.id));
      await appendAudit(tx, {
        organizationId: context.organizationId,
        actorType: 'system',
        action: 'oauth_authorization.expired',
        targetRef: oauthAuthorizationRef(row.id),
        decision: 'deny',
        safeReason: 'OAUTH_EXPIRED',
      });
      // Revoked before the commit: if the commit fails the values are useless anyway, never the reverse.
      await revokeAll(context.organizationId, spentSecretIds(row), secrets);
      return 'expired';
    }
    if (
      !isSuiteConnectorType(row.connectorType) ||
      (row.clientKind !== 'platform' && row.clientKind !== 'customer') ||
      row.codeSecretId === null
    )
      return null;
    await tx
      .update(oauthAuthorizations)
      .set({ status: 'exchanging', updatedAt: sql`now()` })
      .where(eq(oauthAuthorizations.id, row.id));
    return {
      authorizationId: row.id,
      connectorType: row.connectorType,
      displayName: row.displayName,
      config: row.config as Record<string, unknown>,
      clientKind: row.clientKind as OAuthClientKind,
      clientId: row.clientId,
      customerClientSecretId: row.customerClientSecretId,
      verifierSecretId: row.verifierSecretId,
      codeSecretId: row.codeSecretId,
      requestedScopes: [...row.requestedScopes],
      ownerMembershipId: row.ownerMembershipId,
      startedByMembershipId: row.startedByMembershipId,
    };
  });
}

/**
 * In one transaction naming the attempt in OAUTH_EXCHANGE_SETTING: stores the sealed credential, creates
 * the connection with `granted ∩ requested`, moves to `connected`, asks for the first sync, and revokes
 * the code and the verifier. When a chosen capability's scopes are missing nothing is stored, the attempt
 * ends through failExchange, and this refuses OAUTH_SCOPES_INSUFFICIENT.
 */
export async function completeExchange(
  database: AppDatabase,
  context: TenantContext,
  input: CompleteExchangeInput,
  secrets: Pick<SecretLease, 'revoke'>,
): Promise<{ connectionId: string }> {
  requireService(context);
  if (
    !uuid.safeParse(input.authorizationId).success ||
    !uuid.safeParse(input.credentialSecretId).success ||
    !PURPOSE.test(input.credentialPurpose)
  )
    throw new AppError('INVALID_INPUT');
  const done = await withTenantTx(database, context, async (tx) => {
    // 0561 lets the service context create a connection only for the attempt this names.
    await tx.execute(
      sql`select set_config(${OAUTH_EXCHANGE_SETTING}, ${input.authorizationId}, true)`,
    );
    const locked = await lockAttempt(tx, input.authorizationId);
    if (!locked || locked.row.status !== 'exchanging') throw new AppError('OAUTH_EXCHANGE_FAILED');
    const { row } = locked;
    if (!isSuiteConnectorType(row.connectorType)) throw new AppError('OAUTH_EXCHANGE_FAILED');
    const connectorType = row.connectorType;
    const granted = grantedScopesOf(input.reportedScopes, row.requestedScopes);
    const chosen = row.requestedCapabilities.filter((capability): capability is SuiteCapability =>
      (SUITE_CAPABILITIES as readonly string[]).includes(capability),
    );
    if (
      chosen.length !== row.requestedCapabilities.length ||
      !chosen.every((capability) => capabilityGranted(connectorType, capability, granted))
    )
      return null;

    await tx.insert(sealedSecrets).values({
      organizationId: context.organizationId,
      id: input.credentialSecretId,
      purpose: input.credentialPurpose,
      ...input.sealedCredential,
    });
    const connectionId = randomUUID();
    await tx.insert(connections).values({
      organizationId: context.organizationId,
      id: connectionId,
      connectorType,
      displayName: row.displayName,
      state: 'active',
      credentialSecretId: input.credentialSecretId,
      config: row.config,
      grantedScopes: [...granted],
      createdByMembershipId: row.startedByMembershipId,
      ownerMembershipId: row.ownerMembershipId,
    });
    await tx
      .update(oauthAuthorizations)
      .set({ status: 'connected', connectionId, updatedAt: sql`now()` })
      .where(eq(oauthAuthorizations.id, row.id));
    await emit(tx, context, {
      eventType: CONNECTION_CREATED,
      aggregateType: AGGREGATE_CONNECTION,
      aggregateId: connectionId,
      aggregateVersion: 1,
      classification: 'internal',
      payload: { connectionId },
    });
    // The first pass starts now, so a connection made by consent reads its files without anyone asking.
    await emit(tx, context, {
      eventType: CONNECTOR_SYNC_REQUESTED,
      aggregateType: AGGREGATE_CONNECTION,
      aggregateId: connectionId,
      aggregateVersion: 1,
      classification: 'internal',
      payload: { connectionId },
    });
    await emit(tx, context, {
      eventType: OAUTH_AUTHORIZATION_CONNECTED,
      aggregateType: AGGREGATE_OAUTH_AUTHORIZATION,
      aggregateId: row.id,
      aggregateVersion: SETTLED_VERSION,
      classification: 'internal',
      payload: { authorizationId: row.id, connectionId },
    });
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'system',
      action: 'oauth_authorization.connected',
      targetRef: oauthAuthorizationRef(row.id),
      decision: 'allow',
    });
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'system',
      action: 'connection.created',
      targetRef: connectionRef(connectionId),
      decision: 'allow',
    });
    await revokeAll(context.organizationId, spentSecretIds(row), secrets);
    return { connectionId };
  });
  if (done) return done;
  await failExchange(
    database,
    context,
    { authorizationId: input.authorizationId, errorCode: 'OAUTH_SCOPES_INSUFFICIENT' },
    secrets,
  );
  throw new AppError('OAUTH_SCOPES_INSUFFICIENT');
}

/**
 * Ends the attempt `failed` with a fixed code and revokes the code and the verifier. Safe to repeat: an
 * attempt that already settled keeps its status, and its spent values are revoked again, which does no
 * harm. The exchange itself never retries, but this does, so an attempt never stays `exchanging`.
 */
export async function failExchange(
  database: AppDatabase,
  context: TenantContext,
  input: { authorizationId: string; errorCode: OAuthErrorCode },
  secrets: Pick<SecretLease, 'revoke'>,
): Promise<void> {
  requireService(context);
  if (!uuid.safeParse(input.authorizationId).success || !isOAuthErrorCode(input.errorCode))
    throw new AppError('INVALID_INPUT');
  await withTenantTx(database, context, async (tx) => {
    const locked = await lockAttempt(tx, input.authorizationId);
    if (!locked) return;
    const { row } = locked;
    if (row.status === 'code_received' || row.status === 'exchanging') {
      await tx
        .update(oauthAuthorizations)
        .set({ status: 'failed', errorCode: input.errorCode, updatedAt: sql`now()` })
        .where(eq(oauthAuthorizations.id, row.id));
      await emit(tx, context, {
        eventType: OAUTH_AUTHORIZATION_FAILED,
        aggregateType: AGGREGATE_OAUTH_AUTHORIZATION,
        aggregateId: row.id,
        aggregateVersion: SETTLED_VERSION,
        classification: 'internal',
        payload: { authorizationId: row.id, errorCode: input.errorCode },
      });
      await appendAudit(tx, {
        organizationId: context.organizationId,
        actorType: 'system',
        action: 'oauth_authorization.failed',
        targetRef: oauthAuthorizationRef(row.id),
        decision: 'deny',
        safeReason: input.errorCode,
      });
    }
    // A pending attempt has no code yet and is the web tier's to end, so nothing of it is revoked here.
    if (row.status !== 'pending')
      await revokeAll(context.organizationId, spentSecretIds(row), secrets);
  });
}
