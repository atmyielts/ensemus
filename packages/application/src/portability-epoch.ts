import type { TenantContext, Tx } from '@ensemus/database';
import {
  isJoinedPortabilityVersion,
  PORTABILITY_INVENTORY_VERSION,
} from '@ensemus/domain/portability';
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
  const [row] = await queryRows<{
    pinned: string | null;
    current: string | null;
    profile: string | null;
  }>(
    tx,
    sql`
    select e.export_epoch::text as pinned,r.epoch::text as current,e.inventory_version as profile
    from sovereign.organization_exports e
      left join sovereign.export_epochs r on r.organization_id=e.organization_id
    where e.organization_id=${context.organizationId}::uuid and e.id=${exportId}::uuid`,
  );
  if (!exportEpochMatches(row?.pinned, row?.current)) return false;
  // Rows may predate the new modules' epoch triggers, including a restored older archive. A matching
  // counter alone cannot turn an unsupported /3 snapshot into a complete export of that company.
  const profile = row?.profile ?? PORTABILITY_INVENTORY_VERSION;
  if (!isJoinedPortabilityVersion(profile)) return false;
  const [pending] = await queryRows<{ empty: boolean }>(
    tx,
    sql`select sovereign.portable_profile_clear(${profile}) as empty`,
  );
  return pending?.empty === true;
}

export async function assertExportEpoch(tx: Tx, context: TenantContext, exportId: string) {
  if (!(await isExportEpochCurrent(tx, context, exportId))) throw new AppError('EXPORT_SUPERSEDED');
}
