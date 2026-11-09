// The real runIdempotent, under studioOnce, over a scripted database whose transactions commit or
// roll back. runIdempotent stores the key's response from the service's own transaction result, so a
// service that stops a run and returns nothing from that transaction must never commit the stop under a
// key it could not replay. That is how the stop route answered 500 with a TypeError before.
import { randomUUID } from 'node:crypto';
import { createServiceContext } from '@ensemus/database/service';
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import { withTenantTx } from '@ensemus/database';
import { describe, expect, it, vi } from 'vitest';

// Importing the real package from outside a server component throws, which is what it is for.
vi.mock('../../apps/web/node_modules/server-only/index.js', () => ({}));
// Only the route parameter shape is read from the API module, to extend for routes this does not
// call; the rest of that module starts a runtime.
vi.mock('../../apps/web/src/server/api', () => ({
  organizationParams: { extend: () => ({}) },
}));

const { studioOnce, studioResponse } = await import('../../apps/web/src/server/studio-api');

type Row = Record<string, unknown>;
type Scripted = { effect(name: string): void };

/** One stored key row and the writes each committed transaction made. A refusal keeps neither. */
function scriptedDatabase() {
  const keys: Row[] = [],
    effects: string[] = [];
  const database = {
    async transaction<T>(_bindings: Record<string, string>, fn: (tx: Tx) => Promise<T>) {
      const pendingKeys: Row[] = [],
        pendingEffects: string[] = [];
      const tx = {
        select: () => ({
          from: () => ({ where: async () => keys.map((row) => ({ ...row })) }),
        }),
        insert: () => ({
          values: (row: Row) => ({
            onConflictDoNothing: () => ({
              returning: async () => {
                pendingKeys.push({
                  requestHash: row.requestHash,
                  status: row.responseStatus,
                  body: row.responseBody,
                });
                return [{ key: row.key }];
              },
            }),
          }),
        }),
        effect: (name: string) => pendingEffects.push(name),
      };
      const result = await fn(tx as unknown as Tx);
      keys.push(...pendingKeys);
      effects.push(...pendingEffects);
      return result;
    },
  } as unknown as AppDatabase;
  return { database, keys, effects };
}

const person = (): TenantContext => ({
  ...createServiceContext(randomUUID()),
  actorType: 'user',
  userId: randomUUID(),
  membershipId: randomUUID(),
  role: 'owner',
});

/** A service in the shape runIdempotent requires: one transaction, whose result is the service's. */
const service =
  (context: TenantContext, result: unknown) =>
  (db: AppDatabase): Promise<{ id: string }> =>
    withTenantTx(db, context, async (tx) => {
      (tx as unknown as Scripted).effect('stop');
      return result as { id: string };
    });

describe('a Studio write stored under an idempotency key', () => {
  it('stores and replays the record its transaction names', async () => {
    const { database, keys, effects } = scriptedDatabase(),
      context = person(),
      runId = randomUUID(),
      key = randomUUID(),
      input = { runId, expectedVersion: 1 };
    await expect(
      studioOnce(
        database,
        context,
        key,
        'process-run.stop',
        input,
        service(context, { id: runId }),
        202,
      ),
    ).resolves.toBe(runId);
    expect(keys).toEqual([expect.objectContaining({ status: 202, body: { id: runId } })]);
    expect(effects).toEqual(['stop']);
    // The same key and body replays the stored answer, without doing the effect again.
    await expect(
      studioOnce(
        database,
        context,
        key,
        'process-run.stop',
        input,
        service(context, { id: runId }),
        202,
      ),
    ).resolves.toBe(runId);
    expect(effects).toEqual(['stop']);
    // The same key with other details is refused, and does nothing.
    await expect(
      studioOnce(
        database,
        context,
        key,
        'process-run.stop',
        { runId, expectedVersion: 2 },
        service(context, { id: runId }),
        202,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(effects).toEqual(['stop']);
  });

  it.each([
    ['nothing, as the stop service did', undefined],
    ['a record under another name, as the catalog install did', { specId: randomUUID() }],
    ['something that is not a record identity', { id: 'not-an-id' }],
  ])('rolls the effect back when the transaction returns %s', async (_name, result) => {
    const { database, keys, effects } = scriptedDatabase(),
      context = person();
    await expect(
      studioOnce(
        database,
        context,
        randomUUID(),
        'process-run.stop',
        { runId: randomUUID(), expectedVersion: 1 },
        service(context, result),
        202,
      ),
    ).rejects.toThrow('A Studio service must name its committed record in its transaction');
    expect(keys).toEqual([]);
    expect(effects).toEqual([]);
  });

  it('builds the stored response only from a record identity', () => {
    const id = randomUUID();
    expect(studioResponse(202)({ id, other: 'ignored' })).toEqual({ status: 202, body: { id } });
    for (const row of [undefined, null, 'text', {}, { id: 7 }])
      expect(() => studioResponse(201)(row)).toThrow();
  });
});
