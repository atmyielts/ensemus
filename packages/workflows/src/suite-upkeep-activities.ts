// The suite upkeep (ADR-038 D1, D4), in the connector worker, because it revokes sealed values and only the
// broker can. Two sweeps of one tenant, each taking only its ID and answering counts: consent attempts that
// ended early leave nothing sealed behind, and a directory that stopped syncing stops granting.
import {
  attemptSecretStatuses,
  directoryEntitlementEnded,
  enforceDirectoryFreshness,
  expireAbandonedAttempts,
  listDirectoryConnections,
  loadConnectionForWorker,
  removeConnectionDirectory,
} from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  attemptSecretsToRevoke,
  OAUTH_ATTEMPT_SECRET_PURPOSES,
  type LiveAttemptSecret,
} from '@ensemus/domain/workspace-suites';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { tenantInputSchema, type TenantInput } from './schemas';

const log = createLogger('suite-upkeep');

/** What the sweep needs of the broker: SecretBroker.listLive and SecretBroker.revoke. */
export interface AttemptSecretBroker {
  listLive(organizationId: string, purposes: readonly string[]): Promise<LiveAttemptSecret[]>;
  revoke(organizationId: string, secretId: string): Promise<unknown>;
}

export type SuiteUpkeepDeps = { database: AppDatabase; secrets: AttemptSecretBroker };

/** Thrown when PostgreSQL could not be reached. Carries no query text, so it is safe to cross Temporal. */
class UpkeepStoreUnavailable extends Error {
  override name = 'UpkeepStoreUnavailable';
  constructor() {
    super('SUITE_UPKEEP_STORE_UNAVAILABLE');
  }
}

export function createSuiteUpkeepActivities(deps: SuiteUpkeepDeps) {
  const { database } = deps;

  /** Runs a sweep, and lets only a code out if it fails. Every step is safe to repeat. */
  async function guarded<T>(organizationId: string, name: string, run: () => Promise<T>) {
    try {
      return await run();
    } catch (error) {
      log.error(`suite_upkeep.${name}_failed`, { organizationId, errorCode: errorCode(error) });
      throw new UpkeepStoreUnavailable();
    }
  }

  return {
    /**
     * Moves attempts past their ten minutes to `expired`, then revokes every live sealed verifier, customer
     * client and code that a settled attempt names, or that no attempt names and is older than
     * OAUTH_ORPHAN_SECRET_AFTER_MS (a start refused after it sealed). Revoking one twice does no harm.
     */
    async sweepOAuthAttempts(raw: TenantInput): Promise<{ expired: number; revoked: number }> {
      const { organizationId } = tenantInputSchema.parse(raw);
      const context = createServiceContext(organizationId);
      return guarded(organizationId, 'oauth', async () => {
        const expired = await expireAbandonedAttempts(database, context);
        const live = await deps.secrets.listLive(organizationId, OAUTH_ATTEMPT_SECRET_PURPOSES);
        const namedBy = await attemptSecretStatuses(
          database,
          context,
          live.map((secret) => secret.id),
        );
        // The clock is read after the attempts are, so a value sealed by a start that is still writing its
        // row is younger than the bound and is left for the next sweep.
        const spent = attemptSecretsToRevoke({ live, namedBy, now: new Date() });
        for (const secretId of spent) await deps.secrets.revoke(organizationId, secretId);
        if (expired || spent.length) {
          log.info('suite_upkeep.oauth_swept', { organizationId, count: spent.length });
        }
        return { expired, revoked: spent.length };
      });
    },

    /**
     * Holds every directory in the tenant to ADR-038 D4 whether or not anyone asks it to sync: a connection
     * revoked or without the directory scopes loses its teams, and a directory past
     * DIRECTORY_STALE_AFTER_MS, or whose last pass failed, loses its teams' members.
     */
    async holdDirectories(raw: TenantInput): Promise<{ connections: number; removed: number }> {
      const { organizationId } = tenantInputSchema.parse(raw);
      const context = createServiceContext(organizationId);
      return guarded(organizationId, 'directory', async () => {
        const connectionIds = await listDirectoryConnections(database, context);
        let removed = 0;
        for (const connectionId of connectionIds) {
          const connection = await loadConnectionForWorker(database, context, connectionId);
          if (!connection) continue;
          if (directoryEntitlementEnded(connection)) {
            removed += (await removeConnectionDirectory(database, context, { connectionId }))
              .teamsRemoved;
          } else {
            removed += (await enforceDirectoryFreshness(database, context, { connectionId }))
              .membershipsRemoved;
          }
        }
        if (removed) log.warn('suite_upkeep.directory_held', { organizationId, count: removed });
        return { connections: connectionIds.length, removed };
      });
    },
  };
}
export type SuiteUpkeepActivities = ReturnType<typeof createSuiteUpkeepActivities>;
