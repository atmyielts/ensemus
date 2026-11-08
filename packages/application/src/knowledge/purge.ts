// Serving closes in the tombstone transaction. Completion also requires M4's durable writer fence:
// an absent worker is never evidence that no prompt remains. No transaction spans an object-store call.
import { createHash } from 'node:crypto';
import {
  appendAudit,
  knowledgeDocuments,
  knowledgeObjectWriters,
  knowledgePurgeJobs,
  knowledgeSources,
  memberships,
  organizations,
  tombstones,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { ledgerRef, TOMBSTONE_RECORDED, type LedgerEntry } from '@ensemus/domain/tombstone-ledger';
import { knowledgeObjectKey, type PurgeReason, type PurgeState } from '@ensemus/domain/knowledge';
import {
  AGGREGATE_KNOWLEDGE_SOURCE,
  KNOWLEDGE_PURGE_COMPLETED,
  KNOWLEDGE_SOURCE_CLOSED,
} from '@ensemus/domain/knowledge-events';
import { can } from '@ensemus/domain/policy';
import { and, eq, sql } from 'drizzle-orm';
import type { ObjectStore } from '../artifacts';
import type { ReapplyOptions, ReapplyResult } from '../tombstone-ledger';
import { AppError } from '../errors';
import { emit } from '../events';
import { idSchema } from '../ids';
import type { RunTranscriptPurge, DerivedArtifactPurge, DelegatedWorkPurge } from './ports';
import { recoverObjectWrites } from './object-writes';

const PAGE = 100;
const checkedId = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
};
const requireService = (context: TenantContext) => {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
};
type Source = typeof knowledgeSources.$inferSelect;
type Job = typeof knowledgePurgeJobs.$inferSelect;
async function lockSource(tx: Tx, sourceId: string): Promise<Source> {
  const [source] = await tx
    .select()
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, sourceId))
    .for('update');
  if (!source) throw new AppError('NOT_FOUND');
  return source;
}
async function person(tx: Tx, context: TenantContext, source: Source) {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  const [member] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, context.membershipId), eq(memberships.status, 'active')))
    .for('share');
  if (!member || (!can(member.role, 'knowledge.manage') && source.ownerMembershipId !== member.id))
    throw new AppError('FORBIDDEN');
}
async function jobFor(tx: Tx, sourceId: string) {
  const [job] = await tx
    .select()
    .from(knowledgePurgeJobs)
    .where(eq(knowledgePurgeJobs.sourceId, sourceId));
  if (!job) throw new AppError('NOT_FOUND');
  return job;
}
async function assertMaterialHoldFree(
  tx: Tx,
  source: Source,
  jobId: string,
  operation: 'payload' | 'projection',
) {
  // These fixed functions retain the root hold barrier in this same destructive transaction.
  // The two native roles have separate capabilities; no caller-selected SQL target is exposed.
  const available = await tx.execute<{ available: boolean }>(
    operation === 'payload'
      ? sql`select to_regprocedure('lifecycle.source_payload_hold_free(uuid,bigint,uuid)') is not null available`
      : sql`select to_regprocedure('lifecycle.source_projection_hold_free(uuid,bigint,uuid)') is not null available`,
  );
  if (available.rows[0]?.available !== true) throw new AppError('CAPABILITY_UNAVAILABLE');
  const hold = await tx.execute<{ allowed: boolean }>(
    operation === 'payload'
      ? sql`select lifecycle.source_payload_hold_free(${source.id}::uuid,${source.version}::bigint,${jobId}::uuid) allowed`
      : sql`select lifecycle.source_projection_hold_free(${source.id}::uuid,${source.version}::bigint,${jobId}::uuid) allowed`,
  );
  if (hold.rows[0]?.allowed !== true) throw new AppError('POLICY_DENIED');
}
async function close(
  tx: Tx,
  context: TenantContext,
  source: Source,
  reason: PurgeReason,
  deletedAt = new Date(),
) {
  const [existing] = await tx
    .select({ id: knowledgePurgeJobs.id })
    .from(knowledgePurgeJobs)
    .where(eq(knowledgePurgeJobs.sourceId, source.id));
  await tx
    .insert(tombstones)
    .values({
      organizationId: context.organizationId,
      targetType: AGGREGATE_KNOWLEDGE_SOURCE,
      targetId: source.id,
      reasonCode: reason === 'deleted' ? 'USER_DELETED' : 'SOURCE_REVOKED',
      createdAt: deletedAt,
    })
    .onConflictDoNothing();
  if (source.state !== 'active' && existing) return { purgeJobId: existing.id };
  if (source.state === 'active')
    await tx
      .update(knowledgeSources)
      .set({
        state: reason === 'deleted' || reason === 'restore_reapply' ? 'deleted' : 'revoked',
        revokedAt: deletedAt,
        version: source.version + 1,
        aclRevision: source.aclRevision + 1,
        updatedAt: new Date(),
      })
      .where(eq(knowledgeSources.id, source.id));
  const [job] = await tx
    .insert(knowledgePurgeJobs)
    .values({ organizationId: context.organizationId, sourceId: source.id, reason })
    .onConflictDoNothing()
    .returning({ id: knowledgePurgeJobs.id });
  if (!job) return { purgeJobId: (await jobFor(tx, source.id)).id };
  const classification = source.classification;
  await emit(tx, context, {
    eventType: TOMBSTONE_RECORDED,
    aggregateType: AGGREGATE_KNOWLEDGE_SOURCE,
    aggregateId: source.id,
    aggregateVersion: 1,
    classification,
    payload: { source_id: source.id },
  });
  await emit(tx, context, {
    eventType: KNOWLEDGE_SOURCE_CLOSED,
    aggregateType: AGGREGATE_KNOWLEDGE_SOURCE,
    aggregateId: source.id,
    aggregateVersion: source.state === 'active' ? source.version + 1 : source.version,
    classification,
    payload: { source_id: source.id, reason },
  });
  await appendAudit(tx, {
    organizationId: context.organizationId,
    actorType: context.actorType === 'service' ? 'system' : 'user',
    ...(context.actorType === 'service' ? {} : { actorId: context.membershipId }),
    action: 'knowledge.source_closed',
    targetRef: `knowledge_source:${source.id}`,
    decision: 'allow',
    safeReason: reason.toUpperCase(),
  });
  return { purgeJobId: job.id };
}
async function closeAsPerson(
  database: AppDatabase,
  context: TenantContext,
  input: { sourceId: string; expectedVersion: number; reason: string },
  reason: 'deleted' | 'revoked',
) {
  const sourceId = checkedId(input.sourceId);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new AppError('INVALID_INPUT');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000)
    throw new AppError('REASON_REQUIRED');
  return withTenantTx(database, context, async (tx) => {
    const source = await lockSource(tx, sourceId);
    await person(tx, context, source);
    if (source.state !== 'active') return close(tx, context, source, reason);
    if (source.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    return close(tx, context, source, reason);
  });
}
export function revokeSource(
  database: AppDatabase,
  context: TenantContext,
  input: { sourceId: string; expectedVersion: number; reason: string },
) {
  return closeAsPerson(database, context, input, 'revoked');
}
export function deleteSource(
  database: AppDatabase,
  context: TenantContext,
  input: { sourceId: string; expectedVersion: number; reason: string },
) {
  return closeAsPerson(database, context, input, 'deleted');
}

