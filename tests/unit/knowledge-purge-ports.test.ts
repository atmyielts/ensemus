// Actual factory/metadata adapters with an explicit SQL double. This checks absence of a successful
// lifecycle default, not real RLS, writer quiescence, legal holds or physical storage deletion.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { artifactLineage, knowledgeSources, type AppDatabase, type Tx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createKnowledgePurgePorts } from '../../workers/workflow/src/knowledge-ports';

function fixture(unconfirmed=0) {
  const queries: string[] = [],
    context = createServiceContext(randomUUID());
  const chain = (rows: unknown[]): unknown =>
    new Proxy(
      {},
      {
        get(_target, key) {
          if (key === 'then') return (resolve: (value: unknown[]) => void) => resolve(rows);
          return () => chain(rows);
        },
      },
    );
  const tx = {
    select: () => ({
      from(table: PgTable) {
        if (table === knowledgeSources) return chain([{ state: 'deleted' }]);
        if (table === artifactLineage) return chain([]);
        throw new Error('GENERATED_UNSCRIPTED_TABLE');
      },
    }),
    execute: async (query: SQL) => {
      const text = new PgDialect().sqlToQuery(query).sql;
      queries.push(text);
      if (text.includes('lifecycle.object_delete_counts')) return {rows:[{unconfirmed}]};
      if (text.includes('knowledge.derived_artifacts_remaining'))
        return { rows: [{ remaining: 0 }] };
      if (text.includes('count(*) filter') && text.includes('artifact_lineage'))
        return { rows: [{ removed: 0, held: 0 }] };
      if (text.includes('sovereign.archive_file_inventory')) return { rows: [] };
      if (text.includes('sovereign.archive_file_counts'))
        return { rows: [{ removed: 0, remaining: 0, held: 0 }] };
      throw new Error('GENERATED_UNSCRIPTED_SQL');
    },
  } as unknown as Tx;
  const database = {
    transaction: async <T>(bindings: Record<string, string>, run: (inner: Tx) => Promise<T>) => {
      expect(bindings['app.organization_id']).toBe(context.organizationId);
      expect(bindings['app.actor_type']).toBe('service');
      return run(tx);
    },
  } as unknown as AppDatabase;
  const store = {
    put: vi.fn(async () => {}),
    get: vi.fn(async () => Buffer.alloc(0)),
    exists: vi.fn(async () => false),
    delete: vi.fn(async () => {}),
  };
  return { context, queries, database, store, tx };
}
describe('knowledge worker actual purge factory', () => {
  it('constructs both real metadata adapters without I/O or a successful lifecycle default', async () => {
    const f = fixture(),
      ports = createKnowledgePurgePorts({ database: f.database, store: f.store });
    expect(f.queries).toEqual([]);
    expect(
      await ports.derivedArtifacts.purgeSource(f.context, { sourceId: randomUUID(), limit: 25 }),
    ).toEqual({ removed: 0, remaining: 0, held: 0, confirmed: false });
    expect(f.queries.some((query) => query.includes('knowledge.derived_artifacts_remaining'))).toBe(
      true,
    );
    expect(f.queries.some((query) => query.includes('sovereign.archive_file_inventory'))).toBe(
      true,
    );
    expect(f.queries.some((query) => query.includes('sovereign.archive_file_counts'))).toBe(true);
    expect(f.store.put).not.toHaveBeenCalled();
    expect(f.store.delete).not.toHaveBeenCalled();
    expect(f.store.get).not.toHaveBeenCalled();
    expect(f.store.exists).not.toHaveBeenCalled();
  });
  it('refuses completed-job final confirmation when either actual lifecycle is absent', async () => {
    const f = fixture(),
      unavailable = { erase: async () => ({ state: 'unconfirmed' as const }) };
    const setups = [
      () => createKnowledgePurgePorts({ database: f.database, store: f.store }),
      () =>
        createKnowledgePurgePorts({
          database: f.database,
          store: f.store,
          derivedLifecycle: unavailable,
        }),
      () =>
        createKnowledgePurgePorts({
          database: f.database,
          store: f.store,
          archiveLifecycle: unavailable,
        }),
    ];
    for (const setup of setups) {
      const ports = setup();
      await expect(
        ports.derivedArtifacts.confirmInTx(f.tx, f.context, { sourceId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await expect(
        ports.derivedArtifacts.confirmRecordInTx(f.tx, f.context, {
          kind: 'client',
          id: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    }
    expect(f.queries).toEqual([]);
  });
  it('reads both actual final metadata adapters when both lifecycle ports are explicitly supplied', async () => {
    const f = fixture(),
      unavailable = { erase: async () => ({ state: 'unconfirmed' as const }) };
    const ports = createKnowledgePurgePorts({
      database: f.database,
      store: f.store,
      derivedLifecycle: unavailable,
      archiveLifecycle: unavailable,
    });
    expect(
      await ports.derivedArtifacts.confirmInTx(f.tx, f.context, { sourceId: randomUUID() }),
    ).toEqual({ remaining: 0 });
    expect(f.queries.some((query) => query.includes('knowledge.derived_artifacts_remaining'))).toBe(
      true,
    );
    expect(f.queries.some((query) => query.includes('sovereign.archive_file_counts'))).toBe(true);
    expect(f.store.delete).not.toHaveBeenCalled();
  });
  it('refuses an old completed-job path when retained delete/restore debt remains',async()=>{
    const f=fixture(1), unavailable={erase:async()=>({state:'unconfirmed' as const})};
    const ports=createKnowledgePurgePorts({database:f.database,store:f.store,derivedLifecycle:unavailable,archiveLifecycle:unavailable});
    await expect(ports.derivedArtifacts.confirmInTx(f.tx,f.context,{sourceId:randomUUID()})).rejects.toMatchObject({code:'OBJECT_DELETE_UNCONFIRMED'});
    expect(f.queries.some((query)=>query.includes('knowledge.derived_artifacts_remaining'))).toBe(false);
    expect(f.store.delete).not.toHaveBeenCalled();
  });
});
