// For the operator's erase command only (lint blocks everything else). `ensemus_eraser` can delete and count a
// tenant's content, and read nothing but the tenant column, and only while that tenant's offboarding is
// `erasing` with no hold active (ADR-032 D7). Owned by the offboarding slice. See docs/06-delivery/m8-slices.md.
import { openDatabase, type EnsemusDrizzle } from './connection';
import { sql } from 'drizzle-orm';
import { AppDatabase, createServiceContext, withTenantTx, type Tx } from './tenant';

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
  const result = await tx.execute(sql`select current_user as role,session_user as login`);
  if (result.rows[0]?.role !== 'ensemus_eraser' || result.rows[0]?.login !== 'ensemus_eraser')
    throw new Error('ERASURE_ROLE_REQUIRED');
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
 * Deletes one tenant's rows under the native service control binding. Most tables have independent
 * transactions; the exact reciprocal delegated-proof FK group must commit together. Repeated passes
 * resolve remaining FK order without disabling any constraint or proof guard. A blocked group rolls
 * back in full and is counted again under current authority, including a deferred COMMIT failure.
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
  const reciprocal = [
    'ai.delegated_input_refs',
    'ai.delegated_input_receipts',
    'ai.delegated_work_births',
  ];
  const present = reciprocal.filter((table) => tables.includes(table));
  if (present.length !== 0 && present.length !== reciprocal.length)
    throw new Error('ERASURE_PROOF_GROUP_INCOMPLETE');
  const groups = tables.filter((table) => !reciprocal.includes(table)).map((table) => [table]);
  if (present.length) groups.unshift(reciprocal);
  // Reuse the canonical transaction binding so pooled/session selectors are explicitly cleared.
  // This grants no body access; assertRole and SQL erasure/restore/seal checks still own authority.
  const scoped = new AppDatabase(db),
    context = createServiceContext(organizationId);
  const bound = <T>(fn: (tx: Tx) => Promise<T>) => withTenantTx(scoped, context, fn);
  for (;;) {
    let moved = 0;
    for (const group of groups) {
      let pages: { table: string; removed: number; left: number }[];
      try {
        pages = await bound(async (tx) => {
          await assertOpen(tx, organizationId);
          const removals = new Map<string, number>();
          for (const table of group) {
            if (table === 'lifecycle.raw_source_inventories') {
              const deletion = await tx.execute<{ removed: string | number }>(
                sql`select lifecycle.erase_raw_source_inventories() as removed`,
              );
              removals.set(table, number(deletion.rows[0]?.removed));
            } else {
              const deletion = await tx.execute(
                sql`delete from ${tableName(table)} where organization_id=${organizationId}::uuid`,
              );
              removals.set(table, number(deletion.rowCount));
            }
          }
          // RLS can hide rows after a hold. Recheck before accepting any count as zero.
          await assertOpen(tx, organizationId);
          return Promise.all(
            group.map(async (table) => ({
              table,
              removed: removals.get(table)!,
              left: await countRows(tx, table, organizationId),
            })),
          );
        });
      } catch (error) {
        if (codeOf(error) !== '23503') throw error;
        pages = await bound(async (tx) => {
          await assertOpen(tx, organizationId);
          return Promise.all(
            group.map(async (table) => ({
              table,
              removed: 0,
              left: await countRows(tx, table, organizationId),
            })),
          );
        });
      }
      for (const page of pages) {
        const row = result.get(page.table)!;
        row.rowsRemoved += page.removed;
        row.rowsLeft = page.left;
        moved += page.removed;
      }
    }
    if (!moved) break;
  }
  return [...result.values()];
}