export async function closeOrphanedConnectorSources(
  database: AppDatabase,
  context: TenantContext,
  input: { limit: number },
): Promise<{ closed: number }> {
  requireService(context);
  if (!Number.isInteger(input.limit) || input.limit < 1) throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    const rows = await tx.execute<{
      id: string;
      reason: 'connection_revoked' | 'resource_gone';
    }>(sql`select s.id,case when c.state<>'active' then 'connection_revoked' else 'resource_gone' end as reason
      from knowledge.sources s join integrations.connections c on c.organization_id=s.organization_id and c.id=s.connection_id
      join integrations.external_resources r on r.organization_id=s.organization_id and r.id=s.external_resource_id
      where s.organization_id=${context.organizationId}::uuid and s.state='active' and (c.state<>'active' or r.deleted_at is not null)
      order by s.id limit ${Math.min(input.limit, PAGE)} for update of s skip locked`);
    let closed = 0;
    for (const row of rows.rows) {
      const source = await lockSource(tx, row.id);
      const fresh = await tx.execute<{
        gone: boolean;
        reason: 'connection_revoked' | 'resource_gone';
      }>(
        sql`select (c.state<>'active' or r.deleted_at is not null) as gone,case when c.state<>'active' then 'connection_revoked' else 'resource_gone' end as reason from integrations.connections c join integrations.external_resources r on r.organization_id=c.organization_id and r.connection_id=c.id where c.organization_id=${context.organizationId}::uuid and c.id=${source.connectionId}::uuid and r.id=${source.externalResourceId}::uuid`,
      );
      if (fresh.rows[0]?.gone) {
        await close(tx, context, source, fresh.rows[0].reason);
        closed++;
      }
    }
    return { closed };
  });
}

