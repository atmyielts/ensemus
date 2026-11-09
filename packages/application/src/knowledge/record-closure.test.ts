// ADR-028 open question 12, lifecycle item 8a. A scripted transaction exercises the event's shape and
// input checks only; PostgreSQL behaviour is in tests/integration/record-deletion-outbox.test.ts.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { domainEvents, outboxEvents, type Tx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { emitRecordClosedInTx, listRecordPurgeCandidates } from './record-closure';

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
