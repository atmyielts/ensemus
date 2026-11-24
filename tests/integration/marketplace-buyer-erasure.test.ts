import { createHash, randomUUID, sign } from 'node:crypto';
import {
  addTrustedSigner,
  createPublisher,
  createSkillPackage,
  getListing,
  listInstallations,
  removeInstallation,
  requestInstallation,
  submitToMarketplace,
  uploadSkillBundle,
} from '@ensemus/application';
import { sealDelegatedErasureInTx } from '@ensemus/application/knowledge/delegated-erasure';
import { placeLegalHold, releaseLegalHold } from '@ensemus/application/saas/legal-holds';
import { beginErasure, finishErasure } from '@ensemus/application/saas/offboarding';
import { createTenantObjectErasure } from '@ensemus/application/saas/tenant-object-erasure';
import { openAppDatabase, withTenantTx, type TenantContext } from '@ensemus/database';
import { eraseTenantRows, listErasableTables } from '@ensemus/database/eraser';
import {
  createListing,
  markSubmissionInReview,
  openMarketplaceOperatorDatabase,
  recordReview,
  reserveListingObject,
} from '@ensemus/database/marketplace-operator';
import {
  listingObjectKey,
  REVIEW_CHECKS,
  type ReviewAttestation,
} from '@ensemus/domain/marketplace';
import { SANDBOX_DEFAULT_CEILINGS } from '@ensemus/domain/sandbox';
import { SKILL_BUNDLE_MEDIA_TYPE, skillBundleObjectKey } from '@ensemus/domain/skill';
import { attestationPayload } from '@ensemus/skills/review';
import { buildTestBundle, generateTestKey } from '@ensemus/skills/testing';
import { createMarketplaceInstallActivities } from '@ensemus/workflows/marketplace-install-activities';
import { createSkillVerificationActivities } from '@ensemus/workflows/skill-verification-activities';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { provisionMarketplaceRole } from '../helpers/skills';
import { urls } from '../helpers/stack';
import { LifecycleMemoryStore, lifecycleTenant } from './saas-lifecycle-fixture';
import { readyToErase } from './saas-offboarding-fixture';

const gate = { isEnabled: async () => true };
const operatorRef = 'marketplace-erasure@example.invalid';

class MarketplaceLifecycleStore extends LifecycleMemoryStore {
  async putSingleAttempt(
    key: string,
    bytes: Buffer,
  ): Promise<{ transport: 'written' | 'unknown' }> {
    await this.put(key, bytes);
    return { transport: 'written' };
  }
}

