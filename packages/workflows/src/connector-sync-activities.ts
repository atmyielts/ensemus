// The connector worker's sync (CONNECT-01, ADR-027 D3). Takes IDs, works out what to do from PostgreSQL,
// and hands a connector one tenant's settings, a lease and, if it declared a need, the gateway. What a
// connector said, and what a query failed on, stay here: only codes and counters get out.
import {
  commitSyncPage,
  finishSyncStream,
  leaseSyncStream,
  loadConnectionForWorker,
  recordConnectionFailure,
  resolveSourcePrincipal,
  AppError,
  type SyncStreamLease,
} from '@ensemus/application';
import {
  SyncUnavailable,
  type Connector,
  type ConnectorContext,
  type PrincipalDirectory,
} from '@ensemus/connectors';
import { mapSourceGrants, runSyncPass, type SyncStore } from '@ensemus/connectors/runtime';
import type { TenantContext } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import type { SyncPage } from '@ensemus/domain/connector';
import { createLogger, errorCode } from '@ensemus/telemetry';
import type { ConnectorActivityDeps } from './connector-deps';
import {
  connectorSyncInputSchema,
  type ConnectorSyncInput,
  type ConnectorSyncOutcome,
} from './schemas';

const log = createLogger('connector-sync');

/** Pages per stream in one pass. The workflow holds the same number, and a test keeps them equal. */
export const SYNC_PAGES_PER_PASS = 20;
const SYNC_LEASE_MS = 5 * 60_000;
const nothing = (outcome: ConnectorSyncOutcome['outcome']): ConnectorSyncOutcome => ({
  outcome,
  pages: 0,
  resources: 0,
});

/** Thrown when the worker's own store fails. A retry may work, and no query text goes with it. */
class SyncStoreUnavailable extends Error {
  override name = 'SyncStoreUnavailable';
  constructor() {
    super('SYNC_STORE_UNAVAILABLE');
  }
}

function contextFor(
  deps: ConnectorActivityDeps,
  connector: Connector,
  connection: { id: string; config: unknown; credentialSecretId: string | null },
  organizationId: string,
): Omit<ConnectorContext, 'signal'> {
  const { credentialSecretId } = connection;
  const { purpose } = connector.manifest.credential;
  return {
    organizationId,
    connectionId: connection.id,
    config: connection.config,
    // The binding is this connection's own reference, read under this tenant, and the broker's seal
    // covers the tenant and purpose too, so there is no way to ask for anyone else's.
    credentials: {
      withCredential: (use) => {
        if (credentialSecretId === null) throw new Error('CREDENTIAL_UNAVAILABLE');
        return deps.secrets.withSecret(
          { organizationId, secretId: credentialSecretId, purpose },
          use,
        );
      },
    },
    network:
      connector.manifest.capabilities.network === 'egress_gateway'
        ? deps.network
        : {
            openRelay: async () => {
              throw new Error('NETWORK_NOT_DECLARED');
            },
          },
  };
}

function storeFor(
  deps: ConnectorActivityDeps,
  context: TenantContext,
  connectionId: string,
): SyncStore {
  const { database } = deps;
  const directory: PrincipalDirectory = {
    resolve: (principal) => resolveSourcePrincipal(database, context, principal),
  };
  return {
    lease: (stream, leaseMs) =>
      leaseSyncStream(database, context, { connectionId, stream, leaseMs }),
    async commitPage(state: SyncStreamLease, page: SyncPage) {
      const mappedGrants = [];
      for (const resource of page.resources) {
        mappedGrants.push(await mapSourceGrants(resource.acl, directory));
      }
      try {
        return await commitSyncPage(database, context, {
          connectionId,
          lease: state,
          page: { ...page, mappedGrants },
        });
      } catch (error) {
        // Such as a grant naming someone outside the tenant. Retrying the same page would not help.
        if (error instanceof AppError && error.code === 'INVALID_INPUT') {
          throw new SyncUnavailable('SYNC_PAGE_INVALID');
        }
        throw error;
      }
    },
    finish: (stream, outcome) =>
      finishSyncStream(database, context, { connectionId, stream, outcome }),
    markResyncRequired: (stream) =>
      finishSyncStream(database, context, {
        connectionId,
        stream,
        outcome: { resyncRequired: true },
      }),
  };
}

