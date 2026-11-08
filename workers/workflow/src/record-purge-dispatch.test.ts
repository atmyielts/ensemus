import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { RecordPurgeTarget } from '@ensemus/database/dispatcher';
import { knowledgeRecordPurgeWorkflowIdFor } from '@ensemus/workflows/knowledge-schemas';
import { reconcileRecordPurges, startCanonicalRecordPurge } from './record-purge-dispatch';

const target = (kind: RecordPurgeTarget['kind'] = 'work_unit'): RecordPurgeTarget => ({
  organizationId: randomUUID(),
  kind,
  id: randomUUID(),
});
describe('native record purge dispatcher orchestration (no runtime doubles in product)', () => {
  it.each(['work_unit', 'project', 'client', 'object_record'] as const)(
    'starts the exact %s canonical identity with metadata only',
    async (kind) => {
      const row = target(kind),
        start = vi.fn(async () => undefined);
      await startCanonicalRecordPurge(row, { start, alreadyRunning: () => false });
      expect(start).toHaveBeenCalledExactlyOnceWith(
        { ...row, limit: 25 },
        knowledgeRecordPurgeWorkflowIdFor({ ...row, limit: 25 }),
      );
      expect(JSON.stringify(start.mock.calls)).not.toMatch(
        /title|payload|snapshot|readable|confirmed/,
      );
    },
  );
  it('does not replace an existing execution and preserves an unknown start error for durable redelivery', async () => {
    const row = target(),
      running = new Error('TEST_ALREADY_RUNNING'),
      unavailable = new Error('TEST_TRANSPORT_UNAVAILABLE');
    await expect(
      startCanonicalRecordPurge(row, {
        start: async () => {
          throw running;
        },
        alreadyRunning: (error) => error === running,
      }),
    ).resolves.toBeUndefined();
    await expect(
      startCanonicalRecordPurge(row, {
        start: async () => {
          throw unavailable;
        },
        alreadyRunning: () => false,
      }),
    ).rejects.toBe(unavailable);
  });
  it('reuses the same identity after a start response is lost', async () => {
    const row = target(),
      ids: string[] = [],
      running = new Error('TEST_ALREADY_RUNNING');
    const ports = {
      start: async (_input: unknown, id: string) => {
        ids.push(id);
        if (ids.length === 1) throw new Error('TEST_RESPONSE_LOST');
        throw running;
      },
      alreadyRunning: (error: unknown) => error === running,
    };
    await expect(startCanonicalRecordPurge(row, ports)).rejects.toThrow('TEST_RESPONSE_LOST');
    await startCanonicalRecordPurge(row, ports);
    expect(ids).toEqual([
      knowledgeRecordPurgeWorkflowIdFor({ ...row, limit: 25 }),
      knowledgeRecordPurgeWorkflowIdFor({ ...row, limit: 25 }),
    ]);
  });
  it('continues a bounded recovery page after one failed start and preserves the next cursor', async () => {
    const rows = [target(), target('client')],
      next = rows[1]!,
      calls: RecordPurgeTarget[] = [];
    const list = vi.fn(async () => ({ targets: rows, next }));
    const result = await reconcileRecordPurges(
      {
        list,
        start: async (row) => {
          calls.push(row);
          if (row === rows[0]) throw new Error('TEST_TEMPORAL_DOWN');
        },
        shouldStop: () => false,
      },
      null,
    );
    expect(result).toEqual({ next, attempted: 2, failed: 1 });
    expect(calls).toEqual(rows);
    expect(list).toHaveBeenCalledExactlyOnceWith(null);
  });
  it('does not turn an unavailable closed-record inventory into an empty completed scan', async () => {
    const failure = new Error('TEST_METADATA_UNAVAILABLE'),
      start = vi.fn();
    await expect(
      reconcileRecordPurges(
        {
          list: async () => {
            throw failure;
          },
          start,
          shouldStop: () => false,
        },
        null,
      ),
    ).rejects.toBe(failure);
    expect(start).not.toHaveBeenCalled();
  });
  it('retains the page position when shutting down before any start', async () => {
    const after = target(),
      row = target(),
      start = vi.fn();
    expect(
      await reconcileRecordPurges(
        { list: async () => ({ targets: [row], next: null }), start, shouldStop: () => true },
        after,
      ),
    ).toEqual({ next: after, attempted: 0, failed: 0 });
    expect(start).not.toHaveBeenCalled();
  });
});
