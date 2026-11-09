// OPS-02, QA-025: the whole thing, with real dumps of all three databases, the real object store and the
// scripts an operator runs. A file deleted after the backup does not come back in row or bytes, its tenant is
// refused until the reconcile has run, the other tenant is untouched throughout, and a second run changes
// nothing.
//
// It needs the `restore-reconcile` one-shot service in compose.yaml (profile `ops`), which holds both database
// URLs, and the tools built into workers/workflow/dist/tools, which the air-gap gate builds before it starts. It
// restores over the running stack, so it runs on its own in the stack project.
//
// The restore leaves authentication fenced (0422): every runtime role is refused until an operator inspects
// the restored authority, records an external review and acknowledges it, which 0422 allows no sooner than 15
// minutes after begin. The drill does each of those steps itself, with the real migrator login and the real
// cooldown, before it asks the tenant anything, as backup-and-restore.md tells an operator to.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addArtifact,
  countUnappliedTombstones,
  createWorkUnit,
  deleteArtifact,
  objectKey,
  readArtifact,
} from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  type TenantContext,
} from '@ensemus/database';
import {
  acknowledgeAuthenticationRestore,
  inspectAuthenticationRestore,
} from '@ensemus/database/auth-restore-operator';
import { ledgerKeyFor } from '@ensemus/domain/tombstone-ledger';
import { S3ObjectStore } from '@ensemus/storage';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { testRecipient } from '../helpers/sovereign';
import { compose, dbUrl, repoRoot, secret, urls } from '../helpers/stack';

const STORE_ENDPOINT = 'http://127.0.0.1:58333';
const LEDGER_WAIT = { timeout: 90_000, interval: 250 };
const LONG = 600_000;
/** The whole drill: a backup, a restore, 0422's fixed 15-minute cooldown before admission, and the reconcile. */
const DRILL = 40 * 60_000;

const scripts = join(repoRoot, 'infrastructure', 'scripts');
const tools = join(repoRoot, 'workers', 'workflow', 'dist', 'tools');

/**
 * The stack these scripts restore over: the project it runs as, and the files it was started with, the same
 * ones tests/helpers/stack.ts uses. Compose names a project after the first file's folder unless
 * COMPOSE_PROJECT_NAME says otherwise, and the gates set it, so a fixed `compose` named a project that was not
 * running: nothing was stopped, and pg_restore found no PostgreSQL (RESTORE_FAILED_ensemus).
 */
const PROJECT = process.env.COMPOSE_PROJECT_NAME ?? 'compose';
const COMPOSE_FILES = [
  'infrastructure/compose/compose.yaml',
  'infrastructure/compose/compose.test.yaml',
  ...(process.env.ENSEMUS_COMPOSE_AIRGAP ? ['infrastructure/compose/compose.airgap.yaml'] : []),
];
const composeFileArguments = COMPOSE_FILES.flatMap((file) => ['--compose-file', file]);

