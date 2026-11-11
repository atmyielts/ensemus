// The code exchange, in the connector worker (CONNECT-07, ADR-038 D1, D2). Takes two IDs, reads and
// unseals what it needs itself, and answers an outcome and a connection ID. The code, the verifier, a
// client secret and the token live in this process's memory for one request, and every way out of here
// (a log line, an error, a row, a Temporal payload) carries IDs and codes only.
import { randomUUID } from 'node:crypto';
import {
  claimForExchange,
  completeExchange,
  failExchange,
  type OAuthExchangeClaim,
  type SealedCredential,
  type SecretLease,
} from '@ensemus/application';
import type { ProviderHttpClient } from '@ensemus/connectors/knowledge';
import {
  GOOGLE_WORKSPACE_MANIFEST,
  MICROSOFT_365_MANIFEST,
} from '@ensemus/connectors/knowledge-manifests';
import {
  exchangeAuthorizationCode,
  matchReportedScopes,
  type CodeExchangeResult,
  type OAuthRotationPort,
  type OAuthScopesPort,
} from '@ensemus/connectors/provider-oauth';
import type { PlatformOAuthClient, PlatformOAuthClients } from '@ensemus/connectors/suites';
import { connectionRef } from '@ensemus/domain/external-action';
import {
  isSuiteConnectorType,
  SECRET_PURPOSE_OAUTH_AUTHORIZATION_CODE,
  SECRET_PURPOSE_OAUTH_CUSTOMER_CLIENT,
  SECRET_PURPOSE_OAUTH_PKCE_VERIFIER,
  SUITE_PROVIDER,
  type SuiteConnectorType,
} from '@ensemus/domain/workspace-suites';
import {
  appendAudit,
  connections,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createLogger } from '@ensemus/telemetry';
import { eq, sql } from 'drizzle-orm';
import {
  credentialFor,
  customerClientSchema,
  ExchangeStopped,
  narrowedScopes,
  stopCodeOf,
  tokenAuthority,
} from './oauth-exchange-decisions';
import {
  oauthExchangeInputSchema,
  type OAuthExchangeInput,
  type OAuthExchangeOutcome,
} from './schemas';

const log = createLogger('oauth-exchange');

export type OAuthExchangeDeps = {
  database: AppDatabase;
  /** SecretBroker. The only way to the sealed code, verifier and customer client. */
  secrets: SecretLease;
  /** The provider client, with a gateway on `google_oauth` and `ms_login`. */
  http: ProviderHttpClient;
  /** The operator's apps, from this worker's configuration and nowhere else (ADR-038 D2). */
  platformClients: PlatformOAuthClients;
  /** sealSecret with this deployment's public key. Sealing needs no private key and no database. */
  seal(input: {
    organizationId: string;
    secretId: string;
    purpose: string;
    plaintext: string;
  }): SealedCredential;
  /** The deployment's public origin joined with OAUTH_CALLBACK_PATH: the one the authorize URL named. */
  redirectUri: string;
};

/** Thrown when PostgreSQL could not be reached. Carries no query text, so it is safe to cross Temporal. */
class ExchangeStoreUnavailable extends Error {
  override name = 'ExchangeStoreUnavailable';
  constructor() {
    super('OAUTH_EXCHANGE_STORE_UNAVAILABLE');
  }
}

const CREDENTIAL_PURPOSE: Readonly<Record<SuiteConnectorType, string>> = {
  google_workspace: GOOGLE_WORKSPACE_MANIFEST.credential.purpose,
  microsoft_365: MICROSOFT_365_MANIFEST.credential.purpose,
};

