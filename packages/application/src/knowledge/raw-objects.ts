// Native runtime capability, never a browser/Temporal proof. The actual storage executor is trusted;
// SQL checks exact identity/order/generation and does not independently attest a provider response.
import { createHash } from 'node:crypto';
import { withTenantTx, type AppDatabase, type TenantContext, type Tx } from '@ensemus/database';
import { knowledgeObjectKey } from '@ensemus/domain/knowledge';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ObjectStore } from '../artifacts';
import { AppError, pgCode } from '../errors';
import { idSchema } from '../ids';
import {
  createObjectDeletionExecutor,
  createSqlObjectDeletionAuthority,
} from '../saas/object-deletion';
import type { ObjectWrite } from './object-writes';

export type RawSourceIdentity = { sourceId: string; sourceVersion: number; purgeJobId: string };
export interface RawKnowledgeObjectPort {
  put(context: TenantContext, write: ObjectWrite, body: Buffer, mimeType: string): Promise<void>;
  erase(
    context: TenantContext,
    input: { documentId: string },
  ): Promise<{ state: 'purged'; quiescent: true } | { state: 'held' | 'unconfirmed' }>;
  captureSource(context: TenantContext, input: RawSourceIdentity): Promise<{ more: boolean }>;
  reconcile(context: TenantContext, sourceId?: string): Promise<{ changed: number }>;
}
type PutAdmission = {
  state: string;
  source_id: string;
  object_key: string;
  content_sha256: string;
  size_bytes: string | number;
  material_generation: string;
  auth_generation: string;
  token: string;
};
const observed = new WeakSet<object>();
type NativePutObservation = Readonly<
  PutAdmission & ObjectWrite & { outcome: 'written' | 'unknown' }
>;
const rawTarget = z.strictObject({
  kind: z.literal('raw_source'),
  sourceId: idSchema,
  sourceVersion: z.string().regex(/^[1-9][0-9]*$/),
  purgeJobId: idSchema,
  documentId: idSchema,
  writeId: idSchema,
  generation: z.int().nonnegative(),
  materialRestoreGeneration: idSchema,
  authRestoreGeneration: idSchema,
});
const service = (context: TenantContext) => {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
};

