import { addTrustedSigner, uploadSkillBundle } from '@ensemus/application';
import { placeLegalHold, releaseLegalHold } from '@ensemus/application/saas/legal-holds';
import { createTenantObjectErasure } from '@ensemus/application/saas/tenant-object-erasure';
import { beginErasure } from '@ensemus/application/saas/offboarding';
import {
  openAppDatabase,
  offboardings,
  sandboxRuns,
  skillVersions,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { createServiceContext } from '@ensemus/database/service';
import { SANDBOX_DEFAULT_CEILINGS } from '@ensemus/domain/sandbox';
import { skillBundleObjectKey } from '@ensemus/domain/skill';
import { buildTestBundle, generateTestKey } from '@ensemus/skills/testing';
import { createSkillVerificationActivities } from '@ensemus/workflows/skill-verification-activities';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { seedPackage, testPolicy } from '../helpers/skills';
import { urls } from '../helpers/stack';
import { LifecycleMemoryStore } from './saas-lifecycle-fixture';
import { readyToErase } from './saas-offboarding-fixture';

const enabled = { isEnabled: async () => true };
const tables = ['skills.test_runs', 'skills.package_versions', 'skills.bundle_uploads'] as const;

class SkillErasureStore extends LifecycleMemoryStore {
  async putSingleAttempt(
    key: string,
    bytes: Buffer,
  ): Promise<{ transport: 'written' | 'unknown' }> {
    await this.put(key, bytes);
    return { transport: 'written' };
  }
}

async function withEraser<T>(organizationId: string, run: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: urls.superuser() });
  await client.connect();
  try {
    await client.query('set session authorization ensemus_eraser');
    await client.query('begin');
    await client.query(
      "select set_config('app.organization_id',$1,true),set_config('app.actor_type','service',true)",
      [organizationId],
    );
    const result = await run(client);
    await client.query('commit');
    return result;
  } finally {
    await client.end();
  }
}

