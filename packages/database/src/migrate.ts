import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const LOCK_KEY = 7_236_001;

/**
 * Grants and policies for the one role that crosses tenants, which exists only where an operator created
 * it (ADR-035 D2). The function does nothing without the role, and repeating it changes nothing, so this
 * is also how an install that turns cross-organization work on later gets them. It may not exist yet at
 * all, on an earlier migration folder.
 */
async function applyBridgeGrants(client: pg.Client) {
  const { rows } = await client.query<{ fn: string | null }>(
    `select to_regprocedure('federation.apply_bridge_grants()')::text as fn`,
  );
  if (rows[0]?.fn) await client.query('select federation.apply_bridge_grants()');
}

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
    await applyBridgeGrants(client);
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}
