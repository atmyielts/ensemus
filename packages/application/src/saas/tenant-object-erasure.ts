import { withTenantTx, type AppDatabase, type TenantContext } from '@ensemus/database';
import { sql } from 'drizzle-orm';
import { purgeDueBlobs, type ObjectStore } from '../artifacts';
import { createImportedArchivePurge } from '../portability-archive-files';
import { AppError } from '../errors';
import {
  createObjectDeletionExecutor,
  createObjectDeletionLifecycle,
  createSqlObjectDeletionAuthority,
} from './object-deletion';

export type ErasureObjectStore = ObjectStore & {
  listPages(prefix: string): AsyncIterable<readonly string[]>;
};
const count = (value: unknown) => {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
    throw new AppError('PREREQUISITES_INCOMPLETE');
  return n;
};
/** Physical cleanup has independent positive writer/delete/hold proofs. A count is never a provider proof. */
export function createTenantObjectErasure(deps: {
  database: AppDatabase;
  store: ErasureObjectStore;
}) {
  const lifecycle = createObjectDeletionLifecycle(deps);
  const archive = createImportedArchivePurge({ ...deps, lifecycle: lifecycle.archive });
  const eraseObject = createObjectDeletionExecutor({
    authority: createSqlObjectDeletionAuthority(deps.database),
    store: deps.store,
  });
  const assertIntent = async (context: TenantContext, offboardingId: string) => {
    if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
    await withTenantTx(deps.database, context, async (tx) => {
      const result = await tx.execute<{ allowed: boolean }>(
        sql`select lifecycle.erasure_object_intent(${offboardingId}::uuid) as allowed`,
      );
      if (result.rows[0]?.allowed !== true) throw new AppError('PREREQUISITES_INCOMPLETE');
    });
  };
  return {
    async purge(context: TenantContext, input: { offboardingId: string; limit?: number }) {
      await assertIntent(context, input.offboardingId);
      const limit = input.limit ?? 25;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25)
        throw new AppError('INVALID_INPUT');
      // Each material class gets its own bounded page.
      const files = await purgeDueBlobs(deps.database, deps.store, context, new Date(), limit);
      const archives = await archive.purgeTenant(context, { limit });
      const uploads = await withTenantTx(deps.database, context, async (tx) => {
        const result = await tx.execute<{ upload_id: string }>(
          sql`select upload_id from lifecycle.list_skill_offboarding_uploads(${input.offboardingId}::uuid,${limit})`,
        );
        return result.rows;
      });
      let skillBundlesRemoved = 0;
      for (const upload of uploads) {
        const deletion = await eraseObject(context, {
          kind: 'skill_upload',
          uploadId: upload.upload_id,
          offboardingId: input.offboardingId,
        });
        if (deletion.state === 'purged') skillBundlesRemoved += 1;
        else break;
      }
      const counters = await withTenantTx(deps.database, context, async (tx) => {
        const result = await tx.execute<{ unconfirmed: number }>(
          sql`select unconfirmed from lifecycle.object_delete_counts()`,
        );
        return count(result.rows[0]?.unconfirmed);
      });
      return { files, archives, skillBundlesRemoved, unconfirmedDeletes: counters };
    },
    async confirm(context: TenantContext, input: { offboardingId: string }) {
      await assertIntent(context, input.offboardingId);
      const result = await withTenantTx(deps.database, context, async (tx) => {
        const proof = await tx.execute<{ ready: boolean }>(
          sql`select lifecycle.erasure_object_proofs(${input.offboardingId}::uuid) as ready`,
        );
        return proof.rows[0]?.ready === true;
      });
      // Includes unregistered objects and export/other namespaces whose real cleanup is still owed.
      // They remain explicit attention, never silently deleted or qualified by an empty SQL inventory.
      let objectsRemaining = 0;
      for await (const page of deps.store.listPages(`${context.organizationId}/`)) {
        for (const key of page) {
          if (!key.startsWith(`${context.organizationId}/`))
            throw new AppError('PREREQUISITES_INCOMPLETE');
          objectsRemaining += 1;
          if (!Number.isSafeInteger(objectsRemaining))
            throw new AppError('PREREQUISITES_INCOMPLETE');
        }
      }
      return { confirmed: result && objectsRemaining === 0, objectsRemaining };
    },
  };
}
