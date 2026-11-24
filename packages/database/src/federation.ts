// The bridge (ADR-035 D2). The only code that connects as `ensemus_federation`, the one role that writes to
// one tenant from another. Lint keeps this out of everything except the federation worker and its
// Activities. Each transaction binds one grant, and the role's policies see nothing outside it.
import { sql } from 'drizzle-orm';
import { openDatabase, type EnsemusDrizzle } from './connection';
import { createServiceContext, withTenantTx, type AppDatabase, type Tx } from './tenant';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** No other way to use this connection exists, so there is no query that runs with no grant bound. */
export class BridgeDatabase {
  readonly #db: EnsemusDrizzle;
  constructor(db: EnsemusDrizzle) {
    this.#db = db;
  }
  /** Binds one grant. Keep it short: bytes are copied before this, and never inside it. */
  withGrant<T>(grantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID.test(grantId)) throw new Error('INVALID_GRANT_ID');
    return this.#db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.federation_grant_id', ${grantId.toLowerCase()}, true)`,
      );
      return fn(tx);
    });
  }
}

export function openBridgeDatabase(url: string) {
  const { db, close } = openDatabase(url, { max: 2 });
  return { db: new BridgeDatabase(db), close };
}

// Startup checks run under the two installed logins, without binding to a business record.
const STARTUP_PROBE_ID = '00000000-0000-4000-8000-000000000000';

export async function federationSenderReady(db: AppDatabase): Promise<boolean> {
  const result = await withTenantTx(db, createServiceContext(STARTUP_PROBE_ID), (tx) =>
    tx.execute<{ ready: boolean }>(sql`
      select session_user = 'ensemus_worker' and current_user = session_user
        and exists(select 1 from tenancy.deployment_profile where cross_org_enabled) as ready
    `),
  );
  return result.rows[0]?.ready === true;
}

export async function federationBridgeReady(db: BridgeDatabase): Promise<boolean> {
  const result = await db.withGrant(STARTUP_PROBE_ID, (tx) =>
    tx.execute<{ ready: boolean }>(sql`
      select session_user = 'ensemus_federation' and current_user = session_user
        and exists (select 1 from pg_roles r where r.rolname = session_user and r.rolcanlogin
          and not (r.rolinherit or r.rolsuper or r.rolbypassrls or
                   r.rolcreatedb or r.rolcreaterole or r.rolreplication)
          and not exists (select 1 from pg_auth_members where member = r.oid or roleid = r.oid))
        and has_table_privilege('federation.outbound_items', 'SELECT')
        and has_column_privilege('federation.inbound_items', 'id', 'SELECT')
        and not has_column_privilege('federation.inbound_items', 'body', 'SELECT')
        and has_table_privilege('federation.inbound_items', 'INSERT')
        and has_table_privilege('federation.inbound_items', 'DELETE')
        and has_table_privilege('federation.crossings', 'INSERT')
        and not exists (
          select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'work' and c.relname in ('work_units', 'artifacts')
            and has_any_column_privilege(c.oid, 'SELECT')
        )
        and exists(select 1 from tenancy.deployment_profile where cross_org_enabled) as ready
    `),
  );
  return result.rows[0]?.ready === true;
}

export * from './federation-crossing';