/** Both ordinary upload and worker paths call this capability. No missing-store success exists. */
export function createRawKnowledgeObjectPort(deps: {
  database: AppDatabase;
  store: ObjectStore;
}): RawKnowledgeObjectPort {
  const erase = createObjectDeletionExecutor({
    authority: createSqlObjectDeletionAuthority(deps.database),
    store: deps.store,
  });
  // 0532: purge counts are evidence. Record once, before the single admitted DELETE, whether the
  // bytes are there, so the purge can tell bytes it removed from bytes that were already gone. A
  // provider DELETE cannot say which. The observation is a count only: it never admits, qualifies or
  // completes a deletion, and an unreachable store admits no DELETE (a retry begins cleanly).
  const observePresence = async (context: TenantContext, documentId: string) => {
    const pending = await withTenantTx(deps.database, context, (tx) =>
      tx.execute<{ observed: boolean | null; state: string }>(sql`select
        d.object_present_before_purge observed,s.state from knowledge.documents d join knowledge.sources s
        on s.organization_id=d.organization_id and s.id=d.source_id
        where d.organization_id=${context.organizationId}::uuid and d.id=${documentId}::uuid`),
    );
    const row = pending.rows[0];
    // A header already gone, or a source still active, has nothing for this purge to count.
    if (pending.rows.length !== 1 || !row || row.observed !== null || row.state === 'active')
      return;
    let present: boolean;
    try {
      present = await deps.store.exists(knowledgeObjectKey(context.organizationId, documentId));
    } catch {
      throw new Error('STORE_UNAVAILABLE');
    }
    await withTenantTx(deps.database, context, (tx) =>
      tx.execute(sql`update knowledge.documents set object_present_before_purge=${present}
        where organization_id=${context.organizationId}::uuid and id=${documentId}::uuid
        and object_present_before_purge is null`),
    );
  };
  const finish = async (context: TenantContext, receipt: NativePutObservation) => {
    if (!observed.has(receipt)) throw new AppError('PREREQUISITES_INCOMPLETE');
    return withTenantTx(deps.database, context, async (tx) => {
      const result = await tx.execute<{ finished: boolean }>(sql`select lifecycle.finish_raw_put(
        ${receipt.documentId}::uuid,${receipt.writeId}::uuid,${receipt.generation}::bigint,${receipt.token},
        ${receipt.material_generation}::uuid,${receipt.auth_generation}::uuid,${receipt.outcome}) finished`);
      return result.rows.length === 1 && result.rows[0]?.finished === true;
    });
  };
  return {
    async put(context, write, body, mimeType) {
      if (!deps.store.putSingleAttempt) throw new AppError('CAPABILITY_UNAVAILABLE');
      write = Object.freeze({ ...write });
      idSchema.parse(write.sourceId);
      if (!Number.isSafeInteger(write.generation) || write.generation < 1)
        throw new AppError('INVALID_INPUT');
      // Capture bytes/hash before the admission await. Mutable request buffers cannot replace them.
      const bytes = Buffer.from(body),
        sha = createHash('sha256').update(bytes).digest('hex');
      const rows = await withTenantTx(deps.database, context, (tx) =>
        tx.execute<PutAdmission>(sql`select * from lifecycle.admit_raw_put(
        ${idSchema.parse(write.documentId)}::uuid,${idSchema.parse(write.writeId)}::uuid,${write.generation}::bigint)`),
      );
      const admission = rows.rows[0] ? Object.freeze({ ...rows.rows[0] }) : undefined;
      if (
        rows.rows.length !== 1 ||
        !admission ||
        admission.state !== 'send' ||
        admission.source_id !== write.sourceId ||
        admission.object_key !== knowledgeObjectKey(context.organizationId, write.documentId) ||
        admission.content_sha256 !== sha ||
        BigInt(admission.size_bytes) !== BigInt(bytes.length) ||
        !idSchema.safeParse(admission.material_generation).success ||
        !idSchema.safeParse(admission.auth_generation).success ||
        !/^[0-9a-f]{64}$/.test(admission.token)
      )
        throw new AppError('PREREQUISITES_INCOMPLETE');
      let outcome: 'written' | 'unknown' = 'unknown';
      try {
        outcome =
          (await deps.store.putSingleAttempt(admission.object_key, bytes, mimeType)).transport ===
          'written'
            ? 'written'
            : 'unknown';
      } catch {
        /* An actual rejected request is unknown; never resend or certify from HEAD. */
      }
      const receipt = Object.freeze({ ...admission, ...write, outcome });
      observed.add(receipt);
      const finished = await finish(context, receipt);
      if (outcome !== 'written' || !finished) throw new AppError('OBJECT_DELETE_UNCONFIRMED');
    },
    async erase(context, input) {
      service(context);
      const result = await withTenantTx(deps.database, context, (tx) =>
        tx.execute<{ target: unknown }>(sql`select lifecycle.raw_document_delete_target(
        ${idSchema.parse(input.documentId)}::uuid) target`),
      );
      const target = rawTarget.safeParse(result.rows[0]?.target);
      if (result.rows.length !== 1 || !target.success) return { state: 'unconfirmed' };
      // A store without the purge capability never reaches a DELETE, so it has nothing to observe.
      if (deps.store.deleteForPurge && deps.store.isPhysicallyAbsent)
        await observePresence(context, target.data.documentId);
      return erase(context, target.data);
    },
    async captureSource(context, input) {
      service(context);
      if (!Number.isSafeInteger(input.sourceVersion) || input.sourceVersion < 1)
        throw new AppError('INVALID_INPUT');
      const result = await withTenantTx(deps.database, context, (tx) =>
        tx.execute<{ more: boolean }>(sql`select * from lifecycle.capture_raw_source_inventory(
        ${idSchema.parse(input.sourceId)}::uuid,${input.sourceVersion}::bigint,${idSchema.parse(input.purgeJobId)}::uuid)`),
      ).catch((error: unknown) => {
        // 0516's capture refuses first while a hold covers this source's projections (or no
        // current restore generation exists). That is the refusal assertMaterialHoldFree reports,
        // so the source purge records a held source, never an unexplained PURGE_FAILED.
        if (
          pgCode(error) === 'EN850' &&
          (error as { cause?: { message?: unknown } }).cause?.message ===
            'RAW_SOURCE_HOLD_UNCONFIRMED'
        )
          throw new AppError('POLICY_DENIED');
        throw error;
      });
      if (result.rows.length !== 1 || typeof result.rows[0]?.more !== 'boolean')
        throw new AppError('PREREQUISITES_INCOMPLETE');
      return { more: result.rows[0].more };
    },
    async reconcile(context, sourceId) {
      service(context);
      const result = await withTenantTx(deps.database, context, (tx) =>
        tx.execute<{ changed: number }>(sql`select lifecycle.reconcile_raw_source_completions(
        ${sourceId === undefined ? null : idSchema.parse(sourceId)}::uuid) changed`),
      );
      const changed = result.rows[0]?.changed;
      if (
        result.rows.length !== 1 ||
        typeof changed !== 'number' ||
        !Number.isSafeInteger(changed) ||
        changed < 0 ||
        changed > 25
      )
        throw new AppError('PREREQUISITES_INCOMPLETE');
      return { changed };
    },
  };
}

