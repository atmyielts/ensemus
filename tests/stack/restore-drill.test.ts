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
// the restored authority, applies what an external review says to revoke, records that review and acknowledges
// it, which 0422 allows no sooner than 15 minutes after begin. The drill takes each of those steps itself, in
// backup-and-restore.md's order and with its commands: auth-restore.js in the `migrate` one-shot (the migrator
// login), a private review folder mounted at /review, and nothing but IDs and hashes on the command line. It
// shows the reconcile refused before the acknowledgment, waits out the real cooldown, and only then reconciles.
// infrastructure/scripts/restore-drill.mjs runs the same sequence for an operator.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import type { AuthRestoreInspection } from '@ensemus/database/auth-restore-operator';
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
        return { connectionId: connection.rows[0]!.id, tokenId: token.rows[0]!.id };
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
   * backup-and-restore.md's private review folder, mounted at /review in the migrator's one-shot. The one-shot
   * runs as this test's own user, so it can write into a folder only that user can open.
   */
  const reviewFolder = join(folder, 'review');
  const operator =
    typeof process.getuid === 'function' && typeof process.getgid === 'function'
      ? ['--user', `${process.getuid()}:${process.getgid()}`]
      : [];

  /**
   * One step of the authority review exactly as an operator runs it: auth-restore.js in the `migrate` one-shot,
   * whose only database login is ensemus_migrator. IDs and hashes go on the command line; every body is a file
   * in the review folder, which only inspect may write to.
   */
  const authority = (writable: boolean, ...args: string[]) => {
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
        ...operator,
        '--volume',
        `${reviewFolder}:/review${writable ? '' : ':ro'}`,
        'migrate',
        'node',
        'dist/auth-restore.js',
        ...args,
      ],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return {
      status: result.status,
      lines: linesOf(result.stdout),
      // auth-restore.js writes its refusal as a bare code on a line of its own.
      refusals: result.stderr.split('\n').map((line) => line.trim()),
    };
  };

  const only = (lines: Record<string, unknown>[], event: string) => {
    const found = lines.filter((line) => line.event === event);
    expect(found, event).toHaveLength(1);
    return found[0]!;
  };

  /** A snapshot inspect wrote, with the hash of its bytes. */
  const snapshot = (name: string) => {
    const bytes = readFileSync(join(reviewFolder, name));
    return {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      body: JSON.parse(bytes.toString('utf8')) as AuthRestoreInspection,
    };
  };

  type ReviewedRow = { organizationId: string; id: string; state: string; autoJoin?: boolean };
  const reviewedRows = (inspection: AuthRestoreInspection, kind: 'scimTokens' | 'connections') =>
    inspection.security[kind] as ReviewedRow[];

  /** The review declaration with exactly 0422's nine fields, for the snapshot it reviewed. */
  const writeReview = (name: string, inspection: AuthRestoreInspection) => {
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        generation: inspection.generation,
        backupId: inspection.backupId,
        manifestSha256: inspection.manifestSha256,
        securitySha256: inspection.securitySha256,
        reviewer: 'Generated restore drill operator',
        reviewedAt: new Date().toISOString(),
        authorityEvidence: 'Generated drill: the restored authority was inspected in this run.',
        inFlightEffectsEvidence:
          'Generated drill: every reader and worker stayed stopped throughout.',
      }),
    );
    writeFileSync(join(reviewFolder, name), bytes, { flag: 'wx', mode: 0o600 });
    return bytes;
  };

  /** The roles backup-and-restore.md names as unable to acknowledge, and the one login that can. */
  const ACKNOWLEDGE = 'identity.acknowledge_auth_restore(uuid,uuid,text,text,text,integer)';
  const ACKNOWLEDGE_CALL =
    'select identity.acknowledge_auth_restore($1::uuid,$2::uuid,$3,$4,$5,$6) as generation';
  const NOT_ACKNOWLEDGING = [
    'ensemus_agent',
    'ensemus_app',
    'ensemus_auth',
    'ensemus_eraser',
    'ensemus_secrets',
    'ensemus_support',
  ];

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
      expect(await scimState(a.organizationId, bearer.tokenId)).toEqual([
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
        expect(await scimState(a.organizationId, bearer.tokenId)).toEqual([
          { state: 'revoked', revoked: true },
        ]);
        const generation = String(finishedRestore!.auth_restore_generation);
        const manifestSha256 = String(finishedRestore!.manifest_sealed_sha256);

        // The operator's sequence from backup-and-restore.md, in order, through the real one-shot.
        mkdirSync(reviewFolder, { mode: 0o700 });

        // 1. Inspect writes a new file and prints hashes, phase and IDs only.
        const inspected = authority(
          true,
          'inspect',
          '--generation',
          generation,
          '--out',
          '/review/snapshot-1.json',
        );
        expect(inspected.status, inspected.refusals.join('\n')).toBe(0);
        const firstPrinted = only(inspected.lines, 'auth_restore.inspected');
        expect(Object.keys(firstPrinted).sort()).toEqual([
          'event',
          'generation',
          'phase',
          'security_sha256',
          'snapshot_sha256',
        ]);
        const first = snapshot('snapshot-1.json');
        expect(firstPrinted).toEqual({
          event: 'auth_restore.inspected',
          generation,
          phase: 'invalidated',
          security_sha256: first.body.securitySha256,
          snapshot_sha256: first.sha256,
        });
        expect(first.body).toMatchObject({
          generation,
          backupId: finishedRestore!.backup_id,
          manifestSha256,
          phase: 'invalidated',
        });
        // Begin revoked the bearer (0422, 0546). The provider it was issued on is still active, for the review.
        expect(
          reviewedRows(first.body, 'scimTokens').find((token) => token.id === bearer.tokenId),
        ).toMatchObject({ organizationId: a.organizationId, state: 'revoked' });
        expect(
          reviewedRows(first.body, 'connections').find((row) => row.id === bearer.connectionId),
        ).toMatchObject({ organizationId: a.organizationId, state: 'active', autoJoin: true });
        // Inspect never overwrites a review already written.
        const overwrite = authority(
          true,
          'inspect',
          '--generation',
          generation,
          '--out',
          '/review/snapshot-1.json',
        );
        expect(overwrite.status).not.toBe(0);
        expect(snapshot('snapshot-1.json').sha256).toBe(first.sha256);

        // 2. The external-authority review found the provider must go. A stale snapshot hash rolls back...
        writeFileSync(
          join(reviewFolder, 'revocations.json'),
          JSON.stringify([
            { kind: 'disable_provider', organizationId: a.organizationId, id: bearer.connectionId },
          ]),
          { flag: 'wx', mode: 0o600 },
        );
        const revoke = (securitySha256: string) =>
          authority(
            false,
            'reconcile',
            '--generation',
            generation,
            '--snapshot',
            securitySha256,
            '--actions',
            '/review/revocations.json',
          );
        const stale = revoke('0'.repeat(64));
        expect(stale.status).not.toBe(0);
        expect(stale.refusals).toContain('AUTH_RESTORE_REVIEW_CHANGED');
        // ...and the current one applies it, one row, changing the fingerprint.
        const revoked = revoke(first.body.securitySha256);
        expect(revoked.status, revoked.refusals.join('\n')).toBe(0);
        const reconciled = only(revoked.lines, 'auth_restore.reconciled');
        expect(reconciled).toMatchObject({ generation, changed: 1 });
        expect(reconciled.security_sha256).not.toBe(first.body.securitySha256);

        // Any change makes the first snapshot stale, so it is inspected again and that is what is reviewed.
        const reinspected = authority(
          true,
          'inspect',
          '--generation',
          generation,
          '--out',
          '/review/snapshot-2.json',
        );
        expect(reinspected.status, reinspected.refusals.join('\n')).toBe(0);
        const reviewed = snapshot('snapshot-2.json');
        expect(only(reinspected.lines, 'auth_restore.inspected')).toMatchObject({
          generation,
          security_sha256: reconciled.security_sha256,
          snapshot_sha256: reviewed.sha256,
        });
        expect(reviewed.body.securitySha256).toBe(reconciled.security_sha256);
        expect(
          reviewedRows(reviewed.body, 'connections').find((row) => row.id === bearer.connectionId),
        ).toMatchObject({ state: 'disabled', autoJoin: false });

        // 3. The bounded review declaration, for the snapshot reviewed, and one for the stale snapshot.
        const review = writeReview('review.json', reviewed.body);
        writeReview('review-stale.json', first.body);

        // Before the acknowledgment the reconcile is refused by 0422's fence, report and apply alike.
        for (const refused of [reconcile(), reconcile('--apply')]) {
          expect(refused.status).toBe(1);
          expect(
            refused.lines.find((line) => line.event === 'restore_reconcile.failed'),
          ).toMatchObject({ errorCode: 'RESTORE_PENDING' });
          expect(ledgerCounts(refused.lines)).toBeUndefined();
          expect(
            refused.lines.find((line) => line.event === 'restore_reconcile.finished'),
          ).toBeUndefined();
        }

        // 4. Only the migrator's own login can acknowledge. Each runtime login is refused the function...
        for (const url of [urls.app(), urls.auth(), urls.agent(), urls.secrets()]) {
          const runtime = new pg.Client({ connectionString: url });
          await runtime.connect();
          try {
            await expect(
              runtime.query(ACKNOWLEDGE_CALL, [
                generation,
                reviewed.body.backupId,
                manifestSha256,
                reviewed.body.securitySha256,
                createHash('sha256').update(review).digest('hex'),
                review.byteLength,
              ]),
            ).rejects.toMatchObject({ code: '42501' });
          } finally {
            await runtime.end();
          }
        }
        // ...and no runtime role, the NOLOGIN support and eraser ones included, holds it.
        expect(
          await asSuperuser('ensemus', async (su) => {
            const rows = await su.query<{ role: string; allowed: boolean }>(
              `select rolname as role, has_function_privilege(rolname,$1,'EXECUTE') as allowed
               from pg_roles where rolname = any($2) order by rolname`,
              [ACKNOWLEDGE, [...NOT_ACKNOWLEDGING, 'ensemus_migrator']],
            );
            return rows.rows;
          }),
        ).toEqual(
          [...NOT_ACKNOWLEDGING, 'ensemus_migrator']
            .sort()
            .map((role) => ({ role, allowed: role === 'ensemus_migrator' })),
        );

        const acknowledge = (securitySha256: string, reviewFile: string) =>
          authority(
            false,
            'acknowledge',
            '--generation',
            generation,
            '--manifest',
            manifestSha256,
            '--snapshot',
            securitySha256,
            '--review',
            `/review/${reviewFile}`,
          );
        // The stale snapshot is refused, whatever the time...
        const staleAcknowledgment = acknowledge(first.body.securitySha256, 'review-stale.json');
        expect(staleAcknowledgment.status).not.toBe(0);
        expect(staleAcknowledgment.refusals).toContain('AUTH_RESTORE_REVIEW_CHANGED');
        // ...and the current one is refused until 0422's fixed cooldown has passed.
        expect(Date.now() + 60_000).toBeLessThan(Date.parse(reviewed.body.notBefore));
        const early = acknowledge(reviewed.body.securitySha256, 'review.json');
        expect(early.status).not.toBe(0);
        expect(early.refusals).toContain('AUTH_RESTORE_COOLDOWN_REQUIRED');

        // The cooldown is 0422's and is not shortened: it is the time a stopped process gets to notice.
        const wait = Date.parse(reviewed.body.notBefore) - Date.now() + 5_000;
        if (wait > 0) await new Promise((done) => setTimeout(done, wait));
        const acknowledged = acknowledge(reviewed.body.securitySha256, 'review.json');
        expect(acknowledged.status, acknowledged.refusals.join('\n')).toBe(0);
        expect(only(acknowledged.lines, 'auth_restore.admitted')).toEqual({
          event: 'auth_restore.admitted',
          generation,
          review_sha256: createHash('sha256').update(review).digest('hex'),
          review_bytes: review.byteLength,
        });

        // 5. Only now the reconcile, with Temporal first.
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
        '--review-directory',
        join(folder, 'drill-review'),
        ...objectArguments,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    // It stops at the project's name, before asking, because it would wipe that project.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('PROJECT_NAME_DOES_NOT_SAY_DRILL');
  });
});
