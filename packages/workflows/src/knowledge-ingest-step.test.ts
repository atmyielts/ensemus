import { describe, expect, it, vi } from 'vitest';
import { runKnowledgeIngest, runKnowledgeSweep } from './knowledge-ingest-step';

describe('ingest orchestration', () => {
  it('never embeds rejected or closed content', async () => {
    for (const outcome of ['rejected', 'failed', 'closed'] as const) {
      const embed = vi.fn();
      expect(
        await runKnowledgeIngest({
          parse: async () => ({ outcome, chunks: 0 }),
          embed,
          modelWorkerAbsent: () => false,
        }),
      ).toEqual({ outcome, chunks: 0, embedding: 'skipped' });
      expect(embed).not.toHaveBeenCalled();
    }
  });
  it('retains lexical success when policy denies embeddings or a model worker is absent', async () => {
    const parse = async () => ({ outcome: 'searchable' as const, chunks: 2 });
    expect(
      await runKnowledgeIngest({
        parse,
        embed: async () => ({ state: 'denied', count: 0 }),
        modelWorkerAbsent: () => false,
      }),
    ).toEqual({ outcome: 'searchable', chunks: 2, embedding: 'denied' });
    expect(
      await runKnowledgeIngest({
        parse,
        embed: async () => {
          throw new Error();
        },
        modelWorkerAbsent: () => true,
      }),
    ).toEqual({ outcome: 'searchable', chunks: 2, embedding: 'model_worker_absent' });
  });
  it('continues a sweep after individual failures and bounds both lists', async () => {
    const fetched: string[] = [];
    const refreshed: string[] = [];
    const result = await runKnowledgeSweep({
      close: async () => ({ closed: 2 }),
      list: async () => Array.from({ length: 100 }, (_, i) => ({ externalResourceId: String(i) })),
      fetch: async (id) => {
        fetched.push(id);
        if (id === '0') throw new Error();
        return { outcome: 'staged', bytes: 3 };
      },
      mcp: async () => Array.from({ length: 100 }, (_, i) => ({ connectionId: String(i) })),
      refresh: async (id) => {
        refreshed.push(id);
        if (id === '0') throw new Error();
      },
    });
    expect(fetched).toHaveLength(50);
    expect(refreshed).toHaveLength(50);
    expect(result).toEqual({ fetched: 49, closed: 2, failed: 2 });
  });
  it('bounds reindex work and stops waiting for a model worker after the first absence', async () => {
    let called = 0;
    const result = await runKnowledgeSweep({
      close: async () => ({ closed: 0 }),
      list: async () => [],
      fetch: async () => ({ outcome: 'unchanged', bytes: 0 }),
      mcp: async () => [],
      refresh: async () => undefined,
      documents: async () => Array.from({ length: 100 }, (_, i) => ({ documentId: String(i) })),
      embed: async () => {
        called++;
        throw new Error('ABSENT');
      },
      modelWorkerAbsent: () => true,
    });
    expect(called).toBe(1);
    expect(result.failed).toBe(1);
  });
  it('reindexes at most fifty documents while a failed document does not starve the next', async () => {
    let called = 0;
    const result = await runKnowledgeSweep({
      close: async () => ({ closed: 0 }),
      list: async () => [],
      fetch: async () => ({ outcome: 'unchanged', bytes: 0 }),
      mcp: async () => [],
      refresh: async () => undefined,
      documents: async () => Array.from({ length: 100 }, (_, i) => ({ documentId: String(i) })),
      embed: async () => ({ state: ++called === 1 ? 'failed' : 'embedded', count: 1 }),
      modelWorkerAbsent: () => false,
    });
    expect(called).toBe(50);
    expect(result.failed).toBe(1);
  });
  it('repairs at most fifty stale ingests without letting one failure starve later documents', async () => {
    let parsed = 0;
    const result = await runKnowledgeSweep({
      close: async () => ({ closed: 0 }),
      list: async () => [],
      fetch: async () => ({ outcome: 'unchanged', bytes: 0 }),
      mcp: async () => [],
      refresh: async () => undefined,
      pending: async () => Array.from({ length: 75 }, (_, i) => ({ documentId: String(i) })),
      parse: async () => ({ outcome: ++parsed === 1 ? 'failed' : 'searchable', chunks: 1 }),
    });
    expect(parsed).toBe(50);
    expect(result.failed).toBe(1);
  });
  it('requests at most five durable purge restarts and returns each operator-visible state', async () => {
    let retried = 0;
    const result = await runKnowledgeSweep({
      close: async () => ({ closed: 0 }),
      list: async () => [],
      fetch: async () => ({ outcome: 'unchanged', bytes: 0 }),
      mcp: async () => [],
      refresh: async () => undefined,
      purges: async () => Array.from({ length: 20 }, (_, i) => ({ sourceId: String(i) })),
      retryPurge: async () => ({ state: ++retried === 1 ? 'failed' : 'completed' }),
    });
    expect(retried).toBe(5);
    expect(result.failed).toBe(1);
    expect(result.purges).toHaveLength(5);
    expect(result.purges?.[0]).toEqual({ sourceId: '0', state: 'failed' });
  });

  // ADR-028 open question 12, lifecycle item 8a: the typed-record purge restart.
  describe('typed-record purge restarts', () => {
    const quiet = {
      close: async () => ({ closed: 0 }),
      list: async () => [],
      fetch: async () => ({ outcome: 'unchanged' as const, bytes: 0 }),
      mcp: async () => [],
      refresh: async () => undefined,
    };
    const org = '00000000-0000-4000-8000-000000000001';
    const record = (i: number) => ({
      organizationId: org,
      kind: 'work_unit' as const,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      limit: 25,
    });
    it('restarts each claimed record, at most five, and one failure does not stop the others', async () => {
      const retried: string[] = [];
      const result = await runKnowledgeSweep({
        ...quiet,
        recordPurges: async () => ({
          due: Array.from({ length: 8 }, (_, i) => record(i)),
          failed: 0,
        }),
        retryRecordPurge: async (child) => {
          retried.push(child.id);
          if (retried.length === 2) throw new Error('TEST_RECORD_PURGE_FAILED');
          return { state: retried.length === 3 ? 'unconfirmed' : 'completed' };
        },
      });
      expect(retried).toEqual([0, 1, 2, 3, 4].map((i) => record(i).id));
      expect(result.failed).toBe(1);
      expect(result.recordPurges).toEqual([
        { kind: 'work_unit', id: record(0).id, state: 'completed' },
        { kind: 'work_unit', id: record(1).id, state: 'failed' },
        { kind: 'work_unit', id: record(2).id, state: 'unconfirmed' },
        { kind: 'work_unit', id: record(3).id, state: 'completed' },
        { kind: 'work_unit', id: record(4).id, state: 'completed' },
      ]);
    });
    it('counts each candidate whose proof failed, and still restarts the due ones', async () => {
      const retried: string[] = [];
      const result = await runKnowledgeSweep({
        ...quiet,
        recordPurges: async () => ({ due: [record(7)], failed: 2 }),
        retryRecordPurge: async (child) => {
          retried.push(child.id);
          return { state: 'completed' };
        },
      });
      expect(retried).toEqual([record(7).id]);
      expect(result.failed).toBe(2);
      expect(result.recordPurges).toEqual([
        { kind: 'work_unit', id: record(7).id, state: 'completed' },
      ]);
    });
    it('counts a failed claim once and still reports the other work', async () => {
      const retry = vi.fn();
      const result = await runKnowledgeSweep({
        ...quiet,
        recordPurges: async () => {
          throw new Error('TEST_CLAIM_FAILED');
        },
        retryRecordPurge: retry,
      });
      expect(retry).not.toHaveBeenCalled();
      expect(result).toEqual({ fetched: 0, closed: 0, failed: 1, recordPurges: [] });
    });
    it('calls nothing when the ports are absent, as on a history recorded before the patch', async () => {
      const result = await runKnowledgeSweep(quiet);
      expect(result).toEqual({ fetched: 0, closed: 0, failed: 0 });
      expect(result).not.toHaveProperty('recordPurges');
    });
  });
});
