// Requires the complete unregistered0417/0419 +0514 join. These use actual login roles and
// genuinely appended tombstones/holds; no synthetic child receipts or disabled SQL guard.
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createWorkUnit } from '@ensemus/application';
import { transitionWorkUnit } from '@ensemus/application';
import { createDelegatedRecordPurge } from '@ensemus/application/knowledge/delegated-record-purge';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { createRunTranscriptPurge, recordRunInputs, workInputHash } from '@ensemus/application/ai-input-ledger';
import { claimQueuedRun } from '@ensemus/application/ai-runs';
import {
  openAppDatabase,
  recordPurgeJobs,
  recordRunClosures,
  agentRuns,
  workUnits,
  tombstones,
  withTenantTx,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { pgCode } from '../../packages/application/src/errors';
import { loadAgentReadScopeInTx } from '../../packages/application/src/ai/read-scope';
import { openAgentTestDatabase, prepareRunInputContext, seedAgentVersion, seedAiTenant, seedQueuedRun, testAgentSpec } from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';

function barrier() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('typed-record purge snapshot and hold authority (0419/0514)', () => {
  const app = openAppDatabase(urls.app(), { max: 4 }),
    agent = openAgentTestDatabase(4);
  afterAll(async () => {
    await agent.close();
    await app.close();
  });

  async function fixture() {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    const work = await createWorkUnit(app.db, tenant.owner, {
      title: 'Actual record purge target',
    });
    await withTenantTx(app.db, tenant.owner, (tx) =>
      tx.insert(tombstones).values({
        organizationId: tenant.organizationId,
        targetType: 'work_unit',
        targetId: work.id,
        reasonCode: 'USER_DELETED',
      }),
    );
    const service = createServiceContext(tenant.organizationId);
    const snapshot = await withTenantTx(
      app.db,
      service,
      async (tx) =>
        (
          await tx.execute<{ hash: string | null }>(
            sql`select ai.lock_record_purge_snapshot('work_unit',${work.id}::uuid) hash`,
          )
        ).rows[0]?.hash,
    );
    if (!snapshot) throw new Error('TEST_RECORD_SNAPSHOT_MISSING');
    return { tenant, work, service, snapshot };
  }
  async function hold(tx: Tx, owner: TenantContext) {
    const id = randomUUID();
    await tx.execute(sql`insert into lifecycle.legal_holds(organization_id,id,matter_ref,placed_by_membership_id)
      values(${owner.organizationId}::uuid,${id}::uuid,${randomUUID()},${owner.membershipId}::uuid)`);
    await tx.execute(sql`insert into lifecycle.legal_hold_scopes(organization_id,hold_id,scope_type)
      values(${owner.organizationId}::uuid,${id}::uuid,'organization')`);
    return id;
  }
  const check = (tx: Tx, id: string, snapshot: string) =>
    tx.execute<{ allowed: boolean }>(
      sql`select lifecycle.record_purge_hold_free('work_unit',${id}::uuid,${snapshot}) allowed`,
    );
  const adapter = () => createDelegatedRecordPurge({ database: agent.db,transcripts: createRunTranscriptPurge(),
    accounting: createKnowledgeCallStore(agent.db,{ halt: createHaltCheck() }) });

  it('requires an actual checked empty set and returns only the genuine file count', async () => {
    const f = await fixture();
    await expect(
      withTenantTx(app.db, f.service, (tx) =>
        tx.execute(
          sql`select knowledge.derived_structured_artifacts_remaining('work_unit',${f.work.id}::uuid)`,
        ),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN119');
    expect(await adapter().purgeRecord(f.service,{ kind: 'work_unit',id: f.work.id,limit: 25 })).toEqual({
      confirmed: true,removed: 0,remaining: 0,controlsRemaining: 0,unproven: 0 });
    await withTenantTx(app.db, f.service, async (tx) => {
      expect(
        (
          await tx.execute<{ confirmed: boolean }>(
            sql`select ai.record_work_purge_confirmed('work_unit',${f.work.id}::uuid) confirmed`,
          )
        ).rows[0]?.confirmed,
      ).toBe(true);
      expect(
        (
          await tx.execute<{ remaining: number }>(
            sql`select knowledge.derived_structured_artifacts_remaining('work_unit',${f.work.id}::uuid) remaining`,
          )
        ).rows[0]?.remaining,
      ).toBe(0);
    });
  });

  it('refuses active, missing, foreign and wrong-hash metadata without promoting it', async () => {
    const f = await fixture(),
      other = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    const active = await createWorkUnit(app.db, f.tenant.owner, { title: 'Still live record' });
    await withTenantTx(app.db, f.service, async (tx) => {
      expect(
        (
          await tx.execute<{ hash: string | null }>(
            sql`select ai.lock_record_purge_snapshot('work_unit',${active.id}::uuid) hash`,
          )
        ).rows[0]?.hash,
      ).toBeNull();
      for (const id of [active.id, randomUUID()])
        expect((await check(tx, id, f.snapshot)).rows[0]?.allowed).toBe(false);
      expect((await check(tx, f.work.id, '0'.repeat(64))).rows[0]?.allowed).toBe(false);
    });
    await withTenantTx(app.db, createServiceContext(other.organizationId), async (tx) => {
      expect((await check(tx, f.work.id, f.snapshot)).rows[0]?.allowed).toBe(false);
    });
  });

  it('does not admit a human, forged agent actor or app proof writer', async () => {
    const f = await fixture();
    await withTenantTx(app.db, f.tenant.owner, async (tx) => {
      expect((await check(tx, f.work.id, f.snapshot)).rows[0]?.allowed).toBe(false);
      await tx.execute(sql`select set_config('app.actor_type','agent',true)`);
      expect((await check(tx, f.work.id, f.snapshot)).rows[0]?.allowed).toBe(false);
    });
    await expect(
      withTenantTx(app.db, f.service, (tx) =>
        tx.insert(recordPurgeJobs).values({
          organizationId: f.tenant.organizationId,
          recordKind: 'work_unit',
          recordId: f.work.id,
          snapshotSha256: f.snapshot,
        }),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
  });

  it('retains no positive hold proof while an actual legal hold is active', async () => {
    const f = await fixture();
    await withTenantTx(app.db, f.tenant.owner, (tx) => hold(tx, f.tenant.owner));
    for (const database of [app.db, agent.db])
      await withTenantTx(database, f.service, async (tx) => {
        expect((await check(tx, f.work.id, f.snapshot)).rows[0]?.allowed).toBe(false);
      });
  });

  it('refuses an uncommitted hold barrier and observes that hold after commit', async () => {
    const f = await fixture(),
      acquired = barrier(),
      release = barrier();
    const placing = withTenantTx(app.db, f.tenant.owner, async (tx) => {
      await hold(tx, f.tenant.owner);
      acquired.resolve();
      await release.promise;
    });
    try {
      await Promise.race([acquired.promise, placing]);
      await withTenantTx(agent.db, f.service, async (tx) => {
        await tx.execute(sql`set local statement_timeout='2s'`);
        expect((await check(tx, f.work.id, f.snapshot)).rows[0]?.allowed).toBe(false);
      });
    } finally {
      release.resolve();
      await placing;
    }
    await withTenantTx(agent.db, f.service, async (tx) => {
      expect((await check(tx, f.work.id, f.snapshot)).rows[0]?.allowed).toBe(false);
    });
  });

  it('keeps the real hold-placement barrier until its proof transaction commits', async () => {
    const f = await fixture(),
      acquired = barrier(),
      release = barrier();
    const proving = withTenantTx(agent.db, f.service, async (tx) => {
      expect((await check(tx, f.work.id, f.snapshot)).rows[0]?.allowed).toBe(true);
      acquired.resolve();
      await release.promise;
    });
    try {
      await Promise.race([acquired.promise, proving]);
      await expect(
        withTenantTx(app.db, f.tenant.owner, async (tx) => {
          await tx.execute(sql`set local statement_timeout='2s'`);
          return hold(tx, f.tenant.owner);
        }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '55P03');
    } finally {
      release.resolve();
      await proving;
    }
    await withTenantTx(app.db, f.tenant.owner, (tx) => hold(tx, f.tenant.owner));
    await withTenantTx(agent.db, f.service, async (tx) => {
      expect((await check(tx, f.work.id, f.snapshot)).rows[0]?.allowed).toBe(false);
    });
  });

  it('restores every private selector after successful and refused checks', async () => {
    const f = await fixture();
    await withTenantTx(agent.db, f.service, async (tx) => {
      const names = [
        'app.record_purge_kind',
        'app.record_purge_id',
        'lifecycle.record_purge_org',
        'lifecycle.record_purge_kind',
        'lifecycle.record_purge_id',
        'lifecycle.record_purge_hash',
      ];
      for (const name of names)
        await tx.execute(sql`select set_config(${name},'prior-selector',true)`);
      expect((await check(tx, f.work.id, f.snapshot)).rows[0]?.allowed).toBe(true);
      expect((await check(tx, f.work.id, '0'.repeat(64))).rows[0]?.allowed).toBe(false);
      for (const name of names)
        expect(
          (await tx.execute<{ value: string }>(sql`select current_setting(${name},true) value`))
            .rows[0]?.value,
        ).toBe('prior-selector');
    });
  });

  it('serializes genuine uncommitted body reads before record closure and consumes them exactly once', async () => {
    const tenant = await seedAiTenant(app.db,{ commercialMode: 'sovereign' });
    const input = await createWorkUnit(app.db,tenant.owner,{ title: 'Actual earlier material read' });
    const work = await createWorkUnit(app.db,tenant.owner,{ title: 'Actual consuming run' });
    await transitionWorkUnit(app.db,tenant.owner,{ id: work.id,expectedVersion: work.version,to: 'ready' });
    const version = await seedAgentVersion(app.db,tenant.owner,testAgentSpec());
    const runId = await seedQueuedRun(app.db,tenant.owner,{ workUnitId: work.id,version });
    if (!(await claimQueuedRun(agent.db,{ organizationId: tenant.organizationId,workUnitId: work.id,temporalRunId: randomUUID() }))) throw new Error('TEST_RUN_NOT_CLAIMED');
    const context = await prepareRunInputContext(agent.db,tenant.organizationId,runId);
    await withTenantTx(agent.db,context,tx => tx.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id,runId)));
    const read = barrier(),release = barrier();
    const consuming = withTenantTx(agent.db,context,async tx => {
      await loadAgentReadScopeInTx(tx,context);
      const lock = await tx.execute<{ locked: boolean }>(sql`select knowledge.lock_structured_record('work_unit',${input.id}::uuid) locked`);
      if (lock.rows[0]?.locked !== true) throw new Error('TEST_ACTUAL_RECORD_LOCK_REFUSED');
      const [body] = await tx.select({ title: workUnits.title,objective: workUnits.objective }).from(workUnits).where(eq(workUnits.id,input.id)).for('share');
      if (!body) throw new Error('TEST_ACTUAL_BODY_HIDDEN');
      const actualClass = await tx.execute<{ classification: string | null }>(sql`select knowledge.structured_record_class('work_unit',${input.id}::uuid) classification`);
      if (actualClass.rows[0]?.classification !== 'internal') throw new Error('TEST_ACTUAL_CLASS_CHANGED');
      await recordRunInputs(tx,context,[{ kind: 'work_unit',id: input.id,sha256: workInputHash(body),classification: 'internal' }]);
      read.resolve();await release.promise;
    });
    const close = () => withTenantTx(app.db,tenant.owner,async tx => {
      await tx.execute(sql`set local statement_timeout='2s'`);
      await tx.insert(tombstones).values({ organizationId: tenant.organizationId,targetType: 'work_unit',targetId: input.id,reasonCode: 'USER_DELETED' });
    });
    try {
      await Promise.race([read.promise,consuming]);
      await expect(close()).rejects.toSatisfy((error: unknown) => pgCode(error)==='55P03');
      await withTenantTx(app.db,createServiceContext(tenant.organizationId),async tx => {
        expect((await tx.execute<{ hash: string | null }>(sql`select ai.lock_record_purge_snapshot('work_unit',${input.id}::uuid) hash`)).rows[0]?.hash).toBeNull();
      });
    } finally { release.resolve();await consuming; }
    await close();
    const service = createServiceContext(tenant.organizationId),purge = adapter();
    expect(await purge.purgeRecord(service,{ kind: 'work_unit',id: input.id,limit: 1 })).toMatchObject({ confirmed: true,controlsRemaining: 0 });
    const witnesses = () => withTenantTx(app.db,tenant.owner,tx => tx.select().from(recordRunClosures)
      .where(and(eq(recordRunClosures.recordId,input.id),eq(recordRunClosures.runId,runId))));
    const original = await witnesses();expect(original).toHaveLength(1);
    expect(await purge.purgeRecord(service,{ kind: 'work_unit',id: input.id,limit: 1 })).toMatchObject({ confirmed: true,controlsRemaining: 0 });
    expect(await witnesses()).toEqual(original);
  });
});
