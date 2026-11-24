import { withTenantTx, type AppDatabase, type TenantContext } from '@ensemus/database';
import { sql } from 'drizzle-orm';
import type { ObjectStore } from './artifacts';
import { AppError } from './errors';
import {
  createObjectDeletionExecutor,
  createSqlObjectDeletionAuthority,
} from './saas/object-deletion';

/** At most one cleanup per upkeep activity. PostgreSQL owns the candidate and every transition. */
export async function purgeAbandonedSkillUpload(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const uploadId = await withTenantTx(database, context, async (tx) => {
    const result = await tx.execute<{ id: string | null }>(
      sql`select lifecycle.next_skill_upload_cleanup() as id`,
    );
    return result.rows[0]?.id;
  });
  if (!uploadId) return { state: 'idle' } as const;
  const erase = createObjectDeletionExecutor({
    authority: createSqlObjectDeletionAuthority(database),
    store,
  });
  return erase(context, { kind: 'skill_upload', uploadId });
}
