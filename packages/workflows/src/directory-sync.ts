// The directory stream's pass (CONNECT-08, ADR-038 D4), run by the connector sync before its file streams,
// so a file's group grant finds the group's team on the first pass. The same cursor protocol as a sync
// stream: take the lease, read a page, commit it with its cursor if nothing moved. Only codes get out.
import {
  AppError,
  commitDirectoryPage,
  finishSyncStream,
  leaseSyncStream,
  type SyncStreamLease,
} from '@ensemus/application';
import { CursorExpired, SyncUnavailable, type ConnectorContext } from '@ensemus/connectors';
import type { DirectoryCapableConnector } from '@ensemus/connectors/suites';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { safeSyncErrorCode } from '@ensemus/domain/connector';
import {
  DIRECTORY_STREAM,
  capabilityGranted,
  isSuiteConnectorType,
  isValidDirectoryPage,
  type DirectoryPage,
} from '@ensemus/domain/workspace-suites';

/**
 * Pages in one pass. Fewer than a file stream's, because one directory page reads every group in it and
 * each one's members, and the pass shares its Activity's ten minutes with the file streams.
 */
export const DIRECTORY_PAGES_PER_PASS = 5;
const DIRECTORY_PAGE_DEADLINE_MS = 90_000;

/** Whether this connection has a directory to read: a suite connector, granted the directory capability. */
export function directoryWanted(
  connector: { directory?: unknown },
  connection: { connectorType: string; grantedScopes: readonly string[] },
): boolean {
  return (
    connector.directory !== undefined &&
    isSuiteConnectorType(connection.connectorType) &&
    capabilityGranted(connection.connectorType, 'directory', connection.grantedScopes)
  );
}

async function readWithDeadline(
  connector: DirectoryCapableConnector,
  context: Omit<ConnectorContext, 'signal'>,
  cursor: string | null,
): Promise<DirectoryPage> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SyncUnavailable('SYNC_TIMEOUT'));
    }, DIRECTORY_PAGE_DEADLINE_MS);
  });
  const reading = connector.directory.readGroups({ ...context, signal: controller.signal }, cursor);
  reading.catch(() => undefined);
  try {
    return await Promise.race([reading, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export type DirectoryPassResult = {
  /** Read at all: false when another pass held the lease. */
  ran: boolean;
  pages: number;
  /** Stopped at the page limit with more to read. */
  more: boolean;
  failed: boolean;
};

/**
 * One pass of the directory stream. A connector's read failing is recorded on the stream with a code, as
 * a file stream's is. The store failing goes up, so the Activity is retried.
 */
export async function runDirectoryPass(input: {
  database: AppDatabase;
  /** The worker's service context for this tenant. */
  context: TenantContext;
  connectionId: string;
  connector: DirectoryCapableConnector;
  connectorContext: Omit<ConnectorContext, 'signal'>;
  leaseMs: number;
}): Promise<DirectoryPassResult> {
  const { database, context, connectionId, connector, connectorContext, leaseMs } = input;
  const result: DirectoryPassResult = { ran: false, pages: 0, more: false, failed: false };
  const take = () =>
    leaseSyncStream(database, context, { connectionId, stream: DIRECTORY_STREAM, leaseMs });
  const finish = (outcome: Parameters<typeof finishSyncStream>[2]['outcome']) =>
    finishSyncStream(database, context, { connectionId, stream: DIRECTORY_STREAM, outcome });

  let lease: SyncStreamLease | null = await take();
  if (!lease) return result;
  // No cursor means starting from the beginning, and a directory read from the beginning is a full pass:
  // only a full pass may remove groups it did not see. Google ends every pass this way, since its
  // directory has no change feed, so each of its passes asks for a full one here.
  if (lease.cursor === null && !lease.fullSync) {
    await finish({ resyncRequired: true });
    lease = await take();
    if (!lease) return result;
  }
  result.ran = true;

  let ending: { ok: true } | { ok: false; code: string } | null = { ok: true };
  try {
    for (let read = 0; read < DIRECTORY_PAGES_PER_PASS; read += 1) {
      let page: DirectoryPage;
      try {
        page = await readWithDeadline(connector, connectorContext, lease.cursor);
      } catch (error) {
        if (error instanceof CursorExpired) {
          await finish({ resyncRequired: true });
          ending = null;
        } else {
          ending = {
            ok: false,
            code: safeSyncErrorCode(error instanceof SyncUnavailable ? error.code : undefined),
          };
        }
        break;
      }
      if (!isValidDirectoryPage(page) || page.fullSync !== lease.fullSync) {
        ending = { ok: false, code: 'SYNC_PAGE_INVALID' };
        break;
      }

      const before: string | null = lease.cursor;
      let next: SyncStreamLease | null;
      try {
        next = await commitDirectoryPage(database, context, { connectionId, lease, page });
      } catch (error) {
        // The page itself was refused. Anything else is the store, and goes up.
        if (!(error instanceof AppError) || error.code !== 'INVALID_INPUT') throw error;
        ending = { ok: false, code: 'SYNC_PAGE_INVALID' };
        break;
      }
      // Lost the race, or the connection was revoked: the lease runs out on its own, as a sync's does.
      if (!next) return result;
      lease = next;
      result.pages += 1;

      if (!page.hasMore) break;
      if (page.nextCursor === before) {
        ending = { ok: false, code: 'SYNC_NO_PROGRESS' };
        break;
      }
      if (read === DIRECTORY_PAGES_PER_PASS - 1) result.more = true;
    }
  } finally {
    // The provider token lives only as long as the pass.
    (connector as { disposeAuthSession?: (credentials: unknown) => void }).disposeAuthSession?.(
      connectorContext.credentials,
    );
  }
  if (ending) {
    if (!ending.ok) result.failed = true;
    await finish(ending);
  }
  return result;
}
