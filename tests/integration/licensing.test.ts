// COMM-03, SOV-02, SOV-05, QA-021, SOV-TS-02. Real roles, real SQL, real row-level security, and the operator's
// command on top of them. Generated keys only.
//
// Needs migrations 0300 and 0301 in the journal, which the final merge stitches, and a container. It has not
// run: it is written and typechecked, and counts as unverified until someone runs it.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptInvitation,
  createInvitation,
  createWorkUnit,
  getLicenseStatus,
  installSignedDocument,
  listAdvisories,
  readVerifiedLicenseFacts,
} from '@ensemus/application';
import {
  auditEvents,
  createOrganization,
  domainEvents,
  licenseRecords,
  openAppDatabase,
  resolveTenantContext,
  signedDocuments,
  TenantAccessDenied,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  generateTestSigningKey,
  signForTest,
  testLicense,
  testMaintenance,
  testTrustRoot,
  testTrustRootText,
} from '@ensemus/sovereign/testing';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { licenseCommand } from '../../workers/workflow/src/sovereign-license-command';
import { sha256Hex } from '../helpers/sovereign';
import { urls } from '../helpers/stack';

const code = (name: string) => expect.objectContaining({ code: name });

const key = generateTestSigningKey('integration-key');
/** Not marked as a test key here, so the one notice a lapse gives can be seen by itself. */
const trustRoot = testTrustRoot([{ ...key, testOnly: false }]);
const stranger = generateTestSigningKey('stranger-key');
const strangersRoot = testTrustRoot([{ ...stranger, testOnly: false }]);

const at = (day: string) => () => new Date(`${day}T12:00:00.000Z`);

const advisory = (overrides: Record<string, unknown> = {}) => ({
  format: 'ensemus.advisory',
  format_version: 1,
  advisory_id: 'TEST-ADV-1',
  issued_at: '2027-02-01T00:00:00.000Z',
  severity: 'high',
  title: 'A generated advisory',
  summary: 'Generated for a test.',
  affected_versions: ['2.0.0'],
  fixed_in_versions: ['2.0.1'],
  ...overrides,
});

const supportPolicy = {
  format: 'ensemus.support_policy',
  format_version: 1,
  policy_id: randomUUID(),
  issued_at: '2027-02-01T00:00:00.000Z',
  branches: [{ line: '2.0', status: 'supported' }],
  security_patches_after_lapse_grant: 'none',
};

/** A license and a statement with their own IDs, so no two tests share a row even in one tenant. */
function freshDocuments() {
  const licenseId = randomUUID();
  return {
    licenseId,
    license: signForTest('license', testLicense({ license_id: licenseId }), [key]),
    statement: signForTest(
      'maintenance',
      testMaintenance({ maintenance_id: randomUUID(), license_id: licenseId }),
      [key],
    ),
  };
}

