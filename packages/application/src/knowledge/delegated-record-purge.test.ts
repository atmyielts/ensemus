// The record purge's page cursor, without PostgreSQL. Its effects and final proof are integration cases
// (agent-delegated-materials.test.ts L4/L5). The wrap itself, on real PostgreSQL for both the source and
// the record purge (a pass refused by a hold leaves the cursor past every open row, and the first pass
// after the release wraps and proves in that pass), is tests/integration/delegated-purge-cursor-wrap.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { wrapCursorPage } from './delegated-record-purge';

const pages = (rows: Record<string, string[]>) =>
  vi.fn(async (after: string | null) => rows[after ?? 'start'] ?? []);

describe('the record purge page cursor', () => {
  it('a pass after a refused one starts again from the beginning, in the same pass', async () => {
    // The refused pass advanced the cursor past both runs; nothing is open after it.
    const open = pages({ start: ['run-a', 'run-b'] }),
      rewind = vi.fn(async () => true);
    expect(await wrapCursorPage('run-b', open, rewind)).toEqual(['run-a', 'run-b']);
    expect(open.mock.calls).toEqual([['run-b'], [null]]);
    expect(rewind).toHaveBeenCalledOnce();
  });

  it('reads on from the cursor while rows remain past it, and does not rewind', async () => {
    const open = pages({ 'run-a': ['run-b'], start: ['run-a', 'run-b'] }),
      rewind = vi.fn(async () => true);
    expect(await wrapCursorPage('run-a', open, rewind)).toEqual(['run-b']);
    expect(open.mock.calls).toEqual([['run-a']]);
    expect(rewind).not.toHaveBeenCalled();
  });

  it('a cursor already at the start reads once and does not rewind', async () => {
    const open = pages({}),
      rewind = vi.fn(async () => true);
    expect(await wrapCursorPage(null, open, rewind)).toEqual([]);
    expect(open.mock.calls).toEqual([[null]]);
    expect(rewind).not.toHaveBeenCalled();
  });

  it('a cursor a concurrent pass moved is left to that pass: no rows, no read from a stale start', async () => {
    const open = pages({ start: ['run-a'] }),
      rewind = vi.fn(async () => false);
    expect(await wrapCursorPage('run-b', open, rewind)).toEqual([]);
    expect(open.mock.calls).toEqual([['run-b']]);
  });

  it('a pass with nothing open anywhere rewinds and still finds nothing', async () => {
    const open = pages({}),
      rewind = vi.fn(async () => true);
    expect(await wrapCursorPage('run-b', open, rewind)).toEqual([]);
    expect(open.mock.calls).toEqual([['run-b'], [null]]);
  });
});
