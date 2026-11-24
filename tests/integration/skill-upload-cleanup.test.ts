import { randomUUID } from 'node:crypto';
import {
  purgeAbandonedSkillUpload,
  uploadSkillBundle,
  type ObjectStore,
} from '@ensemus/application';
import { placeLegalHold, releaseLegalHold } from '@ensemus/application/saas/legal-holds';
import {
  openAppDatabase,
  skillBundleUploads,
  skillVersions,
  withTenantTx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { skillBundleObjectKey } from '@ensemus/domain/skill';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { seedPackage } from '../helpers/skills';
import { urls } from '../helpers/stack';

function fixtureStore() {
  const files = new Map<string, Buffer>();
  const store = {
    async putSingleAttempt(key: string, bytes: Buffer) {
      files.set(key, bytes);
      return { transport: 'written' } as { transport: 'written' | 'unknown' };
    },
    async get(key: string) {
      const bytes = files.get(key);
      if (!bytes) throw Error('MISSING');
      return bytes;
    },
    deleteForPurge: vi.fn(async (key: string) => {
      files.delete(key);
      return { transport: 'deleted', capabilityVerified: true } as Awaited<
        ReturnType<NonNullable<ObjectStore['deleteForPurge']>>
      >;
    }),
    isPhysicallyAbsent: vi.fn(async (key: string) => !files.has(key)),
    assertPurgeCapability: vi.fn(async () => {}),
    put: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(),
  } satisfies ObjectStore;
  return { files, store };
}

describe('abandoned skill bundle cleanup', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let worker: ReturnType<typeof openAppDatabase>;
  let control: pg.Client;
  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    worker = openAppDatabase(urls.worker());
    control = new pg.Client({ connectionString: urls.superuser() });
    await control.connect();
  });
  afterAll(async () => {
    await Promise.all([app?.close(), worker?.close(), control?.end()]);
  });

  async function abandon(outcome: 'written' | 'unknown' = 'written') {
    const { a, b } = await makeTwoTenants(app.db);
    const owner = a.owner.context;
    const pkg = await seedPackage(app.db, owner);
    const { files, store } = fixtureStore();
    let featureEnabled = true;
    const put = store.putSingleAttempt;
    store.putSingleAttempt = async (key, bytes) => {
      await put(key, bytes);
      featureEnabled = false;
      return { transport: outcome };
    };
    await expect(
      uploadSkillBundle(
        app.db,
        store,
        owner,
        {
          isEnabled: async () => featureEnabled,
        },
        { packageId: pkg.id, bytes: Buffer.from('generated abandoned bundle') },
      ),
    ).rejects.toMatchObject({
      code: outcome === 'written' ? 'FEATURE_NOT_ENABLED' : 'SKILL_UPLOAD_PENDING',
    });
    const [record] = await withTenantTx(app.db, owner, (tx) =>
      tx.select().from(skillBundleUploads).where(eq(skillBundleUploads.packageId, pkg.id)),
    );
    if (!record) throw Error('MISSING_FIXTURE_RECORD');
    const context = createServiceContext(a.organizationId);
    const key = skillBundleObjectKey(a.organizationId, record.id);
    const sweep = () => purgeAbandonedSkillUpload(worker.db, store, context);
    const claims = () =>
      control.query<{ state: string }>(
        `select state from lifecycle.object_deletion_claims
       where organization_id=$1 and artifact_id=$2 and kind='skill_upload'`,
        [a.organizationId, record.id],
      );
    const age = async (oldGeneration = false) => {
      // Only this generated row is aged. The real worker still uses the native receipt admission.
      await control.query('begin');
      try {
        await control.query("set local session_replication_role='replica'");
        const result = await control.query(
          `update skills.bundle_uploads set
           put_finished_at=case when put_finished_at is null then null else clock_timestamp()-interval '2 hours' end,
           put_auth_generation=case when $3 then gen_random_uuid() else put_auth_generation end
           where organization_id=$1 and id=$2`,
          [a.organizationId, record.id, oldGeneration],
        );
        expect(result.rowCount).toBe(1);
        await control.query('commit');
      } catch (error) {
        await control.query('rollback');
        throw error;
      }
    };
    return { a, b, files, store, owner, record, key, sweep, claims, age };
  }

  it('admits only an aged tenant-local orphan and retries only a read after a known DELETE', async () => {
    const fixture = await abandon();
    expect(fixture.record.putFinishedAt).toBeInstanceOf(Date);
    expect(await fixture.sweep()).toEqual({ state: 'idle' });
    await fixture.age();
    expect(
      await purgeAbandonedSkillUpload(
        worker.db,
        fixture.store,
        createServiceContext(fixture.b.organizationId),
      ),
    ).toEqual({ state: 'idle' });
    await expect(
      withTenantTx(app.db, fixture.owner, (tx) =>
        tx.execute(sql`select lifecycle.next_skill_upload_cleanup()`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    fixture.store.isPhysicallyAbsent.mockResolvedValueOnce(false);
    expect(await fixture.sweep()).toEqual({ state: 'unconfirmed' });
    expect((await fixture.claims()).rows).toEqual([{ state: 'deleted' }]);
    expect(await fixture.sweep()).toEqual({ state: 'purged', quiescent: true });
    expect(await fixture.sweep()).toEqual({ state: 'idle' });
    expect(fixture.store.deleteForPurge).toHaveBeenCalledExactlyOnceWith(fixture.key);
    expect(fixture.files.has(fixture.key)).toBe(false);
    expect((await fixture.claims()).rows).toEqual([{ state: 'proven' }]);
    await expect(
      withTenantTx(app.db, fixture.owner, (tx) =>
        tx.insert(skillVersions).values({
          organizationId: fixture.a.organizationId,
          id: fixture.record.id,
          packageId: fixture.record.packageId,
          uploadedByMembershipId: fixture.owner.membershipId,
          bundleObjectKey: fixture.key,
          bundleSha256: fixture.record.bundleSha256,
          sizeBytes: fixture.record.sizeBytes,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: 'ES001' } });
  });

  it('respects a legal hold and retains an ambiguous DELETE without replay', async () => {
    const fixture = await abandon();
    await fixture.age();
    await proveSecondFactor(fixture.a.owner);
    const hold = await placeLegalHold(app.db, fixture.owner, {
      matterRef: randomUUID(),
      scopes: [{ type: 'organization', id: null }],
    });
    expect(await fixture.sweep()).toEqual({ state: 'held' });
    expect(fixture.store.deleteForPurge).not.toHaveBeenCalled();
    await releaseLegalHold(app.db, fixture.owner, {
      holdId: hold.holdId,
      expectedVersion: 1,
      reasonCode: 'QA_REQUEST_RESOLVED',
    });
    fixture.store.deleteForPurge.mockResolvedValueOnce({
      transport: 'unknown',
      capabilityVerified: false,
    });
    expect(await fixture.sweep()).toEqual({ state: 'unconfirmed' });
    expect(await fixture.sweep()).toEqual({ state: 'idle' });
    expect((await fixture.claims()).rows).toEqual([{ state: 'unknown' }]);
    expect(fixture.store.deleteForPurge).toHaveBeenCalledTimes(1);
    expect(fixture.store.isPhysicallyAbsent).not.toHaveBeenCalled();
    await expect(
      placeLegalHold(app.db, fixture.owner, {
        matterRef: randomUUID(),
        scopes: [{ type: 'organization', id: null }],
      }),
    ).rejects.toMatchObject({ cause: { code: 'EN851' } });
  });

  it('keeps unknown PUTs and receipts from a different restore generation in the inventory', async () => {
    const unknown = await abandon('unknown');
    expect(unknown.record.putFinishedAt).toBeNull();
    await unknown.age();
    expect(await unknown.sweep()).toEqual({ state: 'idle' });
    expect((await unknown.claims()).rowCount).toBe(0);
    expect(unknown.store.deleteForPurge).not.toHaveBeenCalled();

    const previous = await abandon();
    await previous.age(true);
    expect(await previous.sweep()).toEqual({ state: 'idle' });
    expect((await previous.claims()).rowCount).toBe(0);
    expect(previous.store.deleteForPurge).not.toHaveBeenCalled();
  });
});
