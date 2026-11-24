import {
  addTrustedSigner,
  listSkillVersions,
  updateSkillPackage,
  uploadSkillBundle,
  type ObjectStore,
} from '@ensemus/application';
import { domainEvents, openAppDatabase, skillBundleUploads, withTenantTx } from '@ensemus/database';
import { SANDBOX_DEFAULT_CEILINGS } from '@ensemus/domain/sandbox';
import { SKILL_BUNDLE_MAX_BYTES, skillBundleObjectKey } from '@ensemus/domain/skill';
import { SKILL_VERSION_UPLOADED } from '@ensemus/domain/skill-events';
import { buildTestBundle, generateTestKey } from '@ensemus/skills/testing';
import { createSkillVerificationActivities } from '@ensemus/workflows/skill-verification-activities';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeTwoTenants } from '../helpers/product';
import { seedPackage } from '../helpers/skills';
import { urls } from '../helpers/stack';

const enabled = { isEnabled: async () => true };

function storeFixture() {
  const objects = new Map<string, Buffer>();
  const store = {
    putSingleAttempt: vi.fn(async (key: string, bytes: Buffer) => {
      objects.set(key, Buffer.from(bytes));
      return { transport: 'written' } as const;
    }),
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) throw Error('MISSING');
      return bytes;
    }),
    put: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(),
  } satisfies ObjectStore;
  return { store, objects };
}

