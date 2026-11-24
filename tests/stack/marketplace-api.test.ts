import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  addTrustedSigner,
  createSkillPackage,
  getSkillVersion,
  uploadSkillBundle,
} from '@ensemus/application';
import { openAppDatabase } from '@ensemus/database';
import {
  createListing,
  delistListing,
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
import { SKILL_BUNDLE_MEDIA_TYPE, skillBundleObjectKey } from '@ensemus/domain/skill';
import { attestationPayload } from '@ensemus/skills/review';
import { keyIdOf } from '@ensemus/skills/signature';
import { buildTestBundle, generateTestKey } from '@ensemus/skills/testing';
import { S3ObjectStore } from '@ensemus/storage';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, createOrganization, join, signUp, type Person } from '../helpers/forms';
import { enrollAuthenticator, nativeStackContext } from '../helpers/native-mfa';
import { contractProblems } from '../helpers/openapi';
import { provisionMarketplaceRole } from '../helpers/skills';
import { secret, urls } from '../helpers/stack';

const enabled = process.env.ENSEMUS_MARKETPLACE_ENABLED === 'true';
const setupGate = { isEnabled: async () => true };
const timeout = 45_000;

type ApiRow = {
  id: string;
  version: number;
  state: string;
  package_id?: string | null;
  skill_version_id?: string | null;
};
type ApiBody = ApiRow & { code?: string; items?: ApiRow[] };

