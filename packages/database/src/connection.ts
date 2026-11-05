import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type EnsemusDrizzle = NodePgDatabase<typeof schema>;

export function openDatabase(url: string, options: { max?: number } = {}) {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'ensemus',
  });
  // An idle client error must not crash the process; the next checkout gets a fresh connection.
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, close: () => pool.end() };
}
