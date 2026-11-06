import type { TenantContext, Tx } from '@ensemus/database';
import { sql } from 'drizzle-orm';
import { AppError } from './errors';
import { queryRows } from './portability-sql';

export function exportEpochMatches(
  pinned: string | null | undefined,
  current: string | null | undefined,
) {
  return typeof pinned === 'string' && /^[1-9][0-9]*$/.test(pinned) && pinned === current;
}

/** Plain SELECTs only: writers take body/grant locks then the epoch lock. A reader must never
 * acquire that epoch lock while waiting for those locks or for storage, including at download. */
export async function isExportEpochCurrent(tx: Tx, context: TenantContext, exportId: string) {
  const [row] = await queryRows<{ pinned: string | null; current: string | null }>(
    tx,
    sql`
    select e.export_epoch::text as pinned,r.epoch::text as current from sovereign.organization_exports e
      left join sovereign.export_epochs r on r.organization_id=e.organization_id
    where e.organization_id=${context.organizationId}::uuid and e.id=${exportId}::uuid`,
  );
  return exportEpochMatches(row?.pinned, row?.current);
}

export async function assertExportEpoch(tx: Tx, context: TenantContext, exportId: string) {
  if (!(await isExportEpochCurrent(tx, context, exportId))) throw new AppError('EXPORT_SUPERSEDED');
}
