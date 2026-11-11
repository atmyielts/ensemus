// The connector worker's sync (CONNECT-01, ADR-027 D3). Takes IDs, works out what to do from PostgreSQL,
// and hands a connector one tenant's settings, a lease and, if it declared a need, the gateway. What a
// connector said, and what a query failed on, stay here: only codes and counters get out.
import {
  commitSyncPage,
  enforceDirectoryFreshness,
  finishSyncStream,
  leaseSyncStream,
  loadConnectionForWorker,
  recordConnectionFailure,
  removeConnectionDirectory,
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
import { hasDirectory } from '@ensemus/connectors/suites';
import type { TenantContext } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import type { SyncPage } from '@ensemus/domain/connector';
import { isSuiteConnectorType } from '@ensemus/domain/workspace-suites';
import { createLogger, errorCode } from '@ensemus/telemetry';
import type { ConnectorActivityDeps } from './connector-deps';
import { directoryWanted, runDirectoryPass, type DirectoryPassResult } from './directory-sync';
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
  connection: {
    id: string;
    config: unknown;
    credentialSecretId: string | null;
    grantedScopes: readonly string[];
  },
  organizationId: string,
): Omit<ConnectorContext, 'signal'> {
  const { credentialSecretId } = connection;
  const { purpose } = connector.manifest.credential;
  return {
    organizationId,
    connectionId: connection.id,
    config: connection.config,
    grantedScopes: [...connection.grantedScopes],
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
    // A group is looked up in this connection's own directory, which is what named it.
    resolve: (principal) => resolveSourcePrincipal(database, context, principal, { connectionId }),
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

  /**
   * A revoked connection's cleanup: its sealed values stop, then the teams its directory made go, in the
   * sync's own service context, which is the only one 0561 lets remove them (ADR-038 D4). Both are safe to
   * repeat, so a retried Activity does no harm.
   */
  async function cleanUpRevoked(
    context: TenantContext,
    connection: {
      id: string;
      credentialSecretId: string | null;
      signingSecretIds: readonly string[];
    },
  ) {
    await revokeSecrets(context.organizationId, connection);
    await dropDirectory(context, connection);
  }

  /**
   * Removes the teams a connection's directory made, once it is revoked or has lost the directory scopes.
   * removeConnectionDirectory reads both again under the row's lock, so a connection still entitled to
   * its directory keeps it whatever this was told.
   */
  async function dropDirectory(context: TenantContext, connection: { id: string }) {
    const { teamsRemoved } = await removeConnectionDirectory(database, context, {
      connectionId: connection.id,
    });
    if (teamsRemoved > 0) {
      log.info('connector_sync.directory_removed', {
        organizationId: context.organizationId,
        count: teamsRemoved,
      });
    }
  }

  async function pass(input: ConnectorSyncInput): Promise<ConnectorSyncOutcome> {
    const { organizationId, connectionId } = input;
    const context = createServiceContext(organizationId);
    const connection = await loadConnectionForWorker(database, context, connectionId);
    if (!connection) return nothing('nothing_to_do');
    if (connection.state === 'revoked') {
      await cleanUpRevoked(context, connection);
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

    const connectorContext = contextFor(deps, connector, { ...connection, config }, organizationId);
    let directory: DirectoryPassResult = { ran: false, pages: 0, more: false, failed: false };
    let result: Awaited<ReturnType<typeof runSyncPass>>;
    try {
      // The directory first, so that a group a file names already has its team when the file commits.
      if (hasDirectory(connector) && directoryWanted(connector, connection)) {
        directory = await runDirectoryPass({
          database,
          context,
          connectionId,
          connector,
          connectorContext,
          leaseMs: SYNC_LEASE_MS,
        });
        // A pass that failed, or a directory past its bound, grants nobody until a full pass completes.
        const held = await enforceDirectoryFreshness(database, context, { connectionId });
        if (held.membershipsRemoved > 0 || held.restarted) {
          log.warn('connector_sync.directory_stale', {
            organizationId,
            count: held.membershipsRemoved,
          });
        }
      } else if (isSuiteConnectorType(connection.connectorType)) {
        // The directory scopes are gone, so what the directory last said can no longer be checked. Its
        // teams go, as a revoked connection's do. Nothing to do for a connection that never had them.
        await dropDirectory(context, connection);
      }
      result = await runSyncPass({
        connector,
        context: connectorContext,
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

    // A revoke landing during this pass has its own run on the way. Looking again here means the sealed
    // value stops now, rather than whenever that run gets its turn.
    const after = await loadConnectionForWorker(database, context, connectionId);
    if (after?.state === 'revoked') {
      await cleanUpRevoked(context, after);
      return { outcome: 'revoked', pages: result.pages, resources: result.resources };
    }
    // Every stream held by another pass, or by a try of this one that died: this pass read nothing, and
    // saying `synced` would claim otherwise.
    if (result.streams === 0 && !directory.ran) return nothing('nothing_to_do');
    // The workflow runs another pass when this one read a full pass's worth of pages, so a directory
    // that stopped at its own, smaller limit counts as that.
    const pages = result.pages + directory.pages;
    return {
      outcome: result.failed > 0 || directory.failed ? 'failed' : 'synced',
      pages: directory.more ? Math.max(pages, SYNC_PAGES_PER_PASS) : pages,
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