describe('licensing', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  const db = () => app.db;

  async function makeUser(label: string) {
    const id = randomUUID();
    const email = `${label}-${id}@example.invalid`;
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      email,
    ]);
    return { id, email };
  }

  // Two tenants, same names, real roles.
  async function newOrg() {
    const user = await makeUser('owner');
    const { organizationId } = await createOrganization(db(), {
      userId: user.id,
      name: 'Same Name Ltd',
      commercialMode: 'sovereign',
    });
    return resolveTenantContext(db(), user.id, organizationId);
  }

  async function join_(context: TenantContext, label: string, role: 'admin' | 'member') {
    const user = await makeUser(label);
    const { token } = await createInvitation(db(), context, { email: user.email, role });
    await acceptInvitation(db(), {
      token,
      userId: user.id,
      email: user.email,
      emailVerified: true,
    });
    return resolveTenantContext(db(), user.id, context.organizationId);
  }

  const licenseRows = (context: TenantContext) =>
    withTenantTx(db(), context, (tx) =>
      tx
        .select()
        .from(licenseRecords)
        .where(eq(licenseRecords.organizationId, context.organizationId)),
    );

  const documentRows = (context: TenantContext) =>
    withTenantTx(db(), context, (tx) =>
      tx
        .select()
        .from(signedDocuments)
        .where(eq(signedDocuments.organizationId, context.organizationId)),
    );

  /** Ordinary business has to carry on, so this runs after every answer the status can give. */
  const expectWorkStillWorks = async (context: TenantContext) => {
    const work = await createWorkUnit(db(), context, { title: 'Ordinary work' });
    expect(work.id).toBeTruthy();
  };

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
  });

  afterAll(async () => {
    await app.close();
    await auth.end();
  });

  describe('QA-021 and SOV-TS-02', () => {
    it('says licensed and lapsed with one notice, and work carries on, whatever else is true', async () => {
      const owner = await newOrg();
      const { license, statement } = freshDocuments();
      await installSignedDocument(db(), owner, { envelope: license }, { trustRoot });
      await installSignedDocument(db(), owner, { envelope: statement }, { trustRoot });

      // Maintenance that ended in the past.
      await expect(
        getLicenseStatus(db(), owner, {
          trustRoot,
          runningRelease: null,
          now: at('2030-01-01'),
        }),
      ).resolves.toMatchObject({
        standing: 'licensed',
        maintenance: { status: 'lapsed', lastCoveredOn: '2027-12-31' },
        notices: ['maintenance_lapsed'],
      });
      await expectWorkStillWorks(owner);

      // Ten years on.
      await expect(
        getLicenseStatus(db(), owner, {
          trustRoot,
          runningRelease: null,
          now: at('2040-01-01'),
        }),
      ).resolves.toMatchObject({
        standing: 'licensed',
        maintenance: { status: 'lapsed' },
        notices: ['maintenance_lapsed'],
      });
      await expectWorkStillWorks(owner);

      // No trust root at all.
      await expect(
        getLicenseStatus(db(), owner, {
          trustRoot: null,
          runningRelease: null,
          now: at('2030-01-01'),
        }),
      ).resolves.toMatchObject({
        standing: 'unverifiable',
        license: null,
        notices: ['license_unverifiable'],
      });
      await expectWorkStillWorks(owner);

      // Every row failing, as when a key is removed from the trust root.
      await expect(
        getLicenseStatus(db(), owner, {
          trustRoot: strangersRoot,
          runningRelease: null,
          now: at('2030-01-01'),
        }),
      ).resolves.toMatchObject({
        standing: 'unverifiable',
        license: null,
        notices: ['license_unverifiable'],
      });
      await expectWorkStillWorks(owner);
    });

    it('takes a stopped clock as a notice, and the standing does not change', async () => {
      const owner = await newOrg();
      const { license, statement } = freshDocuments();
      await installSignedDocument(db(), owner, { envelope: license }, { trustRoot });
      await installSignedDocument(db(), owner, { envelope: statement }, { trustRoot });
      const status = await getLicenseStatus(db(), owner, {
        trustRoot,
        runningRelease: null,
        now: at('2001-01-01'),
      });
      expect(status.standing).toBe('licensed');
      expect(status.notices).toContain('clock_before_issue');
      await expectWorkStillWorks(owner);
    });

    it('counts the seats in use, and a license over them enforces nothing', async () => {
      const owner = await newOrg();
      const licenseId = randomUUID();
      const license = signForTest(
        'license',
        testLicense({
          license_id: licenseId,
          footprint: { ...testLicense().footprint, seats: 1 },
        }),
        [key],
      );
      await installSignedDocument(db(), owner, { envelope: license }, { trustRoot });
      const member = await join_(owner, 'second-seat', 'member');
      const status = await getLicenseStatus(db(), owner, {
        trustRoot,
        runningRelease: null,
        now: at('2030-01-01'),
      });
      expect(status.seatsInUse).toBe(2);
      expect(status.notices).toContain('seats_above_footprint');
      await expectWorkStillWorks(member);
    });
  });

  describe('what a read believes', () => {
    it('takes every value from a verified envelope, and none from a column', async () => {
      const owner = await newOrg();
      const realId = randomUUID();
      const envelope = signForTest(
        'license',
        testLicense({
          license_id: realId,
          term: { kind: 'pilot', review_on: '2029-01-01' },
          licensed_release: { line: '2.3', version: '2.3.4' },
        }),
        [key],
      );
      // A row whose columns all say something else, written around the verifier.
      await withTenantTx(db(), owner, (tx) =>
        tx.insert(licenseRecords).values({
          organizationId: owner.organizationId,
          licenseId: randomUUID(),
          edition: 'sovereign',
          licensedVersion: '9.9.9',
          termKind: 'perpetual',
          keyIds: ['someone-else'],
          envelope,
          envelopeSha256: sha256Hex(envelope),
          issuedAt: new Date('1999-01-01T00:00:00.000Z'),
        }),
      );
      const { license } = await getLicenseStatus(db(), owner, {
        trustRoot,
        runningRelease: null,
        now: at('2030-01-01'),
      });
      expect(license).toMatchObject({
        licenseId: realId,
        term: { kind: 'pilot', review_on: '2029-01-01' },
        licensedRelease: { version: '2.3.4' },
        issuedAt: new Date('2027-01-01T00:00:00.000Z'),
        keyIds: ['integration-key'],
      });
    });

    it('skips a forged row written directly, and the standing rests on what verifies', async () => {
      const owner = await newOrg();
      const forged = signForTest('license', testLicense({ license_id: randomUUID() }), [stranger]);
      await withTenantTx(db(), owner, (tx) =>
        tx.insert(licenseRecords).values({
          organizationId: owner.organizationId,
          licenseId: randomUUID(),
          edition: 'sovereign',
          licensedVersion: '2.0.0',
          termKind: 'perpetual',
          keyIds: [stranger.keyId],
          envelope: forged,
          envelopeSha256: sha256Hex(forged),
          issuedAt: new Date('2099-01-01T00:00:00.000Z'),
        }),
      );
      const deps = { trustRoot, runningRelease: null, now: at('2030-01-01') };
      await expect(getLicenseStatus(db(), owner, deps)).resolves.toMatchObject({
        standing: 'unverifiable',
        license: null,
      });
      await expect(
        readVerifiedLicenseFacts(db(), owner, { trustRoot }),
      ).resolves.toBeNull();

      const { license, licenseId } = freshDocuments();
      await installSignedDocument(db(), owner, { envelope: license }, { trustRoot });
      const status = await getLicenseStatus(db(), owner, deps);
      expect(status.standing).toBe('licensed');
      expect(status.license?.licenseId).toBe(licenseId);
    });

    it('takes which license a statement is for from the statement, not its column', async () => {
      const owner = await newOrg();
      const { license, licenseId } = freshDocuments();
      await installSignedDocument(db(), owner, { envelope: license }, { trustRoot });
      const forAnother = signForTest(
        'maintenance',
        testMaintenance({ maintenance_id: randomUUID(), license_id: randomUUID() }),
        [key],
      );
      await withTenantTx(db(), owner, (tx) =>
        tx.insert(signedDocuments).values({
          organizationId: owner.organizationId,
          documentType: 'maintenance',
          documentId: randomUUID(),
          subjectLicenseId: licenseId,
          keyIds: [key.keyId],
          envelope: forAnother,
          envelopeSha256: sha256Hex(forAnother),
          issuedAt: new Date('2027-01-01T00:00:00.000Z'),
        }),
      );
      const status = await getLicenseStatus(db(), owner, {
        trustRoot,
        runningRelease: null,
        now: at('2027-06-01'),
      });
      expect(status.maintenance.status).toBe('no_agreement');
    });

    it('shows a test key as one, on the view and in the notices', async () => {
      const owner = await newOrg();
      const testRoot = testTrustRoot([key]);
      const { license } = freshDocuments();
      const installed = await installSignedDocument(
        db(),
        owner,
        { envelope: license },
        { trustRoot: testRoot },
      );
      expect(installed.testKey).toBe(true);
      const status = await getLicenseStatus(db(), owner, {
        trustRoot: testRoot,
        runningRelease: null,
        now: at('2030-01-01'),
      });
      expect(status.license?.testKey).toBe(true);
      expect(status.notices).toContain('signed_with_test_key');
    });
  });

  describe('installing', () => {
    it('writes one row, its audit entry and its event, in the one transaction', async () => {
      const owner = await newOrg();
      const { license, licenseId } = freshDocuments();
      const installed = await installSignedDocument(db(), owner, { envelope: license }, { trustRoot });
      expect(installed).toMatchObject({ type: 'license', created: true, testKey: false });

      const [row] = await licenseRows(owner);
      expect(row).toMatchObject({
        id: installed.id,
        licenseId,
        envelope: license,
        envelopeSha256: sha256Hex(license),
        installedByMembershipId: owner.membershipId,
      });
      const [audit, events] = await withTenantTx(db(), owner, async (tx) => [
        await tx
          .select()
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.organizationId, owner.organizationId),
              eq(auditEvents.action, 'license.document_installed'),
            ),
          ),
        await tx
          .select()
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.organizationId, owner.organizationId),
              eq(domainEvents.eventType, 'license.document_installed'),
            ),
          ),
      ]);
      expect(audit).toHaveLength(1);
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('Test Licensee');
    });

    it('makes one row of the same bytes installed twice, with created false', async () => {
      const owner = await newOrg();
      const { license } = freshDocuments();
      const first = await installSignedDocument(db(), owner, { envelope: license }, { trustRoot });
      const second = await installSignedDocument(db(), owner, { envelope: license }, { trustRoot });
      expect(second).toEqual({ ...first, created: false });
      expect(await licenseRows(owner)).toHaveLength(1);
    });

    it('survives the same file being installed by two at once', async () => {
      const owner = await newOrg();
      const { license } = freshDocuments();
      const results = await Promise.all([
        installSignedDocument(db(), owner, { envelope: license }, { trustRoot }),
        installSignedDocument(db(), owner, { envelope: license }, { trustRoot }),
      ]);
      expect(results.filter(({ created }) => created)).toHaveLength(1);
      expect(new Set(results.map(({ id }) => id)).size).toBe(1);
      expect(await licenseRows(owner)).toHaveLength(1);
    });

    it('stores each kind where it belongs, and lists advisories newest first', async () => {
      const owner = await newOrg();
      const { license, statement } = freshDocuments();
      await installSignedDocument(db(), owner, { envelope: license }, { trustRoot });
      await expect(
        installSignedDocument(db(), owner, { envelope: statement }, { trustRoot }),
      ).resolves.toMatchObject({ type: 'maintenance' });
      await expect(
        installSignedDocument(
          db(),
          owner,
          { envelope: signForTest('support_policy', supportPolicy, [key]) },
          { trustRoot },
        ),
      ).resolves.toMatchObject({ type: 'support_policy' });
      for (const [id, issued] of [
        ['TEST-ADV-OLD', '2027-02-01T00:00:00.000Z'],
        ['TEST-ADV-NEW', '2028-02-01T00:00:00.000Z'],
      ] as const) {
        const installed = await installSignedDocument(
          db(),
          owner,
          { envelope: signForTest('advisory', advisory({ advisory_id: id, issued_at: issued }), [key]) },
          { trustRoot },
        );
        expect(installed.type).toBe('advisory');
      }
      expect((await documentRows(owner)).map((row) => row.documentType).sort()).toEqual([
        'advisory',
        'advisory',
        'maintenance',
        'support_policy',
      ]);
      const views = await listAdvisories(db(), owner, { trustRoot, runningRelease: null });
      expect(views.map(({ advisoryId }) => advisoryId)).toEqual(['TEST-ADV-NEW', 'TEST-ADV-OLD']);
    });
  });

  describe('denied', () => {
    let owner: TenantContext;
    let admin: TenantContext;
    let member: TenantContext;
    let other: TenantContext;
    let documents: ReturnType<typeof freshDocuments>;
    const readDeps = { trustRoot, runningRelease: null };

    beforeAll(async () => {
      owner = await newOrg();
      admin = await join_(owner, 'admin', 'admin');
      member = await join_(owner, 'member', 'member');
      other = await newOrg();
      documents = freshDocuments();
      await installSignedDocument(db(), owner, { envelope: documents.license }, { trustRoot });
    });

    it('gives a member FORBIDDEN on reading', async () => {
      await expect(getLicenseStatus(db(), member, readDeps)).rejects.toEqual(code('FORBIDDEN'));
      await expect(listAdvisories(db(), member, readDeps)).rejects.toEqual(code('FORBIDDEN'));
      await expectWorkStillWorks(member);
    });

    it('lets an admin read, and gives them FORBIDDEN on installing', async () => {
      await expect(getLicenseStatus(db(), admin, readDeps)).resolves.toMatchObject({
        standing: 'licensed',
      });
      const before = await documentRows(owner);
      await expect(
        installSignedDocument(db(), admin, { envelope: documents.statement }, { trustRoot }),
      ).rejects.toEqual(code('FORBIDDEN'));
      expect(await documentRows(owner)).toEqual(before);
    });

    it('gives a member FORBIDDEN on installing', async () => {
      await expect(
        installSignedDocument(db(), member, { envelope: documents.statement }, { trustRoot }),
      ).rejects.toEqual(code('FORBIDDEN'));
    });

    it('shows another tenant nothing, and lets them attach no maintenance to it', async () => {
      await expect(getLicenseStatus(db(), other, readDeps)).resolves.toMatchObject({
        standing: 'unlicensed',
        license: null,
      });
      await expect(readVerifiedLicenseFacts(db(), other, { trustRoot })).resolves.toBeNull();
      await expect(
        installSignedDocument(db(), other, { envelope: documents.statement }, { trustRoot }),
      ).rejects.toEqual(code('LICENSE_NOT_VALID'));
      expect(await documentRows(other)).toEqual([]);
      expect(await licenseRows(other)).toEqual([]);
    });

    it('finds no row of another tenant, whatever is asked, through row-level security', async () => {
      const rows = await withTenantTx(db(), other, (tx) =>
        tx
          .select()
          .from(licenseRecords)
          .where(eq(licenseRecords.organizationId, owner.organizationId)),
      );
      expect(rows).toEqual([]);
    });

    it('does not let someone outside the tenant get a context for it', async () => {
      const outsider = await makeUser('outsider');
      await expect(
        resolveTenantContext(db(), outsider.id, owner.organizationId),
      ).rejects.toBeInstanceOf(TenantAccessDenied);
    });

    it('refuses a forged envelope and stores nothing', async () => {
      const envelope = JSON.parse(documents.license) as Record<string, unknown>;
      const forged = JSON.stringify({
        ...envelope,
        payload: Buffer.from(
          JSON.stringify(testLicense({ license_id: randomUUID(), components: ['more'] })),
        ).toString('base64'),
      });
      const before = await licenseRows(owner);
      await expect(
        installSignedDocument(db(), owner, { envelope: forged }, { trustRoot }),
      ).rejects.toEqual(code('LICENSE_NOT_VALID'));
      await expect(
        installSignedDocument(
          db(),
          owner,
          { envelope: signForTest('license', testLicense(), [stranger]) },
          { trustRoot },
        ),
      ).rejects.toEqual(code('LICENSE_NOT_VALID'));
      expect(await licenseRows(owner)).toEqual(before);
    });

    it('refuses a wrong kind, and a statement relabelled as a license', async () => {
      await expect(
        installSignedDocument(
          db(),
          owner,
          { envelope: signForTest('bundle', {}, [key]) },
          { trustRoot },
        ),
      ).rejects.toEqual(code('LICENSE_NOT_VALID'));
      const statement = JSON.parse(documents.statement) as Record<string, unknown>;
      await expect(
        installSignedDocument(
          db(),
          owner,
          {
            envelope: JSON.stringify({
              ...statement,
              payloadType: 'application/vnd.ensemus.license+json',
            }),
          },
          { trustRoot },
        ),
      ).rejects.toEqual(code('LICENSE_NOT_VALID'));
    });

    it('refuses a maintenance statement for a license not installed here, storing nothing', async () => {
      const elsewhere = freshDocuments();
      const before = await documentRows(owner);
      await expect(
        installSignedDocument(db(), owner, { envelope: elsewhere.statement }, { trustRoot }),
      ).rejects.toEqual(code('LICENSE_NOT_VALID'));
      expect(await documentRows(owner)).toEqual(before);
    });
  });

  describe('the operator command', () => {
    const folder = mkdtempSync(join(tmpdir(), 'sovereign-license-'));
    const fileWith = (text: string) => {
      const path = join(folder, `${randomUUID()}.json`);
      writeFileSync(path, text);
      return path;
    };
    const env = () => ({
      ENSEMUS_LICENSE_TRUST_ROOT_FILE: fileWith(
        testTrustRootText([{ ...key, testOnly: false }]),
      ),
    });
    afterAll(() => rmSync(folder, { recursive: true, force: true }));

    async function run(args: string[], commandEnv: NodeJS.ProcessEnv) {
      const lines: string[] = [];
      const exit = await licenseCommand(args, {
        env: commandEnv,
        now: at('2030-01-01'),
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
        // The command closes what it opens, so this gets its own pool.
        openDatabase: () => {
          const { db: opened, close } = openAppDatabase(urls.app());
          return { db: opened, close };
        },
      });
      return { exit, said: lines.join('\n'), result: JSON.parse(lines[0] ?? 'null') };
    }

    it('installs as a service, records no person, and prints the standing', async () => {
      const owner = await newOrg();
      const { license, licenseId, statement } = freshDocuments();
      const commandEnv = env();
      const first = await run(
        ['install', '--organization', owner.organizationId, fileWith(license)],
        commandEnv,
      );
      expect(first.exit).toBe(0);
      expect(first.result).toMatchObject({
        created: true,
        documentId: licenseId,
        standing: 'licensed',
        maintenance: 'no_agreement',
        notices: ['no_maintenance'],
      });
      expect(first.said).not.toContain('Test Licensee');
      expect((await licenseRows(owner))[0]?.installedByMembershipId).toBeNull();

      const again = await run(
        ['install', '--organization', owner.organizationId, fileWith(license)],
        commandEnv,
      );
      expect(again.exit).toBe(0);
      expect(again.result.created).toBe(false);

      const lapsed = await run(
        ['install', '--organization', owner.organizationId, fileWith(statement)],
        commandEnv,
      );
      expect(lapsed.exit).toBe(0);
      expect(lapsed.result).toMatchObject({
        maintenance: 'lapsed',
        notices: ['maintenance_lapsed'],
      });
    });

    it('exits 1 for a maintenance statement for a license not here, and stores nothing', async () => {
      const owner = await newOrg();
      const { statement } = freshDocuments();
      const { exit, result } = await run(
        ['install', '--organization', owner.organizationId, fileWith(statement)],
        env(),
      );
      expect(exit).toBe(1);
      expect(result.reasonCode).toBe('LICENSE_NOT_VALID');
      expect(await documentRows(owner)).toEqual([]);
    });

    it('confines a service context to the organization it was made for', async () => {
      const [owner, other] = [await newOrg(), await newOrg()];
      const { license } = freshDocuments();
      await installSignedDocument(
        db(),
        createServiceContext(owner.organizationId),
        { envelope: license },
        { trustRoot },
      );
      expect(await licenseRows(other)).toEqual([]);
      expect(await licenseRows(owner)).toHaveLength(1);
    });
  });
});
