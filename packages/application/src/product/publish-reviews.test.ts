// The idempotent publication contract only, against a scripted query sequence. PostgreSQL guards, RLS and
// the real lock order are proved by tests/stack/studio.test.ts and tests/integration/studio-publishing.test.ts.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveTenantContext, type AppDatabase, type TenantContext } from '@ensemus/database';
import { requestHash, runIdempotent } from '../idempotency';
import { unavailablePorts } from './ports';
import { publishApproved } from './publish-reviews';

/** Every query answers the next scripted result, in order. An unscripted query fails the test. */
function scriptedDatabase(results: unknown[]) {
  const operations: string[] = [];
  const next = (operation: string) => {
    operations.push(operation);
    if (results.length === 0) throw new Error(`TEST_UNSCRIPTED_QUERY:${operation}`);
    return results.shift();
  };
  const chain = (operation: string): unknown => {
    let taken = false,
      value: unknown;
    const proxy: unknown = new Proxy(function builder() {}, {
      get(_target, property) {
        if (property !== 'then') return () => proxy;
        return (resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
          try {
            if (!taken) {
              value = next(operation);
              taken = true;
            }
            resolve(value);
          } catch (error) {
            reject(error);
          }
        };
      },
    });
    return proxy;
  };
  const tx = {
    select: () => chain('select'),
    insert: () => chain('insert'),
    update: () => chain('update'),
    execute: async () => next('execute'),
  };
  const database = {
    transaction: async (_bindings: unknown, fn: (scripted: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as AppDatabase;
  return { database, operations };
}

async function owner(organizationId: string): Promise<TenantContext> {
  const { database } = scriptedDatabase([
    [{ id: randomUUID(), role: 'owner', organizationId, lifecycle: 'active' }],
  ]);
  return resolveTenantContext(database, randomUUID(), organizationId);
}

/** The same wrapping the publication route and the native form use through studioOnce. */
function publishOnce(database: AppDatabase, context: TenantContext, reviewId: string) {
  const input = { reviewId, expectedVersion: 3 };
  return runIdempotent(
    database,
    context,
    {
      key: randomUUID(),
      requestHash: requestHash(['publish-review.publish', JSON.stringify(input)]),
    },
    (db) => publishApproved(db, context, unavailablePorts(), null, input),
    (row) => ({ status: 200, body: { id: row.id } }),
  );
}

describe('publication receipt stored by an idempotent request', () => {
  it('names the published review, so the stored response is the review and not an empty id', async () => {
    const organizationId = randomUUID(),
      context = await owner(organizationId),
      reviewId = randomUUID(),
      publishedRef = randomUUID();
    const { database, operations } = scriptedDatabase([
      [], // no earlier use of this key
      { rows: [] }, // interactive policy lock
      [{ role: 'owner' }], // the publisher is still a current owner
      { rows: [{ allowed: true }] }, // recent second factor
      [{ id: reviewId, status: 'published', publishedRef }], // already-published receipt
      [{ key: 'stored' }], // the idempotency row joins the same transaction
    ]);
    const outcome = await publishOnce(database, context, reviewId);
    expect(outcome).toEqual({ kind: 'fresh', status: 200, body: { id: reviewId } });
    expect(operations).toEqual(['select', 'execute', 'select', 'execute', 'select', 'insert']);
  });

  it('stores nothing when the second factor is not recent', async () => {
    const organizationId = randomUUID(),
      context = await owner(organizationId);
    const { database, operations } = scriptedDatabase([
      [],
      { rows: [] },
      [{ role: 'owner' }],
      { rows: [{ allowed: false }] },
    ]);
    await expect(publishOnce(database, context, randomUUID())).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
    });
    expect(operations).not.toContain('insert');
    expect(operations).not.toContain('update');
  });
});
