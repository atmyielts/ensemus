import { randomUUID, sign } from 'node:crypto';
import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addTrustedSigner,
  createPublisher,
  createSkillPackage,
  getListing,
  getMarketplaceListingReview,
  getPublisher,
  listInstallations,
  listListings,
  listSubmissions,
  publishSkillVersion,
  removeInstallation,
  requestInstallation,
  resolveSkillVersionForUse,
  requestDelisting,
  submitToMarketplace,
  uploadSkillBundle,
  withdrawSubmission,
  type ObjectStore,
} from '@ensemus/application';
import {
  marketplaceInstallations,
  marketplaceReviews,
  openAppDatabase,
  withTenantTx,
} from '@ensemus/database';
import {
  openMarketplaceOperatorDatabase,
  reserveListingObject,
} from '@ensemus/database/marketplace-operator';
import { createServiceContext } from '@ensemus/database/service';
import { listingObjectKey, REVIEW_CHECKS } from '@ensemus/domain/marketplace';
import { SKILL_METADATA_PORTABILITY_VERSION } from '@ensemus/domain/portability';
import { SANDBOX_DEFAULT_CEILINGS } from '@ensemus/domain/sandbox';
import { skillBundleObjectKey } from '@ensemus/domain/skill';
import { buildTestBundle, generateTestKey } from '@ensemus/skills/testing';
import { createMarketplaceInstallActivities } from '@ensemus/workflows/marketplace-install-activities';
import { eq, sql } from 'drizzle-orm';
import { createSkillVerificationActivities } from '@ensemus/workflows/skill-verification-activities';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { marketplaceCommand } from '../../workers/workflow/src/marketplace-command';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { provisionMarketplaceRole } from '../helpers/skills';
import { urls } from '../helpers/stack';

const enabled = { isEnabled: async () => true };
const disabled = { isEnabled: async () => false };

