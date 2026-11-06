import { randomUUID } from 'node:crypto';
import {
  knowledgeObjectWriters,
  knowledgeSources,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { knowledgeObjectKey } from '@ensemus/domain/knowledge';
import { and, eq } from 'drizzle-orm';
import type { ObjectStore } from '../artifacts';
import { AppError } from '../errors';

export type ObjectWrite = {
  documentId: string;
  sourceId: string;
  writeId: string;
  generation: number;
};
/** Optional recovery port. Quiescent means no old request can subsequently recreate this key. A
 * timeout, absence HEAD, elapsed lease or best-effort AbortController alone is not such proof. */
export interface KnowledgeWriteFence {
  fenceKnowledgeWrite(input: {
    key: string;
    writeId: string;
    generation: number;
  }): Promise<{ quiescent: boolean }>;
}
export type RecoverableKnowledgeStore = ObjectStore & Partial<KnowledgeWriteFence>;

/** Called only after caller authorization, under the source lock and before any out-of-tx put. */
export async function beginObjectWrite(
  tx: Tx,
  context: TenantContext,
  input: { sourceId: string; documentId: string },
): Promise<ObjectWrite> {
  const [source] = await tx
    .select({ state: knowledgeSources.state })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, input.sourceId))
    .for('update');
  if (!source || source.state !== 'active') throw new AppError('KNOWLEDGE_SOURCE_CLOSED');
  const [previous] = await tx
    .select()
    .from(knowledgeObjectWriters)
    .where(eq(knowledgeObjectWriters.documentId, input.documentId))
    .for('update');
  if (previous?.state === 'active') throw new AppError('INVALID_STATE');
  const write = { ...input, writeId: randomUUID(), generation: (previous?.generation ?? 0) + 1 };
  const startedByMembershipId = context.actorType === 'service' ? null : context.membershipId;
  if (previous)
    await tx
      .update(knowledgeObjectWriters)
      .set({
        writeId: write.writeId,
        generation: write.generation,
        state: 'active',
        startedByMembershipId,
        startedAt: new Date(),
      })
      .where(eq(knowledgeObjectWriters.documentId, input.documentId));
  else
    await tx.insert(knowledgeObjectWriters).values({
      organizationId: context.organizationId,
      ...write,
      startedByMembershipId,
      state: 'active',
    });
  return write;
}
/** A successful completed put, or an adapter-proven fence plus verified cleanup, may settle its token. */
export async function settleObjectWrite(tx: Tx, write: ObjectWrite) {
  await tx
    .select({ id: knowledgeSources.id })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, write.sourceId))
    .for('update');
  const rows = await tx
    .update(knowledgeObjectWriters)
    .set({ state: 'settled' })
    .where(
      and(
        eq(knowledgeObjectWriters.documentId, write.documentId),
        eq(knowledgeObjectWriters.writeId, write.writeId),
        eq(knowledgeObjectWriters.generation, write.generation),
        eq(knowledgeObjectWriters.state, 'active'),
      ),
    )
    .returning({ id: knowledgeObjectWriters.documentId });
  if (rows.length !== 1) throw new AppError('INVALID_STATE');
}

/** Crash recovery requires positive provider/worker-fence proof, never a TTL. Missing ports do nothing. */
export async function recoverObjectWrites(
  database: AppDatabase,
  store: RecoverableKnowledgeStore,
  context: TenantContext,
  sourceId?: string,
) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  if (!store.fenceKnowledgeWrite) return;
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select()
      .from(knowledgeObjectWriters)
      .where(
        and(
          eq(knowledgeObjectWriters.state, 'active'),
          ...(sourceId ? [eq(knowledgeObjectWriters.sourceId, sourceId)] : []),
        ),
      )
      .orderBy(knowledgeObjectWriters.startedAt)
      .limit(50),
  );
  for (const write of rows) {
    const key = knowledgeObjectKey(context.organizationId, write.documentId);
    try {
      if (
        !(
          await store.fenceKnowledgeWrite({
            key,
            writeId: write.writeId,
            generation: write.generation,
          })
        ).quiescent
      )
        continue;
      const [source] = await withTenantTx(database, context, (tx) =>
        tx
          .select({ state: knowledgeSources.state })
          .from(knowledgeSources)
          .where(eq(knowledgeSources.id, write.sourceId)),
      );
      if (!source || source.state !== 'active') {
        if (await store.exists(key)) await store.delete(key);
        if (await store.exists(key)) continue;
      }
      await withTenantTx(database, context, async (tx) => {
        await tx
          .select({ id: knowledgeSources.id })
          .from(knowledgeSources)
          .where(eq(knowledgeSources.id, write.sourceId))
          .for('update');
        // Another successful owner may already have settled it; never modify a later generation.
        const [current] = await tx
          .select()
          .from(knowledgeObjectWriters)
          .where(eq(knowledgeObjectWriters.documentId, write.documentId));
        if (
          current?.state === 'active' &&
          current.writeId === write.writeId &&
          current.generation === write.generation
        )
          await settleObjectWrite(tx, write);
      });
    } catch {
      /* An unknown writer stays active, keeping completion honest. */
    }
  }
}
