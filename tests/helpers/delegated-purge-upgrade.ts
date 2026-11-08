// Genuine two-phase upgrade gate: seed with the pre-0419 schema, apply the real0419 transaction,
// then assert and repair with the actual native adapter. No guard disabling or invented read history.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { knowledgePurgeJobs, withTenantTx, type AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { createDelegatedWorkPurge } from '@ensemus/application/knowledge/delegated-work-purge';
import { getPurgeStatus } from '@ensemus/application/knowledge/purge';
import { pgCode } from '../../packages/application/src/errors';
import { seedAiTenant } from './ai/fixtures';
import { seedSearchableSource } from './knowledge';

export async function seedCompletedPurgeBeforeDelegatedProofMigration(app: AppDatabase) {
  const tenant = await seedAiTenant(app, { commercialMode: 'sovereign' });
  const source = await seedSearchableSource(app, tenant.owner, {
    passages: ['Actual generated passage removed by the previous worker.'],
    grants: [{ kind: 'organization' }],
  });
  const jobId = randomUUID(), service = createServiceContext(tenant.organizationId);
  await withTenantTx(app, tenant.owner, async (tx) => {
    assert.equal((await tx.execute<{ applied: boolean }>(sql`select to_regprocedure('ai.source_run_closure_remaining(uuid,bigint)') is not null applied`)).rows[0]?.applied, false,
      'This phase requires the actual pre-0419 schema.');
    // Explicit old column projections let the current test source exercise the genuine old schema.
    // These are actual role-checked source closure and durable tombstone/job writes, not proof rows.
    await tx.execute(sql`update knowledge.sources set state='revoked',version=version+1,acl_revision=acl_revision+1,revoked_at=now(),updated_at=now()
      where organization_id=${tenant.organizationId}::uuid and id=${source.sourceId}::uuid and state='active' and version=1`);
    await tx.execute(sql`insert into platform.tombstones(organization_id,target_type,target_id,reason_code)
      values(${tenant.organizationId}::uuid,'knowledge_source',${source.sourceId}::uuid,'SOURCE_REVOKED')`);
    await tx.execute(sql`insert into knowledge.purge_jobs(organization_id,id,source_id,reason)
      values(${tenant.organizationId}::uuid,${jobId}::uuid,${source.sourceId}::uuid,'revoked')`);
  });
  const original = await withTenantTx(app, service, async (tx) => {
    const runs = await tx.execute<{ id: string }>(sql`select id from ai.source_input_runs(${source.sourceId}::uuid) actual(id) order by id`);
    assert.deepEqual(runs.rows, [], 'An empty transcript proof must be a real current empty consumer set.');
    const chunks = await tx.execute<{ id: string }>(sql`delete from knowledge.chunks where organization_id=${tenant.organizationId}::uuid and source_id=${source.sourceId}::uuid returning id`);
    const documents = await tx.execute<{ id: string }>(sql`delete from knowledge.documents where organization_id=${tenant.organizationId}::uuid and source_id=${source.sourceId}::uuid returning id`);
    assert.equal(chunks.rows.length, 1); assert.equal(documents.rows.length, 1);
    const runHash = createHash('sha256');
    for (const run of runs.rows) runHash.update(`${run.id}\n`);
    const completed = await tx.execute<{
      completedAt: Date; documents: number; chunks: number; transcripts: number; artifacts: number;
      transcriptVersion: string; transcriptHash: string; artifactsCheckedAt: Date; transcriptsCheckedAt: Date;
    }>(sql`update knowledge.purge_jobs set state='completed',completed_at=now(),documents_removed=${documents.rows.length},chunks_removed=${chunks.rows.length},
      artifacts_checked_at=now(),transcripts_checked_at=now(),transcript_source_version=2,transcript_runs_sha256=${runHash.digest('hex')}
      where organization_id=${tenant.organizationId}::uuid and id=${jobId}::uuid
      returning completed_at "completedAt",documents_removed documents,chunks_removed chunks,transcripts_removed transcripts,
        derived_artifacts_removed artifacts,transcript_source_version::text "transcriptVersion",transcript_runs_sha256 "transcriptHash",
        artifacts_checked_at "artifactsCheckedAt",transcripts_checked_at "transcriptsCheckedAt"`);
    const row = completed.rows[0];
    assert.ok(row); assert.ok(row.completedAt instanceof Date);
    return row;
  });
  return { tenant, sourceId: source.sourceId, jobId, original };
}

