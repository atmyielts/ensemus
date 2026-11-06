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
});
