// ADR-028 open question 12, lifecycle item 8a. A scripted transaction exercises the event's shape and
// input checks only; PostgreSQL behaviour is in tests/integration/record-deletion-outbox.test.ts.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { domainEvents, outboxEvents, type Tx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  emitRecordClosedInTx,
  listRecordPurgeCandidates,
  recordRecordPurgeCompletionInTx,
} from './record-closure';

/**
 * A transaction whose first statement is the per-record advisory lock and whose second answers how many
 * events exist for the record and whether one is at least as new as its tombstone (this closure's).
 */
function scriptedTx(prior: { written: number; current: boolean } = { written: 0, current: false }) {
  const inserted: { table: unknown; values: Record<string, unknown> }[] = [];
  const statements: string[] = [];
  const tx = {
    execute: async (query: { queryChunks?: unknown[] }) => {
      const text = (() => {
        try {
          return JSON.stringify(query.queryChunks ?? query);
        } catch {
          return '';
        }
      })();
      statements.push(text.includes('pg_advisory_xact_lock') ? 'lock' : 'prior');
      return { rows: statements.length === 1 ? [] : [prior] };
    },
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        inserted.push({ table, values });
      },
    }),
  } as unknown as Tx;
  return { tx, inserted, statements };
}
const context = createServiceContext(randomUUID());