describe('durable skill bundle upload', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let worker: ReturnType<typeof openAppDatabase>;
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;
  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    worker = openAppDatabase(urls.worker());
    tenants = await makeTwoTenants(app.db);
  });
  afterAll(async () => {
    await worker?.close();
    await app?.close();
  });
  const owner = () => tenants.a.owner.context;
  const receipts = (id: string) =>
    withTenantTx(app.db, owner(), (tx) =>
      tx.select().from(skillBundleUploads).where(eq(skillBundleUploads.packageId, id)),
    );

  it('reserves before writing, emits once, and verifies with the normal worker', async () => {
    const pkg = await seedPackage(app.db, owner());
    const { store, objects } = storeFixture();
    const key = generateTestKey();
    await addTrustedSigner(app.db, owner(), enabled, {
      displayName: 'Publisher',
      publicKey: key.publicKey,
    });
    const { bytes } = buildTestBundle({ name: pkg.name, key });
    store.putSingleAttempt.mockImplementationOnce(async (objectKey, body) => {
      const [record] = await receipts(pkg.id);
      expect(record?.state).toBe('writing');
      expect(objectKey).toBe(skillBundleObjectKey(owner().organizationId, record!.id));
      expect(await listSkillVersions(app.db, owner(), pkg.id)).toEqual([]);
      objects.set(objectKey, body);
      return { transport: 'written' };
    });
    const input = { packageId: pkg.id, bytes };
    const upload = await uploadSkillBundle(app.db, store, owner(), enabled, input);
    expect(upload).toMatchObject({ state: 'uploaded', version: 1, sizeBytes: bytes.length });
    expect(await uploadSkillBundle(app.db, store, tenants.a.admin.context, enabled, input)).toEqual(
      upload,
    );
    expect(store.putSingleAttempt).toHaveBeenCalledTimes(1);
    expect(store.put).not.toHaveBeenCalled();
    expect(await receipts(pkg.id)).toMatchObject([{ id: upload.id, state: 'attached' }]);
    const events = await withTenantTx(app.db, owner(), (tx) =>
      tx
        .select({ eventType: domainEvents.eventType })
        .from(domainEvents)
        .where(eq(domainEvents.aggregateId, upload.id)),
    );
    expect(events).toEqual([{ eventType: SKILL_VERSION_UPLOADED }]);
    const activities = createSkillVerificationActivities({
      database: worker.db,
      store,
      ceilings: SANDBOX_DEFAULT_CEILINGS,
      reviewKeys: new Map(),
    });
    expect(
      await activities.checkSkillBundle({
        organizationId: owner().organizationId,
        skillVersionId: upload.id,
      }),
    ).toEqual({ step: 'finished', outcome: 'verified' });
    expect((await uploadSkillBundle(app.db, store, owner(), enabled, input)).state).toBe(
      'verified',
    );
    expect(store.putSingleAttempt).toHaveBeenCalledTimes(1);
  });

  it('keeps an ambiguous write in the inventory and reuses its bytes on an explicit retry', async () => {
    const pkg = await seedPackage(app.db, owner());
    const { store, objects } = storeFixture();
    store.putSingleAttempt.mockImplementationOnce(async (key, body) => {
      objects.set(key, body);
      throw Error('GENERATED_LOST_RESPONSE');
    });
    const input = { packageId: pkg.id, bytes: Buffer.from('opaque bytes') };
    await expect(uploadSkillBundle(app.db, store, owner(), enabled, input)).rejects.toMatchObject({
      code: 'SKILL_UPLOAD_PENDING',
    });
    const [record] = await receipts(pkg.id);
    expect(record?.state).toBe('writing');
    expect(await listSkillVersions(app.db, owner(), pkg.id)).toEqual([]);
    await expect(
      uploadSkillBundle(app.db, store, tenants.a.admin.context, enabled, input),
    ).rejects.toMatchObject({ code: 'SKILL_UPLOAD_PENDING' });
    expect(store.get).not.toHaveBeenCalled();
    const version = await uploadSkillBundle(app.db, store, owner(), enabled, input);
    expect(version.id).toBe(record?.id);
    expect(store.putSingleAttempt).toHaveBeenCalledTimes(1);
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('shares the reservation during concurrent requests and rechecks package state after the PUT', async () => {
    const pkg = await seedPackage(app.db, owner());
    const { store } = storeFixture();
    let start!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    store.putSingleAttempt.mockImplementationOnce(async () => {
      start();
      await release;
      return { transport: 'written' };
    });
    const upload = () =>
      uploadSkillBundle(app.db, store, owner(), enabled, {
        packageId: pkg.id,
        bytes: Buffer.from('in flight'),
      });
    const first = upload().then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        started,
        first.then(() => {
          throw Error('Writer failed to start');
        }),
      ]);
      await expect(upload()).rejects.toMatchObject({ code: 'SKILL_UPLOAD_PENDING' });
      await updateSkillPackage(app.db, owner(), {
        packageId: pkg.id,
        expectedVersion: 1,
        state: 'disabled',
      });
    } finally {
      resume();
    }
    expect(await first).toMatchObject({ code: 'INVALID_STATE' });
    expect(store.putSingleAttempt).toHaveBeenCalledTimes(1);
    expect(await listSkillVersions(app.db, owner(), pkg.id)).toEqual([]);
    expect(await receipts(pkg.id)).toMatchObject([{ state: 'writing' }]);
  });

  it('refuses foreign packages, ordinary members, and oversized bodies before storage', async () => {
    const pkg = await seedPackage(app.db, owner());
    const { store } = storeFixture();
    const input = { packageId: pkg.id, bytes: Buffer.from('bundle') };
    await expect(
      uploadSkillBundle(app.db, store, tenants.b.owner.context, enabled, input),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      uploadSkillBundle(app.db, store, tenants.a.member.context, enabled, input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      uploadSkillBundle(app.db, store, owner(), enabled, {
        ...input,
        bytes: Buffer.alloc(SKILL_BUNDLE_MAX_BYTES + 1),
      }),
    ).rejects.toMatchObject({ code: 'SKILL_BUNDLE_TOO_LARGE' });
    expect(await receipts(pkg.id)).toEqual([]);
    expect(store.putSingleAttempt).not.toHaveBeenCalled();
  });

  it('uses a fresh key after an expired attempt and fences the old writer', async () => {
    const pkg = await seedPackage(app.db, owner());
    const { store, objects } = storeFixture();
    let didStart!: () => void;
    let didResume!: () => void;
    const started = new Promise<void>((resolve) => {
      didStart = resolve;
    });
    const release = new Promise<void>((resolve) => {
      didResume = resolve;
    });
    store.putSingleAttempt.mockImplementationOnce(async (key, bytes) => {
      didStart();
      await release;
      objects.set(key, bytes);
      return { transport: 'written' };
    });
    const upload = () =>
      uploadSkillBundle(app.db, store, owner(), enabled, {
        packageId: pkg.id,
        bytes: Buffer.from('generated late arrival'),
      });
    const first = upload().then(
      (result) => result,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        started,
        first.then(() => {
          throw Error('Writer failed to start');
        }),
      ]);
      const [record] = await receipts(pkg.id);
      const control = new pg.Client({ connectionString: urls.superuser() });
      await control.connect();
      try {
        // Move just this fixture's birth time. The subsequent takeover uses the real SQL clock.
        await control.query('begin');
        await control.query("set local session_replication_role='replica'");
        const aged = await control.query(
          `update skills.bundle_uploads set created_at=clock_timestamp()-interval '3 minutes'
          where organization_id=$1 and package_id=$2 and id=$3 and state='writing'`,
          [owner().organizationId, pkg.id, record!.id],
        );
        expect(aged.rowCount).toBe(1);
        await control.query('commit');
      } finally {
        await control.end();
      }
      const second = await upload();
      expect(second.id).not.toBe(record?.id);
      expect(await receipts(pkg.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: record?.id, state: 'superseded' }),
          expect.objectContaining({ id: second.id, state: 'attached' }),
        ]),
      );
      didResume();
      expect(await first).toEqual(second);
      expect(await listSkillVersions(app.db, owner(), pkg.id)).toEqual([second]);
      expect(store.putSingleAttempt).toHaveBeenCalledTimes(2);
      expect(objects.size).toBe(2);
      expect(store.delete).not.toHaveBeenCalled();
    } finally {
      didResume();
    }
  });
});