export async function assertCompletedPurgeAfterDelegatedProofMigration(
  app: AppDatabase, agent: AppDatabase,
  fixture: Awaited<ReturnType<typeof seedCompletedPurgeBeforeDelegatedProofMigration>>,
) {
  const { tenant, sourceId, jobId, original } = fixture, service = createServiceContext(tenant.organizationId);
  const read = () => withTenantTx(app, tenant.owner, async (tx) => {
    const [job] = await tx.select().from(knowledgePurgeJobs).where(and(eq(knowledgePurgeJobs.id, jobId),eq(knowledgePurgeJobs.sourceId, sourceId)));
    assert.ok(job); return job;
  });
  const demoted = await read();
  assert.equal(demoted.state, 'failed'); assert.equal(demoted.completedAt, null);
  assert.deepEqual(demoted.priorCompletedAt, original.completedAt);
  assert.equal(demoted.lastErrorCode, 'WORK_CONTROL_PROOF_REQUIRED');
  assert.equal(demoted.documentsRemoved, original.documents); assert.equal(demoted.chunksRemoved, original.chunks);
  assert.equal(demoted.transcriptsRemoved, original.transcripts); assert.equal(demoted.derivedArtifactsRemoved, original.artifacts);
  assert.equal(String(demoted.transcriptSourceVersion), original.transcriptVersion);
  assert.equal(demoted.transcriptRunsSha256, original.transcriptHash);
  assert.deepEqual(demoted.artifactsCheckedAt, original.artifactsCheckedAt);
  assert.deepEqual(demoted.transcriptsCheckedAt, original.transcriptsCheckedAt);
  assert.equal(demoted.delegatedWorkRemaining, null); assert.equal(demoted.delegatedWorkControlsRemaining, null);
  const status = await getPurgeStatus(app, tenant.owner, sourceId);
  assert.equal(status.state, 'failed'); assert.equal(status.lastErrorCode, 'WORK_CONTROL_PROOF_REQUIRED');
  assert.deepEqual(status.priorCompletedAt, original.completedAt);
  for (let replay=0;replay<2;replay+=1) await assert.rejects(withTenantTx(app, service, (tx) => tx.execute(
    sql`update knowledge.purge_jobs set state='completed',completed_at=now() where organization_id=${tenant.organizationId}::uuid and id=${jobId}::uuid`,
  )), (error: unknown) => pgCode(error)==='EN119');
  // Selectors cannot authorize the old app worker, even after copying the exact migration strings.
  await assert.rejects(withTenantTx(app, service, async (tx) => {
    await tx.execute(sql`select set_config('app.work_purge_requalification','row',true),set_config('app.work_purge_requalification_job',${jobId},true)`);
    return tx.execute(sql`update knowledge.purge_jobs set prior_completed_at=null where organization_id=${tenant.organizationId}::uuid and id=${jobId}::uuid`);
  }), (error: unknown) => pgCode(error)==='42501');
  await withTenantTx(app, service, async (tx) => {
    const policies = await tx.execute<{ policyname: string }>(sql`select policyname from pg_policies where schemaname='knowledge' and tablename='purge_jobs'
      and policyname in('work_purge_requalification_scan','work_purge_requalification_read','work_purge_requalification_write')`);
    assert.deepEqual(policies.rows, []);
  });
  const adapter = createDelegatedWorkPurge({ database: agent, accounting: createKnowledgeCallStore(agent, { halt: createHaltCheck() }) });
  const proof = await adapter.purgeSource(service, { sourceId, limit: 25 });
  assert.deepEqual(proof, { confirmed: true, removed: 0, remaining: 0, controlsRemaining: 0, unproven: 0 });
  // The same legacy completion write works only after the genuine new native empty-set proof.
  await withTenantTx(app, service, (tx) => tx.execute(sql`update knowledge.purge_jobs set state='completed',completed_at=now(),last_error_code=null
    where organization_id=${tenant.organizationId}::uuid and id=${jobId}::uuid`));
  const repaired = await read();
  assert.equal(repaired.state, 'completed'); assert.ok(repaired.completedAt instanceof Date);
  assert.deepEqual(repaired.priorCompletedAt, original.completedAt);
  assert.equal(repaired.documentsRemoved, original.documents); assert.equal(repaired.chunksRemoved, original.chunks);
  assert.equal(repaired.transcriptRunsSha256, original.transcriptHash);
  assert.deepEqual(repaired.artifactsCheckedAt, original.artifactsCheckedAt);
}