describe('the typed-record deletion event', () => {
  it('writes one restricted event with an IDs-only payload, and its outbox row', async () => {
    const { tx, inserted } = scriptedTx(),
      id = randomUUID();
    expect(await emitRecordClosedInTx(tx, context, { kind: 'client', id })).toBe(true);
    expect(inserted.map((row) => row.table)).toEqual([domainEvents, outboxEvents]);
    expect(inserted[0]?.values).toMatchObject({
      organizationId: context.organizationId,
      eventType: 'knowledge.record_closed',
      aggregateType: 'client',
      aggregateId: id,
      aggregateVersion: 1,
      classification: 'restricted',
      payload: { record_kind: 'client', record_id: id },
    });
    expect(Object.keys(inserted[0]?.values.payload as object).sort()).toEqual([
      'record_id',
      'record_kind',
    ]);
  });

  it('locks the record before it checks, then writes nothing again for this closure', async () => {
    const { tx, inserted, statements } = scriptedTx({ written: 1, current: true });
    expect(await emitRecordClosedInTx(tx, context, { kind: 'work_unit', id: randomUUID() })).toBe(
      false,
    );
    expect(statements).toEqual(['lock', 'prior']);
    expect(inserted).toEqual([]);
  });

  it('an earlier event older than the record’s closure (a forged or early one) does not suppress it', async () => {
    const { tx, inserted } = scriptedTx({ written: 1, current: false }),
      id = randomUUID();
    expect(await emitRecordClosedInTx(tx, context, { kind: 'work_unit', id })).toBe(true);
    expect(inserted.map((row) => row.table)).toEqual([domainEvents, outboxEvents]);
    expect(inserted[0]?.values).toMatchObject({ aggregateId: id, aggregateVersion: 2 });
  });

  it('refuses a kind a record purge does not cover and an ID that is not a UUID', async () => {
    for (const kind of ['artifact', 'knowledge_source', '', 'WORK_UNIT']) {
      const { tx, inserted } = scriptedTx();
      await expect(
        emitRecordClosedInTx(tx, context, {
          kind: kind as 'work_unit',
          id: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(inserted).toEqual([]);
    }
    const { tx, inserted } = scriptedTx();
    await expect(
      emitRecordClosedInTx(tx, context, { kind: 'project', id: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(inserted).toEqual([]);
  });

  it('lists purge candidates without a record that has a current completion (0554)', async () => {
    const statements: string[] = [];
    const database = {
      transaction: async (_config: unknown, fn: (tx: Tx) => Promise<unknown>) =>
        fn({
          execute: async (query: { queryChunks?: unknown[] }) => {
            statements.push(JSON.stringify(query.queryChunks ?? query));
            return { rows: [] };
          },
        } as unknown as Tx),
    } as unknown as Parameters<typeof listRecordPurgeCandidates>[0];
    expect(await listRecordPurgeCandidates(database, context, { limit: 5 })).toEqual([]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('not ai.record_purge_completed(');
  });

  it('lists purge candidates for a service context only, within a bounded page', async () => {
    const database = {} as Parameters<typeof listRecordPurgeCandidates>[0];
    const person = { ...context, actorType: 'user' } as typeof context;
    await expect(listRecordPurgeCandidates(database, person, { limit: 5 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    for (const limit of [0, 51, 1.5])
      await expect(listRecordPurgeCandidates(database, context, { limit })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
  });
});

describe('the durable record purge completion (0554)', () => {
  /** A transaction whose savepoint runs one statement, answered by `answer`. */
  function savepointTx(answer: () => Promise<{ rows: unknown[] }>) {
    const calls = { savepoints: 0, statements: [] as string[] };
    const inner = {
      execute: async (query: { queryChunks?: unknown[] }) => {
        calls.statements.push(JSON.stringify(query.queryChunks ?? query));
        return answer();
      },
    };
    const tx = {
      execute: async () => {
        throw new Error('TEST_OUTSIDE_SAVEPOINT');
      },
      transaction: async (fn: (savepoint: unknown) => Promise<unknown>) => {
        calls.savepoints += 1;
        return fn(inner);
      },
    } as unknown as Tx;
    return { tx, calls };
  }
  const pgError = (code: string) => Object.assign(new Error('pg'), { cause: { code } });

  it('asks PostgreSQL for the completion in a savepoint, passing no value of its own', async () => {
    const { tx, calls } = savepointTx(async () => ({ rows: [{ recorded: true }] }));
    expect(
      await recordRecordPurgeCompletionInTx(tx, context, {
        kind: 'object_record',
        id: randomUUID(),
      }),
    ).toBe(true);
    expect(calls.savepoints).toBe(1);
    expect(calls.statements).toHaveLength(1);
    // The value is PostgreSQL's own generation, and the row is the record's current snapshot's job.
    expect(calls.statements[0]).toContain(
      'set completed_restore_generation=ai.current_material_restore_generation()',
    );
    expect(calls.statements[0]).toContain('ai.lock_record_purge_snapshot(');
  });

  it('reports no completion when no job is the current snapshot’s, or when PostgreSQL refuses it', async () => {
    expect(
      await recordRecordPurgeCompletionInTx(savepointTx(async () => ({ rows: [] })).tx, context, {
        kind: 'work_unit',
        id: randomUUID(),
      }),
    ).toBe(false);
    // EN119: 0554's attestation found the composite proof incomplete. 55P03: a lock it needs is busy.
    for (const code of ['EN119', '55P03'])
      expect(
        await recordRecordPurgeCompletionInTx(
          savepointTx(async () => {
            throw pgError(code);
          }).tx,
          context,
          { kind: 'work_unit', id: randomUUID() },
        ),
      ).toBe(false);
  });

  it('throws any other failure, such as a refused role, instead of hiding it', async () => {
    await expect(
      recordRecordPurgeCompletionInTx(
        savepointTx(async () => {
          throw pgError('42501');
        }).tx,
        context,
        { kind: 'client', id: randomUUID() },
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('refuses a person, a kind a record purge does not cover and a non-UUID before any statement', async () => {
    const person = { ...context, actorType: 'user' } as typeof context;
    const { tx, calls } = savepointTx(async () => ({ rows: [{ recorded: true }] }));
    await expect(
      recordRecordPurgeCompletionInTx(tx, person, { kind: 'client', id: randomUUID() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      recordRecordPurgeCompletionInTx(tx, context, {
        kind: 'artifact' as 'client',
        id: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      recordRecordPurgeCompletionInTx(tx, context, { kind: 'client', id: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls).toEqual({ savepoints: 0, statements: [] });
  });
});