export type PurgeOutcome = {
  state: PurgeState;
  documents: number;
  chunks: number;
  embeddings: number;
  facts: number;
  answers: number;
  blobs: number;
  transcripts: number;
  artifacts: number;
  workUnits: number;
  workUnitsRemaining: number | null;
  workControlProofsRemaining: number | null;
  unprovenWorkUnits: number | null;
};
const outcome = (job: Job): PurgeOutcome => ({
  state: job.state as PurgeState,
  documents: job.documentsRemoved,
  chunks: job.chunksRemoved,
  embeddings: job.embeddingsRemoved,
  facts: job.factsRemoved,
  answers: job.answersRemoved,
  blobs: job.blobsRemoved,
  transcripts: job.transcriptsRemoved,
  artifacts: job.derivedArtifactsRemoved,
  workUnits: job.delegatedWorkRemoved,
  workUnitsRemaining: job.delegatedWorkRemaining,
  workControlProofsRemaining: job.delegatedWorkControlsRemaining,
  unprovenWorkUnits: job.delegatedWorkUnknown,
});
async function runIdsFor(
  tx: Tx,
  context: TenantContext,
  sourceId: string,
  after: string | null = null,
) {
  const rows = await tx.execute<{ id: string }>(
    sql`select distinct r.id from ai.source_input_runs(${sourceId}::uuid) r(id) where ${context.organizationId}::uuid=app.current_organization_id() ${after ? sql`and r.id>${after}::uuid` : sql``} order by r.id limit ${PAGE}`,
  );
  return rows.rows.map((row) => row.id);
}
async function allRunsHash(tx: Tx, context: TenantContext, sourceId: string) {
  const hash = createHash('sha256');
  let after: string | null = null;
  for (;;) {
    const ids = await runIdsFor(tx, context, sourceId, after);
    for (const id of ids) hash.update(`${id}\n`);
    if (ids.length < PAGE) break;
    after = ids.at(-1)!;
  }
  return hash.digest('hex');
}
async function proofValid(tx: Tx, context: TenantContext, source: Source, job: Job) {
  const generation = await tx.execute<{ generation: string | null }>(
    sql`select ai.current_material_restore_generation() generation`,
  );
  return (
    generation.rows[0]?.generation !== null &&
    generation.rows[0]?.generation !== undefined &&
    job.transcriptRestoreGeneration === generation.rows[0]?.generation &&
    job.transcriptsCheckedAt !== null &&
    job.transcriptSourceVersion === source.version &&
    job.transcriptRunsSha256 === (await allRunsHash(tx, context, source.id))
  );
}
async function fail(database: AppDatabase, context: TenantContext, sourceId: string, code: string) {
  return withTenantTx(database, context, async (tx) => {
    await lockSource(tx, sourceId);
    const job = await jobFor(tx, sourceId);
    if (job.state === 'completed' && !code.startsWith('ARTIFACT')) return outcome(job);
    const [updated] = await tx
      .update(knowledgePurgeJobs)
      .set({
        state: 'failed',
        lastAttemptAt: new Date(),
        lastErrorCode: code,
        ...(code.startsWith('ARTIFACT')
          ? {
              artifactsCheckedAt: null,
              nextRetryAt:
                job.nextRetryAt ??
                (job.retryRequests < 8 ? new Date(Date.now() + 15 * 60_000) : null),
            }
          : {}),
        completedAt: null,
        ...(code.startsWith('TRANSCRIPT_')
          ? {
              transcriptsCheckedAt: null,
              transcriptSourceVersion: null,
              transcriptRunsSha256: null,
            }
          : {}),
      })
      .where(eq(knowledgePurgeJobs.id, job.id))
      .returning();
    return outcome(updated!);
  });
}
/** Knowledge-queue fallback when no agent worker could attest to transcript removal. */
export async function failSourcePurge(
  database: AppDatabase,
  context: TenantContext,
  input: { sourceId: string; reason?: 'TRANSCRIPT_PURGE_UNCONFIRMED' | 'PURGE_FAILED' },
) {
  requireService(context);
  return fail(
    database,
    context,
    checkedId(input.sourceId),
    input.reason === 'PURGE_FAILED' ? 'PURGE_FAILED' : 'TRANSCRIPT_PURGE_UNCONFIRMED',
  );
}
export async function purgeRunTranscriptsForSource(
  database: AppDatabase,
  context: TenantContext,
  deps: { transcripts: RunTranscriptPurge },
  input: { sourceId: string },
): Promise<{ removed: number }> {
  requireService(context);
  const sourceId = checkedId(input.sourceId);
  try {
    const initial = await withTenantTx(database, context, async (tx) => {
      const source = await lockSource(tx, sourceId);
      if (source.state === 'active') throw new AppError('INVALID_STATE');
      return { source, job: await jobFor(tx, sourceId) };
    });
    if (initial.job.state === 'completed') return { removed: 0 };
    if (!deps.transcripts.fenceUsing) throw new Error('TRANSCRIPT_FENCE_UNAVAILABLE');
    const fingerprint = createHash('sha256');
    let after: string | null = null,
      removed = 0;
    for (;;) {
      const runIds = await withTenantTx(database, context, async (tx) => {
        await lockSource(tx, sourceId);
        const runIds = await runIdsFor(tx, context, sourceId, after);
        if (!(await deps.transcripts.fenceUsing!(tx, context, { runIds })).fenced)
          throw new Error('TRANSCRIPT_FENCE_UNCONFIRMED');
        return runIds;
      });
      // Fence commit is independent of a later hold or unknown deletion outcome.
      const batch = await withTenantTx(database, context, async (tx) => {
        const source = await lockSource(tx, sourceId);
        await assertMaterialHoldFree(tx, source, initial.job.id, 'payload');
        const result = await deps.transcripts.purgeUsing(tx, context, { runIds });
        if (
          !Number.isSafeInteger(result.removed) ||
          result.removed < 0 ||
          result.remaining !== 0 ||
          !(await deps.transcripts.fenceUsing!(tx, context, { runIds })).fenced
        )
          throw new Error('TRANSCRIPT_PURGE_UNCONFIRMED');
        await tx
          .update(knowledgePurgeJobs)
          .set({
            transcriptsRemoved: sql`${knowledgePurgeJobs.transcriptsRemoved}+${result.removed}`,
          })
          .where(eq(knowledgePurgeJobs.id, initial.job.id));
        return { runIds, removed: result.removed };
      });
      removed += batch.removed;
      for (const id of batch.runIds) fingerprint.update(`${id}\n`);
      if (batch.runIds.length < PAGE) break;
      after = batch.runIds.at(-1)!;
    }
    const sha256 = fingerprint.digest('hex');
    await withTenantTx(database, context, async (tx) => {
      const source = await lockSource(tx, sourceId);
      await assertMaterialHoldFree(tx, source, initial.job.id, 'payload');
      if (
        source.version !== initial.source.version ||
        sha256 !== (await allRunsHash(tx, context, sourceId))
      )
        throw new Error('TRANSCRIPT_PURGE_UNCONFIRMED');
      await tx
        .update(knowledgePurgeJobs)
        .set({
          transcriptsCheckedAt: new Date(),
          transcriptSourceVersion: source.version,
          transcriptRunsSha256: sha256,
          lastErrorCode: null,
        })
        .where(eq(knowledgePurgeJobs.id, initial.job.id));
    });
    return { removed };
  } catch (error) {
    if (error instanceof AppError) throw error;
    await fail(database, context, sourceId, 'TRANSCRIPT_PURGE_UNCONFIRMED');
    // eslint-disable-next-line preserve-caught-error -- Database/adapter causes can contain company text; retain only the fixed code.
    throw new Error('TRANSCRIPT_PURGE_UNCONFIRMED');
  }
}

