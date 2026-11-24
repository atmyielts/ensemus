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
  if (!rows[0]?.fn) return false;
  const grants = await client.query<{ available: boolean }>(
    'select federation.apply_bridge_grants() as available',
  );
  return grants.rows[0]?.available === true;
}

/**
 * Applies migrations exactly once. A session advisory lock makes concurrent jobs wait and then
 * find nothing to do, so replicas can never migrate at the same time.
 */
export async function runMigrations(
  url: string,
  migrationsFolder?: string,
  options: { requireFederationRole?: boolean } = {},
) {
  const client = new pg.Client({ connectionString: url, application_name: 'ensemus-migrate' });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    if (options.requireFederationRole) {
      const { rows } = await client.query<{ ready: boolean }>(`
        select exists (
          select 1 from pg_roles r
          where r.rolname = 'ensemus_federation' and r.rolcanlogin
            and not (r.rolinherit or r.rolsuper or r.rolbypassrls or
                     r.rolcreatedb or r.rolcreaterole or r.rolreplication)
            and not exists (select 1 from pg_auth_members where member = r.oid or roleid = r.oid)
        ) as ready
      `);
      if (rows[0]?.ready !== true) {
        const error = new Error('Provision the restricted federation role before enabling it.');
        error.name = 'FEDERATION_ROLE_NOT_PROVISIONED';
        throw error;
      }
    }
    await migrate(drizzle(client), {
      migrationsFolder:
        migrationsFolder ?? fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    const bridgeAvailable = await applyBridgeGrants(client);
    if (options.requireFederationRole && !bridgeAvailable) {
      const error = new Error(
        'The database installation is missing the federation grant function.',
      );
      error.name = 'FEDERATION_GRANTS_NOT_AVAILABLE';
      throw error;
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}
