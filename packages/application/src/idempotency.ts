// Idempotency keys for public API writes (API-12). One key belongs to one person in one tenant, and
// its row is written in the same transaction as the work it describes. So a crash leaves either both
// or neither, a failed request stores nothing and can be retried, and two racing requests produce
// one result: the second blocks on the first's key, and then rolls back and replays it.
import { createHash } from 'node:crypto';
import {
  idempotencyKeys,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from './errors';

const keySchema = z.string().min(8).max(128);

export type StoredResponse = { status: number; body: unknown };

export type IdempotentOutcome =
  | ({ kind: 'fresh' | 'replayed' } & StoredResponse)
  /** This key was already used for a different request. Nothing was done. */
  | { kind: 'conflict' };

/** Identifies a request. The parts are encoded so that no two different lists hash the same. */
export function requestHash(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Raised inside the transaction to roll back the losing side of a race. Never leaves this file. */
class KeyAlreadyStored extends Error {
  override name = 'KeyAlreadyStored';
}

/**
 * Runs `perform` once per key. `perform` receives a database handle and passes it to one service,
 * which must open exactly one transaction and return that transaction's result: the key row joins
 * that transaction, so services stay unaware of idempotency. A service that opens a second
 * transaction is refused, because the key could not cover it.
 */
export async function runIdempotent<R>(
  database: AppDatabase,
  context: TenantContext,
  request: { key: string; requestHash: string },
  perform: (database: AppDatabase) => Promise<R>,
  toResponse: (result: R) => StoredResponse,
): Promise<IdempotentOutcome> {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  const parsed = keySchema.safeParse(request.key);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const key = parsed.data;

  const earlier = await findStored(database, context, key);
  if (earlier) return replay(earlier, request.requestHash);

  const committed: { response?: StoredResponse } = {};
  let opened = false;
  const joined = {
    transaction<T>(bindings: Record<string, string>, fn: (tx: Tx) => Promise<T>): Promise<T> {
      if (opened) throw new Error('An idempotent service must use one transaction');
      opened = true;
      return database.transaction(bindings, async (tx) => {
        const result = await fn(tx);
        const response = toResponse(result as unknown as R);
        const stored = await tx
          .insert(idempotencyKeys)
          .values({
            organizationId: context.organizationId,
            membershipId: context.membershipId,
            key,
            requestHash: request.requestHash,
            responseStatus: response.status,
            responseBody: response.body,
          })
          .onConflictDoNothing()
          .returning({ key: idempotencyKeys.key });
        if (stored.length === 0) throw new KeyAlreadyStored();
        committed.response = response;
        return result;
      });
    },
  } as unknown as AppDatabase;

  try {
    await perform(joined);
  } catch (error) {
    if (!(error instanceof KeyAlreadyStored)) throw error;
    const winner = await findStored(database, context, key);
    if (!winner) throw error;
    return replay(winner, request.requestHash);
  }
  if (!committed.response) throw new Error('An idempotent service must use one transaction');
  return { kind: 'fresh', ...committed.response };
}

function findStored(database: AppDatabase, context: TenantContext, key: string) {
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .select({
        requestHash: idempotencyKeys.requestHash,
        status: idempotencyKeys.responseStatus,
        body: idempotencyKeys.responseBody,
      })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.organizationId, context.organizationId),
          eq(idempotencyKeys.membershipId, context.membershipId),
          eq(idempotencyKeys.key, key),
        ),
      );
    return row;
  });
}

function replay(
  row: { requestHash: string; status: number; body: unknown },
  hash: string,
): IdempotentOutcome {
  if (row.requestHash !== hash) return { kind: 'conflict' };
  return { kind: 'replayed', status: row.status, body: row.body };
}
