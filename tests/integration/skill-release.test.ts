import {
  addTrustedSigner,
  getSkillVersion,
  getSkillVersionReview,
  publishSkillVersion,
  resolveSkillVersionForUse,
  revokeTrustedSigner,
  updateSkillPackage,
  uploadSkillBundle,
  yankSkillVersion,
  type ObjectStore,
} from '@ensemus/application';
import {
  domainEvents,
  notifications,
  openAppDatabase,
  skillVersions,
  withTenantTx,
  type Tx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { SANDBOX_DEFAULT_CEILINGS } from '@ensemus/domain/sandbox';
import {
  NOTIFY_SKILL_VERSION_YANKED,
  SKILL_VERSION_PUBLISHED,
  SKILL_VERSION_YANKED,
  skillVersionTargetRef,
} from '@ensemus/domain/skill-events';
import { buildTestBundle, generateTestKey } from '@ensemus/skills/testing';
import { createSkillVerificationActivities } from '@ensemus/workflows/skill-verification-activities';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTwoTenants } from '../helpers/product';
import { seedPackage, withFixtureSkillVerifier } from '../helpers/skills';
import { urls } from '../helpers/stack';

const enabled = { isEnabled: async () => true };

describe('workspace skill releases', () => {
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
  const admin = () => tenants.a.admin.context;
  const prepare = async () => {
    const pkg = await seedPackage(app.db, owner());
    const key = generateTestKey();
    const signer = await addTrustedSigner(app.db, owner(), enabled, {
      displayName: 'QA publisher',
      publicKey: key.publicKey,
    });
    const { bytes } = buildTestBundle({ name: pkg.name, key });
    const files = new Map<string, Buffer>();
    const store: ObjectStore = {
      async putSingleAttempt(key, body) {
        files.set(key, Buffer.from(body));
        return { transport: 'written' };
      },
      async get(key) {
        const body = files.get(key);
        if (!body) throw Error('MISSING');
        return body;
      },
      async exists(key) {
        return files.has(key);
      },
      async put() {
        throw Error('UNEXPECTED_TRANSITION');
      },
      async delete() {
        throw Error('UNEXPECTED_TRANSITION');
      },
    };
    const uploaded = await uploadSkillBundle(app.db, store, owner(), enabled, {
      packageId: pkg.id,
      bytes,
    });
    const input = { organizationId: owner().organizationId, skillVersionId: uploaded.id };
    const verifier = createSkillVerificationActivities({
      database: worker.db,
      store,
      ceilings: SANDBOX_DEFAULT_CEILINGS,
      reviewKeys: new Map(),
    });
    expect(await verifier.checkSkillBundle(input)).toEqual({
      step: 'finished',
      outcome: 'verified',
    });
    return {
      pkg,
      signer,
      id: uploaded.id,
      release: { skillVersionId: uploaded.id, expectedVersion: 3 },
    };
  };

  it('admits a second admin to publish and removes admission on disable or withdrawal', async () => {
    const { pkg, id, release } = await prepare();
    expect((await getSkillVersionReview(app.db, owner(), id)).uploadedByViewer).toBe(true);
    expect((await getSkillVersionReview(app.db, admin(), id)).uploadedByViewer).toBe(false);
    expect(await resolveSkillVersionForUse(app.db, owner(), id)).toEqual({
      ok: false,
      denial: 'NOT_PUBLISHED',
    });
    await expect(publishSkillVersion(app.db, owner(), enabled, release)).rejects.toMatchObject({
      code: 'SKILL_PUBLISH_SAME_PERSON',
    });
    await expect(
      publishSkillVersion(app.db, admin(), { isEnabled: async () => false }, release),
    ).rejects.toMatchObject({ code: 'FEATURE_NOT_ENABLED' });
    const published = await publishSkillVersion(app.db, admin(), enabled, release);
    expect(published).toMatchObject({
      state: 'published',
      version: 4,
      publishedAt: expect.any(Date),
    });
    await expect(publishSkillVersion(app.db, admin(), enabled, release)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(
      await resolveSkillVersionForUse(worker.db, createServiceContext(owner().organizationId), id),
    ).toMatchObject({ ok: true, skillVersionId: id, executionKind: 'declarative' });
    expect(await resolveSkillVersionForUse(app.db, tenants.b.owner.context, id)).toEqual({
      ok: false,
      denial: 'NOT_PUBLISHED',
    });

    await updateSkillPackage(app.db, owner(), {
      packageId: pkg.id,
      expectedVersion: 1,
      state: 'disabled',
    });
    expect(await resolveSkillVersionForUse(app.db, owner(), id)).toEqual({
      ok: false,
      denial: 'PACKAGE_DISABLED',
    });
    await updateSkillPackage(app.db, owner(), {
      packageId: pkg.id,
      expectedVersion: 2,
      state: 'active',
    });
    expect(await resolveSkillVersionForUse(app.db, owner(), id)).toMatchObject({ ok: true });
    const withdrawn = await yankSkillVersion(app.db, admin(), {
      skillVersionId: id,
      expectedVersion: published.version,
      code: 'SECURITY_ISSUE',
    });
    expect(withdrawn).toMatchObject({
      state: 'yanked',
      version: 5,
      yankCode: 'SECURITY_ISSUE',
      publishedAt: published.publishedAt,
    });
    expect(await resolveSkillVersionForUse(app.db, owner(), id)).toEqual({
      ok: false,
      denial: 'NOT_PUBLISHED',
    });
    const { events, tells } = await withTenantTx(app.db, owner(), async (tx) => ({
      events: await tx
        .select({ type: domainEvents.eventType })
        .from(domainEvents)
        .where(eq(domainEvents.aggregateId, id)),
      tells: await tx
        .select({ kind: notifications.kind })
        .from(notifications)
        .where(eq(notifications.targetRef, skillVersionTargetRef(id))),
    }));
    expect(events.filter(({ type }) => type === SKILL_VERSION_PUBLISHED)).toHaveLength(1);
    expect(events.filter(({ type }) => type === SKILL_VERSION_YANKED)).toHaveLength(1);
    expect(tells).toContainEqual({ kind: NOTIFY_SKILL_VERSION_YANKED });
  });

  it('refuses members, foreign tenants, workers, and forged actor receipts', async () => {
    const { id, release } = await prepare();
    await expect(
      publishSkillVersion(app.db, tenants.a.member.context, enabled, release),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      publishSkillVersion(app.db, tenants.b.owner.context, enabled, release),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      publishSkillVersion(
        worker.db,
        createServiceContext(owner().organizationId),
        enabled,
        release,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const forge = (tx: Tx) =>
      tx
        .update(skillVersions)
        .set({
          state: 'published',
          publishedByMembershipId: admin().membershipId,
          version: 4,
          publishedAt: sql`statement_timestamp()`,
        })
        .where(eq(skillVersions.id, id));
    await expect(withTenantTx(app.db, owner(), forge)).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    await expect(withFixtureSkillVerifier(owner().organizationId, forge)).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    await publishSkillVersion(app.db, admin(), enabled, release);
    await expect(
      withTenantTx(app.db, admin(), (tx) =>
        tx
          .update(skillVersions)
          .set({ version: 5, publishedAt: new Date(0) })
          .where(eq(skillVersions.id, id)),
      ),
    ).rejects.toMatchObject({ cause: { code: 'ES002' } });
  });

  it('serializes publication with signer revocation and closes use', async () => {
    const { id, signer, release } = await prepare();
    const results = await Promise.allSettled([
      publishSkillVersion(app.db, admin(), enabled, release),
      revokeTrustedSigner(app.db, owner(), {
        signerId: signer.id,
        expectedVersion: signer.version,
      }),
    ]);
    expect(results[1]?.status).toBe('fulfilled');
    if (results[0]?.status === 'rejected') {
      expect(results[0].reason).toMatchObject({ code: 'VERSION_CONFLICT' });
    }
    expect(await getSkillVersion(app.db, owner(), id)).toMatchObject({
      state: 'yanked',
      yankCode: 'SIGNER_REVOKED',
    });
    expect(await resolveSkillVersionForUse(app.db, admin(), id)).toEqual({
      ok: false,
      denial: 'NOT_PUBLISHED',
    });
  });
});
