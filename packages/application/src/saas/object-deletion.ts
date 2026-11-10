// Durable deletion admission is separate from storage I/O. A rejected DELETE can still complete
// at the provider: an unknown claim is retained and never retried or promoted by a later HEAD.
import { withTenantTx, type AppDatabase, type TenantContext, type Tx } from '@ensemus/database';
import { sql } from 'drizzle-orm';
import type { ObjectStore } from '../artifacts';
import type { DerivedArtifactLifecycle } from '../knowledge/artifact-provenance';
import type { ArchiveQuarantineLifecycle } from '../portability-archive-files';
import { AppError } from '../errors';

/** Existing raw Knowledge deletes lack durable operation/hold admission. Keep their writer debt
 * rather than letting a retry silently erase an earlier ambiguous provider operation. Exact admitted
 * lifecycle adapters receive the underlying store at composition, never this ordinary delete path. */
export function refuseUnadmittedDeletes<T extends ObjectStore>(store: T): T {
  return new Proxy(store, {
    get(target, key) {
      if (key === 'delete' || key === 'deleteForPurge')
        return async () => {
          throw new AppError('OBJECT_DELETE_UNCONFIRMED');
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export type DeletionTarget =
  | { kind: 'derived'; artifactId: string; writeId: string; generation: number }
  | { kind: 'ordinary'; artifactId: string }
  | {
      kind: 'raw_source';
      sourceId: string;
      sourceVersion: string;
      purgeJobId: string;
      documentId: string;
      writeId: string;
      generation: number;
      materialRestoreGeneration: string;
      authRestoreGeneration: string;
    }
  /**
   * One raw Knowledge object whose bytes survived an admitted restore (0547). The keys are exactly
   * what lifecycle.raw_restore_survivor_delete_target returns and begin_object_deletion compares, key
   * for key: `priorMaterialRestoreGeneration` is the generation the source's restore debt was left
   * from, the other two are the current ones. Service-only; SQL refuses any other key set.
   */
  | {
      kind: 'raw_restore_survivor';
      sourceId: string;
      sourceVersion: string;
      purgeJobId: string;
      documentId: string;
      writeId: string;
      generation: number;
      priorMaterialRestoreGeneration: string;
      materialRestoreGeneration: string;
      authRestoreGeneration: string;
    }
  | { kind: 'archive'; importId: string; sourceArtifactId: string; writeToken: string };
export type DeletionAdmission =
  | { state: 'held' }
  | { state: 'unconfirmed' }
  | { state: 'admitted'; claimId: string; objectKey: string }
  | { state: 'deleted'; claimId: string; objectKey: string };
export interface ObjectDeletionAuthority {
  begin(context: TenantContext, target: DeletionTarget): Promise<DeletionAdmission>;
  terminal(context: TenantContext, claimId: string, outcome: 'deleted' | 'unknown'): Promise<void>;
  proveAbsent(context: TenantContext, claimId: string): Promise<boolean>;
}
type Result = { state: 'purged'; quiescent: true } | { state: 'held' | 'unconfirmed' };
type DeletionStore = Pick<
  ObjectStore,
  'delete' | 'exists' | 'deleteForPurge' | 'isPhysicallyAbsent' | 'assertPurgeCapability'
>;

/** A testable state machine around the actual SQL authority, never a successful default port. */
export function createObjectDeletionExecutor(deps: {
  authority: ObjectDeletionAuthority;
  store: DeletionStore;
}) {
  return async (context: TenantContext, target: DeletionTarget): Promise<Result> => {
    if (context.actorType !== 'service' && target.kind !== 'ordinary')
      throw new AppError('FORBIDDEN');
    // Old/test adapters that only expose HEAD cannot certify that prior object versions are gone.
    if (!deps.store.deleteForPurge || !deps.store.isPhysicallyAbsent)
      return { state: 'unconfirmed' };
    // LIFE-01: a store that is down when a file is deleted must still lose the bytes later. Its
    // capability preflight is asked before admission, so an outage admits nothing; an admitted claim
    // refused after this point stays retained and unreplayable, exactly as before (M8 join, 0508).
    if (deps.store.assertPurgeCapability) {
      try {
        await deps.store.assertPurgeCapability();
      } catch {
        return { state: 'unconfirmed' };
      }
    }
    const claim = await deps.authority.begin(context, target);
    if (claim.state === 'held' || claim.state === 'unconfirmed') return claim;
    if (claim.state === 'admitted') {
      let result;
      try {
        // The production transport performs exactly one attempt. Never retry an ambiguous request.
        result = await deps.store.deleteForPurge(claim.objectKey);
      } catch {
        // Even a failed SQL write leaves an admitted claim unresolved. It cannot admit another DELETE.
        await deps.authority.terminal(context, claim.claimId, 'unknown');
        return { state: 'unconfirmed' };
      }
      // The admitted claim remains unconfirmed/nonreplayable. A capability refusal cannot forge a
      // successful cancellation or become a claim that an actual DELETE reached the provider.
      if (result.transport === 'not_attempted') return { state: 'unconfirmed' };
      if (result.transport !== 'deleted') {
        await deps.authority.terminal(context, claim.claimId, 'unknown');
        return { state: 'unconfirmed' };
      }
      await deps.authority.terminal(context, claim.claimId, 'deleted');
      if (!result.capabilityVerified) return { state: 'unconfirmed' };
    }
    // A known terminal DELETE may retry only this independent absence check after a transient read
    // failure. Neither this check nor any later successful request clears an UNKNOWN operation.
    try {
      if (!(await deps.store.isPhysicallyAbsent(claim.objectKey))) return { state: 'unconfirmed' };
    } catch {
      return { state: 'unconfirmed' };
    }
    return (await deps.authority.proveAbsent(context, claim.claimId))
      ? { state: 'purged', quiescent: true }
      : { state: 'unconfirmed' };
  };
}

export function createSqlObjectDeletionAuthority(database: AppDatabase): ObjectDeletionAuthority {
  return {
    async begin(context, target) {
      return withTenantTx(database, context, async (tx) => {
        const result = await tx.execute<{
          state: string;
          claim_id: string | null;
          object_key: string | null;
        }>(sql`select * from lifecycle.begin_object_deletion(${JSON.stringify(target)}::jsonb)`);
        const row = result.rows[0];
        if (!row) throw new AppError('PREREQUISITES_INCOMPLETE');
        if (row.state === 'held' || row.state === 'unconfirmed') return { state: row.state };
        if (
          (row.state !== 'admitted' && row.state !== 'deleted') ||
          !row.claim_id ||
          !row.object_key
        )
          throw new AppError('PREREQUISITES_INCOMPLETE');
        return { state: row.state, claimId: row.claim_id, objectKey: row.object_key };
      });
    },
    async terminal(context, claimId, outcome) {
      await withTenantTx(database, context, (tx) =>
        tx.execute(sql`select lifecycle.object_delete_terminal(${claimId}::uuid,${outcome})`),
      );
    },
    async proveAbsent(context, claimId) {
      return withTenantTx(database, context, async (tx) => {
        const result = await tx.execute<{ proven: boolean }>(
          sql`select lifecycle.object_delete_absent(${claimId}::uuid) as proven`,
        );
        return result.rows[0]?.proven === true;
      });
    },
  };
}

/** M5's completed-job fast path must recheck retained operation/restore debt, not only headers. */
export async function assertNoUnresolvedObjectDeletes(tx: Tx, context: TenantContext) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const result = await tx.execute<{ unconfirmed: number }>(
    sql`select unconfirmed from lifecycle.object_delete_counts()`,
  );
  if (result.rows[0]?.unconfirmed !== 0) throw new AppError('OBJECT_DELETE_UNCONFIRMED');
}

export function createObjectDeletionLifecycle(deps: {
  database: AppDatabase;
  store: DeletionStore;
}): { derived: DerivedArtifactLifecycle; archive: ArchiveQuarantineLifecycle } {
  const erase = createObjectDeletionExecutor({
    authority: createSqlObjectDeletionAuthority(deps.database),
    store: deps.store,
  });
  return {
    derived: {
      erase: (context, input) =>
        erase(context, {
          kind: 'derived',
          artifactId: input.artifactId,
          writeId: input.writeId,
          generation: input.generation,
        }),
    },
    archive: {
      erase: (context, input) =>
        erase(context, {
          kind: 'archive',
          importId: input.importId,
          sourceArtifactId: input.sourceArtifactId,
          writeToken: input.writeToken,
        }),
    },
  };
}

/** Select the actual retained writer; callers never label a generated file ordinary. */
export async function eraseTombstonedArtifact(
  deps: {
    database: AppDatabase;
    store: DeletionStore;
  },
  context: TenantContext,
  artifactId: string,
): Promise<Result> {
  const target = await withTenantTx(deps.database, context, async (tx) => {
    const result = await tx.execute<{ target: DeletionTarget | null }>(
      sql`select lifecycle.artifact_delete_target(${artifactId}::uuid) as target`,
    );
    return result.rows[0]?.target ?? null;
  });
  if (!target) return { state: 'unconfirmed' };
  return createObjectDeletionExecutor({
    authority: createSqlObjectDeletionAuthority(deps.database),
    store: deps.store,
  })(context, target);
}