export function createConnectorSyncActivities(deps: ConnectorActivityDeps) {
  const { database } = deps;

  /** Stops every sealed value this connection held. Revoking one twice does no harm. */
  async function revokeSecrets(
    organizationId: string,
    connection: { credentialSecretId: string | null; signingSecretIds: readonly string[] },
  ) {
    const secretIds = [
      ...(connection.credentialSecretId ? [connection.credentialSecretId] : []),
      ...connection.signingSecretIds,
    ];
    for (const secretId of secretIds) await deps.secrets.revoke(organizationId, secretId);
    log.info('connector_sync.secrets_revoked', { organizationId, count: secretIds.length });
  }

  async function pass(input: ConnectorSyncInput): Promise<ConnectorSyncOutcome> {
    const { organizationId, connectionId } = input;
    const context = createServiceContext(organizationId);
    const connection = await loadConnectionForWorker(database, context, connectionId);
    if (!connection) return nothing('nothing_to_do');
    if (connection.state === 'revoked') {
      await revokeSecrets(organizationId, connection);
      return nothing('revoked');
    }
    if (connection.state !== 'active') return nothing('nothing_to_do');

    const connector = deps.registry.get(connection.connectorType);
    if (!connector?.sync || !connector.manifest.capabilities.sync) return nothing('nothing_to_do');

    let config: unknown;
    try {
      config = connector.parseConfig(connection.config);
    } catch {
      await recordConnectionFailure(database, context, { connectionId, code: 'CONFIG_INVALID' });
      return nothing('failed');
    }

    let result: Awaited<ReturnType<typeof runSyncPass>>;
    try {
      result = await runSyncPass({
        connector,
        context: contextFor(deps, connector, { ...connection, config }, organizationId),
        store: storeFor(deps, context, connectionId),
        maxPages: SYNC_PAGES_PER_PASS,
        leaseMs: SYNC_LEASE_MS,
      });
    } catch (error) {
      // A revoke landing between reading the row and taking a lease is the one refusal that is not an
      // outage. Anything else goes round again, below.
      if (!(error instanceof AppError) || error.code !== 'CONNECTION_NOT_ACTIVE') throw error;
      result = { streams: 0, pages: 0, resources: 0, failed: 0 };
    }

    // A connection.revoked arriving while this run is open starts nothing, because this run covers it.
    // So this looks again before it ends, or the sealed value could outlive the connection.
    const after = await loadConnectionForWorker(database, context, connectionId);
    if (after?.state === 'revoked') {
      await revokeSecrets(organizationId, after);
      return { outcome: 'revoked', pages: result.pages, resources: result.resources };
    }
    // Every stream held by another pass, or by a try of this one that died: this pass read nothing, and
    // saying `synced` would claim otherwise.
    if (result.streams === 0) return nothing('nothing_to_do');
    return {
      outcome: result.failed > 0 ? 'failed' : 'synced',
      pages: result.pages,
      resources: result.resources,
    };
  }

  return {
    /** One pass, bounded by page count. A revoked connection has its secret revoked instead. */
    async syncConnection(raw: ConnectorSyncInput): Promise<ConnectorSyncOutcome> {
      const input = connectorSyncInputSchema.parse(raw);
      try {
        const result = await pass(input);
        log.info('connector_sync.pass', {
          organizationId: input.organizationId,
          status: result.outcome,
          count: result.pages,
        });
        return result;
      } catch (error) {
        // Temporal keeps what is thrown, and a driver's message can hold a page's bound values.
        log.error('connector_sync.store_failed', {
          organizationId: input.organizationId,
          errorCode: errorCode(error),
        });
        throw new SyncStoreUnavailable();
      }
    },
  };
}
export type ConnectorSyncActivities = ReturnType<typeof createConnectorSyncActivities>;