function linesOf(output: string) {
  return output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('a backup, a deletion, and a restore', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  // This suite's own connections are readers like any other. 0422's identity.begin_auth_restore
  // refuses while any runtime role is connected (AUTH_RESTORE_READERS_STILL_CONNECTED), so they are
  // closed across the restore, as an operator's are, and the app pool is opened again afterwards.
  let appOpen = false;
  let authOpen = false;
  const folder = mkdtempSync(join(tmpdir(), 'restore-drill-'));
  const backup = join(folder, 'backup');
  const accessFile = join(folder, 'access');
  const secretFile = join(folder, 'secret');
  const recipientFile = join(folder, 'recipient.pub');
  const keyFile = join(folder, 'recipient.key');
  const store = new S3ObjectStore({
    endpoint: STORE_ENDPOINT,
    bucket: 'ensemus',
    accessKey: secret('objects_access_key'),
    secretKey: secret('objects_secret_key'),
  });
  const db = () => app.db;

  const objectArguments = [
    '--object-endpoint',
    STORE_ENDPOINT,
    '--object-access-key-file',
    accessFile,
    '--object-secret-key-file',
    secretFile,
  ];

  beforeAll(async () => {
    if (!existsSync(join(tools, 'seal-parts.mjs'))) {
      throw new Error('Build the tools first: workers/workflow/scripts/build-sovereign-tools.mjs');
    }
    app = openAppDatabase(urls.app());
    appOpen = true;
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    authOpen = true;
    const recipient = testRecipient();
    writeFileSync(recipientFile, recipient.publicKeyBase64);
    writeFileSync(keyFile, recipient.privateKeyPem);
    writeFileSync(accessFile, secret('objects_access_key'));
    writeFileSync(secretFile, secret('objects_secret_key'));
  });

  afterAll(async () => {
    rmSync(folder, { recursive: true, force: true });
    if (appOpen) await app.close();
    if (authOpen) await auth.end();
  });

  /** Closes this suite's own database sessions, so that nothing it holds is connected to a restore. */
  async function disconnect() {
    if (appOpen) {
      appOpen = false;
      await app.close();
    }
    if (authOpen) {
      authOpen = false;
      await auth.end();
    }
  }

  async function newOrg(): Promise<TenantContext> {
    const id = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      'owner',
      `owner-${id}@example.invalid`,
    ]);
    const { organizationId } = await createOrganization(db(), {
      userId: id,
      name: 'Same Name Ltd',
      commercialMode: 'sovereign',
    });
    return resolveTenantContext(db(), id, organizationId);
  }

  const reconcile = (...args: string[]) => {
    const result = spawnSync(
      'docker',
      [
        'compose',
        '-p',
        PROJECT,
        ...COMPOSE_FILES.flatMap((file) => ['-f', file]),
        'run',
        '--rm',
        '--no-deps',
        'restore-reconcile',
        'node',
        'dist/restore-reconcile.js',
        ...args,
      ],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return { status: result.status, lines: linesOf(result.stdout) };
  };

  const ledgerCounts = (lines: Record<string, unknown>[]) =>
    lines.find((line) => line.event === 'restore_reconcile.ledger');

  /** As the test superuser, which every restore step leaves alone. */
  async function asSuperuser<T>(database: string, use: (client: pg.Client) => Promise<T>) {
    const client = new pg.Client({
      connectionString: dbUrl('postgres', 'db_superuser_password', database),
    });
    await client.connect();
    try {
      return await use(client);
    } finally {
      await client.end();
    }
  }

  /**
   * An active verified SSO connection with automatic joining and a live SCIM bearer on it: authority a backup
   * can bring back, which 0422 begin must revoke as it closes admission (0546). No production path issues
   * them without a person's interactive MFA proof, so the generated fixture writes them as the superuser,
   * bound to the tenant so every SSO trigger still checks them.
   */
  const activeScimBearer = (context: TenantContext) =>
    asSuperuser('ensemus', (su) =>
      inFixtureTenant(su, context.organizationId, async () => {
        const connection = await su.query<{ id: string }>(
          `insert into org.sso_connections(organization_id,provider_id,display_name,domain,domain_state,
            domain_verified_at,state,auto_join,created_by_membership_id)
           values($1,$2,'Generated provider',$3,'verified',now(),'active',true,$4) returning id`,
          [
            context.organizationId,
            `generated-${randomUUID()}`,
            `restore-${randomUUID()}.example.invalid`,
            context.membershipId,
          ],
        );
        const token = await su.query<{ id: string }>(
          `insert into org.scim_tokens(organization_id,connection_id,token_hash,created_by_membership_id)
           values($1,$2,$3,$4) returning id`,
          [
            context.organizationId,
            connection.rows[0]!.id,
            createHash('sha256').update(randomUUID()).digest('hex'),
            context.membershipId,
          ],
        );
        return token.rows[0]!.id;
      }),
    );

  const scimState = (organizationId: string, tokenId: string) =>
    asSuperuser('ensemus', async (su) => {
      const rows = await su.query<{ state: string; revoked: boolean }>(
        'select state, revoked_at is not null as revoked from org.scim_tokens where organization_id=$1 and id=$2',
        [organizationId, tokenId],
      );
      return rows.rows;
    });

  /**
   * What an operator does after the restore and before anyone is served: inspect the restored authority,
   * record a review of it, wait out 0422's cooldown and acknowledge. Each step is the real migrator helper.
   */
  async function admitAfterReview(generation: string, manifestSha256: string) {
    const inspection = await inspectAuthenticationRestore(urls.migrator(), generation);
    expect(inspection).toMatchObject({ generation, manifestSha256, phase: 'invalidated' });
    // The cooldown is 0422's and is not shortened: it is the time a stopped process gets to notice.
    const wait = Date.parse(inspection.notBefore) - Date.now() + 5_000;
    if (wait > 0) await new Promise((done) => setTimeout(done, wait));
    const review = Buffer.from(
      JSON.stringify({
        version: 1,
        generation,
        backupId: inspection.backupId,
        manifestSha256,
        securitySha256: inspection.securitySha256,
        reviewer: 'Generated restore drill operator',
        reviewedAt: new Date().toISOString(),
        authorityEvidence: 'Generated drill: the restored authority was inspected in this run.',
        inFlightEffectsEvidence:
          'Generated drill: every reader and worker stayed stopped throughout.',
      }),
    );
    expect(
      await acknowledgeAuthenticationRestore(urls.migrator(), {
        generation,
        manifestSha256,
        securitySha256: inspection.securitySha256,
        review,
      }),
    ).toBe(generation);
    return inspection;
  }

  /** Every table each restored database holds, by OID. A restore drops and recreates them all. */
  const tablesOf = (database: string) =>
    asSuperuser(database, async (su) => {
      const rows = await su.query<{ tables: string | null }>(
        `select string_agg(n.nspname||'.'||c.relname||'#'||c.oid::text, ',' order by c.oid) as tables
         from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema')
           and n.nspname not like 'pg_toast%'`,
      );
      return rows.rows[0]?.tables ?? '';
    });
  const restoredDatabases = ['ensemus', 'temporal', 'temporal_visibility'];

  it(
    'keeps it deleted, serves the tenant again, and leaves the other one alone',
    async () => {
      // Two tenants with the same names, each with a file called the same.
      const [a, b] = [await newOrg(), await newOrg()];
      const workA = await createWorkUnit(db(), a, { title: 'Same title' });
      const workB = await createWorkUnit(db(), b, { title: 'Same title' });
      const addTo = (context: TenantContext, workUnitId: string, name: string) =>
        addArtifact(db(), store, context, {
          workUnitId,
          name,
          mimeType: 'text/plain',
          body: Buffer.from(`bytes of ${name}`),
        });
      const doomed = await addTo(a, workA.id, 'same-name.txt');
      const kept = await addTo(a, workA.id, 'kept.txt');
      const other = await addTo(b, workB.id, 'same-name.txt');
      // Authority the backup holds and the restore must not hand back.
      const bearer = await activeScimBearer(a);
      expect(await scimState(a.organizationId, bearer)).toEqual([
        { state: 'active', revoked: false },
      ]);

      // The backup. The script itself refuses to go on if the ledger backlog has not drained.
      const backedUp = execFileSync(
        process.execPath,
        [
          join(scripts, 'sovereign-backup.mjs'),
          '--out',
          backup,
          '--recipient',
          recipientFile,
          '--release',
          'test',
          '--schema-version',
          'test',
          ...objectArguments,
          '--project',
          PROJECT,
          ...composeFileArguments,
        ],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      const finished = linesOf(backedUp).find((line) => line.event === 'sovereign_backup.finished');
      expect(finished).toMatchObject({ excludes_tombstone_ledger: true });

      // The deletion, after the backup, and its ledger entry written by the dispatcher.
      await deleteArtifact(db(), store, a, { workUnitId: workA.id, artifactId: doomed.id });
      const entryKey = ledgerKeyFor({
        organizationId: a.organizationId,
        targetType: 'artifact',
        targetId: doomed.id,
      });
      await vi.waitFor(async () => {
        expect(await store.exists(entryKey)).toBe(true);
      }, LEDGER_WAIT);

      // The restore stops the whole stack and leaves it stopped, as the runbook says, so whatever happens
      // below, the stack is started again for the suites after this one.
      await disconnect();
      try {
        // The restore, with no reconcile yet. The ledger survives it, and the bytes do not come back.
        const restored = execFileSync(
          process.execPath,
          [
            join(scripts, 'sovereign-restore.mjs'),
            '--backup',
            backup,
            '--key',
            keyFile,
            '--project',
            PROJECT,
            '--replace-databases-of',
            PROJECT,
            ...objectArguments,
            ...composeFileArguments,
          ],
          { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        );
        const restoreLines = linesOf(restored);
        const objectStep = restoreLines.find(
          (line) => line.event === 'sovereign_restore.step' && line.component === 'objects',
        );
        expect(objectStep).toMatchObject({ refused_by_key: 0, left_out_as_tombstoned: 1 });
        expect(await store.exists(entryKey)).toBe(true);
        expect(await store.exists(objectKey(a.organizationId, doomed.id))).toBe(false);

        // Authentication is fenced, and begin revoked the bearer the backup held (0422, 0546).
        const finishedRestore = restoreLines.find(
          (line) => line.event === 'sovereign_restore.finished',
        );
        expect(finishedRestore).toMatchObject({
          next: 'INSPECT_RECONCILE_REVIEW_ACKNOWLEDGE_AUTHORITY_THEN_RECONCILE_MATERIAL',
          readers_and_workers: 'STAY_STOPPED_NO_AUTOMATIC_RESUME',
        });
        expect(await scimState(a.organizationId, bearer)).toEqual([
          { state: 'revoked', revoked: true },
        ]);
        const inspection = await admitAfterReview(
          String(finishedRestore!.auth_restore_generation),
          String(finishedRestore!.manifest_sealed_sha256),
        );
        const reviewedBearer = (
          inspection.security.scimTokens as { organizationId: string; id: string; state: string }[]
        ).find((token) => token.id === bearer);
        expect(reviewedBearer).toMatchObject({
          organizationId: a.organizationId,
          state: 'revoked',
        });

        app = openAppDatabase(urls.app());
        appOpen = true;
        compose('up', '-d', '--wait', '--no-deps', 'temporal');

        // Skipping the re-apply: the row is back, and the gate's own count refuses the tenant. The other is clear.
        expect(await countUnappliedTombstones(db(), store, a)).toBe(1);
        expect(await countUnappliedTombstones(db(), store, b)).toBe(0);

        // A report changes nothing.
        const report = reconcile();
        expect(report.status).toBe(1);
        expect(ledgerCounts(report.lines)).toMatchObject({
          tombstonesAdded: 1,
          artifactsRemoved: 1,
        });
        expect(await countUnappliedTombstones(db(), store, a)).toBe(1);

        // Applying puts it right. Gone in row and bytes, the tenant served, and what it kept is still there.
        const applied = reconcile('--apply');
        expect(ledgerCounts(applied.lines)).toMatchObject({
          tombstonesAdded: 1,
          artifactsRemoved: 1,
        });
        expect(await countUnappliedTombstones(db(), store, a)).toBe(0);
        await expect(
          readArtifact(db(), store, a, { workUnitId: workA.id, artifactId: doomed.id }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(await store.exists(objectKey(a.organizationId, doomed.id))).toBe(false);
        expect(
          (await readArtifact(db(), store, a, { workUnitId: workA.id, artifactId: kept.id })).name,
        ).toBe('kept.txt');
        expect(
          (await readArtifact(db(), store, b, { workUnitId: workB.id, artifactId: other.id })).name,
        ).toBe('same-name.txt');

        // A second run changes nothing.
        const second = reconcile('--apply');
        expect(ledgerCounts(second.lines)).toMatchObject({
          tombstonesAdded: 0,
          artifactsRemoved: 0,
          bytesRemoved: 0,
        });
      } finally {
        compose('up', '-d', '--wait');
      }
    },
    DRILL,
  );

  it(
    'stops before it replaces any database while a runtime role is still connected',
    async () => {
      // The backup the drill above took. A session held from outside the project is exactly what stopping
      // every service cannot end, so the restore asks PostgreSQL who is connected before it replaces anything.
      expect(existsSync(backup), 'the drill above took no backup').toBe(true);
      const reader = new pg.Client({ connectionString: urls.app() });
      await reader.connect();
      try {
        expect((await reader.query('select current_user as role')).rows).toEqual([
          { role: 'ensemus_app' },
        ]);
        const before = await Promise.all(restoredDatabases.map(tablesOf));
        expect(before.every((tables) => tables.length > 0)).toBe(true);
        const refused = spawnSync(
          process.execPath,
          [
            join(scripts, 'sovereign-restore.mjs'),
            '--backup',
            backup,
            '--key',
            keyFile,
            '--project',
            PROJECT,
            '--replace-databases-of',
            PROJECT,
            ...objectArguments,
            ...composeFileArguments,
          ],
          { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        );
        expect(refused.status).not.toBe(0);
        expect(refused.stderr).toContain('Refused: RESTORE_READERS_STILL_CONNECTED');
        const lines = linesOf(refused.stdout);
        // It verified the backup and stopped the services first, then refused...
        expect(lines.map((line) => line.event)).toEqual([
          'sovereign_restore.verified',
          'sovereign_restore.stopped',
          'sovereign_restore.readers_still_connected',
        ]);
        // ...naming this reader by its role and count only...
        expect(
          lines.find((line) => line.event === 'sovereign_restore.readers_still_connected'),
        ).toMatchObject({
          readers: expect.arrayContaining([
            { role: 'ensemus_app', sessions: expect.any(Number) as number },
          ]),
        });
        // ...and replaced none of the three databases: every table is the same one it was.
        expect(await Promise.all(restoredDatabases.map(tablesOf))).toEqual(before);
        // The reader it named is still connected, to the same database.
        expect((await reader.query('select 1 as alive')).rows).toEqual([{ alive: 1 }]);
      } finally {
        await reader.end();
        compose('up', '-d', '--wait');
      }
    },
    LONG,
  );

  it('refuses a damaged backup before it has touched anything', () => {
    const result = spawnSync(
      process.execPath,
      [
        join(scripts, 'sovereign-restore.mjs'),
        '--backup',
        join(folder, 'not-a-backup'),
        '--key',
        keyFile,
        '--project',
        PROJECT,
        '--replace-databases-of',
        PROJECT,
        ...objectArguments,
        ...composeFileArguments,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(linesOf(result.stdout).some((line) => line.event === 'sovereign_restore.stopped')).toBe(
      false,
    );
  });

  it('asks who ran the drill and does not fill it in', () => {
    const result = spawnSync(
      process.execPath,
      [
        join(scripts, 'restore-drill.mjs'),
        '--project',
        'not-the-right-name',
        '--wipe-project',
        'not-the-right-name',
        '--backup',
        backup,
        '--key',
        keyFile,
        '--record',
        join(folder, 'record.md'),
        ...objectArguments,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    // It stops at the project's name, before asking, because it would wipe that project.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('PROJECT_NAME_DOES_NOT_SAY_DRILL');
  });
});
