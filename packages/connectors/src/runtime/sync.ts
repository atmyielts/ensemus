// One pass of the cursor protocol (ADR-027 D3). Take the lease, read a page, commit the page and the next
// cursor together if nothing has moved. A crash repeats a page, and losing the race stops the pass.
import { isValidSyncPage, safeSyncErrorCode, type SyncPage } from '@ensemus/domain/connector';
import {
  CursorExpired,
  SyncUnavailable,
  type Connector,
  type ConnectorContext,
  type SyncConnector,
} from '../index';

export type SyncStreamState = {
  stream: string;
  cursor: string | null;
  generation: number;
  fullSync: boolean;
  fullSyncGeneration: number;
};

/** Where a pass keeps its state. The worker backs this on to the application service. */
export interface SyncStore {
  /** Takes the stream's lease, or returns null if another pass holds it. */
  lease(stream: string, leaseMs: number): Promise<SyncStreamState | null>;
  /**
   * Commits a page and the cursor it moves to in one transaction, if the generation still matches.
   * Returns the new state, or null if it lost the race, in which case this pass stops.
   */
  commitPage(state: SyncStreamState, page: SyncPage): Promise<SyncStreamState | null>;
  finish(stream: string, outcome: { ok: true } | { ok: false; code: string }): Promise<void>;
  markResyncRequired(stream: string): Promise<void>;
}

export type SyncPassDeps = {
  connector: Connector;
  context: Omit<ConnectorContext, 'signal'>;
  store: SyncStore;
  /** Pages per stream in one pass. The next pass carries on from the cursor. */
  maxPages: number;
  /** How long a stream's lease lasts. A pass that dies is out of the way this much later. */
  leaseMs?: number;
  /** How long one read may take. */
  pageDeadlineMs?: number;
};

export type SyncPassResult = {
  streams: number;
  pages: number;
  resources: number;
  /** Streams whose read failed this pass, each recorded with a code from the fixed list. */
  failed: number;
};

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_PAGE_DEADLINE_MS = 60_000;

async function readWithDeadline(
  sync: SyncConnector,
  context: Omit<ConnectorContext, 'signal'>,
  request: Parameters<SyncConnector['readPage']>[1],
  deadlineMs: number,
): Promise<SyncPage> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SyncUnavailable('SYNC_TIMEOUT'));
    }, deadlineMs);
  });
  const reading = (async () => sync.readPage({ ...context, signal: controller.signal }, request))();
  reading.catch(() => undefined);
  try {
    return await Promise.race([reading, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One pass over the connector's streams. Applying a page twice changes nothing. Only a connector's read
 * is caught here: a store that fails is an outage, and it goes up so that the pass is retried.
 */
export async function runSyncPass(deps: SyncPassDeps): Promise<SyncPassResult> {
  const result: SyncPassResult = { streams: 0, pages: 0, resources: 0, failed: 0 };
  const { connector, context, store, maxPages } = deps;
  const declared = connector.manifest.capabilities.sync;
  const sync = connector.sync;
  if (!declared || !sync) return result;

  for (const stream of declared.streams) {
    let state = await store.lease(stream, deps.leaseMs ?? DEFAULT_LEASE_MS);
    if (!state) continue;
    result.streams += 1;

    // What this stream's pass ends with: null means it has already been told, or must not be.
    let ending: { ok: true } | { ok: false; code: string } | null = { ok: true };
    for (let read = 0; read < maxPages; read += 1) {
      let page: SyncPage;
      try {
        page = await readWithDeadline(
          sync,
          context,
          {
            stream,
            cursor: state.cursor,
            fullSync: state.fullSync,
            pageSize: declared.pageSize,
          },
          deps.pageDeadlineMs ?? DEFAULT_PAGE_DEADLINE_MS,
        );
      } catch (error) {
        if (error instanceof CursorExpired) {
          await store.markResyncRequired(stream);
          ending = null;
        } else {
          ending = {
            ok: false,
            code: safeSyncErrorCode(error instanceof SyncUnavailable ? error.code : undefined),
          };
        }
        break;
      }
      if (!isValidSyncPage(stream, page)) {
        ending = { ok: false, code: 'SYNC_PAGE_INVALID' };
        break;
      }

      const before = state.cursor;
      let next: SyncStreamState | null;
      try {
        next = await store.commitPage(state, page);
      } catch (error) {
        // The store refusing this page is the source's doing. Any other failure is an outage.
        if (!(error instanceof SyncUnavailable)) throw error;
        ending = { ok: false, code: safeSyncErrorCode(error.code) };
        break;
      }
      if (!next) return result;
      state = next;
      result.pages += 1;
      result.resources += page.resources.length;

      if (!page.hasMore) break;
      if (page.nextCursor === before) {
        ending = { ok: false, code: 'SYNC_NO_PROGRESS' };
        break;
      }
    }
    if (ending) {
      if (!ending.ok) result.failed += 1;
      await store.finish(stream, ending);
    }
  }
  return result;
}