describe('skill bundle offboarding', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let worker: ReturnType<typeof openAppDatabase>;
  beforeAll(() => {
    database = openAppDatabase(urls.app());
    worker = openAppDatabase(urls.worker());
  });
  afterAll(async () => {
    await Promise.all([database?.close(), worker?.close()]);
  });

  async function uploadedBundle(owner: TenantContext, store: SkillErasureStore) {
    const pkg = await seedPackage(database.db, owner);
    const key = generateTestKey();
    await addTrustedSigner(database.db, owner, enabled, {
      displayName: 'Generated publisher',
      publicKey: key.publicKey,
    });
    const { bytes } = buildTestBundle({ name: pkg.name, key });
    return uploadSkillBundle(database.db, store, owner, enabled, { packageId: pkg.id, bytes });
  }

  async function verifiedUpload(owner: TenantContext, store: SkillErasureStore) {
    const uploaded = await uploadedBundle(owner, store);
    const verifier = createSkillVerificationActivities({
      database: worker.db,
      store,
      ceilings: SANDBOX_DEFAULT_CEILINGS,
      reviewKeys: new Map(),
    });
    expect(
      await verifier.checkSkillBundle({
        organizationId: owner.organizationId,
        skillVersionId: uploaded.id,
      }),
    ).toEqual({ step: 'finished', outcome: 'verified' });
    return skillBundleObjectKey(owner.organizationId, uploaded.id);
  }

  async function enterErasing(ready: Awaited<ReturnType<typeof readyToErase>>) {
    // Exercise this module after native admission. The full command still checks all modules first.
    await withAccountTx(database.db, ready.service, (tx) =>
      tx
        .update(offboardings)
        .set({
          state: 'erasing',
          erasureStartedAt: new Date(),
          erasureStartedByRef: 'test-operator@example.invalid',
          version: sql`${offboardings.version}+1`,
          updatedAt: new Date(),
        })
        .where(eq(offboardings.id, ready.offboardingId)),
    );
  }

  const checkPhysical = (ready: Awaited<ReturnType<typeof readyToErase>>) =>
    withAccountTx(database.db, ready.service, async (tx) => {
      const result = await tx.execute<{ ready: boolean }>(
        sql`select lifecycle.erasure_physical_ready() as ready`,
      );
      return result.rows[0]?.ready;
    });

  it('requires physical proof before restricted metadata erasure and preserves the other tenant', async () => {
    const { a, b } = await makeTwoTenants(database.db);
    const store = new SkillErasureStore();
    const key = await verifiedUpload(a.owner.context, store);
    const otherKey = await verifiedUpload(b.owner.context, store);
    const erasure = createTenantObjectErasure({ database: database.db, store });
    const remove = vi.spyOn(store, 'deleteForPurge');
    const ready = await readyToErase(database.db, a.owner.context);
    await expect(erasure.purge(ready.service, ready)).rejects.toMatchObject({
      code: 'PREREQUISITES_INCOMPLETE',
    });
    expect(remove).not.toHaveBeenCalled();
    await enterErasing(ready);
    await expect(
      erasure.purge(createServiceContext(b.organizationId), ready),
    ).rejects.toMatchObject({
      code: 'PREREQUISITES_INCOMPLETE',
    });
    expect(await checkPhysical(ready)).toBe(false);
    await expect(
      withEraser(a.organizationId, (client) => client.query('delete from skills.test_runs')),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await erasure.confirm(ready.service, ready)).toMatchObject({
      confirmed: false,
      objectsRemaining: 1,
    });

    vi.spyOn(store, 'isPhysicallyAbsent').mockResolvedValueOnce(false);
    expect(await erasure.purge(ready.service, ready)).toMatchObject({
      skillBundlesRemoved: 0,
      unconfirmedDeletes: 1,
    });
    expect(await checkPhysical(ready)).toBe(false);
    expect(await erasure.purge(ready.service, ready)).toMatchObject({
      skillBundlesRemoved: 1,
      unconfirmedDeletes: 0,
    });
    expect(remove).toHaveBeenCalledExactlyOnceWith(key);
    expect(await erasure.confirm(ready.service, ready)).toEqual({
      confirmed: true,
      objectsRemaining: 0,
    });
    expect(await checkPhysical(ready)).toBe(true);

    await expect(
      withEraser(a.organizationId, (client) => client.query('delete from skills.bundle_uploads')),
    ).rejects.toMatchObject({ code: '23503' });
    await withEraser(a.organizationId, async (client) => {
      for (const table of tables) {
        const result = await client.query(`delete from ${table} where organization_id in ($1,$2)`, [
          a.organizationId,
          b.organizationId,
        ]);
        expect(result.rowCount).toBe(1);
      }
    });
    expect(await checkPhysical(ready)).toBe(true);
    const reported = await withAccountTx(database.db, ready.service, (tx) =>
      tx.execute<{ n: string }>(
        sql`select lifecycle.skill_offboarding_bundles_removed(${ready.offboardingId}::uuid)::text as n`,
      ),
    );
    expect(reported.rows).toEqual([{ n: '1' }]);
    expect(await store.exists(otherKey)).toBe(true);
  });

  it('erases cancelled sandbox metadata only if execution was never admitted', async () => {
    const { a, b } = await makeTwoTenants(database.db);
    const store = new SkillErasureStore();
    const newRun = async (owner: TenantContext) => {
      const uploaded = await uploadedBundle(owner, store);
      const service = createServiceContext(owner.organizationId);
      await withTenantTx(worker.db, service, (tx) =>
        tx
          .update(skillVersions)
          .set({ state: 'verifying', version: sql`version+1` })
          .where(eq(skillVersions.id, uploaded.id)),
      );
      const id = randomUUID();
      await withTenantTx(worker.db, service, (tx) =>
        tx.insert(sandboxRuns).values({
          id,
          organizationId: owner.organizationId,
          skillVersionId: uploaded.id,
          digest: '1'.repeat(64),
          purpose: 'skill_test',
          testFixture: 0,
          classification: 'internal',
          input: { generated: true },
          ...testPolicy(),
        }),
      );
      return { id, service };
    };
    const blocked = await newRun(b.owner.context);
    const allowed = await newRun(a.owner.context);
    const start = ({ id, service }: typeof allowed) =>
      withTenantTx(worker.db, service, (tx) =>
        tx
          .update(sandboxRuns)
          .set({
            status: 'running',
            attempts: 1,
            startedAt: new Date(),
            isolationProbePassedAt: new Date(),
            version: sql`version+1`,
          })
          .where(eq(sandboxRuns.id, id)),
      );
    const settle = ({ id, service }: typeof allowed, status: 'cancelled' | 'runner_unavailable') =>
      withTenantTx(
        worker.db,
        service,
        async (tx) =>
          (
            await tx
              .update(sandboxRuns)
              .set({
                status,
                outcomeCode: status === 'cancelled' ? 'CANCELLED_BY_REQUEST' : 'RUNNER_UNREACHABLE',
                finishedAt: new Date(),
                version: sql`version+1`,
              })
              .where(eq(sandboxRuns.id, id))
              .returning({ admitted: sandboxRuns.executionEverAdmitted })
          )[0],
      );

    await start(blocked);
    expect(await settle(blocked, 'runner_unavailable')).toEqual({ admitted: true });
    const bReady = await readyToErase(database.db, b.owner.context);
    const operatorRef = 'test-operator@example.invalid';
    await expect(
      beginErasure(database.db, bReady.service, { ...bReady, operatorRef }),
    ).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });

    const aReady = await readyToErase(database.db, a.owner.context);
    await expect(
      beginErasure(database.db, aReady.service, { ...aReady, operatorRef }),
    ).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
    await expect(
      withAccountTx(database.db, aReady.service, (tx) =>
        tx
          .update(offboardings)
          .set({
            state: 'erasing',
            erasureStartedAt: new Date(),
            erasureStartedByRef: operatorRef,
            version: sql`${offboardings.version}+1`,
            updatedAt: new Date(),
          })
          .where(eq(offboardings.id, aReady.offboardingId)),
      ),
    ).rejects.toMatchObject({
      cause: { code: 'EN850', message: 'DEFERRED_ERASURE_CONTENT_PRESENT' },
    });
    await expect(start(allowed)).rejects.toMatchObject({
      cause: { code: 'EN850', message: 'TENANT_ERASURE_IN_PROGRESS' },
    });
    expect(await settle(allowed, 'cancelled')).toEqual({ admitted: false });
    await expect(settle(allowed, 'cancelled')).rejects.toMatchObject({
      cause: { code: '42501', message: 'SANDBOX_SETTLED_IMMUTABLE' },
    });

    await beginErasure(database.db, aReady.service, { ...aReady, operatorRef });
    const cleanup = createTenantObjectErasure({ database: database.db, store });
    expect(await cleanup.purge(aReady.service, aReady)).toMatchObject({ skillBundlesRemoved: 1 });
    expect(await checkPhysical(aReady)).toBe(true);
    await withEraser(a.organizationId, async (client) => {
      await expect(
        client.query('delete from sandbox.runs where organization_id in ($1,$2)', [
          a.organizationId,
          b.organizationId,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });
    });
    const remaining = await withTenantTx(worker.db, blocked.service, (tx) =>
      tx.select({ id: sandboxRuns.id }).from(sandboxRuns),
    );
    expect(remaining).toEqual([{ id: blocked.id }]);
  });

  it('honors holds and keeps an ambiguous DELETE as an erasure blocker', async () => {
    const { a } = await makeTwoTenants(database.db);
    const store = new SkillErasureStore();
    await verifiedUpload(a.owner.context, store);
    const ready = await readyToErase(database.db, a.owner.context);
    await enterErasing(ready);
    await proveSecondFactor(a.owner);
    const hold = await placeLegalHold(database.db, a.owner.context, {
      matterRef: randomUUID(),
      scopes: [{ type: 'organization', id: null }],
    });
    const erasure = createTenantObjectErasure({ database: database.db, store });
    const remove = vi.spyOn(store, 'deleteForPurge').mockResolvedValue({
      transport: 'unknown',
      capabilityVerified: false,
    });
    await expect(erasure.purge(ready.service, ready)).rejects.toMatchObject({
      cause: { code: 'EN850' },
    });
    expect(remove).not.toHaveBeenCalled();
    await releaseLegalHold(database.db, a.owner.context, {
      holdId: hold.holdId,
      expectedVersion: 1,
      reasonCode: 'TEST_CLOSED',
    });
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await erasure.purge(ready.service, ready)).toMatchObject({
        skillBundlesRemoved: 0,
        unconfirmedDeletes: 1,
      });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await checkPhysical(ready)).toBe(false);
  });

  it('does not accept an empty bucket as proof when the PUT outcome is unknown', async () => {
    const { a } = await makeTwoTenants(database.db);
    const store = new SkillErasureStore();
    vi.spyOn(store, 'putSingleAttempt').mockResolvedValue({ transport: 'unknown' });
    const pkg = await seedPackage(database.db, a.owner.context);
    await expect(
      uploadSkillBundle(database.db, store, a.owner.context, enabled, {
        packageId: pkg.id,
        bytes: Buffer.from('generated unknown PUT'),
      }),
    ).rejects.toMatchObject({ code: 'SKILL_UPLOAD_PENDING' });
    const ready = await readyToErase(database.db, a.owner.context);
    await enterErasing(ready);
    const erasure = createTenantObjectErasure({ database: database.db, store });
    const remove = vi.spyOn(store, 'deleteForPurge');
    expect(await erasure.purge(ready.service, ready)).toMatchObject({ skillBundlesRemoved: 0 });
    expect(await erasure.confirm(ready.service, ready)).toEqual({
      confirmed: false,
      objectsRemaining: 0,
    });
    expect(await checkPhysical(ready)).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });
});