/** Bounded transactions remove projections; counters commit with exactly those deleted rows. */
export async function runSourcePurge(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  input: { sourceId: string },
  deps?: {
    derivedArtifacts?: DerivedArtifactPurge;
    delegatedWorks?: Pick<DelegatedWorkPurge, 'confirmInTx'>;
  },
): Promise<PurgeOutcome> {
  requireService(context);
  const sourceId = checkedId(input.sourceId);
  // A previous process may have died mid-put. Only an explicit storage/worker fence can recover it.
  await recoverObjectWrites(database, store, context, sourceId);
  const start = await withTenantTx(database, context, async (tx) => {
    const source = await lockSource(tx, sourceId);
    if (source.state === 'active') throw new AppError('INVALID_STATE');
    const job = await jobFor(tx, sourceId);
    const active = await tx
      .select({ id: knowledgeObjectWriters.documentId })
      .from(knowledgeObjectWriters)
      .where(
        and(
          eq(knowledgeObjectWriters.sourceId, sourceId),
          eq(knowledgeObjectWriters.state, 'active'),
        ),
      )
      .limit(1);
    if (job.state === 'completed') {
      const artifactProof = deps?.derivedArtifacts
        ? await deps.derivedArtifacts.confirmInTx(tx, context, { sourceId })
        : null;
      const workProof = deps?.delegatedWorks
        ? await deps.delegatedWorks.confirmInTx(tx, context, { sourceId })
        : null;
      if (
        !active.length &&
        (await proofValid(tx, context, source, job)) &&
        artifactProof?.remaining === 0 &&
        workProof?.confirmed === true &&
        workProof.remaining === 0 &&
        workProof.controlsRemaining === 0 &&
        workProof.unproven === 0
      ) {
        const [fresh] = await tx
          .update(knowledgePurgeJobs)
          .set({ artifactsCheckedAt: new Date(), derivedArtifactsHeld: 0 })
          .where(eq(knowledgePurgeJobs.id, job.id))
          .returning();
        return outcome(fresh!);
      }
      const [unconfirmed] = await tx
        .update(knowledgePurgeJobs)
        .set({
          state: 'failed',
          completedAt: null,
          artifactsCheckedAt: null,
          lastErrorCode: 'ARTIFACT_PURGE_UNCONFIRMED',
          nextRetryAt:
            job.nextRetryAt ?? (job.retryRequests < 8 ? new Date(Date.now() + 15 * 60_000) : null),
        })
        .where(eq(knowledgePurgeJobs.id, job.id))
        .returning();
      return outcome(unconfirmed!);
    }
    if (active.length) {
      await tx
        .update(knowledgePurgeJobs)
        .set({
          state: 'failed',
          lastAttemptAt: new Date(),
          attempts: job.attempts + 1,
          lastErrorCode: 'OBJECT_WRITER_UNCONFIRMED',
          completedAt: null,
        })
        .where(eq(knowledgePurgeJobs.id, job.id));
      return { ...outcome(job), state: 'failed' as const };
    }
    const proven = await proofValid(tx, context, source, job);
    await tx
      .update(knowledgePurgeJobs)
      .set({
        state: proven ? 'running' : 'failed',
        lastAttemptAt: new Date(),
        attempts: job.attempts + 1,
        lastErrorCode: proven ? null : 'TRANSCRIPT_PURGE_UNCONFIRMED',
        completedAt: null,
      })
      .where(eq(knowledgePurgeJobs.id, job.id));
    return proven ? null : { ...outcome(job), state: 'failed' as const };
  });
  if (start) return start;
  try {
    const derived = deps?.derivedArtifacts;
    if (!derived) return fail(database, context, sourceId, 'ARTIFACT_PURGE_UNCONFIRMED');
    const works = deps?.delegatedWorks;
    if (!works) return fail(database, context, sourceId, 'DELEGATED_WORK_PURGE_UNCONFIRMED');
    let generated;
    try {
      generated = await derived.purgeSource(context, { sourceId, limit: 25 });
    } catch {
      return fail(database, context, sourceId, 'ARTIFACT_PURGE_UNCONFIRMED');
    }
    if (
      [generated.removed, generated.remaining, generated.held].some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      ) ||
      typeof generated.confirmed !== 'boolean'
    )
      return fail(database, context, sourceId, 'ARTIFACT_PURGE_UNCONFIRMED');
    await withTenantTx(database, context, async (tx) => {
      await lockSource(tx, sourceId);
      const job = await jobFor(tx, sourceId);
      await tx
        .update(knowledgePurgeJobs)
        .set({
          derivedArtifactsRemoved: Math.max(job.derivedArtifactsRemoved, generated.removed),
          derivedArtifactsHeld: generated.held,
        })
        .where(eq(knowledgePurgeJobs.id, job.id));
    });
    if (!generated.confirmed || generated.remaining || generated.held)
      return fail(
        database,
        context,
        sourceId,
        generated.held
          ? 'ARTIFACTS_HELD'
          : generated.remaining
            ? 'ARTIFACT_PURGE_PENDING'
            : 'ARTIFACT_PURGE_UNCONFIRMED',
      );
    // All inputs, including uncited ones, invalidate a produced answer.
    while (
      await withTenantTx(database, context, async (tx) => {
        const source = await lockSource(tx, sourceId);
        await assertMaterialHoldFree(tx, source, (await jobFor(tx, sourceId)).id, 'projection');
        const removed = await tx.execute<{ id: string }>(
          sql`delete from knowledge.answers where organization_id=${context.organizationId}::uuid and id in(select a.id from knowledge.answers a where a.organization_id=${context.organizationId}::uuid and (exists(select 1 from knowledge.answer_sources s where s.organization_id=a.organization_id and s.answer_id=a.id and s.source_id=${sourceId}::uuid) or exists(select 1 from knowledge.answer_citations c where c.organization_id=a.organization_id and c.answer_id=a.id and c.source_id=${sourceId}::uuid)) order by a.id limit ${PAGE}) returning id`,
        );
        if (removed.rows.length)
          await tx
            .update(knowledgePurgeJobs)
            .set({
              answersRemoved: sql`${knowledgePurgeJobs.answersRemoved}+${removed.rows.length}`,
            })
            .where(eq(knowledgePurgeJobs.sourceId, sourceId));
        return removed.rows.length === PAGE;
      })
    ) {
      /* Each page commits its own counters; continue until no full page remains. */
    }
    while (
      await withTenantTx(database, context, async (tx) => {
        const source = await lockSource(tx, sourceId);
        await assertMaterialHoldFree(tx, source, (await jobFor(tx, sourceId)).id, 'projection');
        const facts = await tx.execute<{ id: string; trustState: string }>(
          sql`select f.id,f.trust_state as "trustState" from knowledge.facts f where f.organization_id=${context.organizationId}::uuid and exists(select 1 from knowledge.fact_evidence e where e.organization_id=f.organization_id and e.fact_id=f.id and e.source_id=${sourceId}::uuid) order by f.id limit ${PAGE} for update`,
        );
        let removed = 0;
        for (const fact of facts.rows) {
          await tx.execute(
            sql`delete from knowledge.fact_evidence where organization_id=${context.organizationId}::uuid and fact_id=${fact.id}::uuid and source_id=${sourceId}::uuid`,
          );
          const remaining = await tx.execute<{ found: boolean }>(
            sql`select exists(select 1 from knowledge.fact_evidence where organization_id=${context.organizationId}::uuid and fact_id=${fact.id}::uuid) as found`,
          );
          if (!remaining.rows[0]?.found) {
            // Preserve historical superseded claims while detaching their now-erased successor. 0204
            // permits this service-only clear only when that successor no longer has evidence.
            await tx.execute(
              sql`update knowledge.facts set superseded_by_id=null,version=version+1,updated_at=now() where organization_id=${context.organizationId}::uuid and trust_state='superseded' and superseded_by_id=${fact.id}::uuid`,
            );
            await tx.execute(
              sql`delete from knowledge.facts where organization_id=${context.organizationId}::uuid and id=${fact.id}::uuid`,
            );
            removed++;
          } else if (fact.trustState === 'proposed' || fact.trustState === 'verified')
            await tx.execute(
              sql`update knowledge.facts set trust_state='disputed',conflict_ref=${`knowledge_source:${sourceId}`},version=version+1,updated_at=now() where organization_id=${context.organizationId}::uuid and id=${fact.id}::uuid`,
            );
        }
        if (removed)
          await tx
            .update(knowledgePurgeJobs)
            .set({ factsRemoved: sql`${knowledgePurgeJobs.factsRemoved}+${removed}` })
            .where(eq(knowledgePurgeJobs.sourceId, sourceId));
        return facts.rows.length === PAGE;
      })
    ) {
      /* Fact evidence and trust changes commit together on each bounded page. */
    }
    // Append-only evidence packages/items and artifact citation hashes survive as audit lineage.
    while (
      await withTenantTx(database, context, async (tx) => {
        const source = await lockSource(tx, sourceId);
        await assertMaterialHoldFree(tx, source, (await jobFor(tx, sourceId)).id, 'projection');
        const ids = await tx.execute<{ id: string }>(
          sql`select id from knowledge.chunks where organization_id=${context.organizationId}::uuid and source_id=${sourceId}::uuid order by id limit ${PAGE}`,
        );
        if (!ids.rows.length) return false;
        const list = sql.join(
          ids.rows.map((row) => sql`${row.id}::uuid`),
          sql`, `,
        );
        const vectors = await tx.execute<{ id: string }>(
          sql`delete from knowledge.embeddings where organization_id=${context.organizationId}::uuid and chunk_id in (${list}) returning chunk_id as id`,
        );
        const chunks = await tx.execute<{ id: string }>(
          sql`delete from knowledge.chunks where organization_id=${context.organizationId}::uuid and id in (${list}) returning id`,
        );
        await tx
          .update(knowledgePurgeJobs)
          .set({
            chunksRemoved: sql`${knowledgePurgeJobs.chunksRemoved}+${chunks.rows.length}`,
            embeddingsRemoved: sql`${knowledgePurgeJobs.embeddingsRemoved}+${vectors.rows.length}`,
          })
          .where(eq(knowledgePurgeJobs.sourceId, sourceId));
        return ids.rows.length === PAGE;
      })
    ) {
      /* Each bounded passage page is durable before requesting another. */
    }
    for (;;) {
      const documents = await withTenantTx(database, context, async (tx) => {
        await lockSource(tx, sourceId);
        return tx
          .select({ id: knowledgeDocuments.id, key: knowledgeDocuments.objectKey })
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.sourceId, sourceId))
          .orderBy(knowledgeDocuments.id)
          .limit(25);
      });
      if (!documents.length) break;
      for (const document of documents) {
        const expectedKey = knowledgeObjectKey(context.organizationId, document.id);
        const key = document.key ?? expectedKey;
        // A damaged/restored row must never turn this source's cleanup into an arbitrary object delete.
        if (key !== expectedKey) throw new Error('OBJECT_KEY_INVALID');
        // Retain the row until absence is verified, so a crash after DELETE retries the same key.
        try {
          if (await store.exists(key)) {
            await withTenantTx(database, context, async (tx) => {
              await lockSource(tx, sourceId);
              await tx
                .update(knowledgeDocuments)
                .set({ objectPurgeObserved: true })
                .where(
                  and(
                    eq(knowledgeDocuments.id, document.id),
                    eq(knowledgeDocuments.sourceId, sourceId),
                  ),
                );
            });
            await store.delete(key);
          }
          if (await store.exists(key)) throw new Error('STORE_UNAVAILABLE');
        } catch {
          throw new Error('STORE_UNAVAILABLE');
        }
        await withTenantTx(database, context, async (tx) => {
          const source = await lockSource(tx, sourceId);
          await assertMaterialHoldFree(tx, source, (await jobFor(tx, sourceId)).id, 'projection');
          await tx
            .delete(knowledgeObjectWriters)
            .where(
              and(
                eq(knowledgeObjectWriters.documentId, document.id),
                eq(knowledgeObjectWriters.state, 'settled'),
              ),
            );
          const removed = await tx
            .delete(knowledgeDocuments)
            .where(
              and(
                eq(knowledgeDocuments.id, document.id),
                eq(knowledgeDocuments.sourceId, sourceId),
              ),
            )
            .returning({
              id: knowledgeDocuments.id,
              observed: knowledgeDocuments.objectPurgeObserved,
            });
          if (removed.length)
            await tx
              .update(knowledgePurgeJobs)
              .set({
                documentsRemoved: sql`${knowledgePurgeJobs.documentsRemoved}+1`,
                blobsRemoved: sql`${knowledgePurgeJobs.blobsRemoved}+${removed[0]!.observed ? 1 : 0}`,
              })
              .where(eq(knowledgePurgeJobs.sourceId, sourceId));
        });
      }
    }
    return await withTenantTx(database, context, async (tx) => {
      const source = await lockSource(tx, sourceId);
      const job = await jobFor(tx, sourceId);
      await assertMaterialHoldFree(tx, source, job.id, 'projection');
      if (!(await proofValid(tx, context, source, job)))
        throw new Error('TRANSCRIPT_PURGE_UNCONFIRMED');
      const currentArtifacts = await derived.confirmInTx(tx, context, { sourceId });
      if (currentArtifacts.remaining !== 0) throw new Error('ARTIFACT_PURGE_UNCONFIRMED');
      const currentWorks = await works.confirmInTx(tx, context, { sourceId });
      if (
        !currentWorks.confirmed ||
        currentWorks.remaining !== 0 ||
        currentWorks.controlsRemaining !== 0 ||
        currentWorks.unproven !== 0
      )
        throw new Error('DELEGATED_WORK_PURGE_UNCONFIRMED');
      if (job.state === 'completed') return outcome(job);
      const [updated] = await tx
        .update(knowledgePurgeJobs)
        .set({
          state: 'completed',
          completedAt: new Date(),
          lastErrorCode: null,
          nextRetryAt: null,
          artifactsCheckedAt: new Date(),
        })
        .where(eq(knowledgePurgeJobs.id, job.id))
        .returning();
      await emit(tx, context, {
        eventType: KNOWLEDGE_PURGE_COMPLETED,
        aggregateType: AGGREGATE_KNOWLEDGE_SOURCE,
        aggregateId: sourceId,
        aggregateVersion: source.version,
        classification: source.classification,
        payload: { source_id: sourceId, purge_job_id: job.id },
      });
      return outcome(updated!);
    });
  } catch (error) {
    return fail(
      database,
      context,
      sourceId,
      error instanceof AppError &&
      (error.code === 'POLICY_DENIED' || error.code === 'CAPABILITY_UNAVAILABLE')
        ? 'SOURCE_MATERIAL_HOLD_UNCONFIRMED'
        : error instanceof Error && error.message === 'STORE_UNAVAILABLE'
        ? 'STORE_UNAVAILABLE'
        : error instanceof Error && error.message === 'ARTIFACT_PURGE_UNCONFIRMED'
          ? 'ARTIFACT_PURGE_UNCONFIRMED'
          : error instanceof Error && error.message === 'TRANSCRIPT_PURGE_UNCONFIRMED'
            ? 'TRANSCRIPT_PURGE_UNCONFIRMED'
            : 'PURGE_FAILED',
    );
  }
}

