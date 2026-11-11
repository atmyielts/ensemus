// Directory sync (CONNECT-08, ADR-038 D4): each provider group mirrored as a team that only this sync may
// change. Each write runs in a transaction naming its connection in DIRECTORY_SYNC_SETTING, which is the
// only way migration 0561 lets a directory team, its members or its group row change.
//
// Stage 1a stubs: these are the exact signatures stage 1b implements, and each refuses until then.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type { DirectoryPage } from '@ensemus/domain/workspace-suites';
import type { SyncStreamLease } from './integration-ports';

const notImplemented = () => Promise.reject(new Error('NOT_IMPLEMENTED'));

/**
 * The worker's service context only. Commits a page of groups with the cursor, if the lease's generation
 * still matches and the connection is active: creates a team for a new group, renames it, replaces each
 * group's members (flattened at most DIRECTORY_MAX_NESTING deep, cycles cut, matched by email), and after
 * the last page of a completed full pass removes the members, then the team, of every group it did not
 * see. Returns the new lease, or null when nothing was written, as commitSyncPage does.
 */
export const commitDirectoryPage: (
  database: AppDatabase,
  context: TenantContext,
  input: { connectionId: string; lease: SyncStreamLease; page: DirectoryPage },
) => Promise<SyncStreamLease | null> = notImplemented;

/**
 * Removes every team a connection's directory made, with their members and group rows. Called inside
 * the transaction that marks the connection revoked, so the two commit together (ADR-038 D4).
 */
export const removeConnectionDirectory: (
  tx: Tx,
  context: TenantContext,
  input: { connectionId: string },
) => Promise<{ teamsRemoved: number }> = notImplemented;
