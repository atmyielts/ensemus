import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const LOCK_KEY = 7_236_001;

/**
 * Applies migrations exactly once. A session advisory lock makes concurrent jobs wait and then
 * find nothing to do, so replicas can never migrate at the same time.
 */
export async function runMigrations(url: string, migrationsFolder?: string) {
  const client = new pg.Client({ connectionString: url, application_name: 'ensemus-migrate' });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await migrate(drizzle(client), {
      migrationsFolder:
        migrationsFolder ?? fileURLToPath(new URL('../migrations', import.meta.url)),
    });
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}