export const rawKnowledgeObjects = (store: ObjectStore): RawKnowledgeObjectPort => {
  if (!store.rawKnowledge) throw new AppError('CAPABILITY_UNAVAILABLE');
  return store.rawKnowledge;
};

/** The exposed normal store cannot issue raw PUT/DELETE. Only the closed native port holds the
 * actual underlying transport. Artifact/archive behavior is preserved rather than reclassified. */
export function withRawKnowledgeObjects<T extends ObjectStore>(deps: {
  database: AppDatabase;
  store: T;
  exposedStore?: T;
}): T & { rawKnowledge: RawKnowledgeObjectPort } {
  const port = createRawKnowledgeObjectPort(deps),
    exposed = deps.exposedStore ?? deps.store;
  return new Proxy(exposed, {
    get(target, key) {
      if (key === 'rawKnowledge') return port;
      const value: unknown = Reflect.get(target, key, target);
      if (
        ['put', 'putSingleAttempt', 'delete', 'deleteForPurge'].includes(String(key)) &&
        typeof value === 'function'
      ) {
        return (objectKey: string, ...args: unknown[]) => {
          if (/^[^/]+\/knowledge\//.test(objectKey))
            throw new AppError('OBJECT_DELETE_UNCONFIRMED');
          return Reflect.apply(value, target, [objectKey, ...args]);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T & { rawKnowledge: RawKnowledgeObjectPort };
}

/** Missing/unapplied metadata authority is unknown, never a zero/positive completion default. */
export async function rawSourceMaterialCompleteInTx(
  tx: Tx,
  input: RawSourceIdentity,
  person = false,
): Promise<boolean> {
  const signature = person
    ? 'lifecycle.raw_source_status(uuid,uuid)'
    : 'lifecycle.raw_source_material_complete(uuid,bigint,uuid,uuid)';
  const available = await tx.execute<{ available: boolean }>(
    sql`select to_regprocedure(${signature}) is not null available`,
  );
  if (available.rows[0]?.available !== true) return false;
  const result = person
    ? await tx.execute<{ complete: boolean }>(
        sql`select lifecycle.raw_source_status(${input.sourceId}::uuid,${input.purgeJobId}::uuid) complete`,
      )
    : await tx.execute<{
        complete: boolean;
      }>(sql`select lifecycle.raw_source_material_complete(${input.sourceId}::uuid,${input.sourceVersion}::bigint,
        ${input.purgeJobId}::uuid,ai.current_material_restore_generation()) complete`);
  return result.rows.length === 1 && result.rows[0]?.complete === true;
}

/** An active writer whose admitted native PUT lost its response (0523). Its row stays unknown; only
 * its next generation may replace it, with a fresh single-attempt PUT of the same document bytes. */
export async function rawWriteSupersedableInTx(tx: Tx, write: ObjectWrite): Promise<boolean> {
  const result = await tx.execute<{ supersedable: boolean }>(
    sql`select lifecycle.raw_write_supersedable(${write.documentId}::uuid,${write.writeId}::uuid,${write.generation}::bigint) supersedable`,
  );
  return result.rows.length === 1 && result.rows[0]?.supersedable === true;
}

export async function assertRawWriteQuiescentInTx(tx: Tx, write: ObjectWrite) {
  const result = await tx.execute<{ quiescent: boolean }>(sql`select lifecycle.raw_write_quiescent(
    ${write.documentId}::uuid,${write.writeId}::uuid,${write.generation}::bigint) or lifecycle.close_unadmitted_raw_write(
    ${write.documentId}::uuid,${write.writeId}::uuid,${write.generation}::bigint) quiescent`);
  if (result.rows.length !== 1 || result.rows[0]?.quiescent !== true)
    throw new AppError('OBJECT_DELETE_UNCONFIRMED');
}