async function call(
  viewer: Person | null,
  organization: string,
  method: 'GET' | 'POST' | 'DELETE',
  suffix: string,
  {
    body,
    key,
    version,
    origin = BASE,
  }: { body?: unknown; key?: string; version?: number; origin?: string } = {},
) {
  const path = '/api/v1/organizations/' + organization + '/marketplace/' + suffix;
  const response = await fetch(BASE + path, {
    method,
    headers: {
      ...(viewer ? { cookie: viewer.jar.cookie } : {}),
      ...(method === 'GET' ? {} : { origin }),
      ...(key === undefined ? {} : { 'idempotency-key': key }),
      ...(version === undefined ? {} : { 'if-match': JSON.stringify(String(version)) }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  expect(
    contractProblems({ method, path, status: response.status, headers: response.headers, text })
      .problems,
    method + ' ' + suffix,
  ).toEqual([]);
  expect(response.headers.get('cache-control')).toContain('no-store');
  return {
    status: response.status,
    etag: response.headers.get('etag'),
    body: (text ? JSON.parse(text) : {}) as ApiBody,
    text,
  };
}

function reviewerFixture() {
  const file = process.env.ENSEMUS_TEST_MARKETPLACE_REVIEW_PRIVATE_KEY_FILE;
  if (!file) throw new Error('MARKETPLACE_TEST_REVIEW_KEY_REQUIRED');
  const privateKey = createPrivateKey(readFileSync(file));
  const publicKey = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'der' })
    .subarray(-32);
  if (
    privateKey.asymmetricKeyType !== 'ed25519' ||
    !process.env.ENSEMUS_MARKETPLACE_REVIEW_KEYS?.split(',')
      .map((key) => key.trim())
      .includes(publicKey.toString('base64'))
  )
    throw new Error('MARKETPLACE_TEST_REVIEW_KEY_NOT_CONFIGURED_ON_WORKER');
  return { privateKey, keyId: keyIdOf(publicKey) };
}

describe('Marketplace HTTP contract', () => {
  let publisher: Person, member: Person, outsider: Person, publisherOrg: string;
  beforeAll(async () => {
    publisher = await signUp('Generated Marketplace publisher');
    publisherOrg = await createOrganization(publisher, 'Generated Marketplace publisher company');
    member = await join(publisher, publisherOrg, 'Generated Marketplace member');
    outsider = await signUp('Generated Marketplace outsider');
  });

  it('enforces tenant, publisher, install and origin permissions and reports an unavailable catalog', async () => {
    const body = { display_name: 'Generated publishing profile' };
    const listing = randomUUID();
    expect((await call(null, publisherOrg, 'GET', 'listings')).status).toBe(401);
    expect((await call(outsider, publisherOrg, 'GET', 'listings')).status).toBe(404);
    expect(
      (
        await call(publisher, publisherOrg, 'POST', 'publisher', {
          body,
          origin: 'https://outside.example.invalid',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(member, publisherOrg, 'POST', 'installations', {
          body: { listing_id: listing },
          key: randomUUID(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(member, publisherOrg, 'POST', 'submissions', {
          body: { skill_version_id: randomUUID(), confirm_share_with_other_organizations: true },
          key: randomUUID(),
        })
      ).status,
    ).toBe(403);
    expect((await call(member, publisherOrg, 'GET', 'listings')).status).toBe(200);
    if (enabled) {
      expect((await call(publisher, publisherOrg, 'GET', 'publisher')).status).toBe(404);
      expect((await call(member, publisherOrg, 'GET', 'publisher')).status).toBe(403);
      expect((await call(member, publisherOrg, 'POST', 'publisher', { body })).status).toBe(403);
      expect((await call(publisher, publisherOrg, 'GET', 'installations')).body).toEqual({
        items: [],
      });
      return;
    }
    expect((await call(publisher, publisherOrg, 'GET', 'listings')).body).toEqual({
      items: [],
      next_cursor: null,
    });
    for (const suffix of ['publisher', 'submissions', 'installations', 'listings/' + listing]) {
      const blocked = await call(publisher, publisherOrg, 'GET', suffix);
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('FEATURE_NOT_ENABLED');
    }
    const blocked = await call(publisher, publisherOrg, 'POST', 'publisher', { body });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('FEATURE_NOT_ENABLED');
  });

  it.skipIf(!enabled)(
    'registers a publisher, lists a reviewed signed bundle, installs it through the worker and removes the buyer copy',
    async () => {
      const reviewer = reviewerFixture();
      const buyer = await signUp('Generated Marketplace buyer');
      const buyerOrg = await createOrganization(buyer, 'Generated Marketplace buyer company');
      const buyerMember = await join(buyer, buyerOrg, 'Generated Marketplace buyer member');
      await enrollAuthenticator(publisher, publisherOrg);

      const app = openAppDatabase(urls.app());
      const operator = openMarketplaceOperatorDatabase(await provisionMarketplaceRole());
      const store = new S3ObjectStore({
        endpoint: 'http://127.0.0.1:' + (process.env.ENSEMUS_TEST_OBJECTS_PORT ?? '58333'),
        bucket: 'ensemus',
        accessKey: secret('objects_access_key'),
        secretKey: secret('objects_secret_key'),
      });
      try {
        const publication = await call(publisher, publisherOrg, 'POST', 'publisher', {
          body: { display_name: 'Generated Marketplace publisher profile' },
        });
        expect(publication.status).toBe(201);
        expect(publication.etag).toBe('"1"');
        expect(publication.body).toMatchObject({ state: 'active', version: 1 });
        expect((await call(publisher, publisherOrg, 'GET', 'publisher')).body).toEqual(
          publication.body,
        );
        expect((await call(buyer, buyerOrg, 'GET', 'publisher')).status).toBe(404);

        const publisherContext = await nativeStackContext(app.db, publisher, publisherOrg);
        const signer = generateTestKey();
        await addTrustedSigner(app.db, publisherContext, setupGate, {
          displayName: 'Generated test signer',
          publicKey: signer.publicKey,
        });

        async function signedVersion() {
          const name = 'marketplace-http-' + randomUUID();
          const bundle = buildTestBundle({ key: signer, name });
          const pkg = await createSkillPackage(app.db, publisherContext, setupGate, {
            name,
            displayName: 'Generated public bundle',
            contentClassification: 'public',
          });
          const version = await uploadSkillBundle(app.db, store, publisherContext, setupGate, {
            packageId: pkg.id,
            bytes: bundle.bytes,
          });
          await expect
            .poll(async () => (await getSkillVersion(app.db, publisherContext, version.id)).state, {
              timeout,
              interval: 500,
            })
            .toBe('verified');
          return { ...bundle, name, versionId: version.id };
        }

        const first = await signedVersion();
        async function submitVersion(
          bundle: Awaited<ReturnType<typeof signedVersion>>,
          key = randomUUID(),
        ) {
          return call(publisher, publisherOrg, 'POST', 'submissions', {
            key,
            body: {
              skill_version_id: bundle.versionId,
              confirm_share_with_other_organizations: true,
            },
          });
        }
        const submitKey = randomUUID();
        const submitted = await submitVersion(first, submitKey);
        expect(submitted.status).toBe(201);
        expect(submitted.etag).toBe('"1"');
        expect(submitted.body).toMatchObject({
          skill_version_id: first.versionId,
          state: 'submitted',
        });
        expect((await submitVersion(first, submitKey)).body).toEqual(submitted.body);
        expect(
          (await call(publisher, publisherOrg, 'GET', 'submissions')).body.items,
        ).toContainEqual(submitted.body);
        expect((await call(member, publisherOrg, 'GET', 'submissions')).status).toBe(403);

        const target = { organizationId: publisherOrg, submissionId: submitted.body.id };
        await markSubmissionInReview(operator.db, { ...target, expectedVersion: 1 });
        const attestation: ReviewAttestation = {
          kind: 'ensemus.skill.review.v1',
          submissionId: target.submissionId,
          publisherId: publication.body.id,
          name: first.name,
          semver: first.bundle.manifest.version,
          digest: first.digest,
          signerKeyId: signer.keyId,
          verdict: 'approved',
          checks: Object.fromEntries(
            REVIEW_CHECKS.map((check) => [check, 'pass']),
          ) as ReviewAttestation['checks'],
          findingCodes: [],
          reviewerKeyId: reviewer.keyId,
          decidedAt: new Date().toISOString(),
        };
        const review = await recordReview(operator.db, {
          organizationId: publisherOrg,
          attestation,
          attestationSignature: sign(null, attestationPayload(attestation), reviewer.privateKey),
          reviewerLabel: 'Generated independent reviewer',
          expectedVersion: 2,
        });
        const objectKey = listingObjectKey(first.digest);
        const bundleSha256 = createHash('sha256').update(first.bytes).digest('hex');
        await expect(
          reserveListingObject(operator.db, {
            ...target,
            digest: first.digest,
            sizeBytes: first.bytes.length,
            bundleSha256,
          }),
        ).resolves.toBe(true);
        await store.put(objectKey, first.bytes, SKILL_BUNDLE_MEDIA_TYPE);
        const listing = await createListing(operator.db, {
          ...target,
          reviewId: review.id,
          objectKey,
          bundleSha256,
        });

        const listed = await call(buyerMember, buyerOrg, 'GET', 'listings/' + listing.id);
        expect(listed.status).toBe(200);
        expect(listed.body).toMatchObject({
          id: listing.id,
          digest: listing.digest,
          state: 'listed',
          signer_key_id: signer.keyId,
          reviewer_key_id: reviewer.keyId,
        });
        expect(listed.text).not.toContain(objectKey);
        expect(listed.text).not.toContain(review.attestationSignature.toString('base64'));
        expect((await call(buyer, buyerOrg, 'GET', 'listings')).body.items).toContainEqual(
          expect.objectContaining({ id: listing.id }),
        );

        const installKey = randomUUID();
        const install = (key = installKey, listingId = listing.id) =>
          call(buyer, buyerOrg, 'POST', 'installations', { body: { listing_id: listingId }, key });
        const queued = await install();
        expect(queued.status).toBe(202);
        expect(queued.etag).toBe('"1"');
        expect(queued.body).toMatchObject({
          listing_id: listing.id,
          state: 'requested',
          package_id: null,
          skill_version_id: null,
          version: 1,
        });
        expect((await install()).body).toEqual(queued.body);
        expect((await install(installKey, randomUUID())).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        expect((await install(randomUUID())).body.code).toBe('MARKETPLACE_ALREADY_INSTALLED');

        const loadInstallation = async (viewer: Person) =>
          (await call(viewer, buyerOrg, 'GET', 'installations')).body.items?.find(
            (item) => item.id === queued.body.id,
          );
        await expect
          .poll(async () => (await loadInstallation(buyer))?.state, { timeout, interval: 500 })
          .toBe('installed');
        const installed = await loadInstallation(buyerMember);
        expect(installed).toMatchObject({
          id: queued.body.id,
          package_id: queued.body.id,
          skill_version_id: queued.body.id,
          state: 'installed',
        });
        if (!installed) throw new Error('MARKETPLACE_TEST_INSTALLED_ROW_MISSING');
        await expect(store.get(skillBundleObjectKey(buyerOrg, installed.id))).resolves.toEqual(
          first.bytes,
        );
        expect((await call(publisher, publisherOrg, 'GET', 'installations')).body).toEqual({
          items: [],
        });

        const installPath = 'installations/' + installed.id;
        expect((await call(buyer, buyerOrg, 'DELETE', installPath)).status).toBe(428);
        expect(
          (await call(buyerMember, buyerOrg, 'DELETE', installPath, { version: installed.version }))
            .status,
        ).toBe(403);
        expect(
          (
            await call(publisher, publisherOrg, 'DELETE', installPath, {
              version: installed.version,
            })
          ).status,
        ).toBe(404);
        const unverified = await call(buyer, buyerOrg, 'DELETE', installPath, {
          version: installed.version,
        });
        expect(unverified.status).toBe(403);
        expect(unverified.body.code).toBe('MFA_REQUIRED');
        await enrollAuthenticator(buyer, buyerOrg);
        expect((await call(buyer, buyerOrg, 'DELETE', installPath, { version: 1 })).body.code).toBe(
          'VERSION_CONFLICT',
        );
        const removed = await call(buyer, buyerOrg, 'DELETE', installPath, {
          version: installed.version,
        });
        expect(removed.status).toBe(204);
        expect(removed.text).toBe('');
        expect(await loadInstallation(buyer)).toMatchObject({
          state: 'removed',
          version: installed.version + 1,
        });
        await expect(store.get(listing.objectKey)).resolves.toEqual(first.bytes);

        const delist = await call(
          publisher,
          publisherOrg,
          'POST',
          'submissions/' + submitted.body.id + '/delist-request',
          { version: 3 },
        );
        expect(delist.status).toBe(200);
        expect(delist.etag).toBe('"4"');
        expect(delist.body).toMatchObject({
          state: 'approved',
          delist_requested_at: expect.any(String),
        });
        await delistListing(operator.db, {
          listingId: listing.id,
          mode: 'stop_new',
          code: 'PUBLISHER_REQUEST',
          expectedVersion: 1,
        });
        expect(
          (await call(buyerMember, buyerOrg, 'GET', 'listings/' + listing.id)).body,
        ).toMatchObject({ state: 'delisted', delist_mode: 'stop_new' });

        const draft = await submitVersion(await signedVersion());
        expect(draft.status).toBe(201);
        const withdrawn = await call(
          publisher,
          publisherOrg,
          'POST',
          'submissions/' + draft.body.id + '/withdrawal',
          { version: 1 },
        );
        expect(withdrawn.status).toBe(200);
        expect(withdrawn.etag).toBe('"2"');
        expect(withdrawn.body).toMatchObject({ state: 'withdrawn', version: 2 });
      } finally {
        store.close();
        await Promise.all([operator.close(), app.close()]);
      }
    },
    180_000,
  );
});
