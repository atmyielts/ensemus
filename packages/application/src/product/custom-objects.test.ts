// A custom object write refused only because a purge held a row it needed did nothing, and the caller
// hears that the tenant is busy. It is not told that someone else changed the record (ADR-028 item 8a:
// a record deletion starts a purge that holds the organization row; 0533 birth fence, FOR SHARE NOWAIT).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createObjectRecord, linkObjectRecords, updateObjectRecord } from './custom-objects';

const context = createServiceContext(randomUUID());
const refusing = (code: string, error = new Error('Private SQL', { cause: { code } })) => ({
  error,
  database: {
    transaction: async () => {
      throw error;
    },
  } as unknown as AppDatabase,
});
const writes = {
  create: (database: AppDatabase) =>
    createObjectRecord(database, context, {
      typeId: randomUUID(),
      displayName: 'Generated',
      attributes: {},
    }),
  update: (database: AppDatabase) =>
    updateObjectRecord(database, context, {
      recordId: randomUUID(),
      expectedVersion: 1,
      displayName: 'Generated',
    }),
  link: (database: AppDatabase) =>
    linkObjectRecords(database, context, {
      relationKey: 'related',
      fromRecordId: randomUUID(),
      toRecordId: randomUUID(),
    }),
};

describe('custom object writes refused by lock contention', () => {
  it.each(Object.entries(writes))('%s answers TENANT_BUSY for 55P03', async (_, write) => {
    await expect(write(refusing('55P03').database)).rejects.toMatchObject({
      code: 'TENANT_BUSY',
      message:
        'This organization is busy with another change right now, so nothing was changed. Try again in a moment.',
    });
  });

  it('still answers VERSION_CONFLICT for a real conflict the database reports', async () => {
    for (const code of ['23505', 'EN407'])
      await expect(writes.link(refusing(code).database)).rejects.toMatchObject({
        code: 'VERSION_CONFLICT',
      });
  });

  it('preserves an unrelated database failure as it was', async () => {
    const { error, database } = refusing('40001');
    await expect(writes.create(database)).rejects.toBe(error);
  });
});
