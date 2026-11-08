// Source only. Requires the coherent 0417/0419/0510/0515 join; no SQL execution is claimed.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { openAppDatabase, withTenantTx, type Tx, type TenantContext } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createRunTranscriptPurge } from '@ensemus/application/ai-input-ledger';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { createDelegatedWorkPurge } from '@ensemus/application/knowledge/delegated-work-purge';
import {
  purgeRunTranscriptsForSource,
  revokeSource,
  runSourcePurge,
} from '@ensemus/application/knowledge/purge';
import { createDerivedArtifactPurge } from '../../packages/application/src/knowledge/artifact-provenance';
import { pgCode } from '../../packages/application/src/errors';
import { seedSearchableSource } from '../helpers/knowledge';
import { openAgentTestDatabase, seedAiTenant } from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';

function barrier() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('source material hold authority (0515)', () => {
  const app = openAppDatabase(urls.app(), { max: 4 }),
    agent = openAgentTestDatabase(4);
  afterAll(async () => {
    await agent.close();
    await app.close();
  });
  async function fixture() {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    const source = await seedSearchableSource(app.db, tenant.owner, {
      passages: ['Actual held source projection.'],
      grants: [{ kind: 'organization' }],
    });
    const { purgeJobId } = await revokeSource(app.db, tenant.owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      reason: 'Actual source hold fixture.',
    });
    const service = createServiceContext(tenant.organizationId);
    return { tenant, source, purgeJobId, service };
  }
  async function hold(tx: Tx, owner: TenantContext) {
    const id = randomUUID();
    await tx.execute(sql`insert into lifecycle.legal_holds(organization_id,id,matter_ref,placed_by_membership_id)
      values(${owner.organizationId}::uuid,${id}::uuid,${randomUUID()},${owner.membershipId}::uuid)`);
    await tx.execute(
      sql`insert into lifecycle.legal_hold_scopes(organization_id,hold_id,scope_type) values(${owner.organizationId}::uuid,${id}::uuid,'organization')`,
    );
    return id;
  }
  const check = (tx: Tx, source: string, job: string, version = 2) =>
    tx.execute<{ allowed: boolean }>(
      sql`select lifecycle.source_payload_hold_free(${source}::uuid,${version}::bigint,${job}::uuid) allowed`,
    );

  it('requires exact native operation/job/version/tenant and restores its private selectors', async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      withTenantTx(app.db, f.service, (tx) => check(tx, f.source.sourceId, f.purgeJobId)),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    await withTenantTx(agent.db, f.service, async (tx) => {
      for (const name of [
        'lifecycle.source_purge_org',
        'lifecycle.source_purge_source',
        'lifecycle.source_purge_job',
      ])
        await tx.execute(sql`select set_config(${name},'prior-selector',true)`);
      expect((await check(tx, f.source.sourceId, f.purgeJobId)).rows[0]?.allowed).toBe(true);
      expect((await check(tx, f.source.sourceId, f.purgeJobId, 1)).rows[0]?.allowed).toBe(false);
      expect((await check(tx, f.source.sourceId, randomUUID())).rows[0]?.allowed).toBe(false);
      expect((await check(tx, other.source.sourceId, other.purgeJobId)).rows[0]?.allowed).toBe(
        false,
      );
      expect(
        (
          await tx.execute<{ allowed: boolean }>(
            sql`select lifecycle.source_projection_hold_free(${f.source.sourceId}::uuid,2,${f.purgeJobId}::uuid) allowed`,
          )
        ).rows[0]?.allowed,
      ).toBe(false);
      for (const name of [
        'lifecycle.source_purge_org',
        'lifecycle.source_purge_source',
        'lifecycle.source_purge_job',
      ])
        expect(
          (await tx.execute<{ value: string }>(sql`select current_setting(${name},true) value`))
            .rows[0]?.value,
        ).toBe('prior-selector');
    });
    await withTenantTx(app.db, f.tenant.owner, async (tx) => {
      expect(
        (
          await tx.execute<{ allowed: boolean }>(
            sql`select lifecycle.source_projection_hold_free(${f.source.sourceId}::uuid,2,${f.purgeJobId}::uuid) allowed`,
          )
        ).rows[0]?.allowed,
      ).toBe(false);
    });
  });

  it('preserves actual source projections under a hold even after genuine empty transcript/Work proof', async () => {
    const f = await fixture();
    await purgeRunTranscriptsForSource(
      agent.db,
      f.service,
      { transcripts: createRunTranscriptPurge() },
      { sourceId: f.source.sourceId },
    );
    const works = createDelegatedWorkPurge({
      database: agent.db,
      accounting: createKnowledgeCallStore(agent.db, { halt: createHaltCheck() }),
    });
    expect(
      await works.purgeSource(f.service, { sourceId: f.source.sourceId, limit: 25 }),
    ).toMatchObject({ confirmed: true });
    await withTenantTx(app.db, f.tenant.owner, (tx) => hold(tx, f.tenant.owner));
    // An older native bundle can omit the new DAL helper. Actual fixed SQL row guards still
    // preserve both rows; no public selector string can override the same tenant hold barrier.
    await withTenantTx(app.db, f.service, async (tx) => {
      const keys = [
        'lifecycle.material_delete_org',
        'lifecycle.material_delete_source',
        'lifecycle.material_delete_run',
        'lifecycle.material_delete_row',
      ];
      for (const key of keys)
        await tx.execute(sql`select set_config(${key},'prior-selector',true)`);
      await tx.execute(sql`savepoint held_chunk`);
      await expect(
        tx.execute(
          sql`delete from knowledge.chunks where organization_id=${f.tenant.organizationId}::uuid and source_id=${f.source.sourceId}::uuid`,
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN119');
      await tx.execute(sql`rollback to savepoint held_chunk`);
      await tx.execute(sql`release savepoint held_chunk`);
      for (const key of keys)
        expect(
          (await tx.execute<{ value: string }>(sql`select current_setting(${key},true) value`))
            .rows[0]?.value,
        ).toBe('prior-selector');
    });
    await expect(
      withTenantTx(app.db, f.service, (tx) =>
        tx.execute(sql`delete from knowledge.documents
      where organization_id=${f.tenant.organizationId}::uuid and id=${f.source.documentId}::uuid`),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN119');
    const unexpected = async () => {
      throw new Error('TEST_UNEXPECTED_OBJECT_TRANSPORT');
    };
    const store = { put: unexpected, get: unexpected, delete: unexpected, exists: unexpected };
    const files = createDerivedArtifactPurge({
      database: app.db,
      store,
      lifecycle: { erase: async () => ({ state: 'unconfirmed' }) },
    });
    expect(
      await runSourcePurge(
        app.db,
        store,
        f.service,
        { sourceId: f.source.sourceId },
        { derivedArtifacts: files, delegatedWorks: works },
      ),
    ).toMatchObject({ state: 'failed', chunks: 0, documents: 0, blobs: 0 });
    await withTenantTx(app.db, f.service, async (tx) => {
      const rows = await tx.execute<{ chunks: number; documents: number; code: string }>(sql`select
        (select count(*)::integer from knowledge.chunks where organization_id=${f.tenant.organizationId}::uuid and source_id=${f.source.sourceId}::uuid) chunks,
        (select count(*)::integer from knowledge.documents where organization_id=${f.tenant.organizationId}::uuid and source_id=${f.source.sourceId}::uuid) documents,
        (select last_error_code from knowledge.purge_jobs where organization_id=${f.tenant.organizationId}::uuid and id=${f.purgeJobId}::uuid) code`);
      expect(rows.rows[0]).toEqual({
        chunks: 1,
        documents: 1,
        code: 'SOURCE_MATERIAL_HOLD_UNCONFIRMED',
      });
    });
  });

  it('allows a genuine current no-hold native projection purge and refuses agent role impersonation', async () => {
    const f = await fixture();
    await purgeRunTranscriptsForSource(
      agent.db,
      f.service,
      { transcripts: createRunTranscriptPurge() },
      { sourceId: f.source.sourceId },
    );
    await expect(
      withTenantTx(agent.db, f.service, (tx) =>
        tx.execute(sql`delete from knowledge.chunks
      where organization_id=${f.tenant.organizationId}::uuid and source_id=${f.source.sourceId}::uuid`),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    const removed = await withTenantTx(app.db, f.service, (tx) =>
      tx.execute<{ id: string }>(sql`delete from knowledge.chunks
      where organization_id=${f.tenant.organizationId}::uuid and source_id=${f.source.sourceId}::uuid returning id`),
    );
    expect(removed.rows.map((row) => row.id)).toEqual(f.source.chunkIds);
  });

  it('refuses a concurrent hold and retains the successful barrier until transaction commit', async () => {
    const f = await fixture(),
      acquired = barrier(),
      release = barrier();
    const proving = withTenantTx(agent.db, f.service, async (tx) => {
      expect((await check(tx, f.source.sourceId, f.purgeJobId)).rows[0]?.allowed).toBe(true);
      acquired.resolve();
      await release.promise;
    });
    try {
      await Promise.race([acquired.promise, proving]);
      await expect(
        withTenantTx(app.db, f.tenant.owner, async (tx) => {
          await tx.execute(sql`set local statement_timeout='2s'`);
          await hold(tx, f.tenant.owner);
        }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '55P03');
    } finally {
      release.resolve();
      await proving;
    }
    const placed = barrier(),
      finish = barrier();
    const placing = withTenantTx(app.db, f.tenant.owner, async (tx) => {
      await hold(tx, f.tenant.owner);
      placed.resolve();
      await finish.promise;
    });
    try {
      await Promise.race([placed.promise, placing]);
      await withTenantTx(agent.db, f.service, async (tx) => {
        expect((await check(tx, f.source.sourceId, f.purgeJobId)).rows[0]?.allowed).toBe(false);
      });
    } finally {
      finish.resolve();
      await placing;
    }
    await withTenantTx(agent.db, f.service, async (tx) => {
      expect((await check(tx, f.source.sourceId, f.purgeJobId)).rows[0]?.allowed).toBe(false);
    });
  });
});
