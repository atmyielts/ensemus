// Requires coherent0419/0510/0514/0515. The native global rotation case is a dedicated serial
// restore-admission gate, not a parallel/shared-stack test or proof of a completed physical restore.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createWorkUnit } from '@ensemus/application';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { createRunTranscriptPurge } from '@ensemus/application/ai-input-ledger';
import { createDelegatedRecordPurge } from '@ensemus/application/knowledge/delegated-record-purge';
import { createDelegatedWorkPurge } from '@ensemus/application/knowledge/delegated-work-purge';
import { purgeRunTranscriptsForSource, revokeSource } from '@ensemus/application/knowledge/purge';
import {
  knowledgePurgeJobs,
  knowledgeSources,
  openAppDatabase,
  organizations,
  recordPurgeJobs,
  tombstones,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { pgCode } from '../../packages/application/src/errors';
import { openAgentTestDatabase, seedAiTenant } from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';

describe('actual protected material restore admission (0515)', () => {
  const app = openAppDatabase(urls.app()),
    agent = openAgentTestDatabase();
  const migrator = new pg.Client({ connectionString: urls.migrator() });
  beforeAll(async () => {
    await migrator.connect();
  });
  afterAll(async () => {
    await migrator.end();
    await agent.close();
    await app.close();
  });
  const accounting = () => createKnowledgeCallStore(agent.db, { halt: createHaltCheck() });
  const records = () =>
    createDelegatedRecordPurge({
      database: agent.db,
      accounting: accounting(),
      transcripts: createRunTranscriptPurge(),
    });
  const generation = (context: TenantContext) =>
    withTenantTx(
      app.db,
      context,
      async (tx) =>
        (
          await tx.execute<{ value: string | null }>(
            sql`select ai.current_material_restore_generation() value`,
          )
        ).rows[0]?.value,
    );

  it('does not let a native owner, service or agent rotate or choose the root generation', async () => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' }),
      service = createServiceContext(tenant.organizationId);
    const original = await generation(tenant.owner);
    expect(original).toMatch(/^[0-9a-f-]{36}$/);
    for (const context of [tenant.owner, service]) {
      await expect(
        withTenantTx(app.db, context, (tx) =>
          tx
            .update(organizations)
            .set({ materialRestoreGeneration: randomUUID() })
            .where(eq(organizations.id, tenant.organizationId)),
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
      await expect(
        withTenantTx(app.db, context, (tx) =>
          tx.execute(sql`select sovereign.rotate_material_restore_generation()`),
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    }
    await expect(
      withTenantTx(agent.db, service, (tx) =>
        tx.execute(sql`select sovereign.rotate_material_restore_generation()`),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    expect(await generation(tenant.owner)).toBe(original);
  });

  async function completedEmptySource(owner: TenantContext) {
    const sourceId = randomUUID();
    await withTenantTx(app.db, owner, (tx) =>
      tx.insert(knowledgeSources).values({
        organizationId: owner.organizationId,
        id: sourceId,
        kind: 'upload',
        classification: 'internal',
        ownerMembershipId: owner.membershipId,
      }),
    );
    const { purgeJobId } = await revokeSource(app.db, owner, {
      sourceId,
      expectedVersion: 1,
      reason: 'Actual empty source restore gate.',
    });
    const service = createServiceContext(owner.organizationId);
    await purgeRunTranscriptsForSource(
      agent.db,
      service,
      { transcripts: createRunTranscriptPurge() },
      { sourceId },
    );
    expect(
      await createDelegatedWorkPurge({ database: agent.db, accounting: accounting() }).purgeSource(
        service,
        { sourceId, limit: 25 },
      ),
    ).toMatchObject({ confirmed: true, removed: 0, remaining: 0, controlsRemaining: 0 });
    // No document/object/header was ever created for this source. The actual SQL source/archive/
    // object/Work/control guards independently validate this known empty inventory.
    await withTenantTx(app.db, service, (tx) =>
      tx
        .update(knowledgePurgeJobs)
        .set({ state: 'completed', completedAt: new Date(), artifactsCheckedAt: new Date() })
        .where(eq(knowledgePurgeJobs.id, purgeJobId)),
    );
    const [job] = await withTenantTx(app.db, owner, (tx) =>
      tx.select().from(knowledgePurgeJobs).where(eq(knowledgePurgeJobs.id, purgeJobId)),
    );
    if (!job?.completedAt) throw new Error('TEST_ACTUAL_SOURCE_PROOF_MISSING');
    expect(job.transcriptRunsSha256).toBe(createHash('sha256').digest('hex'));
    return { sourceId, purgeJobId, job };
  }

  it('invalidates restored certificates, restores native bindings and requires genuine current-generation repair', async () => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' }),
      service = createServiceContext(tenant.organizationId);
    const source = await completedEmptySource(tenant.owner);
    const work = await createWorkUnit(app.db, tenant.owner, {
      title: 'Actual record snapshot to requalify',
    });
    await withTenantTx(app.db, tenant.owner, (tx) =>
      tx.insert(tombstones).values({
        organizationId: tenant.organizationId,
        targetType: 'work_unit',
        targetId: work.id,
        reasonCode: 'USER_DELETED',
      }),
    );
    expect(
      await records().purgeRecord(service, { kind: 'work_unit', id: work.id, limit: 25 }),
    ).toMatchObject({ confirmed: true });
    const oldGeneration = await generation(tenant.owner);
    const [oldJob] = await withTenantTx(app.db, tenant.owner, (tx) =>
      tx.select().from(recordPurgeJobs).where(eq(recordPurgeJobs.recordId, work.id)),
    );
    expect(oldJob?.restoreGeneration).toBe(oldGeneration);
    const prior = {
      'app.organization_id': randomUUID(),
      'app.actor_type': 'user',
      'app.membership_id': randomUUID(),
      'app.user_id': randomUUID(),
      'sovereign.material_restore_mode': 'previous',
      'sovereign.material_restore_org': randomUUID(),
      'sovereign.material_restore_generation': randomUUID(),
    };
    await migrator.query('begin');
    try {
      for (const [key, value] of Object.entries(prior))
        await migrator.query('select set_config($1,$2,true)', [key, value]);
      const rotation = await migrator.query<{ tenants: number }>(
        'select sovereign.rotate_material_restore_generation() tenants',
      );
      expect(rotation.rows[0]?.tenants).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(prior))
        expect(
          (await migrator.query<{ value: string }>('select current_setting($1,true) value', [key]))
            .rows[0]?.value,
        ).toBe(value);
      await migrator.query('commit');
    } catch (error) {
      await migrator.query('rollback');
      throw error;
    }
    const currentGeneration = await generation(tenant.owner);
    expect(currentGeneration).not.toBe(oldGeneration);
    const [invalidated] = await withTenantTx(app.db, tenant.owner, (tx) =>
      tx.select().from(knowledgePurgeJobs).where(eq(knowledgePurgeJobs.id, source.purgeJobId)),
    );
    expect(invalidated).toMatchObject({
      state: 'failed',
      completedAt: null,
      priorCompletedAt: source.job.completedAt,
      lastErrorCode: 'RESTORE_MATERIAL_REQUALIFICATION_REQUIRED',
      documentsRemoved: source.job.documentsRemoved,
      transcriptsRemoved: source.job.transcriptsRemoved,
      transcriptsCheckedAt: source.job.transcriptsCheckedAt,
      transcriptRunsSha256: source.job.transcriptRunsSha256,
      delegatedWorkCheckedAt: source.job.delegatedWorkCheckedAt,
    });
    await expect(
      withTenantTx(app.db, service, (tx) =>
        tx
          .update(knowledgePurgeJobs)
          .set({ state: 'completed', completedAt: new Date() })
          .where(eq(knowledgePurgeJobs.id, source.purgeJobId)),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN119');
    expect(
      await withTenantTx(app.db, service, (tx) =>
        records().confirmRecordInTx(tx, service, { kind: 'work_unit', id: work.id }),
      ),
    ).toMatchObject({ confirmed: false });
    // The old record row/history is not rewritten into new observed authority. The actual native
    // adapter verifies current catalog/hold/empty-run proof before replacing its progress certificate.
    expect(
      await records().purgeRecord(service, { kind: 'work_unit', id: work.id, limit: 25 }),
    ).toMatchObject({ confirmed: true });
    const [fresh] = await withTenantTx(app.db, tenant.owner, (tx) =>
      tx.select().from(recordPurgeJobs).where(eq(recordPurgeJobs.recordId, work.id)),
    );
    expect(fresh?.restoreGeneration).toBe(currentGeneration);
    expect(fresh?.createdAt).toEqual(oldJob?.createdAt);
    await purgeRunTranscriptsForSource(
      agent.db,
      service,
      { transcripts: createRunTranscriptPurge() },
      { sourceId: source.sourceId },
    );
    expect(
      await createDelegatedWorkPurge({ database: agent.db, accounting: accounting() }).purgeSource(
        service,
        { sourceId: source.sourceId, limit: 25 },
      ),
    ).toMatchObject({ confirmed: true });
    await withTenantTx(app.db, service, (tx) =>
      tx
        .update(knowledgePurgeJobs)
        .set({ state: 'completed', completedAt: new Date() })
        .where(eq(knowledgePurgeJobs.id, source.purgeJobId)),
    );
    const [repaired] = await withTenantTx(app.db, tenant.owner, (tx) =>
      tx.select().from(knowledgePurgeJobs).where(eq(knowledgePurgeJobs.id, source.purgeJobId)),
    );
    expect(repaired?.priorCompletedAt).toEqual(source.job.completedAt);
    expect(repaired?.transcriptRestoreGeneration).toBe(currentGeneration);
    expect(repaired?.delegatedWorkRestoreGeneration).toBe(currentGeneration);
    expect(repaired?.documentsRemoved).toBe(source.job.documentsRemoved);
    expect(repaired?.transcriptsRemoved).toBe(source.job.transcriptsRemoved);
  });
});
