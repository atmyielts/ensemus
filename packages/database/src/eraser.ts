// For the operator's erase command only (lint blocks everything else). `ensemus_eraser` can delete and count a
// tenant's content, and read nothing but the tenant column, and only while that tenant's offboarding is
// `erasing` with no hold active (ADR-032 D7). Owned by the offboarding slice. See docs/06-delivery/m8-slices.md.
import { openDatabase, type EnsemusDrizzle } from './connection';
import { sql } from 'drizzle-orm';
import type { Tx } from './tenant';

const tableName = (value: string) => {
  const parts = value.split('.');
  if (parts.length !== 2 || parts.some((part) => !/^[_a-z][_a-z0-9]*$/.test(part)))
    throw new Error('ERASURE_TABLE_INVALID');
  return sql`${sql.identifier(parts[0]!)}.${sql.identifier(parts[1]!)}`;
};
const number = (value: unknown) => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value)))
    throw new Error('ERASURE_COUNT_INVALID');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('ERASURE_COUNT_INVALID');
  return result;
};
async function assertRole(tx: Tx) {
  const result = await tx.execute(sql`select current_user as role`);
  if (result.rows[0]?.role !== 'ensemus_eraser') throw new Error('ERASURE_ROLE_REQUIRED');
}
async function assertOpen(tx: Tx, organizationId: string) {
  await assertRole(tx);
  const result = await tx.execute(
    sql`select app.current_organization_id()=${organizationId}::uuid and lifecycle.lock_erasure_tenant() as allowed`,
  );
  if (result.rows[0]?.allowed !== true) throw new Error('ERASURE_NOT_OPEN');
}
async function countRows(tx: Tx, table: string, organizationId: string) {
  const result = await tx.execute(
    sql`select count(*)::text as n from ${tableName(table)} where organization_id=${organizationId}::uuid`,
  );
  return number(result.rows[0]?.n);
}
function codeOf(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined;
  return 'code' in error ? error.code : 'cause' in error ? codeOf(error.cause) : undefined;
}

export function openEraserDatabase(url: string) {
  return openDatabase(url, { max: 1 });
}

export type ErasedTable = { tableRef: string; rowsRemoved: number; rowsLeft: number };

/** Every table this role reaches, as `schema.table`. Read from the catalog, so it cannot go stale. */
export async function listErasableTables(db: EnsemusDrizzle): Promise<readonly string[]> {
  return db.transaction(async (tx) => {
    await assertRole(tx);
    const result = await tx.execute(
      sql`select n.nspname||'.'||c.relname as table_ref,has_table_privilege(current_user,c.oid,'DELETE') as granted from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attname='organization_id' and not a.attisdropped where c.relkind in ('r','p') and not c.relispartition and n.nspname not like 'pg_%' and n.nspname<>'information_schema' and not lifecycle.retained_table(n.nspname::text,c.relname::text) order by n.nspname,c.relname`,
    );
    return result.rows.map((row) => {
      if (typeof row.table_ref !== 'string' || row.granted !== true)
        throw new Error('ERASURE_GRANTS_INCOMPLETE');
      tableName(row.table_ref);
      return row.table_ref;
    });
  });
}

/**
 * Deletes one tenant's rows, table by table, each in its own transaction binding that tenant, and passes over
 * the list again until nothing moves, since foreign keys order them. A table it cannot empty counts as left
 * over, and is reported rather than forced. Counting is from the role's own view, after deleting.
 */
export async function eraseTenantRows(
  db: EnsemusDrizzle,
  organizationId: string,
): Promise<readonly ErasedTable[]> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      organizationId,
    )
  )
    throw new Error('ERASURE_TENANT_INVALID');
  const tables = await listErasableTables(db),
    result = new Map<string, ErasedTable>(
      tables.map((tableRef) => [tableRef, { tableRef, rowsRemoved: 0, rowsLeft: 0 }]),
    );
  for (;;) {
    let moved = 0;
    for (const table of tables) {
      const page = await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.organization_id',${organizationId},true)`);
        await assertOpen(tx, organizationId);
        let removed = 0;
        try {
          removed = await tx.transaction(async (save) => {
            const deletion = await save.execute(
              sql`delete from ${tableName(table)} where organization_id=${organizationId}::uuid`,
            );
            return number(deletion.rowCount);
          });
        } catch (error) {
          if (codeOf(error) !== '23503') throw error;
        }
        // RLS may hide everything when a hold appears. Check the authority again before trusting a zero.
        await assertOpen(tx, organizationId);
        return { removed, left: await countRows(tx, table, organizationId) };
      });
      const row = result.get(table)!;
      row.rowsRemoved += page.removed;
      row.rowsLeft = page.left;
      moved += page.removed;
    }
    if (!moved) break;
  }
  return [...result.values()];
}
