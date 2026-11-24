import { createHash, randomUUID } from 'node:crypto';
import {
  addTrustedSigner,
  beginSkillVerification,
  getSkillVersion,
  listSkillVersions,
  revokeTrustedSigner,
} from '@ensemus/application';
import { openAppDatabase, skillTestRuns, skillVersions, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { SANDBOX_DEFAULT_CEILINGS } from '@ensemus/domain/sandbox';
import { skillBundleObjectKey } from '@ensemus/domain/skill';
import { buildTestBundle, generateTestKey } from '@ensemus/skills/testing';
import { createSkillVerificationActivities } from '@ensemus/workflows/skill-verification-activities';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeTwoTenants } from '../helpers/product';
import { seedPackage } from '../helpers/skills';
import { urls } from '../helpers/stack';

describe('native skill bundle verification', () => {
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

  async function uploaded(options: { trust?: boolean; source?: string; forgedKey?: string } = {}) {
    const pkg = await seedPackage(app.db, owner());
    const key = generateTestKey();
    const signer =
      options.trust === false
        ? null
        : await addTrustedSigner(
            app.db,
            owner(),
            {
              isEnabled: async () => true,
            },
            { displayName: 'Generated verification publisher', publicKey: key.publicKey },
          );
    const built = buildTestBundle({
      key,
      name: pkg.name,
      ...(options.source === undefined ? {} : { source: options.source }),
    });
    const organizationId = owner().organizationId;
    const id = randomUUID();
    const bundleObjectKey = skillBundleObjectKey(organizationId, id);
    await withTenantTx(app.db, owner(), (tx) =>
      tx.insert(skillVersions).values({
        id,
        organizationId,
        packageId: pkg.id,
        bundleObjectKey: options.forgedKey ?? bundleObjectKey,
        bundleSha256: createHash('sha256').update(built.bytes).digest('hex'),
        sizeBytes: built.bytes.length,
        uploadedByMembershipId: owner().membershipId,
      }),
    );
    return {
      input: { organizationId, skillVersionId: id },
      packageId: pkg.id,
      key: bundleObjectKey,
      signer,
      ...built,
    };
  }

  const activities = (get: (key: string, max?: number) => Promise<Buffer>) =>
    createSkillVerificationActivities({
      database: worker.db,
      store: {
        get,
        put: async () => {
          throw Error('UNEXPECTED_WRITE');
        },
        exists: async () => false,
        delete: async () => {
          throw Error('UNEXPECTED_DELETE');
        },
      },
      ceilings: SANDBOX_DEFAULT_CEILINGS,
      reviewKeys: new Map(),
    });
  const row = async (id: string) =>
    (
      await withTenantTx(app.db, owner(), (tx) =>
        tx.select().from(skillVersions).where(eq(skillVersions.id, id)),
      )
    )[0];

  it('verifies signed declarative bytes, and retries reuse the recorded outcome', async () => {
    const fixture = await uploaded();
    const get = vi.fn(async () => fixture.bytes);
    const verifier = activities(get);
    expect(await verifier.checkSkillBundle(fixture.input)).toEqual({
      step: 'finished',
      outcome: 'verified',
    });
    expect(await verifier.checkSkillBundle(fixture.input)).toEqual({
      step: 'finished',
      outcome: 'verified',
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(fixture.key, 8_388_608);
    expect(await row(fixture.input.skillVersionId)).toMatchObject({
      state: 'verified',
      semver: '1.0.0',
      digest: fixture.digest,
      version: 3,
    });
    const testRows = await withTenantTx(app.db, owner(), (tx) =>
      tx
        .select()
        .from(skillTestRuns)
        .where(eq(skillTestRuns.skillVersionId, fixture.input.skillVersionId)),
    );
    expect(testRows).toMatchObject([{ mode: 'contract', outcome: 'passed', fixturesPassed: 1 }]);
    const view = await getSkillVersion(
      app.db,
      tenants.a.member.context,
      fixture.input.skillVersionId,
    );
    expect(view.latestTest).toMatchObject({ outcome: 'passed', fixturesPassed: 1 });
    expect(view).not.toHaveProperty('manifest');
    expect(view).not.toHaveProperty('bundleObjectKey');
    expect(await listSkillVersions(app.db, tenants.a.member.context, fixture.packageId)).toEqual([
      view,
    ]);
    await expect(
      getSkillVersion(app.db, tenants.b.owner.context, fixture.input.skillVersionId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects changed bytes and a signer this tenant never trusted', async () => {
    const modified = await uploaded();
    const wrongBytes = Buffer.from(modified.bytes);
    wrongBytes[0] = 0;
    const untrusted = await uploaded({ trust: false });
    for (const [fixture, bytes, code] of [
      [modified, wrongBytes, 'BUNDLE_HASH_MISMATCH'],
      [untrusted, untrusted.bytes, 'SIGNER_UNTRUSTED'],
    ] as const) {
      expect(await activities(async () => bytes).checkSkillBundle(fixture.input)).toEqual({
        step: 'finished',
        outcome: 'rejected',
      });
      expect(await row(fixture.input.skillVersionId)).toMatchObject({
        state: 'rejected',
        rejectCode: code,
      });
    }
  });

  it('refuses foreign IDs, forged storage keys and verification through the web login', async () => {
    const fixture = await uploaded();
    const forged = await uploaded({ forgedKey: fixture.key });
    const get = vi.fn(async () => fixture.bytes);
    const verifier = activities(get);
    expect(
      await verifier.checkSkillBundle({
        ...fixture.input,
        organizationId: tenants.b.organizationId,
      }),
    ).toEqual({ step: 'finished', outcome: 'rejected' });
    expect(await row(fixture.input.skillVersionId)).toMatchObject({ state: 'uploaded' });
    expect(await verifier.checkSkillBundle(forged.input)).toEqual({
      step: 'finished',
      outcome: 'rejected',
    });
    expect(get).not.toHaveBeenCalled();
    await expect(
      beginSkillVerification(
        app.db,
        createServiceContext(fixture.input.organizationId),
        fixture.input,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      withTenantTx(app.db, owner(), (tx) =>
        tx
          .update(skillVersions)
          .set({ state: 'verifying', version: sql`version+1` })
          .where(eq(skillVersions.id, fixture.input.skillVersionId)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      withTenantTx(app.db, owner(), (tx) =>
        tx.insert(skillTestRuns).values({
          organizationId: fixture.input.organizationId,
          skillVersionId: fixture.input.skillVersionId,
          digest: fixture.digest,
          mode: 'contract',
          outcome: 'passed',
          fixturesPassed: 1,
          fixturesTotal: 1,
          startedAt: new Date(),
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('keeps execution disabled and rechecks signer trust after reading the bytes', async () => {
    const executable = await uploaded({ source: 'console.log(JSON.stringify({sample:true}));' });
    expect(
      await activities(async () => executable.bytes).checkSkillBundle(executable.input),
    ).toEqual({ step: 'finished', outcome: 'rejected' });
    expect(await row(executable.input.skillVersionId)).toMatchObject({
      rejectCode: 'SANDBOX_UNAVAILABLE',
    });

    const revoked = await uploaded();
    const get = async () => {
      await revokeTrustedSigner(app.db, owner(), {
        signerId: revoked.signer!.id,
        expectedVersion: revoked.signer!.version,
      });
      return revoked.bytes;
    };
    expect(await activities(get).checkSkillBundle(revoked.input)).toEqual({
      step: 'finished',
      outcome: 'rejected',
    });
    expect(await row(revoked.input.skillVersionId)).toMatchObject({ rejectCode: 'SIGNER_REVOKED' });
  });
});
