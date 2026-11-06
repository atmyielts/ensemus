// For the operator's erase command only (lint blocks everything else). `ensemus_eraser` can delete and count a
// tenant's content, and read nothing but the tenant column, and only while that tenant's offboarding is
// `erasing` with no hold active (ADR-032 D7). Owned by the offboarding slice. See docs/06-delivery/m8-slices.md.
import { openDatabase, type EnsemusDrizzle } from './connection';

export function openEraserDatabase(url: string) {
  return openDatabase(url, { max: 1 });
}

export type ErasedTable = { tableRef: string; rowsRemoved: number; rowsLeft: number };

/** Every table this role reaches, as `schema.table`. Read from the catalog, so it cannot go stale. */
export function listErasableTables(_db: EnsemusDrizzle): Promise<readonly string[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Deletes one tenant's rows, table by table, each in its own transaction binding that tenant, and passes over
 * the list again until nothing moves, since foreign keys order them. A table it cannot empty counts as left
 * over, and is reported rather than forced. Counting is from the role's own view, after deleting.
 */
export function eraseTenantRows(
  _db: EnsemusDrizzle,
  _organizationId: string,
): Promise<readonly ErasedTable[]> {
  throw new Error('NOT_IMPLEMENTED');
}
