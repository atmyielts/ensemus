// OPS-02, QA-025: the whole thing, with real dumps of all three databases, the real object store and the
// scripts an operator runs. A file deleted after the backup does not come back in row or bytes, its tenant is
// refused until the reconcile has run, the other tenant is untouched throughout, and a second run changes
// nothing.
//
// It needs the `restore-reconcile` one-shot service in compose.yaml (profile `ops`), which holds both database
// URLs, and the tools built into workers/workflow/dist/tools, which the air-gap gate builds before it starts. It
// restores over the running stack, so it runs on its own in the stack project.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import { ledgerKeyFor } from '@ensemus/domain/tombstone-ledger';
import { S3ObjectStore } from '@ensemus/storage';
import { testRecipient } from '../helpers/sovereign';
import { compose, repoRoot, secret, urls } from '../helpers/stack';

const STORE_ENDPOINT = 'http://127.0.0.1:58333';
const LEDGER_WAIT = { timeout: 90_000, interval: 250 };
const LONG = 600_000;

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
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const recipient = testRecipient();
    writeFileSync(recipientFile, recipient.publicKeyBase64);
    writeFileSync(keyFile, recipient.privateKeyPem);
    writeFileSync(accessFile, secret('objects_access_key'));
    writeFileSync(secretFile, secret('objects_secret_key'));
  });

  afterAll(async () => {
    rmSync(folder, { recursive: true, force: true });
    await app?.close();
    await auth?.end();
  });

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
        const objectStep = linesOf(restored).find(
          (line) => line.event === 'sovereign_restore.step' && line.component === 'objects',
        );
        expect(objectStep).toMatchObject({ refused_by_key: 0, left_out_as_tombstoned: 1 });
        expect(await store.exists(entryKey)).toBe(true);
        expect(await store.exists(objectKey(a.organizationId, doomed.id))).toBe(false);

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
