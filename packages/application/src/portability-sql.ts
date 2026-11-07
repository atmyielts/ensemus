import type { Tx } from '@ensemus/database';
import type { SQL } from 'drizzle-orm';

/** Node-postgres returns a result object, including for an empty result set. */
export async function queryRows<T extends Record<string, unknown>>(
  tx: Tx,
  query: SQL,
): Promise<T[]> {
  return (await tx.execute<T>(query)).rows as T[];
}