const text = (secret: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(secret);

export function createOAuthExchangeActivities(deps: OAuthExchangeDeps) {
  const { database } = deps;

  const lease = <T>(
    context: TenantContext,
    secretId: string,
    purpose: string,
    use: (secret: Buffer) => Promise<T>,
  ) => deps.secrets.withSecret({ organizationId: context.organizationId, secretId, purpose }, use);

  /**
   * Lends the app this attempt names. The operator's must be configured here with the same public ID the
   * authorize URL used. A customer's is unsealed, and must be the one the admin entered.
   */
  async function withClient<T>(
    context: TenantContext,
    claim: OAuthExchangeClaim,
    use: (client: PlatformOAuthClient, customer: { tenant?: string } | null) => Promise<T>,
  ): Promise<T> {
    if (claim.clientKind === 'platform') {
      const platform = deps.platformClients.get(SUITE_PROVIDER[claim.connectorType]);
      if (!platform || platform.client_id !== claim.clientId)
        throw new ExchangeStopped('OAUTH_CLIENT_NOT_CONFIGURED');
      return use(platform, null);
    }
    if (!claim.customerClientSecretId) throw new ExchangeStopped('OAUTH_CLIENT_NOT_CONFIGURED');
    let opened = false;
    try {
      return await lease(
        context,
        claim.customerClientSecretId,
        SECRET_PURPOSE_OAUTH_CUSTOMER_CLIENT,
        async (secret) => {
          opened = true;
          let customer;
          try {
            customer = customerClientSchema.parse(JSON.parse(text(secret)));
          } catch {
            throw new ExchangeStopped('OAUTH_CLIENT_NOT_CONFIGURED');
          }
          if (customer.client_id !== claim.clientId)
            throw new ExchangeStopped('OAUTH_CLIENT_NOT_CONFIGURED');
          return use(
            { client_id: customer.client_id, client_secret: customer.client_secret },
            customer.tenant ? { tenant: customer.tenant } : {},
          );
        },
      );
    } catch (error) {
      // A customer's sealed client that is gone or will not open is a client that is not configured.
      if (!opened) throw new ExchangeStopped('OAUTH_CLIENT_NOT_CONFIGURED');
      throw error;
    }
  }

  /** Unseal, redeem the code once, seal the credential, and complete in one transaction. */
  async function exchange(context: TenantContext, claim: OAuthExchangeClaim): Promise<string> {
    const provider = SUITE_PROVIDER[claim.connectorType];
    const credentialSecretId = randomUUID();
    const purpose = CREDENTIAL_PURPOSE[claim.connectorType];
    const sealed = await lease(
      context,
      claim.verifierSecretId,
      SECRET_PURPOSE_OAUTH_PKCE_VERIFIER,
      (verifier) =>
        lease(context, claim.codeSecretId, SECRET_PURPOSE_OAUTH_AUTHORIZATION_CODE, (code) =>
          withClient(context, claim, async (client, customer) => {
            const exchanged: CodeExchangeResult = await exchangeAuthorizationCode(deps.http, {
              provider,
              client,
              authority: tokenAuthority(claim.connectorType, claim.clientKind, customer?.tenant),
              code: text(code),
              verifier: text(verifier),
              redirectUri: deps.redirectUri,
              scopes: claim.requestedScopes,
              signal: AbortSignal.timeout(60_000),
            });
            const credential = credentialFor(
              claim.connectorType,
              customer
                ? {
                    kind: 'customer',
                    clientId: client.client_id,
                    clientSecret: client.client_secret,
                  }
                : { kind: 'platform' },
              exchanged,
            );
            return {
              reportedScopes: matchReportedScopes(
                provider,
                exchanged.reportedScopes,
                claim.requestedScopes,
              ),
              connectedAccount: exchanged.account,
              credential: deps.seal({
                organizationId: context.organizationId,
                secretId: credentialSecretId,
                purpose,
                plaintext: JSON.stringify(credential),
              }),
            };
          }),
        ),
    );
    const { connectionId } = await completeExchange(
      database,
      context,
      {
        authorizationId: claim.authorizationId,
        credentialSecretId,
        sealedCredential: sealed.credential,
        credentialPurpose: purpose,
        reportedScopes: sealed.reportedScopes,
        connectedAccount: sealed.connectedAccount,
      },
      deps.secrets,
    );
    return connectionId;
  }

  return {
    /**
     * Runs once (OAUTH_EXCHANGE_MAX_ATTEMPTS). Settles the attempt itself, connected or failed with a
     * code, and throws only when it could not reach PostgreSQL to say so, which the workflow answers by
     * abandoning the attempt.
     */
    async exchangeOAuthAuthorization(raw: OAuthExchangeInput): Promise<OAuthExchangeOutcome> {
      const input = oauthExchangeInputSchema.parse(raw);
      const context = createServiceContext(input.organizationId);
      let claim: Awaited<ReturnType<typeof claimForExchange>>;
      try {
        claim = await claimForExchange(
          database,
          context,
          { authorizationId: input.authorizationId },
          deps.secrets,
        );
      } catch {
        log.error('oauth_exchange.store_failed', { organizationId: input.organizationId });
        throw new ExchangeStoreUnavailable();
      }
      if (claim === null) return { outcome: 'already_settled', connectionId: null };
      if (claim === 'expired') {
        log.info('oauth_exchange.expired', { organizationId: input.organizationId });
        return { outcome: 'expired', connectionId: null };
      }
      try {
        const connectionId = await exchange(context, claim);
        log.info('oauth_exchange.connected', { organizationId: input.organizationId });
        return { outcome: 'connected', connectionId };
      } catch (error) {
        const code = stopCodeOf(error);
        log.warn('oauth_exchange.failed', {
          organizationId: input.organizationId,
          errorCode: code,
        });
        try {
          // Already done when completeExchange refused the scopes, and doing it again changes nothing.
          await failExchange(
            database,
            context,
            { authorizationId: claim.authorizationId, errorCode: code },
            deps.secrets,
          );
        } catch {
          log.error('oauth_exchange.store_failed', { organizationId: input.organizationId });
          throw new ExchangeStoreUnavailable();
        }
        return { outcome: 'failed', connectionId: null };
      }
    },

    /**
     * After the exchange gave no answer. Ends the attempt `failed` unless it already settled, and revokes
     * its spent values. Never reaches the provider, so retrying it is safe.
     */
    async abandonOAuthExchange(raw: OAuthExchangeInput): Promise<void> {
      const input = oauthExchangeInputSchema.parse(raw);
      try {
        await failExchange(
          database,
          createServiceContext(input.organizationId),
          { authorizationId: input.authorizationId, errorCode: 'OAUTH_EXCHANGE_FAILED' },
          deps.secrets,
        );
      } catch {
        log.error('oauth_exchange.store_failed', { organizationId: input.organizationId });
        throw new ExchangeStoreUnavailable();
      }
    },
  };
}
export type OAuthExchangeActivities = ReturnType<typeof createOAuthExchangeActivities>;

/**
 * Writes what a refresh reported into `connections.granted_scopes`, narrowing only (ADR-038 D3, 0561).
 * The connector worker hands this to the Google and Microsoft connectors' token sessions.
 */
export function createGrantedScopesRecorder(database: AppDatabase): OAuthScopesPort {
  return {
    async reported({ organizationId, connectionId, reportedScopes }) {
      const context = createServiceContext(organizationId);
      await withTenantTx(database, context, async (tx) => {
        const [row] = await tx
          .select({
            connectorType: connections.connectorType,
            grantedScopes: connections.grantedScopes,
            state: connections.state,
          })
          .from(connections)
          .where(eq(connections.id, connectionId))
          .for('update');
        if (!row || row.state !== 'active' || !isSuiteConnectorType(row.connectorType)) return;
        const stillReported = matchReportedScopes(
          SUITE_PROVIDER[row.connectorType],
          reportedScopes,
          row.grantedScopes,
        );
        const kept = narrowedScopes(row.connectorType, row.grantedScopes, stillReported);
        if (kept.length === row.grantedScopes.length) return;
        await tx
          .update(connections)
          .set({
            grantedScopes: [...kept],
            version: sql`${connections.version} + 1`,
            updatedAt: sql`now()`,
          })
          .where(eq(connections.id, connectionId));
        await appendAudit(tx, {
          organizationId,
          actorType: 'system',
          action: 'connection.scopes_narrowed',
          targetRef: connectionRef(connectionId),
          decision: 'allow',
        });
      });
    },
  };
}

/** What the rotation port needs of the broker: SecretBroker.reseal. */
export interface CredentialResealer {
  reseal(
    binding: { organizationId: string; secretId: string; purpose: string },
    expectedSha256: string,
    replacement: Buffer,
  ): Promise<'stored' | 'stale'>;
}

/**
 * Keeps the refresh token a provider rotated (Microsoft does on every refresh), by resealing the
 * connection's credential in place under the same secret ID (0562). The connection is read in the service
 * context to find that ID. A connection that is no longer an active suite connection, or has no
 * credential, answers stale, and so does a credential some other refresh already replaced: the broker
 * compares what this refresh read before it writes, under a row lock.
 */
export function createCredentialRotation(
  database: AppDatabase,
  secrets: CredentialResealer,
): OAuthRotationPort {
  return {
    async persist({ organizationId, connectionId, expectedCredentialSha256, replacement }) {
      const context = createServiceContext(organizationId);
      const connection = await withTenantTx(database, context, async (tx) => {
        const [row] = await tx
          .select({
            connectorType: connections.connectorType,
            credentialSecretId: connections.credentialSecretId,
            state: connections.state,
          })
          .from(connections)
          .where(eq(connections.id, connectionId));
        return row;
      });
      if (
        !connection ||
        connection.state !== 'active' ||
        !connection.credentialSecretId ||
        !isSuiteConnectorType(connection.connectorType)
      )
        return 'stale';
      return secrets.reseal(
        {
          organizationId,
          secretId: connection.credentialSecretId,
          purpose: CREDENTIAL_PURPOSE[connection.connectorType],
        },
        expectedCredentialSha256,
        replacement,
      );
    },
  };
}
