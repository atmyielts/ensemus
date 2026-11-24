import { randomUUID, sign } from 'node:crypto';
import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addTrustedSigner,
  createPublisher,
  createSkillPackage,
  getListing,
  getPublisher,
  listInstallations,
  listListings,
  listSubmissions,
  requestDelisting,
  submitToMarketplace,
  uploadSkillBundle,
  withdrawSubmission,
  type ObjectStore,
} from '@ensemus/application';
import { openAppDatabase } from '@ensemus/database';
import {
  openMarketplaceOperatorDatabase,
  reserveListingObject,
} from '@ensemus/database/marketplace-operator';
import { createServiceContext } from '@ensemus/database/service';
import { listingObjectKey, REVIEW_CHECKS } from '@ensemus/domain/marketplace';
import { SANDBOX_DEFAULT_CEILINGS } from '@ensemus/domain/sandbox';
import { buildTestBundle, generateTestKey } from '@ensemus/skills/testing';
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

  it('verifies an independent review and signed bytes before listing, then limits a delisted listing to its publisher', async () => {
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
    await writeFile(
      decision,
      JSON.stringify({
        verdict: 'approved',
        checks: Object.fromEntries(REVIEW_CHECKS.map((name) => [name, 'pass'])),
        findingCodes: [],
        reviewerKeyId: review.keyId,
        decidedAt: new Date().toISOString(),
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
    await expect(getListing(web.db, other, enabled, listingId)).resolves.toMatchObject({
      id: listingId,
      digest: built.digest,
      signerKeyId: built.bundle.signature.key_id,
      reviewerKeyId: review.keyId,
      state: 'listed',
    });
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
    await expect(
      withdrawSubmission(web.db, owner, { submissionId: subject.id, expectedVersion: 3 }),
    ).rejects.toMatchObject({ code: 'MARKETPLACE_SUBMISSION_NOT_WITHDRAWABLE' });
    await expect(
      requestDelisting(web.db, owner, { submissionId: subject.id, expectedVersion: 3 }),
    ).resolves.toMatchObject({ delistRequestedAt: expect.any(Date), version: 4 });
    await expect(run('delist', listingId, 'stop_new', 'PUBLISHER_REQUEST', '1')).resolves.toBe(0);
    await expect(getListing(web.db, other, enabled, listingId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(getListing(web.db, owner, enabled, listingId)).resolves.toMatchObject({
      state: 'delisted',
      delistMode: 'stop_new',
    });
  });
});
