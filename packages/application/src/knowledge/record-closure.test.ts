// ADR-028 open question 12, lifecycle item 8a. A scripted transaction exercises the event's shape and
// input checks only; PostgreSQL behaviour is in tests/integration/record-deletion-outbox.test.ts.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { domainEvents, outboxEvents, type Tx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { emitRecordClosedInTx, listRecordPurgeCandidates } from './record-closure';

function scriptedTx(existing: readonly { id: string }[] = []) {
  const inserted: { table: unknown; values: Record<string, unknown> }[] = [];
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => existing,
  };
  const tx = {
    select: () => chain,
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        inserted.push({ table, values });
      },
    }),
  } as unknown as Tx;
  return { tx, inserted };
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

  it('writes nothing again for a record whose event already exists', async () => {
    const { tx, inserted } = scriptedTx([{ id: randomUUID() }]);
    expect(await emitRecordClosedInTx(tx, context, { kind: 'work_unit', id: randomUUID() })).toBe(
      false,
    );
    expect(inserted).toEqual([]);
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
