// The actual agent role alone deletes private job payloads and certifies COUNT0 under the permanent
// job fence. Metadata callers can verify the receipt but cannot manufacture one from an app boolean.
import {
  modelJobPayloads,
  modelJobs,
  knowledgeSources,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { eq, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import type { KnowledgeCallAccounting } from './knowledge-call-store';
const id = (raw: string) => {
  const value = idSchema.safeParse(raw);
  if (!value.success) throw new AppError('INVALID_INPUT');
  return value.data;
};
function requireService(context: TenantContext) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
}
export async function purgeModelJobPayloadsInTx(
  tx: Tx,
  context: TenantContext,
  jobId: string,
): Promise<{ removed: number }> {
  requireService(context);
  const [job] = await tx
    .select()
    .from(modelJobs)
    .where(eq(modelJobs.id, id(jobId)))
    .for('update');
  if (!job) throw new AppError('NOT_FOUND');
  if (!job.fencedAt)
    await tx
      .update(modelJobs)
      .set({ state: 'fenced', refusalCode: 'MODEL_UNAVAILABLE' })
      .where(eq(modelJobs.id, job.id));
  const removed = await tx
    .delete(modelJobPayloads)
    .where(eq(modelJobPayloads.jobId, job.id))
    .returning({ id: modelJobPayloads.jobId });
  const remaining = await tx.execute<{ count: number }>(
    sql`select count(*)::int count from ai.model_job_payloads where organization_id=${context.organizationId}::uuid and job_id=${job.id}::uuid`,
  );
  if (remaining.rows[0]?.count !== 0) throw new AppError('INVALID_STATE');
  if (!job.payloadsPurgedAt)
    await tx
      .update(modelJobs)
      .set({ payloadsPurgedAt: new Date(), purgedFenceGeneration: 1 })
      .where(eq(modelJobs.id, job.id));
  return { removed: removed.length };
}
export async function purgeModelJobPayloads(
  database: AppDatabase,
  context: TenantContext,
  jobId: string,
) {
  return withTenantTx(database, context, (tx) => purgeModelJobPayloadsInTx(tx, context, jobId));
}
export async function purgeModelJobsForSource(
  database: AppDatabase,
  context: TenantContext,
  calls: KnowledgeCallAccounting,
  input: { sourceId: string },
): Promise<{ removed: number }> {
  requireService(context);
  const sourceId = id(input.sourceId);
  let after: string | null = null,
    removed = 0;
  for (;;) {
    const jobs = await withTenantTx(database, context, async (tx) => {
      const [source] = await tx
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, sourceId))
        .for('update');
      if (!source || source.state === 'active') throw new AppError('INVALID_STATE');
      return tx.execute<{
        id: string;
      }>(sql`select distinct c.job_id id from ai.model_call_inputs i join ai.model_call_attempts c on c.organization_id=i.organization_id and c.id=i.call_id
        where i.organization_id=${context.organizationId}::uuid and i.source_id=${sourceId}::uuid and c.job_id is not null ${after ? sql`and c.job_id>${after}::uuid` : sql``} order by c.job_id limit 50`);
    });
    for (const job of jobs.rows) {
      await calls.reconcileJob(context, job.id);
      const result = await withTenantTx(database, context, async (tx) => {
        const [source] = await tx
          .select({ state: knowledgeSources.state })
          .from(knowledgeSources)
          .where(eq(knowledgeSources.id, sourceId))
          .for('update');
        if (!source || source.state === 'active') throw new AppError('INVALID_STATE');
        return purgeModelJobPayloadsInTx(tx, context, job.id);
      });
      removed += result.removed;
    }
    if (jobs.rows.length < 50) break;
    after = jobs.rows.at(-1)!.id;
  }
  const proof = await withTenantTx(database, context, (tx) =>
    tx.execute<{ ok: boolean }>(sql`select ai.model_source_payloads_purged(${sourceId}::uuid) ok`),
  );
  if (!proof.rows[0]?.ok) throw new AppError('INVALID_STATE');
  return { removed };
}
