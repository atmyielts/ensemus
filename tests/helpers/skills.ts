// Test seeds for ADR-034 tables, shared by every M11B slice. They walk a version or a run to a state through the
// real transitions and triggers, as the application role, so a seed can never reach a state the rules forbid.
// Keys are generated on the spot, and hashes and signatures in here are random, because the database checks
// that they agree and cannot check that they verify. @ensemus/skills/testing builds bundles that really do.
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import {
  sandboxRuns,
  skillPackages,
  skillTestRuns,
  skillVersions,
  trustedSigners,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { SANDBOX_DEFAULT_CEILINGS, sandboxPolicyHash, type SandboxPolicy } from '@ensemus/domain/sandbox';
import type { SkillVersionState } from '@ensemus/domain/skill';
import { skillBundleObjectKey } from '@ensemus/domain/skill';
import { eq, and, sql } from 'drizzle-orm';
import { dbUrl, urls } from './stack';

export const randomHex = (bytes = 32) => randomBytes(bytes).toString('hex');

/** The raw 32 bytes at the end of an Ed25519 public key's DER form. */
export function generateTestSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    publicKey: Buffer.from(raw),
    keyId: createHash('sha256').update(raw).digest('hex'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
export type TestSigner = ReturnType<typeof generateTestSigner>;

export async function seedSigner(
  database: AppDatabase,
  context: TenantContext,
  signer: TestSigner = generateTestSigner(),
) {
  const id = randomUUID();
  await withTenantTx(database, context, (tx) =>
    tx.insert(trustedSigners).values({
      organizationId: context.organizationId,
      id,
      displayName: `Signer ${id.slice(0, 8)}`,
      keyId: signer.keyId,
      publicKey: signer.publicKey,
      addedByMembershipId: context.membershipId,
    }),
  );
  return { id, signer };
}

export async function seedPackage(
  database: AppDatabase,
  context: TenantContext,
  options: {
    name?: string;
    contentClassification?: 'public' | 'internal' | 'confidential' | 'restricted';
  } = {},
) {
  const id = randomUUID();
  const name = options.name ?? `skill-${id.slice(0, 8)}`;
  await withTenantTx(database, context, (tx) =>
    tx.insert(skillPackages).values({
      organizationId: context.organizationId,
      id,
      name,
      displayName: name,
      contentClassification: options.contentClassification ?? 'internal',
      createdByMembershipId: context.membershipId || null,
    }),
  );
  return { id, name };
}

export function testManifest(name: string, semver: string, kind: 'declarative' | 'sandbox') {
  return {
    schema_version: 1,
    name,
    version: semver,
    display_name: name,
    summary: 'A test package. Nothing here is real.',
    license: 'MIT',
    instructions: 'instructions.md',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    tool_boundaries: [],
    max_classification: 'internal',
    dependencies: [],
    execution:
      kind === 'declarative'
        ? { kind }
        : {
            kind,
            runtime: 'node24',
            entry: 'main.mjs',
            network: { mode: 'none' },
            limits: { wall_ms: 1000, cpu_ms: 1000, memory_mb: 64, tmpfs_mb: 1, output_kb: 16, pids: 4 },
          },
    tests: [{ name: 'one', input: 'in.json', expected_output: 'out.json' }],
    files: [{ path: 'instructions.md', sha256: randomHex(), size_bytes: 1 }],
  };
}

export type SeededVersion = {
  id: string;
  packageId: string;
  digest: string;
  semver: string;
  signerKeyId: string;
  signature: Buffer;
  bundleObjectKey: string;
  manifest: ReturnType<typeof testManifest>;
  sizeBytes: number;
};

/**
 * Walks a version to `state`. `publisher` has to be a different person from `context` for `published`,
 * because the table says so. The signer has to be on file for anything past `verifying`.
 */
export async function seedVersion(
  database: AppDatabase,
  context: TenantContext,
  options: {
    packageId: string;
    packageName: string;
    signer: TestSigner;
    state: SkillVersionState;
    kind?: 'declarative' | 'sandbox';
    semver?: string;
    publisher?: TenantContext;
  },
): Promise<SeededVersion> {
  const id = randomUUID();
  const organizationId = context.organizationId;
  const kind = options.kind ?? 'declarative';
  const semver = options.semver ?? `1.0.${Math.floor(Math.random() * 1_000_000)}`;
  const bundleObjectKey = skillBundleObjectKey(organizationId, id);
  const digest = randomHex();
  const signature = randomBytes(64);
  const manifest = testManifest(options.packageName, semver, kind);
  const sizeBytes = 1024;
  const seeded: SeededVersion = {
    id,
    packageId: options.packageId,
    digest,
    semver,
    signerKeyId: options.signer.keyId,
    signature,
    bundleObjectKey,
    manifest,
    sizeBytes,
  };
  const where = and(
    eq(skillVersions.organizationId, organizationId),
    eq(skillVersions.id, id),
  );
  await withTenantTx(database, context, (tx) =>
    tx.insert(skillVersions).values({
      organizationId,
      id,
      packageId: options.packageId,
      bundleObjectKey,
      bundleSha256: randomHex(),
      sizeBytes,
      uploadedByMembershipId: context.membershipId || null,
    }),
  );
  if (options.state === 'uploaded') return seeded;
  if (options.state === 'rejected') {
    await withTenantTx(database, context, (tx) =>
      tx
        .update(skillVersions)
        .set({ state: 'rejected', rejectCode: 'MANIFEST_INVALID', version: sql`version + 1` })
        .where(where),
    );
    return seeded;
  }
  await withTenantTx(database, context, (tx) =>
    tx
      .update(skillVersions)
      .set({ state: 'verifying', version: sql`version + 1` })
      .where(where),
  );
  if (options.state === 'verifying') return seeded;
  await withTenantTx(database, context, async (tx) => {
    await tx.insert(skillTestRuns).values({
      organizationId,
      skillVersionId: id,
      digest,
      mode: kind === 'sandbox' ? 'sandbox' : 'contract',
      outcome: 'passed',
      fixturesTotal: 1,
      fixturesPassed: 1,
      startedAt: new Date(),
    });
    await tx
      .update(skillVersions)
      .set({
        state: 'verified',
        semver,
        digest,
        manifest,
        executionKind: kind,
        license: 'MIT',
        maxClassification: 'internal',
        signerKeyId: options.signer.keyId,
        signature,
        verifiedAt: new Date(),
        version: sql`version + 1`,
      })
      .where(where);
  });
  if (options.state === 'verified') return seeded;
  if (options.state === 'published') {
    const publisher = options.publisher;
    if (!publisher) throw new Error('Publishing takes someone other than the uploader');
    await withTenantTx(database, publisher, (tx) =>
      tx
        .update(skillVersions)
        .set({
          state: 'published',
          publishedByMembershipId: publisher.membershipId,
          publishedAt: new Date(),
          version: sql`version + 1`,
        })
        .where(where),
    );
    return seeded;
  }
  await withTenantTx(database, context, (tx) =>
    tx
      .update(skillVersions)
      .set({
        state: 'yanked',
        yankCode: 'WITHDRAWN_BY_OWNER',
        yankedAt: new Date(),
        version: sql`version + 1`,
      })
      .where(where),
  );
  return seeded;
}

/** What a compiled policy looks like. Written out, so these tests do not lean on the slice that compiles it. */
export function testPolicy(): { policy: SandboxPolicy; policyHash: string } {
  const policy: SandboxPolicy = {
    policyVersion: 1,
    runtime: 'node24',
    entry: 'main.mjs',
    network: { mode: 'none' },
    credentials: 'none',
    environment: 'fixed_empty',
    filesystem: { root: 'read_only', skill: 'read_only', scratch: 'tmpfs_only' },
    limits: SANDBOX_DEFAULT_CEILINGS,
  };
  return { policy, policyHash: sandboxPolicyHash(policy) };
}

export async function seedSandboxRun(
  database: AppDatabase,
  context: TenantContext,
  options: {
    skillVersionId: string;
    digest: string;
    classification?: 'public' | 'internal' | 'confidential';
    input?: unknown;
  },
) {
  const id = randomUUID();
  const { policy, policyHash } = testPolicy();
  await withTenantTx(database, context, (tx) =>
    tx.insert(sandboxRuns).values({
      organizationId: context.organizationId,
      id,
      skillVersionId: options.skillVersionId,
      digest: options.digest,
      purpose: 'operator_test',
      requestedByMembershipId: context.membershipId || null,
      classification: options.classification ?? 'internal',
      input: options.input ?? { nothing: 'here is real' },
      policy,
      policyHash,
    }),
  );
  return { id };
}

const OPERATOR_PASSWORD = randomHex(24);

/**
 * Does what provision-marketplace.sql does, with a password made up for this test run. Safe to repeat. A
 * real server only gets this role when its operator chooses to run that file.
 */
export async function provisionMarketplaceRole() {
  const su = new pg.Client({ connectionString: urls.superuser() });
  await su.connect();
  try {
    const { rows } = await su.query(
      `select 1 from pg_roles where rolname = 'ensemus_marketplace'`,
    );
    if (rows.length === 0) {
      await su.query(
        `create role ensemus_marketplace login nosuperuser nocreaterole nobypassrls password '${OPERATOR_PASSWORD}'`,
      );
    } else {
      await su.query(`alter role ensemus_marketplace password '${OPERATOR_PASSWORD}'`);
    }
    await su.query('grant connect on database ensemus to ensemus_marketplace');
    await su.query('set role ensemus_migrator');
    await su.query('select marketplace.grant_operator_role()');
    await su.query('reset role');
  } finally {
    await su.end();
  }
  const url = new URL(dbUrl('ensemus_app', 'db_app_password'));
  url.username = 'ensemus_marketplace';
  url.password = OPERATOR_PASSWORD;
  return url.toString();
}
