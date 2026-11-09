// ADR-028 open question 12, lifecycle item 8a, and ADR-030 D8: an imported tombstone's date. A scripted
// transaction checks what is written only; PostgreSQL behaviour (one record_closed event for a
// future-dated archive deletion) is in tests/integration/record-deletion-outbox.test.ts.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { tombstones, type Tx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { recordImportedTombstone } from './portability-sections-import';

const dialect = new PgDialect();
const context = createServiceContext(randomUUID());

/** A transaction whose tombstone insert finds the row already there, so nothing after it runs. */
function scriptedTx() {
  const inserted: { table: unknown; values: Record<string, unknown> }[] = [];
  const tx = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserted.push({ table, values });
        return { onConflictDoNothing: () => ({ returning: async () => [] }) };
      },
    }),
    execute: async () => {
      throw new Error('TEST_UNUSED');
    },
  } as unknown as Tx;
  return { tx, inserted };
}

const createdAtOf = (values: Record<string, unknown> | undefined) =>
  dialect.sqlToQuery(values?.createdAt as SQL);

describe('an imported tombstone’s date', () => {
  it('clamps a future-dated archive deletion to the transaction’s now()', async () => {
    const { tx, inserted } = scriptedTx(),
      deletedAt = new Date(Date.now() + 86_400_000);
    expect(
      await recordImportedTombstone(tx, context, {
        targetType: 'client',
        targetId: randomUUID(),
        deletedAt,
      }),
    ).toBe(false);
    expect(inserted.map((row) => row.table)).toEqual([tombstones]);
    expect(createdAtOf(inserted[0]?.values)).toMatchObject({
      sql: 'least($1::timestamptz, now())',
      params: [deletedAt.toISOString()],
    });
  });

  it('keeps a past deletion’s own time, through the same clamp', async () => {
    const { tx, inserted } = scriptedTx(),
      deletedAt = new Date('2024-03-01T12:00:00.000Z');
    await recordImportedTombstone(tx, context, {
      targetType: 'work_unit',
      targetId: randomUUID(),
      deletedAt,
    });
    expect(createdAtOf(inserted[0]?.values)).toMatchObject({
      sql: 'least($1::timestamptz, now())',
      params: ['2024-03-01T12:00:00.000Z'],
    });
  });

  it('refuses a deletion time that is not a date, and writes nothing', async () => {
    const { tx, inserted } = scriptedTx();
    await expect(
      recordImportedTombstone(tx, context, {
        targetType: 'client',
        targetId: randomUUID(),
        deletedAt: new Date('not a date'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(inserted).toEqual([]);
  });
});
