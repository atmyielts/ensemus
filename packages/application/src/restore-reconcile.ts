// Owned by the restore slice (OPS-02). See docs/06-delivery/m6-slices.md and ADR-030 D11. What brings a tenant
// back into agreement after PostgreSQL, Temporal and the object store have been restored from points that
// are never quite the same moment. It reports what it finds and changes only what is safe to change without
// a person: it sends nothing, and never decides what happened to something that may have gone out.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { ObjectStore } from './artifacts';
import type { ContributorReport, RestoreContributor, RunProbe } from './sovereign-ports';
import type { LedgerReader, ReapplyOptions, ReapplyResult } from './tombstone-ledger';

export type TenantRestoreReport = {
  organizationId: string;
  /** Work holding a run Temporal has no open record of. Marked failed, the same as the upkeep does. */
  runsClosed: number;
  /** Runs Temporal could not answer about. Reported, left alone, and counted as needing attention. */
  runsUnknown: number;
  /** Open work whose run was restored and is still going. Left alone. */
  runsOpen: number;
  /**
   * Intents `sending` or `reconciling` in the restored database, or `ready` with an attempt behind them.
   * Moved to `unknown` where the attempts allow it, and otherwise reported. Never retried (ADR-027 D2).
   */
  actionsNeedingReview: number;
  /** Bytes in the store with no row. Listed by key, in the operator's report, and not deleted by this. */
  unreferencedObjects: number;
  /** Rows whose bytes are gone or differ from their hash. Files cannot be read back, so a person looks. */
  artifactsMissingBytes: number;
  contributors: readonly ContributorReport[];
};

export type RestoreReport = {
  ledger: ReapplyResult;
  tenants: readonly TenantRestoreReport[];
  /** Zero means nothing needs a person. The command's exit status comes from this. */
  needsAttention: number;
};

/**
 * Runs in order, because each step depends on the last: first re-apply the tombstone ledger across all tenants
 * (`reapplyTombstoneLedger`), so nothing below reads a deleted file. Then, for each tenant, runs, intents,
 * bytes and the contributors. Safe to run again. `report` makes it change nothing, so an operator can look
 * before letting it act.
 */
export function reconcileAfterRestore(
  _database: AppDatabase,
  _store: ObjectStore & LedgerReader,
  _input: {
    organizationIds: readonly string[];
    contextFor: (organizationId: string) => TenantContext;
    probeRun: RunProbe;
    contributors: readonly RestoreContributor[];
    mode: 'report' | 'apply';
    ledgerOptions?: ReapplyOptions;
  },
): Promise<RestoreReport> {
  throw new Error('NOT_IMPLEMENTED');
}