/** Claim at most five due restarts. Temporal's stable source workflow ID owns execution, not this row.
 * Eight automatic requests are enough to hand a persistent failure to an operator without a hot loop. */
export async function claimSourcePurgeRetries(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly { sourceId: string }[]> {
  requireService(context);
  return withTenantTx(database, context, async (tx) => {
    const due = await tx.execute<{ id: string; sourceId: string; requests: number }>(
      sql`select j.id,j.source_id as "sourceId",j.retry_requests as requests from knowledge.purge_jobs j join knowledge.sources s on s.organization_id=j.organization_id and s.id=j.source_id where j.organization_id=${context.organizationId}::uuid and s.state<>'active' and j.state<>'completed' and j.retry_requests<8 and j.next_retry_at<=now() and (j.state in ('pending','failed') or (j.state='running' and j.last_attempt_at<now()-interval '1 hour')) order by j.next_retry_at,j.requested_at,j.id limit 5 for update of j skip locked`,
    );
    for (const job of due.rows) {
      const requests = job.requests + 1;
      await tx
        .update(knowledgePurgeJobs)
        .set({
          retryRequests: requests,
          nextRetryAt:
            requests >= 8
              ? null
              : new Date(
                  Date.now() + Math.min(24 * 60 * 60_000, 15 * 60_000 * 2 ** (requests - 1)),
                ),
        })
        .where(eq(knowledgePurgeJobs.id, job.id));
    }
    return due.rows.map((job) => ({ sourceId: job.sourceId }));
  });
}
export async function sourcePurgeWorkerState(
  database: AppDatabase,
  context: TenantContext,
  input: { sourceId: string },
): Promise<{ state: PurgeState; chunks: number }> {
  requireService(context);
  return withTenantTx(database, context, async (tx) => {
    const job = await jobFor(tx, checkedId(input.sourceId));
    return { state: job.state as PurgeState, chunks: job.chunksRemoved };
  });
}

export type PurgeStatus = {
  sourceId: string;
  reason: PurgeReason;
  state: PurgeState;
  counts: Omit<PurgeOutcome, 'state'>;
  requestedAt: Date;
  completedAt: Date | null;
  priorCompletedAt: Date | null;
  lastErrorCode: string | null;
  retryRequests: number;
  nextRetryAt: Date | null;
  retryExhausted: boolean;
  heldArtifacts: number;
};
export async function getPurgeStatus(
  database: AppDatabase,
  context: TenantContext,
  rawSourceId: string,
): Promise<PurgeStatus> {
  const sourceId = checkedId(rawSourceId);
  return withTenantTx(database, context, async (tx) => {
    const source = await lockSource(tx, sourceId);
    await person(tx, context, source);
    const job = await jobFor(tx, sourceId);
    const { state: recordedState, ...counts } = outcome(job);
    const work =
      source.state === 'active'
        ? null
        : (
            await tx.execute<{
              removed: number;
              remaining: number;
              unproven: number;
              controlsRemaining: number;
              receiptsSha256: string;
            }>(sql`select removed,remaining,unproven,receipts_sha256 "receiptsSha256",
      ai.source_run_closure_remaining(${sourceId}::uuid,${source.version}::bigint) "controlsRemaining"
      from ai.source_delegated_work_counts(${sourceId}::uuid)`)
          ).rows[0];
    const generation = (
      await tx.execute<{ generation: string | null }>(
        sql`select ai.current_material_restore_generation() generation`,
      )
    ).rows[0]?.generation;
    const workProof =
      work !== null &&
      work !== undefined &&
      work.remaining === 0 &&
      work.unproven === 0 &&
      work.controlsRemaining === 0 &&
      job.delegatedWorkCheckedAt !== null &&
      job.delegatedWorkSourceVersion === source.version &&
      job.delegatedWorkReceiptsSha256 === work.receiptsSha256 &&
      job.delegatedWorkRestoreGeneration !== null &&
      job.delegatedWorkRestoreGeneration === generation &&
      job.transcriptRestoreGeneration === generation;
    const state =
      recordedState === 'completed' &&
      (!job.transcriptsCheckedAt || !job.artifactsCheckedAt || !workProof)
        ? 'failed'
        : recordedState;
    return {
      sourceId,
      reason: job.reason as PurgeReason,
      state,
      counts: {
        ...counts,
        workUnits: work?.removed ?? job.delegatedWorkRemoved,
        workUnitsRemaining: work?.remaining ?? null,
        workControlProofsRemaining: work?.controlsRemaining ?? null,
        unprovenWorkUnits: work?.unproven ?? null,
      },
      requestedAt: job.requestedAt,
      completedAt: state === 'completed' ? job.completedAt : null,
      priorCompletedAt: job.priorCompletedAt,
      lastErrorCode:
        state !== recordedState
          ? !workProof
            ? 'DELEGATED_WORK_PURGE_UNCONFIRMED'
            : 'ARTIFACT_PURGE_UNCONFIRMED'
          : job.lastErrorCode,
      retryRequests: job.retryRequests,
      nextRetryAt: job.nextRetryAt,
      retryExhausted: job.retryRequests >= 8 && state !== 'completed',
      heldArtifacts: job.derivedArtifactsHeld,
    };
  });
}

export async function reapplyKnowledgeSourceEntry(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  entry: LedgerEntry,
  result: ReapplyResult,
  options: ReapplyOptions,
): Promise<void> {
  requireService(context);
  if (
    entry.targetType !== AGGREGATE_KNOWLEDGE_SOURCE ||
    entry.organizationId !== context.organizationId
  )
    throw new AppError('INVALID_INPUT');
  const sourceId = checkedId(entry.targetId);
  const snapshot = await withTenantTx(database, context, async (tx) => {
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId));
    if (!organization) return { missing: true as const };
    const [source] = await tx
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, sourceId));
    if (!source) return { missing: false as const, source: null, documents: [] };
    const documents = await tx
      .select({ id: knowledgeDocuments.id, key: knowledgeDocuments.objectKey })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.sourceId, sourceId));
    return { missing: false as const, source, documents };
  });
  if (snapshot.missing) {
    result.organizationsMissing++;
    return;
  }
  if (
    snapshot.source?.state === 'active' &&
    !options.confirmed?.has(ledgerRef(entry)) &&
    snapshot.documents.length &&
    (await allBytesExist(
      store,
      snapshot.documents.map(
        (document) => document.key ?? knowledgeObjectKey(context.organizationId, document.id),
      ),
    ))
  ) {
    result.unconfirmed++;
    options.onUnconfirmed?.(entry);
    return;
  }
  const added = await withTenantTx(database, context, async (tx) => {
    const [source] = await tx
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, sourceId))
      .for('update');
    if (source) {
      const existed = await tx
        .select({ id: tombstones.targetId })
        .from(tombstones)
        .where(
          and(
            eq(tombstones.targetType, AGGREGATE_KNOWLEDGE_SOURCE),
            eq(tombstones.targetId, sourceId),
          ),
        );
      await close(tx, context, source, 'restore_reapply', entry.deletedAt);
      return existed.length === 0;
    }
    const rows = await tx
      .insert(tombstones)
      .values({
        organizationId: context.organizationId,
        targetType: AGGREGATE_KNOWLEDGE_SOURCE,
        targetId: sourceId,
        reasonCode: 'RESTORE_REAPPLY',
        createdAt: entry.deletedAt,
      })
      .onConflictDoNothing()
      .returning({ id: tombstones.targetId });
    return rows.length > 0;
  });
  if (added) result.tombstonesAdded++;
  // The transactional outbox starts M4's durable fence and the remaining projection cleanup.
}
async function allBytesExist(store: ObjectStore, keys: readonly string[]) {
  for (const key of keys) if (!(await store.exists(key))) return false;
  return true;
}
