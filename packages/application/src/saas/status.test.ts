import type { AppDatabase } from '@ensemus/database';
import { describe, expect, it, vi } from 'vitest';
import { getStatusPage } from './status';
describe('status read failure is never an availability claim', () => {
  it('reports unknown when its database read fails', async () => {
    const database = {
      run: vi.fn().mockRejectedValue(new Error('test unavailable')),
    } as unknown as AppDatabase;
    expect(await getStatusPage(database, { limit: 10 })).toEqual({
      overall: 'unknown',
      open: [],
      recent: [],
      updates: [],
    });
  });
  it('refuses unbounded display input before reading', async () => {
    const run = vi.fn(),
      database = { run } as unknown as AppDatabase;
    for (const limit of [0, -1, 1.5, Number.NaN, 101])
      await expect(getStatusPage(database, { limit })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    expect(run).not.toHaveBeenCalled();
  });
});
