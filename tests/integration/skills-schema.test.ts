// ADR-034's database rules on their own: forced RLS, what each role can reach, and the triggers that hold
// "signed, tested and reviewed" whatever application code does. Real PostgreSQL, real roles. The slices test
// behaviour on top of this, and each writes its own file.
//
// Not run when this was written: the build that wrote it runs no containers, and migrations 0650 and 0651
// only join the journal at the final merge. Treat it as unverified until it has run.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganization,
  marketplaceInstallations,
  marketplaceListings,
  marketplacePublishers,
  marketplaceReviews,
  marketplaceSubmissions,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  sandboxRuns,
  skillPackages,
  skillVersions,
  trustedSigners,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { REVIEW_CHECKS } from '@ensemus/domain/marketplace';
import { and, eq, sql } from 'drizzle-orm';
import {
  generateTestSigner,
  provisionMarketplaceRole,
  randomHex,
  seedPackage,
  seedSandboxRun,
  seedSigner,
  seedVersion,
  testPolicy,
  type SeededVersion,
  type TestSigner,
} from '../helpers/skills';
import { urls } from '../helpers/stack';

const client = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
};

const sqlState = (code: string) =>
  expect.objectContaining({ cause: expect.objectContaining({ code }) });

describe('skill, sandbox and marketplace rules in the database', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let ctxA: TenantContext;
  let ctxA2: TenantContext;
  let ctxB: TenantContext;
  let signerA: TestSigner;
  let operatorUrl: string;

  const makeUser = async (label: string) => {
    const id = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      `${label}-${id}@example.invalid`,
    ]);
    return id;
  };

  const seedPublished = async (kind: 'declarative' | 'sandbox' = 'declarative') => {
    const pkg = await seedPackage(database.db, ctxA, { contentClassification: 'public' });
    const version = await seedVersion(database.db, ctxA, {
      packageId: pkg.id,
      packageName: pkg.name,
      signer: signerA,
      state: 'published',
      kind,
      publisher: ctxA2,
    });
    return { pkg, version };
  };

  const seedPublisher = async (context: TenantContext) => {
    const id = randomUUID();
    await withTenantTx(database.db, context, (tx) =>
      tx.insert(marketplacePublishers).values({
        id,
        organizationId: context.organizationId,
        displayName: 'A publisher',
      }),
    );
    return id;
  };

  const submissionValues = (
    context: TenantContext,
    publisherId: string,
    pkg: { id: string; name: string },
    version: SeededVersion,
    signer: TestSigner,
  ) => ({
    organizationId: context.organizationId,
    id: randomUUID(),
    publisherId,
    packageId: pkg.id,
    skillVersionId: version.id,
    name: pkg.name,
    semver: version.semver,
    digest: version.digest,
    manifest: version.manifest,
    signerKeyId: version.signerKeyId,
    signerPublicKey: signer.publicKey,
    signature: version.signature,
    bundleObjectKey: version.bundleObjectKey,
    sizeBytes: version.sizeBytes,
    submittedByMembershipId: context.membershipId,
    publishConfirmedAt: new Date(),
  });

  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = await client(urls.auth());
    const owner = await makeUser('owner-a');
    const second = await makeUser('second-a');
    const ownerB = await makeUser('owner-b');
    const a = await createOrganization(database.db, {
      name: 'Same Name Ltd',
      userId: owner,
      commercialMode: 'cloud',
    });
    const b = await createOrganization(database.db, {
      name: 'Same Name Ltd',
      userId: ownerB,
      commercialMode: 'cloud',
    });
    ctxA = await resolveTenantContext(database.db, owner, a.organizationId);
    ctxB = await resolveTenantContext(database.db, ownerB, b.organizationId);
    await withTenantTx(database.db, ctxA, (tx) =>
      tx.insert(memberships).values({
        organizationId: a.organizationId,
        userId: second,
        role: 'admin',
        status: 'active',
      }),
    );
    ctxA2 = await resolveTenantContext(database.db, second, a.organizationId);
    ({ signer: signerA } = await seedSigner(database.db, ctxA));
    operatorUrl = await provisionMarketplaceRole();
  });

  afterAll(async () => {
    await database.close();
    await auth.end();
  });

  describe('row-level security', () => {
    it('forces it on every table in these schemas', async () => {
      const su = await client(urls.superuser());
      const { rows } = await su.query(
        `select n.nspname || '.' || c.relname as t
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r','p') and n.nspname in ('skills','sandbox','marketplace')
            and not (c.relrowsecurity and c.relforcerowsecurity)`,
      );
      await su.end();
      expect(rows).toEqual([]);
    });

    it('shows one tenant nothing of another, with the same names', async () => {
      const { pkg, version } = await seedPublished();
      const read = (context: TenantContext) =>
        withTenantTx(database.db, context, async (tx) => ({
          signers: await tx.select().from(trustedSigners),
          packages: await tx.select().from(skillPackages).where(eq(skillPackages.id, pkg.id)),
          versions: await tx.select().from(skillVersions).where(eq(skillVersions.id, version.id)),
        }));
      const seen = await read(ctxB);
      expect(seen.signers).toEqual([]);
      expect(seen.packages).toEqual([]);
      expect(seen.versions).toEqual([]);
      expect((await read(ctxA)).versions).toHaveLength(1);
    });

    it('refuses a write naming another tenant', async () => {
      await expect(
        withTenantTx(database.db, ctxA, (tx) =>
          tx.insert(skillPackages).values({
            organizationId: ctxB.organizationId,
            name: `foreign-${randomHex(4)}`,
            displayName: 'Foreign',
          }),
        ),
      ).rejects.toThrow();
    });

    it('shows nothing at all with no tenant bound, including listings', async () => {
      await expect(database.db.run((tx) => tx.select().from(marketplaceListings))).resolves.toEqual(
        [],
      );
      await expect(database.db.run((tx) => tx.select().from(skillVersions))).resolves.toEqual([]);
    });
  });

  describe('what each role can reach', () => {
    it('gives the application role no write on a review or a listing', async () => {
      const app = await client(urls.app());
      await expect(app.query('delete from marketplace.listings')).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query(`update marketplace.listings set state = 'listed'`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        app.query(`insert into marketplace.security_reviews (id) values (gen_random_uuid())`),
      ).rejects.toThrow(/permission denied/);
      await app.end();
    });

    it('gives the application role no way to change a version bytes, or a run input or policy', async () => {
      const app = await client(urls.app());
      await expect(
        app.query(`update skills.package_versions set bundle_sha256 = repeat('0', 64)`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        app.query(`update skills.package_versions set uploaded_by_membership_id = null`),
      ).rejects.toThrow(/permission denied/);
      await expect(app.query(`update sandbox.runs set input = '{}'`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query(`update sandbox.runs set policy = '{}'`)).rejects.toThrow(
        /permission denied/,
      );
      await app.end();
    });

    it('gives the dispatcher and the secrets role nothing here', async () => {
      for (const url of [urls.dispatcher(), urls.secrets()]) {
        const role = await client(url);
        for (const table of [
          'skills.package_versions',
          'sandbox.runs',
          'marketplace.listings',
          'marketplace.submissions',
        ]) {
          await expect(role.query(`select 1 from ${table}`)).rejects.toThrow(/permission denied/);
        }
        await role.end();
      }
    });

    it('confines the operator role to the marketplace schema', async () => {
      const operator = await client(operatorUrl);
      for (const table of [
        'skills.package_versions',
        'skills.trusted_signers',
        'sandbox.runs',
        'work.work_units',
        'secrets.sealed_secrets',
        'identity.users',
        'org.memberships',
        'marketplace.installations',
      ]) {
        await expect(operator.query(`select 1 from ${table}`), table).rejects.toThrow(
          /permission denied/,
        );
      }
      await expect(operator.query(`delete from marketplace.listings`)).rejects.toThrow(
        /permission denied/,
      );
      await operator.end();
    });

    it('never gives the operator role any special powers', async () => {
      const su = await client(urls.superuser());
      const { rows } = await su.query(
        `select rolsuper, rolcreaterole, rolbypassrls, rolcreatedb from pg_roles
          where rolname = 'ensemus_marketplace'`,
      );
      await su.end();
      expect(rows).toEqual([
        { rolsuper: false, rolcreaterole: false, rolbypassrls: false, rolcreatedb: false },
      ]);
    });
  });

  describe('a skill version', () => {
    it('starts knowing only its bytes', async () => {
      const pkg = await seedPackage(database.db, ctxA);
      await expect(
        withTenantTx(database.db, ctxA, (tx) =>
          tx.insert(skillVersions).values({
            organizationId: ctxA.organizationId,
            packageId: pkg.id,
            bundleObjectKey: 'x',
            bundleSha256: randomHex(),
            sizeBytes: 1,
            uploadedByMembershipId: ctxA.membershipId,
            state: 'published',
          }),
        ),
      ).rejects.toThrow(sqlState('ES001'));
    });

    it('has to say who uploaded it, if it is the tenant own', async () => {
      const pkg = await seedPackage(database.db, ctxA);
      await expect(
        withTenantTx(database.db, ctxA, (tx) =>
          tx.insert(skillVersions).values({
            organizationId: ctxA.organizationId,
            packageId: pkg.id,
            bundleObjectKey: 'x',
            bundleSha256: randomHex(),
            sizeBytes: 1,
          }),
        ),
      ).rejects.toThrow(sqlState('ES001'));
    });

    const move = (id: string, set: Record<string, unknown>, context: TenantContext = ctxA) =>
      withTenantTx(database.db, context, (tx) =>
        tx
          .update(skillVersions)
          .set({ ...set, version: sql`version + 1` })
          .where(
            and(eq(skillVersions.organizationId, context.organizationId), eq(skillVersions.id, id)),
          ),
      );

    it('cannot skip being checked', async () => {
      const pkg = await seedPackage(database.db, ctxA);
      const version = await seedVersion(database.db, ctxA, {
        packageId: pkg.id,
        packageName: pkg.name,
        signer: signerA,
        state: 'uploaded',
      });
      await expect(
        move(version.id, {
          state: 'published',
          publishedByMembershipId: ctxA2.membershipId,
          publishedAt: new Date(),
        }),
      ).rejects.toThrow(sqlState('ES001'));
    });

    it('cannot be verified without a passed test of exactly these bytes', async () => {
      const pkg = await seedPackage(database.db, ctxA);
      const version = await seedVersion(database.db, ctxA, {
        packageId: pkg.id,
        packageName: pkg.name,
        signer: signerA,
        state: 'verifying',
      });
      await expect(
        move(version.id, {
          state: 'verified',
          semver: version.semver,
          digest: version.digest,
          manifest: version.manifest,
          executionKind: 'declarative',
          license: 'MIT',
          maxClassification: 'internal',
          signerKeyId: signerA.keyId,
          signature: version.signature,
          verifiedAt: new Date(),
        }),
      ).rejects.toThrow(sqlState('ES003'));
    });

    it('cannot be verified with a signer this tenant does not trust', async () => {
      const stranger = generateTestSigner();
      const pkg = await seedPackage(database.db, ctxA);
      await expect(
        seedVersion(database.db, ctxA, {
          packageId: pkg.id,
          packageName: pkg.name,
          signer: stranger,
          state: 'verified',
        }),
      ).rejects.toThrow(sqlState('ES003'));
    });

    it('cannot be published by whoever uploaded it', async () => {
      const pkg = await seedPackage(database.db, ctxA);
      const version = await seedVersion(database.db, ctxA, {
        packageId: pkg.id,
        packageName: pkg.name,
        signer: signerA,
        state: 'verified',
      });
      await expect(
        move(version.id, {
          state: 'published',
          publishedByMembershipId: ctxA.membershipId,
          publishedAt: new Date(),
        }),
      ).rejects.toThrow(sqlState('23514'));
    });

    it('never comes to mean something else once it is checked', async () => {
      const { version } = await seedPublished();
      for (const change of [
        { digest: randomHex() },
        { semver: '9.9.9' },
        { manifest: { changed: true } },
        { signature: randomBytes(64) },
        { signerKeyId: randomHex() },
        { maxClassification: 'confidential' },
        { executionKind: 'sandbox' },
        { license: 'Apache-2.0' },
      ]) {
        await expect(move(version.id, change), JSON.stringify(Object.keys(change))).rejects.toThrow(
          sqlState('ES002'),
        );
      }
    });

    it('goes nowhere from yanked', async () => {
      const { version } = await seedPublished();
      await move(version.id, {
        state: 'yanked',
        yankCode: 'SECURITY_ISSUE',
        yankedAt: new Date(),
      });
      await expect(
        move(version.id, {
          state: 'published',
          yankCode: null,
          yankedAt: null,
        }),
      ).rejects.toThrow(sqlState('ES001'));
    });

    it('cannot be deleted, by the application or the owner', async () => {
      const su = await client(urls.migrator());
      await expect(su.query('delete from skills.package_versions')).rejects.toThrow();
      await expect(su.query('truncate skills.test_runs')).rejects.toThrow();
      await su.end();
    });

    it('keeps a revoked signer revoked', async () => {
      const { id } = await seedSigner(database.db, ctxA);
      const set = (state: string) =>
        withTenantTx(database.db, ctxA, (tx) =>
          tx
            .update(trustedSigners)
            .set({
              state,
              revokedAt: state === 'revoked' ? new Date() : null,
              version: sql`version + 1`,
            })
            .where(
              and(
                eq(trustedSigners.organizationId, ctxA.organizationId),
                eq(trustedSigners.id, id),
              ),
            ),
        );
      await set('revoked');
      await expect(set('active')).rejects.toThrow(sqlState('ES001'));
    });
  });

  describe('a sandbox run', () => {
    it('cannot start for a version nobody published, or with code it does not have', async () => {
      const pkg = await seedPackage(database.db, ctxA);
      const verified = await seedVersion(database.db, ctxA, {
        packageId: pkg.id,
        packageName: pkg.name,
        signer: signerA,
        state: 'uploaded',
        kind: 'sandbox',
      });
      await expect(
        seedSandboxRun(database.db, ctxA, { skillVersionId: verified.id, digest: randomHex() }),
      ).rejects.toThrow(sqlState('ES003'));
      const { version: declarative } = await seedPublished('declarative');
      await expect(
        seedSandboxRun(database.db, ctxA, {
          skillVersionId: declarative.id,
          digest: declarative.digest,
        }),
      ).rejects.toThrow(sqlState('ES003'));
    });

    it('cannot run bytes other than what was checked', async () => {
      const { version } = await seedPublished('sandbox');
      await expect(
        seedSandboxRun(database.db, ctxA, { skillVersionId: version.id, digest: randomHex() }),
      ).rejects.toThrow(sqlState('ES003'));
    });

    it('cannot be given data over what the package allows', async () => {
      const { version } = await seedPublished('sandbox');
      await expect(
        seedSandboxRun(database.db, ctxA, {
          skillVersionId: version.id,
          digest: version.digest,
          classification: 'confidential',
        }),
      ).rejects.toThrow(sqlState('ES003'));
    });

    it('cannot be given restricted data at all', async () => {
      const { version } = await seedPublished('sandbox');
      const { policy, policyHash } = testPolicy();
      await expect(
        withTenantTx(database.db, ctxA, (tx) =>
          tx.insert(sandboxRuns).values({
            organizationId: ctxA.organizationId,
            skillVersionId: version.id,
            digest: version.digest,
            purpose: 'operator_test',
            classification: 'restricted',
            input: {},
            policy,
            policyHash,
          }),
        ),
      ).rejects.toThrow(sqlState('23514'));
    });

    const change = (id: string, set: Record<string, unknown>) =>
      withTenantTx(database.db, ctxA, (tx) =>
        tx
          .update(sandboxRuns)
          .set({ ...set, version: sql`version + 1` })
          .where(and(eq(sandboxRuns.organizationId, ctxA.organizationId), eq(sandboxRuns.id, id))),
      );

    it('cannot start without a probe having passed for it, and every start counts', async () => {
      const { version } = await seedPublished('sandbox');
      const { id } = await seedSandboxRun(database.db, ctxA, {
        skillVersionId: version.id,
        digest: version.digest,
      });
      await expect(change(id, { status: 'running', attempts: 1 })).rejects.toThrow(
        sqlState('ES003'),
      );
      await expect(
        change(id, { status: 'running', isolationProbePassedAt: new Date() }),
      ).rejects.toThrow(sqlState('ES003'));
      await change(id, { status: 'running', attempts: 1, isolationProbePassedAt: new Date() });
    });

    it('holds output only for a job that succeeded', async () => {
      const { version } = await seedPublished('sandbox');
      const { id } = await seedSandboxRun(database.db, ctxA, {
        skillVersionId: version.id,
        digest: version.digest,
      });
      await change(id, { status: 'running', attempts: 1, isolationProbePassedAt: new Date() });
      await expect(
        change(id, {
          status: 'failed',
          outcomeCode: 'EXITED_NON_ZERO',
          finishedAt: new Date(),
          output: { leaked: true },
        }),
      ).rejects.toThrow(sqlState('ES002'));
      await expect(
        change(id, { status: 'succeeded', outcomeCode: 'EXITED_ZERO', finishedAt: new Date() }),
      ).rejects.toThrow(sqlState('ES002'));
      await change(id, {
        status: 'succeeded',
        outcomeCode: 'EXITED_ZERO',
        finishedAt: new Date(),
        exitCode: 0,
        output: { ok: true },
      });
      await expect(change(id, { status: 'queued', output: null })).rejects.toThrow(
        sqlState('ES001'),
      );
    });
  });

  describe('the marketplace', () => {
    it('refuses a package that was not marked public', async () => {
      const publisherCtx = ctxA;
      const pkg = await seedPackage(database.db, publisherCtx);
      const version = await seedVersion(database.db, publisherCtx, {
        packageId: pkg.id,
        packageName: pkg.name,
        signer: signerA,
        state: 'verified',
      });
      const publisherId = await seedPublisher(publisherCtx).catch(async () => {
        const [row] = await withTenantTx(database.db, publisherCtx, (tx) =>
          tx.select({ id: marketplacePublishers.id }).from(marketplacePublishers),
        );
        return row!.id;
      });
      await expect(
        withTenantTx(database.db, publisherCtx, (tx) =>
          tx
            .insert(marketplaceSubmissions)
            .values(submissionValues(publisherCtx, publisherId, pkg, version, signerA)),
        ),
      ).rejects.toThrow(sqlState('ES005'));
    });

    const seedSubmission = async () => {
      const { pkg, version } = await seedPublished();
      const [existing] = await withTenantTx(database.db, ctxA, (tx) =>
        tx.select({ id: marketplacePublishers.id }).from(marketplacePublishers),
      );
      const publisherId = existing?.id ?? (await seedPublisher(ctxA));
      const values = submissionValues(ctxA, publisherId, pkg, version, signerA);
      await withTenantTx(database.db, ctxA, (tx) =>
        tx.insert(marketplaceSubmissions).values(values),
      );
      return { pkg, version, publisherId, submissionId: values.id, values };
    };

    it('holds a submission equal to the version it names', async () => {
      const { pkg, version } = await seedPublished();
      const [existing] = await withTenantTx(database.db, ctxA, (tx) =>
        tx.select({ id: marketplacePublishers.id }).from(marketplacePublishers),
      );
      const publisherId = existing?.id ?? (await seedPublisher(ctxA));
      const values = submissionValues(ctxA, publisherId, pkg, version, signerA);
      await expect(
        withTenantTx(database.db, ctxA, (tx) =>
          tx.insert(marketplaceSubmissions).values({ ...values, digest: randomHex() }),
        ),
      ).rejects.toThrow(sqlState('ES004'));
    });

    it('lets a publisher withdraw and nothing else', async () => {
      const { submissionId } = await seedSubmission();
      const set = (state: string) =>
        withTenantTx(database.db, ctxA, (tx) =>
          tx
            .update(marketplaceSubmissions)
            .set({ state, version: sql`version + 1` })
            .where(
              and(
                eq(marketplaceSubmissions.organizationId, ctxA.organizationId),
                eq(marketplaceSubmissions.id, submissionId),
              ),
            ),
        );
      await expect(set('in_review')).rejects.toThrow(sqlState('ES005'));
      await expect(set('approved')).rejects.toThrow();
      await set('withdrawn');
    });

    it('does not let separate worker or agent logins progress a marketplace review', async () => {
      const { submissionId } = await seedSubmission();
      for (const url of [urls.worker(), urls.connector(), urls.knowledge(), urls.agent()]) {
        const runtime = await client(url);
        try {
          await runtime.query("select set_config('app.organization_id', $1, false)", [
            ctxA.organizationId,
          ]);
          await expect(
            runtime.query(
              `update marketplace.submissions set state='in_review', version=version+1
              where organization_id=$1 and id=$2 returning id`,
              [ctxA.organizationId, submissionId],
            ),
          ).rejects.toMatchObject({ code: 'ES005' });
        } finally {
          await runtime.end();
        }
      }
    });

    const passedChecks = () =>
      Object.fromEntries(REVIEW_CHECKS.map((check) => [check, 'pass'])) as Record<string, string>;

    it('refuses a listing with no approved review of these bytes', async () => {
      const { values, publisherId } = await seedSubmission();
      const operator = await client(operatorUrl);
      await operator.query(
        `update marketplace.submissions set state = 'in_review', version = version + 1
          where organization_id = $1 and id = $2`,
        [ctxA.organizationId, values.id],
      );
      await expect(
        operator.query(
          `update marketplace.submissions set state = 'approved', version = version + 1
            where organization_id = $1 and id = $2`,
          [ctxA.organizationId, values.id],
        ),
      ).rejects.toMatchObject({ code: 'ES005' });
      await expect(
        operator.query(
          `insert into marketplace.listings
             (publisher_id, publisher_organization_id, publisher_display_name, submission_id, review_id,
              name, semver, display_name, summary, digest, manifest, license, execution_kind,
              max_classification, signer_key_id, signer_public_key, signature, reviewer_key_id,
              attestation_signature, object_key, size_bytes)
           values ($1, $2, 'P', $3, $4, 'n', '1.0.0', 'd', 's', $5, '{}', 'MIT', 'declarative', 'internal',
                   $6, $7, $8, $9, $10, 'marketplace/x', 1)`,
          [
            publisherId,
            ctxA.organizationId,
            values.id,
            randomUUID(),
            values.digest,
            values.signerKeyId,
            values.signerPublicKey,
            randomBytes(64),
            randomHex(),
            randomBytes(64),
          ],
        ),
      ).rejects.toThrow();
      await operator.end();
    });

    const review = (
      operator: pg.Client,
      values: { id: string; digest: string; signerKeyId: string },
      overrides: {
        verdict?: string;
        checks?: Record<string, string>;
        findings?: string[];
        digest?: string;
        reviewerKeyId?: string;
      } = {},
    ) =>
      operator.query(
        `insert into marketplace.security_reviews
           (submission_organization_id, submission_id, digest, signer_key_id, reviewer_key_id,
            reviewer_label, verdict, checks, finding_codes, attestation, attestation_signature, decided_at)
         values ($1, $2, $3, $4, $5, 'A reviewer', $6, $7, $8, '{}', $9, now())
         returning id`,
        [
          ctxA.organizationId,
          values.id,
          overrides.digest ?? values.digest,
          values.signerKeyId,
          overrides.reviewerKeyId ?? randomHex(),
          overrides.verdict ?? 'approved',
          JSON.stringify(overrides.checks ?? passedChecks()),
          overrides.findings ?? [],
          randomBytes(64),
        ],
      );

    it('refuses an approval with a failed check, a finding, the wrong bytes, or the signer as reviewer', async () => {
      const { values } = await seedSubmission();
      const operator = await client(operatorUrl);
      await expect(
        review(operator, values, { checks: { ...passedChecks(), tests_inspected: 'fail' } }),
      ).rejects.toMatchObject({ code: 'ES005' });
      await expect(
        review(operator, values, { checks: { only_one: 'pass' } }),
      ).rejects.toMatchObject({ code: 'ES005' });
      await expect(review(operator, values, { findings: ['HARMFUL_CODE'] })).rejects.toMatchObject({
        code: 'ES005',
      });
      await expect(review(operator, values, { digest: randomHex() })).rejects.toMatchObject({
        code: 'ES004',
      });
      await expect(
        review(operator, values, { reviewerKeyId: values.signerKeyId }),
      ).rejects.toMatchObject({ code: 'ES005' });
      await operator.end();
    });

    const seedListing = async () => {
      const { values, publisherId } = await seedSubmission();
      const operator = await client(operatorUrl);
      const reviewerKeyId = randomHex();
      await operator.query(
        `update marketplace.submissions set state = 'in_review', version = version + 1
          where organization_id = $1 and id = $2`,
        [ctxA.organizationId, values.id],
      );
      const attestationSignature = randomBytes(64);
      const { rows } = await operator.query(
        `insert into marketplace.security_reviews
           (submission_organization_id, submission_id, digest, signer_key_id, reviewer_key_id,
            reviewer_label, verdict, checks, finding_codes, attestation, attestation_signature, decided_at)
         values ($1, $2, $3, $4, $5, 'A reviewer', 'approved', $6, '{}', '{}', $7, now())
         returning id`,
        [
          ctxA.organizationId,
          values.id,
          values.digest,
          values.signerKeyId,
          reviewerKeyId,
          JSON.stringify(passedChecks()),
          attestationSignature,
        ],
      );
      await operator.query(
        `update marketplace.submissions set state = 'approved', decided_at = now(), version = version + 1
          where organization_id = $1 and id = $2`,
        [ctxA.organizationId, values.id],
      );
      const listingId = randomUUID();
      await operator.query(
        `insert into marketplace.listings
           (id, publisher_id, publisher_organization_id, publisher_display_name, submission_id, review_id,
            name, semver, display_name, summary, digest, manifest, license, execution_kind,
            max_classification, signer_key_id, signer_public_key, signature, reviewer_key_id,
            attestation_signature, object_key, size_bytes)
         values ($1, $2, $3, 'P', $4, $5, $6, $7, 'd', 's', $8, $9, 'MIT', 'declarative', 'internal',
                 $10, $11, $12, $13, $14, $15, $16)`,
        [
          listingId,
          publisherId,
          ctxA.organizationId,
          values.id,
          rows[0].id,
          values.name,
          values.semver,
          values.digest,
          JSON.stringify(values.manifest),
          values.signerKeyId,
          values.signerPublicKey,
          values.signature,
          reviewerKeyId,
          attestationSignature,
          `marketplace/${values.digest}`,
          values.sizeBytes,
        ],
      );
      await operator.end();
      return { listingId, values };
    };

    it('lists a reviewed version, and every tenant can then see it', async () => {
      const { listingId } = await seedListing();
      const seen = await withTenantTx(database.db, ctxB, (tx) =>
        tx.select().from(marketplaceListings).where(eq(marketplaceListings.id, listingId)),
      );
      expect(seen).toHaveLength(1);
      const reviews = await withTenantTx(database.db, ctxB, (tx) =>
        tx.select().from(marketplaceReviews),
      );
      expect(reviews).toEqual([]);
    });

    it('cannot withdraw what is listed', async () => {
      const { values } = await seedListing();
      await expect(
        withTenantTx(database.db, ctxA, (tx) =>
          tx
            .update(marketplaceSubmissions)
            .set({ state: 'withdrawn', version: sql`version + 1` })
            .where(
              and(
                eq(marketplaceSubmissions.organizationId, ctxA.organizationId),
                eq(marketplaceSubmissions.id, values.id),
              ),
            ),
        ),
      ).rejects.toThrow(sqlState('ES005'));
    });

    it('never lists again, and a revoke stays a revoke', async () => {
      const { listingId } = await seedListing();
      const operator = await client(operatorUrl);
      const set = (state: string, mode: string | null) =>
        operator.query(
          `update marketplace.listings
              set state = $1, delist_mode = $2, delist_code = $3, delisted_at = $4, version = version + 1
            where id = $5`,
          [state, mode, mode ? 'SECURITY_ISSUE' : null, mode ? new Date() : null, listingId],
        );
      await set('delisted', 'stop_new');
      await expect(set('listed', null)).rejects.toMatchObject({ code: 'ES001' });
      await set('delisted', 'revoke');
      await expect(set('delisted', 'stop_new')).rejects.toMatchObject({ code: 'ES001' });
      await operator.end();
    });

    it('hides a delisted listing from anyone who has not installed it', async () => {
      const { listingId } = await seedListing();
      const installationId = randomUUID();
      await withTenantTx(database.db, ctxB, (tx) =>
        tx.insert(marketplaceInstallations).values({
          organizationId: ctxB.organizationId,
          id: installationId,
          listingId,
          requestedByMembershipId: ctxB.membershipId,
        }),
      );
      const operator = await client(operatorUrl);
      await operator.query(
        `update marketplace.listings
            set state = 'delisted', delist_mode = 'revoke', delist_code = 'SECURITY_ISSUE',
                delisted_at = now(), version = version + 1
          where id = $1`,
        [listingId],
      );
      await operator.end();
      const c = await withTenantTx(database.db, ctxB, (tx) =>
        tx.select().from(marketplaceListings).where(eq(marketplaceListings.id, listingId)),
      );
      expect(c).toHaveLength(1);
      await expect(
        withTenantTx(database.db, ctxB, (tx) =>
          tx.insert(marketplaceInstallations).values({
            organizationId: ctxB.organizationId,
            listingId,
            requestedByMembershipId: ctxB.membershipId,
          }),
        ),
      ).rejects.toThrow();
    });

    it('cannot install what is not on offer', async () => {
      await expect(
        withTenantTx(database.db, ctxB, (tx) =>
          tx.insert(marketplaceInstallations).values({
            organizationId: ctxB.organizationId,
            listingId: randomUUID(),
            requestedByMembershipId: ctxB.membershipId,
          }),
        ),
      ).rejects.toThrow(sqlState('ES005'));
    });
  });
});