describe('marketplace tenant actions and signed offline publication', () => {
  let web: ReturnType<typeof openAppDatabase>;
  let worker: ReturnType<typeof openAppDatabase>;
  let operator: ReturnType<typeof openMarketplaceOperatorDatabase>;
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;
  const files = new Map<string, Buffer>();
  const store: ObjectStore = {
    async put(key, body) {
      files.set(key, Buffer.from(body));
    },
    async putSingleAttempt(key, body) {
      await store.put(key, body, 'application/json');
      return { transport: 'written' };
    },
    async get(key) {
      const body = files.get(key);
      if (!body) throw Error('TEST_OBJECT_NOT_FOUND');
      return Buffer.from(body);
    },
    async exists(key) {
      return files.has(key);
    },
    async delete(key) {
      files.delete(key);
    },
  };

  beforeAll(async () => {
    web = openAppDatabase(urls.app());
    worker = openAppDatabase(urls.worker());
    operator = openMarketplaceOperatorDatabase(await provisionMarketplaceRole());
  });
  beforeEach(async () => {
    tenants = await makeTwoTenants(web.db);
    await proveSecondFactor(tenants.a.owner);
    await proveSecondFactor(tenants.b.owner);
  });
  afterAll(async () => {
    await Promise.all([web?.close(), worker?.close(), operator?.close()]);
  });

  async function prepare(contentClassification: 'public' | 'internal') {
    const owner = tenants.a.owner.context;
    const name = `generated-${randomUUID()}`;
    const signer = generateTestKey();
    const built = buildTestBundle({ key: signer, name });
    await addTrustedSigner(web.db, owner, enabled, {
      displayName: 'Generated signer',
      publicKey: signer.publicKey,
    });
    const skill = await createSkillPackage(web.db, owner, enabled, {
      name,
      displayName: 'Generated package',
      contentClassification,
    });
    const uploaded = await uploadSkillBundle(web.db, store, owner, enabled, {
      packageId: skill.id,
      bytes: built.bytes,
    });
    await expect(
      createSkillVerificationActivities({
        database: worker.db,
        store,
        reviewKeys: new Map(),
        ceilings: SANDBOX_DEFAULT_CEILINGS,
      }).checkSkillBundle({ organizationId: owner.organizationId, skillVersionId: uploaded.id }),
    ).resolves.toEqual({ step: 'finished', outcome: 'verified' });
    return { id: uploaded.id, ...built };
  }

  it('checks the feature gate, owner authority, and publisher tenant boundary', async () => {
    const owner = tenants.a.owner.context;
    const input = { displayName: 'Generated publisher' };
    await expect(createPublisher(web.db, owner, disabled, input)).rejects.toMatchObject({
      code: 'FEATURE_NOT_ENABLED',
    });
    for (const context of [
      tenants.a.admin.context,
      tenants.a.member.context,
      createServiceContext(owner.organizationId),
    ]) {
      await expect(createPublisher(web.db, context, enabled, input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(getPublisher(web.db, context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(getPublisher(web.db, owner)).resolves.toBeNull();
    const made = await createPublisher(web.db, owner, enabled, input);
    expect(made).toMatchObject({ displayName: input.displayName, state: 'active', version: 1 });
    await expect(createPublisher(web.db, owner, enabled, input)).rejects.toMatchObject({
      code: 'MARKETPLACE_PUBLISHER_EXISTS',
    });
    await expect(getPublisher(web.db, owner)).resolves.toEqual(made);
    await expect(getPublisher(web.db, tenants.b.owner.context)).resolves.toBeNull();
    await expect(listListings(web.db, owner, disabled, {})).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(listInstallations(web.db, tenants.b.member.context)).resolves.toEqual([]);
    const wrongRole = openMarketplaceOperatorDatabase(urls.app());
    try {
      await expect(
        marketplaceCommand(['queue'], {
          db: wrongRole.db,
          store,
          reviewKeys: new Map(),
          print: () => {
            throw Error('WEB_ROLE_READ_OPERATOR_QUEUE');
          },
        }),
      ).resolves.toBe(2);
    } finally {
      await wrongRole.close();
    }
  });

  it('copies only public verified versions, and preserves one native submission through retries', async () => {
    const owner = tenants.a.owner.context;
    await createPublisher(web.db, owner, enabled, { displayName: 'Generated publisher' });
    const privateVersion = await prepare('internal');
    await expect(
      submitToMarketplace(web.db, owner, enabled, {
        skillVersionId: privateVersion.id,
        confirmShareWithOtherOrganizations: true,
      }),
    ).rejects.toMatchObject({ code: 'MARKETPLACE_NOT_PUBLIC' });
    const other = tenants.b.owner.context;
    await createPublisher(web.db, other, enabled, { displayName: 'Other generated publisher' });
    await expect(
      submitToMarketplace(web.db, other, enabled, {
        skillVersionId: privateVersion.id,
        confirmShareWithOtherOrganizations: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const publicVersion = await prepare('public');
    const input = {
      skillVersionId: publicVersion.id,
      confirmShareWithOtherOrganizations: true,
    } as const;
    await expect(
      submitToMarketplace(web.db, owner, enabled, {
        ...input,
        confirmShareWithOtherOrganizations: false as unknown as true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const result = await Promise.allSettled([
      submitToMarketplace(web.db, owner, enabled, input),
      submitToMarketplace(web.db, owner, enabled, input),
    ]);
    expect(result.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    const seen = await listSubmissions(web.db, owner);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      skillVersionId: publicVersion.id,
      digest: publicVersion.digest,
      state: 'submitted',
    });
    await expect(listSubmissions(web.db, other)).resolves.toEqual([]);
    await expect(
      requestDelisting(web.db, owner, {
        submissionId: seen[0]!.id,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      withdrawSubmission(web.db, other, {
        submissionId: seen[0]!.id,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      withdrawSubmission(web.db, owner, {
        submissionId: seen[0]!.id,
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ state: 'withdrawn', version: 2 });
  });

  it('binds reviewed bytes to a tenant copy, recovers an ambiguous write, then enforces takedown and removal', async () => {
    const owner = tenants.a.owner.context;
    const other = tenants.b.member.context;
    await createPublisher(web.db, owner, enabled, { displayName: 'Generated publisher' });
    const built = await prepare('public');
    const subject = await submitToMarketplace(web.db, owner, enabled, {
      skillVersionId: built.id,
      confirmShareWithOtherOrganizations: true,
    });
    const review = generateTestKey();
    const offer = generateTestKey();
    const printed: string[] = [];
    const deps = {
      db: operator.db,
      store,
      reviewKeys: new Map([[review.keyId, review.publicKey]]),
      print: (line: string) => printed.push(line),
    };
    const tx = [owner.organizationId, subject.id];
    const run = (...args: string[]) => marketplaceCommand(args, deps);
    await expect(run('start-review', ...tx, '1')).resolves.toBe(0);
    await using folder = await mkdtempDisposable(join(tmpdir(), 'ensemus-marketplace-'));
    const decision = join(folder.path, 'decision.json');
    const payload = join(folder.path, 'payload');
    const attestation = join(folder.path, 'attestation.json');
    const signature = join(folder.path, 'signature.base64');
    const decidedAt = new Date();
    await writeFile(
      decision,
      JSON.stringify({
        verdict: 'approved',
        checks: Object.fromEntries(REVIEW_CHECKS.map((name) => [name, 'pass'])),
        findingCodes: [],
        reviewerKeyId: review.keyId,
        decidedAt: decidedAt.toISOString(),
      }),
    );
    await expect(run('review-payload', ...tx, decision, payload)).resolves.toBe(0);
    await writeFile(attestation, printed.at(-1)!);
    const payloadBytes = await readFile(payload);
    await writeFile(signature, sign(null, payloadBytes, offer.privateKeyPem).toString('base64'));
    await expect(
      run('record-review', ...tx, attestation, signature, 'Generated reviewer', '2'),
    ).resolves.toBe(2);
    expect((await listSubmissions(web.db, owner)).find((row) => row.id === subject.id)?.state).toBe(
      'in_review',
    );
    await writeFile(signature, sign(null, payloadBytes, review.privateKeyPem).toString('base64'));
    await expect(
      run('record-review', ...tx, attestation, signature, 'Generated reviewer', '2'),
    ).resolves.toBe(0);

    const key = listingObjectKey(built.digest);
    await store.put(key, Buffer.from('generated conflicting content'), 'text/plain');
    await expect(run('list', ...tx)).resolves.toBe(2);
    expect(await store.get(key)).toEqual(Buffer.from('generated conflicting content'));
    await store.delete(key);
    await expect(
      marketplaceCommand(['list', ...tx], {
        ...deps,
        store: {
          ...store,
          async put(key, body, mimeType) {
            await store.put(key, body, mimeType);
            throw new Error('TEST_LOST_PUT_RECEIPT');
          },
        },
      }),
    ).rejects.toThrow('TEST_LOST_PUT_RECEIPT');
    await expect(
      reserveListingObject(operator.db, {
        organizationId: owner.organizationId,
        submissionId: subject.id,
        digest: built.digest,
        bundleSha256: 'f'.repeat(64),
        sizeBytes: built.bytes.length,
      }),
    ).resolves.toBe(false);
    await expect(run('list', ...tx)).resolves.toBe(0);
    const first = printed.at(-1)!;
    await expect(run('list', ...tx)).resolves.toBe(0);
    expect(printed.at(-1)).toBe(first);
    const { listingId } = JSON.parse(first) as { listingId: string };
    expect(await store.get(key)).toEqual(built.bytes);
    const listing = await getListing(web.db, other, enabled, listingId);
    expect(listing).toMatchObject({
      id: listingId,
      digest: built.digest,
      signerKeyId: built.bundle.signature.key_id,
      reviewerKeyId: review.keyId,
      state: 'listed',
    });
    const reviewReceipt = {
      reviewerLabel: 'Generated reviewer',
      decidedAt,
    };
    await expect(getMarketplaceListingReview(web.db, other, listingId)).resolves.toEqual(
      reviewReceipt,
    );
    await expect(getMarketplaceListingReview(web.db, other, randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      withTenantTx(web.db, other, (native) =>
        native
          .select({ id: marketplaceReviews.id })
          .from(marketplaceReviews)
          .where(eq(marketplaceReviews.submissionId, subject.id)),
      ),
    ).resolves.toEqual([]);
    const listings = await listListings(web.db, other, enabled, { limit: 1 });
    expect(listings.items).toHaveLength(1);
    if (listings.nextCursor) {
      const nextPage = await listListings(web.db, other, enabled, {
        after: listings.nextCursor,
        limit: 1,
      });
      expect(nextPage.items[0]?.id).not.toBe(listings.items[0]!.id);
    }
    await expect(
      listListings(web.db, other, enabled, { after: randomUUID() }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const buyer = tenants.b.owner.context;
    const buyerStore = {
      ...store,
      async putSingleAttempt(key: string, body: Buffer) {
        copyWrites++;
        await store.put(key, body, 'application/json');
        return { transport: 'unknown' } as const;
      },
      async get(key: string) {
        if (key === tenantKey && unreadableCopy) throw new Error('TEST_COPY_REPLY_LOST');
        return store.get(key);
      },
    };
    let copyWrites = 0;
    let unreadableCopy = true;
    let tenantKey: string | null = null;
    const workerDeps = {
      database: worker.db,
      store: buyerStore,
      ceilings: SANDBOX_DEFAULT_CEILINGS,
    };
    const installActivities = createMarketplaceInstallActivities({
      ...workerDeps,
      reviewKeys: deps.reviewKeys,
      gate: enabled,
    });
    const unknownReviewer = createMarketplaceInstallActivities({
      ...workerDeps,
      reviewKeys: new Map(),
      gate: enabled,
    });
    const revokeEntitlement = createMarketplaceInstallActivities({
      ...workerDeps,
      reviewKeys: deps.reviewKeys,
      gate: disabled,
    });
    await expect(requestInstallation(web.db, other, enabled, { listingId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(requestInstallation(web.db, buyer, disabled, { listingId })).rejects.toMatchObject(
      {
        code: 'FEATURE_NOT_ENABLED',
      },
    );
    const request = () => requestInstallation(web.db, buyer, enabled, { listingId });
    const installInput = (installationId: string) => ({
      organizationId: buyer.organizationId,
      installationId,
    });
    const firstRequest = await request();
    await expect(request()).rejects.toMatchObject({ code: 'MARKETPLACE_ALREADY_INSTALLED' });
    await expect(listInstallations(web.db, owner)).resolves.toEqual([]);
    await expect(
      withTenantTx(web.db, buyer, (db) =>
        db
          .update(marketplaceInstallations)
          .set({ state: 'installing', version: 2 })
          .where(eq(marketplaceInstallations.id, firstRequest.id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    const untrusted = installInput(firstRequest.id);
    await expect(unknownReviewer.materializeListing(untrusted)).resolves.toEqual({
      step: 'failed',
      code: 'ATTESTATION_INVALID',
    });
    await expect(
      unknownReviewer.finishListingInstall({
        ...untrusted,
        outcome: { ok: false, code: 'ATTESTATION_INVALID' },
      }),
    ).resolves.toBe('failed');
    const denied = installInput((await request()).id);
    await expect(revokeEntitlement.materializeListing(denied)).resolves.toEqual({
      step: 'failed',
      code: 'LISTING_NOT_AVAILABLE',
    });
    await expect(
      revokeEntitlement.finishListingInstall({
        ...denied,
        outcome: { ok: false, code: 'LISTING_NOT_AVAILABLE' },
      }),
    ).resolves.toBe('failed');
    const metadataProfile = () =>
      withTenantTx(web.db, buyer, async (native) => {
        const result = await native.execute<{ admitted: boolean }>(
          sql`select sovereign.portable_profile_clear(${SKILL_METADATA_PORTABILITY_VERSION}) as admitted`,
        );
        return result.rows[0]?.admitted;
      });
    await expect(metadataProfile()).resolves.toBe(true);

    const queued = await request();
    await expect(metadataProfile()).resolves.toBe(false);
    const install = installInput(queued.id);
    tenantKey = skillBundleObjectKey(buyer.organizationId, queued.id);
    await expect(installActivities.materializeListing(install)).rejects.toMatchObject({
      type: 'MARKETPLACE_BUNDLE_PENDING',
    });
    expect(copyWrites).toBe(1);
    expect(await store.get(tenantKey)).toEqual(built.bytes);
    expect(
      (await listInstallations(web.db, buyer)).find((row) => row.id === queued.id),
    ).toMatchObject({
      state: 'installing',
      packageId: null,
      skillVersionId: null,
    });
    unreadableCopy = false;
    const copy = { step: 'verify', skillVersionId: queued.id };
    await expect(installActivities.materializeListing(install)).resolves.toEqual(copy);
    await expect(installActivities.materializeListing(install)).resolves.toEqual(copy);
    expect(copyWrites).toBe(1);
    expect(await store.get(tenantKey)).toEqual(built.bytes);
    await expect(resolveSkillVersionForUse(web.db, buyer, queued.id)).resolves.toMatchObject({
      ok: false,
      denial: 'NOT_PUBLISHED',
    });
    const verify = createSkillVerificationActivities({
      ...workerDeps,
      reviewKeys: deps.reviewKeys,
    });
    await expect(
      verify.checkSkillBundle({
        organizationId: buyer.organizationId,
        skillVersionId: queued.id,
      }),
    ).resolves.toEqual({ step: 'finished', outcome: 'verified' });
    const publish = () =>
      publishSkillVersion(web.db, buyer, enabled, {
        skillVersionId: queued.id,
        expectedVersion: 3,
      });
    await expect(publish()).rejects.toMatchObject({ code: 'SKILL_VERSION_NOT_PUBLISHABLE' });
    const finish = () =>
      installActivities.finishListingInstall({ ...install, outcome: { ok: true } });
    await expect(finish()).resolves.toBe('installed');
    await expect(finish()).resolves.toBe('installed');
    await expect(installActivities.materializeListing(install)).resolves.toEqual({
      step: 'settled',
      outcome: 'installed',
    });
    await expect(resolveSkillVersionForUse(web.db, buyer, queued.id)).resolves.toMatchObject({
      ok: false,
      denial: 'NOT_PUBLISHED',
    });
    await expect(publish()).resolves.toMatchObject({ state: 'published', version: 4 });
    await expect(resolveSkillVersionForUse(web.db, buyer, queued.id)).resolves.toMatchObject({
      ok: true,
    });

    await expect(
      withdrawSubmission(web.db, owner, { submissionId: subject.id, expectedVersion: 3 }),
    ).rejects.toMatchObject({ code: 'MARKETPLACE_SUBMISSION_NOT_WITHDRAWABLE' });
    await expect(
      requestDelisting(web.db, owner, { submissionId: subject.id, expectedVersion: 3 }),
    ).resolves.toMatchObject({ delistRequestedAt: expect.any(Date), version: 4 });
    await expect(run('delist', listingId, 'stop_new', 'PUBLISHER_REQUEST', '1')).resolves.toBe(0);
    const outsider = (await makeTwoTenants(web.db)).a.member.context;
    await expect(getListing(web.db, outsider, enabled, listingId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(getMarketplaceListingReview(web.db, outsider, listingId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(getMarketplaceListingReview(web.db, other, listingId)).resolves.toEqual(
      reviewReceipt,
    );
    await expect(getListing(web.db, other, enabled, listingId)).resolves.toMatchObject({
      state: 'delisted',
      delistMode: 'stop_new',
    });
    await expect(resolveSkillVersionForUse(web.db, buyer, queued.id)).resolves.toMatchObject({
      ok: true,
    });
    await expect(run('delist', listingId, 'revoke', 'PUBLISHER_REQUEST', '2')).resolves.toBe(0);
    await expect(resolveSkillVersionForUse(web.db, buyer, queued.id)).resolves.toMatchObject({
      ok: false,
    });
    const installed = (await listInstallations(web.db, buyer)).find((row) => row.id === queued.id);
    expect(installed).toMatchObject({
      listingDisplayName: listing.displayName,
      state: 'installed',
      version: 4,
    });
    await expect(
      removeInstallation(web.db, owner, {
        installationId: queued.id,
        expectedVersion: 4,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      removeInstallation(web.db, buyer, {
        installationId: queued.id,
        expectedVersion: 3,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      removeInstallation(web.db, buyer, {
        installationId: queued.id,
        expectedVersion: 4,
      }),
    ).resolves.toBeUndefined();
    expect(
      (await listInstallations(web.db, buyer)).find((row) => row.id === queued.id),
    ).toMatchObject({
      state: 'removed',
      version: 5,
    });
    await expect(resolveSkillVersionForUse(web.db, buyer, queued.id)).resolves.toMatchObject({
      ok: false,
      denial: 'NOT_PUBLISHED',
    });
    await expect(getListing(web.db, owner, enabled, listingId)).resolves.toMatchObject({
      state: 'delisted',
      delistMode: 'revoke',
    });
  });
});
