// Real-role signer administration. Generated fixtures; no hosted/provider/sandbox acceptance claim.
import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { addTrustedSigner, listTrustedSigners, revokeTrustedSigner } from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  trustedSigners,
  skillVersions,
  skillTestRuns,
  type TenantContext,
} from '@ensemus/database';
import { eq, sql } from 'drizzle-orm';
import { urls } from '../helpers/stack';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { seedPackage, seedVersion, generateTestSigner } from '../helpers/skills';

const code = (code: string) => expect.objectContaining({ code });
const on = { isEnabled: async () => true };
const off = { isEnabled: async () => false };
const rawKey = () =>
  generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
describe('trusted publisher administration', () => {
  let app: ReturnType<typeof openAppDatabase>, auth: pg.Client, su: pg.Client;
  let ownerA: TenantContext, ownerB: TenantContext, admin: TenantContext, member: TenantContext;
  async function user() {
    const id = randomUUID();
    await auth.query(
      'insert into identity.users (id,name,email,email_verified) values ($1,$2,$3,true)',
      [id, 'Generated member', `${id}@example.invalid`],
    );
    return id;
  }
  async function organization() {
    const userId = await user();
    const { organizationId } = await createOrganization(app.db, {
      userId,
      name: 'Generated organization',
      commercialMode: 'byom',
    });
    return resolveTenantContext(app.db, userId, organizationId);
  }
  async function teammate(role: 'admin' | 'member') {
    const userId = await user();
    await withTenantTx(app.db, ownerA, (tx) =>
      tx.execute(
        sql`insert into org.memberships (organization_id,user_id,role) values (${ownerA.organizationId},${userId},${role})`,
      ),
    );
    return resolveTenantContext(app.db, userId, ownerA.organizationId);
  }
  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    su = new pg.Client({ connectionString: urls.superuser() });
    await auth.connect();
    await su.connect();
    ownerA = await organization();
    ownerB = await organization();
    admin = await teammate('admin');
    member = await teammate('member');
  });
  afterAll(async () => {
    await app?.close();
    await auth?.end();
    await su?.end();
  });

  it('trusts one raw public key and returns its fingerprint without exposing its bytes', async () => {
    const publicKey = rawKey();
    const added = await addTrustedSigner(app.db, ownerA, on, {
      displayName: 'Publisher',
      publicKey,
    });
    expect(added).toMatchObject({
      displayName: 'Publisher',
      keyId: createHash('sha256').update(publicKey).digest('hex'),
      state: 'active',
      version: 1,
    });
    expect(added).not.toHaveProperty('publicKey');
    expect(await listTrustedSigners(app.db, member)).toContainEqual(added);
    expect((await listTrustedSigners(app.db, ownerB)).some((row) => row.id === added.id)).toBe(
      false,
    );
    await expect(
      addTrustedSigner(app.db, ownerA, on, { displayName: 'Again', publicKey }),
    ).rejects.toMatchObject(code('SKILL_SIGNER_EXISTS'));
    await expect(
      revokeTrustedSigner(app.db, ownerB, { signerId: added.id, expectedVersion: 1 }),
    ).rejects.toMatchObject(code('NOT_FOUND'));
  });
  it('refuses invalid key encodings, disabled admission, ordinary members and a stale administrator role', async () => {
    await expect(
      addTrustedSigner(app.db, ownerA, off, { displayName: 'Off', publicKey: rawKey() }),
    ).rejects.toMatchObject(code('FEATURE_NOT_ENABLED'));
    for (const publicKey of [
      Buffer.alloc(31),
      Buffer.alloc(33),
      Buffer.from('-----BEGIN PRIVATE KEY-----'),
    ]) {
      await expect(
        addTrustedSigner(app.db, ownerA, on, { displayName: 'Invalid', publicKey }),
      ).rejects.toMatchObject(code('SKILL_SIGNER_KEY_INVALID'));
    }
    await expect(
      addTrustedSigner(app.db, member, on, { displayName: 'Member', publicKey: rawKey() }),
    ).rejects.toMatchObject(code('FORBIDDEN'));
    await inFixtureTenant(su, ownerA.organizationId, () =>
      su.query("update org.memberships set role='member' where organization_id=$1 and id=$2", [
        ownerA.organizationId,
        admin.membershipId,
      ]),
    );
    await expect(
      addTrustedSigner(app.db, admin, on, { displayName: 'Stale role', publicKey: rawKey() }),
    ).rejects.toMatchObject(code('FORBIDDEN'));
  });
  it("revokes atomically with yanking this tenant's signed versions, and cannot restore the key", async () => {
    const signer = generateTestSigner(),
      added = await addTrustedSigner(app.db, ownerA, on, {
        displayName: 'Revoked publisher',
        publicKey: signer.publicKey,
      });
    const other = await addTrustedSigner(app.db, ownerB, on, {
      displayName: 'Same publisher elsewhere',
      publicKey: signer.publicKey,
    });
    const pkg = await seedPackage(app.db, ownerA);
    const verified = await seedVersion(app.db, ownerA, {
      packageId: pkg.id,
      packageName: pkg.name,
      signer,
      state: 'verified',
    });
    await expect(
      revokeTrustedSigner(app.db, ownerA, { signerId: added.id, expectedVersion: 99 }),
    ).rejects.toMatchObject(code('VERSION_CONFLICT'));
    await revokeTrustedSigner(app.db, ownerA, { signerId: added.id, expectedVersion: 1 });
    await revokeTrustedSigner(app.db, ownerA, { signerId: added.id, expectedVersion: 1 });
    const [version] = await withTenantTx(app.db, ownerA, (tx) =>
      tx
        .select({ state: skillVersions.state, code: skillVersions.yankCode })
        .from(skillVersions)
        .where(eq(skillVersions.id, verified.id)),
    );
    expect(version).toEqual({ state: 'yanked', code: 'SIGNER_REVOKED' });
    expect(await listTrustedSigners(app.db, ownerA)).toContainEqual(
      expect.objectContaining({ id: added.id, state: 'revoked', version: 2 }),
    );
    expect(await listTrustedSigners(app.db, ownerB)).toContainEqual(other);
    await expect(
      addTrustedSigner(app.db, ownerA, on, { displayName: 'Restore', publicKey: signer.publicKey }),
    ).rejects.toMatchObject(code('SKILL_SIGNER_EXISTS'));
  });
  it('serializes an in-flight verification with revocation so the version cannot escape withdrawal', async () => {
    const signer = generateTestSigner();
    const added = await addTrustedSigner(app.db, ownerA, on, {
      displayName: 'Racing publisher',
      publicKey: signer.publicKey,
    });
    const pkg = await seedPackage(app.db, ownerA);
    const version = await seedVersion(app.db, ownerA, {
      packageId: pkg.id,
      packageName: pkg.name,
      signer,
      state: 'verifying',
    });
    let markUpdated!: () => void, release!: () => void;
    const updated = new Promise<void>((resolve) => {
      markUpdated = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let verifierPid = 0,
      verificationError: unknown;
    const verifying = withTenantTx(app.db, ownerA, async (tx) => {
      const pid = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      verifierPid = pid.rows[0]!.pid;
      await tx.insert(skillTestRuns).values({
        organizationId: ownerA.organizationId,
        skillVersionId: version.id,
        digest: version.digest,
        mode: 'contract',
        outcome: 'passed',
        fixturesTotal: 1,
        fixturesPassed: 1,
        startedAt: new Date(),
      });
      await tx
        .update(skillVersions)
        .set({
          state: 'verified',
          semver: version.semver,
          digest: version.digest,
          manifest: version.manifest,
          executionKind: 'declarative',
          license: 'MIT',
          maxClassification: 'internal',
          signerKeyId: signer.keyId,
          signature: version.signature,
          verifiedAt: new Date(),
          version: sql`version+1`,
        })
        .where(eq(skillVersions.id, version.id));
      markUpdated();
      await held;
    }).catch((error: unknown) => {
      verificationError = error;
      markUpdated();
    });
    await updated;
    let revoked = false;
    const revoking = revokeTrustedSigner(app.db, ownerA, {
      signerId: added.id,
      expectedVersion: 1,
    }).then(() => {
      revoked = true;
    });
    try {
      await expect
        .poll(
          async () => {
            if (revoked || verificationError) return true;
            const { rows } = await su.query(
              `select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked`,
              [verifierPid],
            );
            return rows[0].blocked as boolean;
          },
          { timeout: 5_000, interval: 20 },
        )
        .toBe(true);
    } finally {
      release();
    }
    await Promise.all([verifying, revoking]);
    if (verificationError) throw verificationError;
    const [row] = await withTenantTx(app.db, ownerA, (tx) =>
      tx
        .select({ state: skillVersions.state, code: skillVersions.yankCode })
        .from(skillVersions)
        .where(eq(skillVersions.id, version.id)),
    );
    expect(row).toEqual({ state: 'yanked', code: 'SIGNER_REVOKED' });
  });

  it('requires recent MFA when company administration requires it', async () => {
    const context = await organization();
    await inFixtureTenant(su, context.organizationId, () =>
      su.query(
        'insert into org.security_policies (organization_id,mfa_for_administration,mfa_max_age_seconds) values ($1,true,900)',
        [context.organizationId],
      ),
    );
    await expect(
      addTrustedSigner(app.db, context, on, { displayName: 'Missing proof', publicKey: rawKey() }),
    ).rejects.toMatchObject(code('MFA_REQUIRED'));
    expect(await listTrustedSigners(app.db, context)).toEqual([]);
  });
  it('refuses a worker forging user bindings and a misleading public-key fingerprint', async () => {
    const key = rawKey();
    for (const url of [urls.worker(), urls.connector(), urls.knowledge(), urls.agent()]) {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        await c.query(
          "select set_config('app.organization_id',$1,false),set_config('app.membership_id',$2,false),set_config('app.user_id',$3,false),set_config('app.actor_type','user',false)",
          [ownerA.organizationId, ownerA.membershipId, ownerA.userId],
        );
        await expect(
          c.query(
            "insert into skills.trusted_signers (organization_id,display_name,key_id,public_key,added_by_membership_id) values ($1,'Forged',$2,$3,$4)",
            [
              ownerA.organizationId,
              createHash('sha256').update(key).digest('hex'),
              key,
              ownerA.membershipId,
            ],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await c.end();
      }
    }
    await expect(
      withTenantTx(app.db, ownerA, (tx) =>
        tx.insert(trustedSigners).values({
          organizationId: ownerA.organizationId,
          displayName: 'Wrong fingerprint',
          keyId: 'a'.repeat(64),
          publicKey: key,
          addedByMembershipId: ownerA.membershipId,
        }),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'ES002' }) });
  });
});
