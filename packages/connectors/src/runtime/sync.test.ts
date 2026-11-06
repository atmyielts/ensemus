// The cursor protocol, against a recording store (ADR-027 D3). The store's real rules are proved against
// PostgreSQL in tests/integration/connector-sync.test.ts.
import { randomUUID } from 'node:crypto';
import type { SyncPage, SyncedResource } from '@ensemus/domain/connector';
import { describe, expect, it, vi } from 'vitest';
import { CursorExpired, SyncUnavailable, type Connector, type ConnectorContext } from '../index';
import { createFakeConnector } from '../testing';
import { runSyncPass, type SyncStore, type SyncStreamState } from './sync';

const CANARY = `CANARY-provider-text-${randomUUID()}`;

const resource = (externalId: string, stream = 'files'): SyncedResource => ({
  externalId,
  resourceType: stream,
  externalVersion: '1',
  acl: [],
});
const page = (...ids: string[]): SyncPage => ({
  resources: ids.map((id) => resource(id)),
  deletedExternalIds: [],
  nextCursor: null,
  hasMore: false,
});

const context: Omit<ConnectorContext, 'signal'> = {
  organizationId: randomUUID(),
  connectionId: randomUUID(),
  config: {},
  credentials: {
    withCredential: async () => {
      throw new Error('not used');
    },
  },
  network: {
    openRelay: async () => {
      throw new Error('not used');
    },
  },
};

function memoryStore(overrides: Partial<SyncStore> = {}) {
  const states = new Map<string, SyncStreamState>();
  const committed: Array<{ stream: string; page: SyncPage }> = [];
  const finished: Array<{ stream: string; outcome: unknown }> = [];
  const resync: string[] = [];
  const store: SyncStore = {
    lease: async (stream) => {
      const state = states.get(stream) ?? {
        stream,
        cursor: null,
        generation: 0,
        fullSync: true,
        fullSyncGeneration: 1,
      };
      states.set(stream, state);
      return state;
    },
    commitPage: async (state, next) => {
      committed.push({ stream: state.stream, page: next });
      const moved = {
        ...state,
        cursor: next.nextCursor,
        generation: state.generation + 1,
        fullSync: state.fullSync && next.hasMore,
      };
      states.set(state.stream, moved);
      return moved;
    },
    finish: async (stream, outcome) => {
      finished.push({ stream, outcome });
    },
    markResyncRequired: async (stream) => {
      resync.push(stream);
    },
    ...overrides,
  };
  return { store, states, committed, finished, resync };
}