describe('buyer-only Marketplace offboarding', () => {
  const web = openAppDatabase(urls.app());
  const worker = openAppDatabase(urls.worker());
  const eraserClient = new pg.Client({ connectionString: urls.superuser() });
  const auth = new pg.Client({ connectionString: urls.auth() });
  const store = new MarketplaceLifecycleStore();
  const reviewer = generateTestKey();
  const reviewKeys = new Map([[reviewer.keyId, reviewer.publicKey]]);
  const workerDeps = { database: worker.db, store, ceilings: SANDBOX_DEFAULT_CEILINGS, reviewKeys };
  const installActivities = createMarketplaceInstallActivities({ ...workerDeps, gate });
  const verifier = createSkillVerificationActivities(workerDeps);
  const erasure = createTenantObjectErasure({ database: web.db, store });
  let eraser: Parameters<typeof eraseTenantRows>[0];
  let operator: ReturnType<typeof openMarketplaceOperatorDatabase>;
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;
  let listing: Awaited<ReturnType<typeof createListing>>;
  let publisherKey: string;
  let publishedBytes: Buffer;

  beforeAll(async () => {
    await auth.connect();
    await eraserClient.connect();
    await eraserClient.query('set session authorization ensemus_eraser');
    eraser = drizzle(eraserClient, { casing: 'snake_case' }) as unknown as typeof eraser;
    operator = openMarketplaceOperatorDatabase(await provisionMarketplaceRole());
    tenants = await makeTwoTenants(web.db);
    await proveSecondFactor(tenants.a.owner);
    await proveSecondFactor(tenants.b.owner);
    const publisher = tenants.a.owner.context;
    const publisherId = (
      await createPublisher(web.db, publisher, gate, {
        displayName: 'Generated marketplace publisher',
      })
    ).id;
    const key = generateTestKey();
    const name = 'buyer-proof-' + randomUUID();
    const built = buildTestBundle({ key, name });
    await addTrustedSigner(web.db, publisher, gate, {
      displayName: 'Generated signer',
      publicKey: key.publicKey,
    });
    const pkg = await createSkillPackage(web.db, publisher, gate, {
      name,
      displayName: 'Erasure proof package',
      contentClassification: 'public',
    });
    const uploaded = await uploadSkillBundle(web.db, store, publisher, gate, {
      packageId: pkg.id,
      bytes: built.bytes,
    });
    publisherKey = skillBundleObjectKey(publisher.organizationId, uploaded.id);
    publishedBytes = built.bytes;
    await expect(
      verifier.checkSkillBundle({
        organizationId: publisher.organizationId,
        skillVersionId: uploaded.id,
      }),
    ).resolves.toEqual({ step: 'finished', outcome: 'verified' });
    const submission = await submitToMarketplace(web.db, publisher, gate, {
      skillVersionId: uploaded.id,
      confirmShareWithOtherOrganizations: true,
    });
    const target = { organizationId: publisher.organizationId, submissionId: submission.id };
    await markSubmissionInReview(operator.db, { ...target, expectedVersion: submission.version });
    const attestation: ReviewAttestation = {
      kind: 'ensemus.skill.review.v1',
      submissionId: submission.id,
      publisherId,
      name,
      semver: submission.semver,
      digest: built.digest,
      signerKeyId: key.keyId,
      verdict: 'approved',
      checks: Object.fromEntries(
        REVIEW_CHECKS.map((check) => [check, 'pass']),
      ) as ReviewAttestation['checks'],
      findingCodes: [],
      reviewerKeyId: reviewer.keyId,
      decidedAt: new Date().toISOString(),
    };
    const approved = await recordReview(operator.db, {
      organizationId: publisher.organizationId,
      attestation,
      attestationSignature: sign(null, attestationPayload(attestation), reviewer.privateKeyPem),
      reviewerLabel: 'Generated independent reviewer',
      expectedVersion: submission.version + 1,
    });
    const bundleSha256 = createHash('sha256').update(built.bytes).digest('hex');
    await expect(
      reserveListingObject(operator.db, {
        ...target,
        digest: built.digest,
        bundleSha256,
        sizeBytes: built.bytes.length,
      }),
    ).resolves.toBe(true);
    const objectKey = listingObjectKey(built.digest);
    await store.put(objectKey, built.bytes);
    listing = await createListing(operator.db, {
      ...target,
      reviewId: approved.id,
      objectKey,
      bundleSha256,
    });
  }, 90_000);

  afterAll(async () => {
    await Promise.all([
      web.close(),
      worker.close(),
      operator?.close(),
      eraserClient.end(),
      auth.end(),
    ]);
  });

  async function request(owner: TenantContext) {
    const copy = await requestInstallation(web.db, owner, gate, { listingId: listing.id });
    return { organizationId: owner.organizationId, installationId: copy.id };
  }

  async function withNativeEraser<T>(organizationId: string, action: () => Promise<T>) {
    await eraserClient.query('begin');
    try {
      await eraserClient.query(
        "select set_config('app.organization_id',$1,true),set_config('app.actor_type','service',true)",
        [organizationId],
      );
      const result = await action();
      await eraserClient.query('commit');
      return result;
    } catch (error) {
      await eraserClient.query('rollback');
      throw error;
    }
  }

  async function fixtureRestoreGeneration(
    input: { organizationId: string; installationId: string },
    authGeneration: string,
  ) {
    // Model a copy receipt from a previous restore in this test's own generated row.
    const client = new pg.Client({ connectionString: urls.superuser() });
    await client.connect();
    try {
      await client.query('begin');
      const target = [input.organizationId, input.installationId];
      const prior = await client.query<{ put_auth_generation: string }>(
        'select put_auth_generation from skills.bundle_uploads where organization_id=$1 and id=$2 and marketplace_copy for update',
        target,
      );
      const generation = prior.rows[0]?.put_auth_generation;
      if (!generation) throw Error('TEST_COPY_RECEIPT_MISSING');
      await client.query("set local session_replication_role='replica'");
      const updated = await client.query(
        'update skills.bundle_uploads set copy_auth_generation=$3,put_auth_generation=$3 where organization_id=$1 and id=$2 and marketplace_copy',
        [...target, authGeneration],
      );
      if (updated.rowCount !== 1) throw Error('TEST_COPY_RECEIPT_MISSING');
      await client.query('commit');
      return generation;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      await client.end();
    }
  }

  async function seal(ready: Awaited<ReturnType<typeof readyToErase>>) {
    await expect(
      withTenantTx(web.db, ready.service, (tx) =>
        sealDelegatedErasureInTx(tx, ready.service, ready),
      ),
    ).resolves.toBe(true);
  }

  it('proves absence before erasing a removed buyer copy and keeps every shared object', async () => {
    const buyer = tenants.b.owner.context;
    const other = await lifecycleTenant(web.db, auth);
    const foreign = await request(other);
    const input = await request(buyer);
    const key = skillBundleObjectKey(buyer.organizationId, input.installationId);
    await expect(installActivities.materializeListing(input)).resolves.toEqual({
      step: 'verify',
      skillVersionId: input.installationId,
    });
    await expect(
      verifier.checkSkillBundle({
        organizationId: buyer.organizationId,
        skillVersionId: input.installationId,
      }),
    ).resolves.toEqual({ step: 'finished', outcome: 'verified' });
    await expect(
      installActivities.finishListingInstall({ ...input, outcome: { ok: true } }),
    ).resolves.toBe('installed');

    const ready = await readyToErase(web.db, buyer);
    const begin = () => beginErasure(web.db, ready.service, { ...ready, operatorRef });
    await expect(begin()).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
    await proveSecondFactor(tenants.b.owner);
    await removeInstallation(web.db, buyer, {
      installationId: input.installationId,
      expectedVersion: 4,
    });
    const freshGeneration = await fixtureRestoreGeneration(input, randomUUID());
    try {
      await expect(begin()).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
    } finally {
      await fixtureRestoreGeneration(input, freshGeneration);
    }
    await expect(begin()).resolves.toMatchObject({ tombstoned: 0 });

    const nativeDelete = () =>
      withNativeEraser(buyer.organizationId, () =>
        eraserClient.query('delete from marketplace.installations where organization_id=$1', [
          buyer.organizationId,
        ]),
      );
    await expect(nativeDelete()).rejects.toMatchObject({ code: '42501' });
    await expect(
      withNativeEraser(buyer.organizationId, () =>
        eraserClient.query('select listing_id from marketplace.installations'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withNativeEraser(buyer.organizationId, () =>
        eraserClient.query('delete from marketplace.listings'),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const remove = vi.spyOn(store, 'deleteForPurge');
    vi.spyOn(store, 'isPhysicallyAbsent').mockResolvedValueOnce(false);
    await expect(erasure.purge(ready.service, ready)).resolves.toMatchObject({
      unconfirmedDeletes: 1,
      skillBundlesRemoved: 0,
    });
    await expect(nativeDelete()).rejects.toMatchObject({ code: '42501' });
    await expect(erasure.purge(ready.service, ready)).resolves.toMatchObject({
      unconfirmedDeletes: 0,
      skillBundlesRemoved: 1,
    });
    expect(remove).toHaveBeenCalledExactlyOnceWith(key);
    remove.mockRestore();
    await expect(erasure.confirm(ready.service, ready)).resolves.toEqual({
      confirmed: true,
      objectsRemaining: 0,
    });
    await seal(ready);

    const hold = await placeLegalHold(web.db, buyer, {
      matterRef: randomUUID(),
      scopes: [{ type: 'organization', id: null }],
    });
    await expect(nativeDelete()).rejects.toMatchObject({ code: '42501' });
    await releaseLegalHold(web.db, buyer, {
      holdId: hold.holdId,
      expectedVersion: 1,
      reasonCode: 'TEST_CLOSED',
    });

    await expect(
      withNativeEraser(buyer.organizationId, () =>
        eraserClient.query('delete from skills.package_versions where organization_id=$1', [
          buyer.organizationId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    const tables = await eraseTenantRows(eraser, buyer.organizationId);
    expect(tables.find((row) => row.tableRef === 'marketplace.installations')).toEqual({
      tableRef: 'marketplace.installations',
      rowsRemoved: 1,
      rowsLeft: 0,
    });
    expect(tables.filter((row) => row.tableRef.startsWith('marketplace.'))).toHaveLength(1);
    await expect(
      finishErasure(
        web.db,
        ready.service,
        {
          ...ready,
          tables,
          operatorRef,
          blobsRemoved: 0,
        },
        ready.ports.offboardingAgents,
        erasure,
      ),
    ).resolves.toMatchObject({ state: 'reported' });
    await expect(store.exists(key)).resolves.toBe(false);
    await expect(store.get(publisherKey)).resolves.toEqual(publishedBytes);
    await expect(store.get(listing.objectKey)).resolves.toEqual(publishedBytes);
    await expect(getListing(web.db, other, gate, listing.id)).resolves.toMatchObject({
      state: 'listed',
    });
    await expect(listInstallations(web.db, other)).resolves.toEqual([
      expect.objectContaining({ id: foreign.installationId, state: 'requested' }),
    ]);
  }, 120_000);

  it('erases a native failed request that never reserved a tenant copy', async () => {
    const buyer = await lifecycleTenant(web.db, auth);
    const input = await request(buyer);
    const untrusted = createMarketplaceInstallActivities({
      ...workerDeps,
      reviewKeys: new Map(),
      gate,
    });
    await expect(untrusted.materializeListing(input)).resolves.toEqual({
      step: 'failed',
      code: 'ATTESTATION_INVALID',
    });
    await expect(
      untrusted.finishListingInstall({
        ...input,
        outcome: { ok: false, code: 'ATTESTATION_INVALID' },
      }),
    ).resolves.toBe('failed');
    const ready = await readyToErase(web.db, buyer);
    await beginErasure(web.db, ready.service, { ...ready, operatorRef });
    await expect(erasure.confirm(ready.service, ready)).resolves.toEqual({
      confirmed: true,
      objectsRemaining: 0,
    });
    await seal(ready);
    await expect(listErasableTables(eraser)).resolves.toContain('marketplace.installations');
    const tables = await eraseTenantRows(eraser, buyer.organizationId);
    expect(tables.find((row) => row.tableRef === 'marketplace.installations')).toMatchObject({
      rowsRemoved: 1,
      rowsLeft: 0,
    });
  }, 60_000);

  it('keeps an unresolved copy write as a blocker even when no bytes are visible', async () => {
    const buyer = await lifecycleTenant(web.db, auth);
    const input = await request(buyer);
    const target = skillBundleObjectKey(buyer.organizationId, input.installationId);
    const put = vi.spyOn(store, 'putSingleAttempt').mockResolvedValueOnce({ transport: 'unknown' });
    try {
      await expect(installActivities.materializeListing(input)).rejects.toMatchObject({
        type: 'MARKETPLACE_BUNDLE_PENDING',
      });
      expect(put).toHaveBeenCalledExactlyOnceWith(target, publishedBytes, SKILL_BUNDLE_MEDIA_TYPE);
    } finally {
      put.mockRestore();
    }
    await expect(
      installActivities.finishListingInstall({
        ...input,
        outcome: { ok: false, code: 'BUNDLE_UNAVAILABLE' },
      }),
    ).resolves.toBe('failed');
    await expect(store.exists(target)).resolves.toBe(false);
    const ready = await readyToErase(web.db, buyer);
    await expect(
      beginErasure(web.db, ready.service, { ...ready, operatorRef }),
    ).rejects.toMatchObject({
      code: 'PREREQUISITES_INCOMPLETE',
    });
    await expect(
      withNativeEraser(buyer.organizationId, () =>
        eraserClient.query('delete from marketplace.installations where organization_id=$1', [
          buyer.organizationId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  }, 60_000);
});