describe('runSyncPass', () => {
  it('reads each stream to the end, one page at a time, moving the cursor', async () => {
    const memory = memoryStore();
    const result = await runSyncPass({
      connector: createFakeConnector({
        pages: { files: [page('a', 'b'), page('c')], notes: [page()] },
      }),
      context,
      store: memory.store,
      maxPages: 10,
    });
    expect(result).toEqual({ streams: 2, pages: 3, resources: 3, failed: 0 });
    expect(memory.states.get('files')?.cursor).toBe('2');
    expect(memory.finished).toEqual([
      { stream: 'files', outcome: { ok: true } },
      { stream: 'notes', outcome: { ok: true } },
    ]);
  });

  it('stops at the page limit, and the next pass carries on from the cursor', async () => {
    const connector = createFakeConnector({ pages: { files: [page('a'), page('b'), page('c')] } });
    const memory = memoryStore();
    const first = await runSyncPass({ connector, context, store: memory.store, maxPages: 2 });
    expect(first.pages).toBe(2);
    expect(memory.states.get('files')?.cursor).toBe('2');
    const second = await runSyncPass({ connector, context, store: memory.store, maxPages: 2 });
    expect(second.pages).toBe(1);
    expect(memory.committed.map((c) => c.page.resources[0]?.externalId)).toEqual(['a', 'b', 'c']);
  });

  it('skips a stream another pass holds, and touches nothing of it', async () => {
    const memory = memoryStore({ lease: async () => null });
    const readPage = vi.fn();
    const connector = createFakeConnector({ pages: { files: [page('a')] } });
    const result = await runSyncPass({
      connector: { ...connector, sync: { readPage } },
      context,
      store: memory.store,
      maxPages: 5,
    });
    expect(result).toEqual({ streams: 0, pages: 0, resources: 0, failed: 0 });
    expect(readPage).not.toHaveBeenCalled();
    expect(memory.finished).toEqual([]);
  });

  it('stops the whole pass when it loses the race, without finishing what the winner holds', async () => {
    const memory = memoryStore({ commitPage: async () => null });
    const result = await runSyncPass({
      connector: createFakeConnector({ pages: { files: [page('a'), page('b')], notes: [page()] } }),
      context,
      store: memory.store,
      maxPages: 5,
    });
    expect(result).toEqual({ streams: 1, pages: 0, resources: 0, failed: 0 });
    expect(memory.finished).toEqual([]);
  });

  it('sends a stream back to a full sync when the cursor has expired', async () => {
    const memory = memoryStore();
    const connector = createFakeConnector({
      pages: { files: [page('a')] },
      readPage: async () => {
        throw new CursorExpired();
      },
    });
    const result = await runSyncPass({ connector, context, store: memory.store, maxPages: 5 });
    expect(result).toEqual({ streams: 1, pages: 0, resources: 0, failed: 0 });
    expect(memory.resync).toEqual(['files']);
    expect(memory.finished).toEqual([]);
  });

  it('records a known code when a read is unavailable, and carries on with the next stream', async () => {
    const memory = memoryStore();
    const connector: Connector = createFakeConnector({
      pages: { files: [page('a')], notes: [page()] },
      readPage: async (_context, request) => {
        if (request.stream === 'files') throw new SyncUnavailable('SYNC_RATE_LIMITED');
        return page();
      },
    });
    const result = await runSyncPass({ connector, context, store: memory.store, maxPages: 5 });
    expect(result).toEqual({ streams: 2, pages: 1, resources: 0, failed: 1 });
    expect(memory.finished).toEqual([
      { stream: 'files', outcome: { ok: false, code: 'SYNC_RATE_LIMITED' } },
      { stream: 'notes', outcome: { ok: true } },
    ]);
  });

  it.each([
    ['a code off the list', new SyncUnavailable(CANARY)],
    ['any other error', new Error(CANARY)],
  ])('reports %s as a failure and nothing more', async (_label, error) => {
    const memory = memoryStore();
    const connector = createFakeConnector({
      pages: { files: [page('a')] },
      readPage: async () => {
        throw error;
      },
    });
    await runSyncPass({ connector, context, store: memory.store, maxPages: 5 });
    expect(memory.finished).toEqual([
      { stream: 'files', outcome: { ok: false, code: 'SYNC_FAILED' } },
    ]);
    expect(JSON.stringify(memory.finished)).not.toContain(CANARY);
  });

  it('fails a page it cannot accept, and commits nothing of it', async () => {
    const memory = memoryStore();
    const connector = createFakeConnector({
      pages: { files: [{ ...page(), resources: [resource('a', 'somewhere_else')] }] },
    });
    await runSyncPass({ connector, context, store: memory.store, maxPages: 5 });
    expect(memory.committed).toEqual([]);
    expect(memory.finished).toEqual([
      { stream: 'files', outcome: { ok: false, code: 'SYNC_PAGE_INVALID' } },
    ]);
  });

  it('records a page the store refused, and carries on', async () => {
    const memory = memoryStore({
      commitPage: async () => {
        throw new SyncUnavailable('SYNC_PAGE_INVALID');
      },
    });
    const result = await runSyncPass({
      connector: createFakeConnector({ pages: { files: [page('a')] } }),
      context,
      store: memory.store,
      maxPages: 5,
    });
    expect(result.failed).toBe(1);
    expect(memory.finished).toEqual([
      { stream: 'files', outcome: { ok: false, code: 'SYNC_PAGE_INVALID' } },
    ]);
  });

  it('gives up on a read that hangs, and tells the connector', async () => {
    let signal: AbortSignal | undefined;
    const memory = memoryStore();
    const connector = createFakeConnector({
      pages: { files: [page('a')] },
      readPage: (ctx) => {
        signal = ctx.signal;
        return new Promise(() => undefined);
      },
    });
    await runSyncPass({ connector, context, store: memory.store, maxPages: 5, pageDeadlineMs: 5 });
    expect(signal?.aborted).toBe(true);
    expect(memory.finished).toEqual([
      { stream: 'files', outcome: { ok: false, code: 'SYNC_TIMEOUT' } },
    ]);
  });

  it('stops a connector that says there is more but never moves its cursor', async () => {
    const memory = memoryStore();
    const readPage = vi.fn(async () => ({ ...page('a'), nextCursor: 'same', hasMore: true }));
    const connector = createFakeConnector({ pages: { files: [page('a')] }, readPage });
    await memory.store.lease('files', 1);
    memory.states.set('files', {
      stream: 'files',
      cursor: 'same',
      generation: 1,
      fullSync: false,
      fullSyncGeneration: 1,
    });
    await runSyncPass({ connector, context, store: memory.store, maxPages: 50 });
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(memory.finished).toEqual([
      { stream: 'files', outcome: { ok: false, code: 'SYNC_NO_PROGRESS' } },
    ]);
  });

  it('lets a store failure out, because that is a retry and not the source failing', async () => {
    const memory = memoryStore({
      commitPage: async () => {
        throw new Error('The database is down');
      },
    });
    await expect(
      runSyncPass({
        connector: createFakeConnector({ pages: { files: [page('a')] } }),
        context,
        store: memory.store,
        maxPages: 5,
      }),
    ).rejects.toThrow('The database is down');
  });

  it('does nothing for a connector that declares no sync', async () => {
    const memory = memoryStore();
    const result = await runSyncPass({
      connector: createFakeConnector({}),
      context,
      store: memory.store,
      maxPages: 5,
    });
    expect(result).toEqual({ streams: 0, pages: 0, resources: 0, failed: 0 });
  });
});
