// OPS-02 for Cloud: scheduled base backups, WAL archiving and a point-in-time drill on a real server, through
// compose.backup.yaml. tests/unit/pg-backup-*.test.ts cover the scripts' choices without Docker.
//
// Skipped unless ENSEMUS_TEST_BACKUP_OVERLAY=1, because it needs the stack started with the overlay as well:
//   docker compose -f compose.yaml -f compose.test.yaml -f compose.backup.yaml up -d --build --wait
// with the overlay's settings in the environment (any values: these are tests, not a retention decision), the
// objects_backup_* secrets and an identity in
// objects_identity.json for the backup bucket, and the bucket made (11-postgres-backup-and-pitr.md). The worker
// image must be built, for the reconcile report. It writes a probe table on the test server and removes it.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot, urls } from '../helpers/stack';

const enabled = process.env.ENSEMUS_TEST_BACKUP_OVERLAY === '1';
const FILES = [
  'infrastructure/compose/compose.yaml',
  'infrastructure/compose/compose.test.yaml',
  'infrastructure/compose/compose.backup.yaml',
];

function compose(env: Record<string, string>, ...args: string[]) {
  return execFileSync('docker', ['compose', ...FILES.flatMap((file) => ['-f', file]), ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const secondAfter = (date: Date) => new Date(Math.ceil(date.getTime() / 1000) * 1000 + 1000);
const isoSecond = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

describe.skipIf(!enabled)(
  'PostgreSQL backups and point-in-time recovery',
  { timeout: 900_000 },
  () => {
    let client: pg.Client;
    let folder: string;

    async function archived(): Promise<string | null> {
      const result = await client.query<{ wal: string | null }>(
        'select last_archived_wal as wal from pg_stat_archiver',
      );
      return result.rows[0]?.wal ?? null;
    }

    /** Closes the current segment and waits until archive_command has taken it. */
    async function archiveNow() {
      const before = await archived();
      await client.query('select pg_switch_wal()');
      for (let i = 0; i < 60; i++) {
        if ((await archived()) !== before) return;
        await sleep(1000);
      }
      throw new Error('WAL_NOT_ARCHIVED');
    }

    beforeAll(async () => {
      folder = mkdtempSync(join(tmpdir(), 'ensemus-pitr-'));
      client = new pg.Client({ connectionString: urls.superuser() });
      await client.connect();
      await client.query('create table if not exists public.pitr_probe (label text not null)');
      await client.query('truncate public.pitr_probe');
    });

    afterAll(async () => {
      spawnSync(
        'docker',
        [
          'compose',
          ...FILES.flatMap((f) => ['-f', f]),
          '--profile',
          'drill',
          'rm',
          '-sfv',
          'pg-drill',
        ],
        {
          cwd: repoRoot,
        },
      );
      await client?.query('drop table if exists public.pitr_probe').catch(() => undefined);
      await client?.end();
      rmSync(folder, { recursive: true, force: true });
    });

    it('archives WAL as PostgreSQL closes it', async () => {
      const settings = await client.query<{ name: string; setting: string }>(
        "select name, setting from pg_settings where name in ('archive_mode','wal_level')",
      );
      expect(Object.fromEntries(settings.rows.map((row) => [row.name, row.setting]))).toEqual({
        archive_mode: 'on',
        wal_level: 'replica',
      });
      await archiveNow();
      const failed = await client.query<{ failed: string }>(
        'select failed_count::text as failed from pg_stat_archiver',
      );
      expect(failed.rows[0]?.failed).toBe('0');
    });

    it('takes a base backup that passes its own manifest check', () => {
      const output = compose({ ENSEMUS_BACKUP_ONCE: '1' }, 'run', '--rm', '--no-deps', 'pg-backup');
      expect(output).toContain('"event":"pg_backup.completed"');
    });

    it('recovers to a point in time, and not past it', async () => {
      await client.query("insert into public.pitr_probe values ('before')");
      await archiveNow();
      const target = secondAfter(new Date());
      await sleep(target.getTime() - Date.now() + 1500);
      await client.query("insert into public.pitr_probe values ('after')");
      await archiveNow();

      compose(
        { ENSEMUS_DRILL_TARGET_TIME: isoSecond(target), ENSEMUS_DRILL_SOURCE: 'local' },
        '--profile',
        'drill',
        'up',
        '-d',
        '--no-deps',
        '--wait',
        'pg-drill',
      );
      const rows = compose(
        {},
        '--profile',
        'drill',
        'exec',
        '-T',
        'pg-drill',
        'gosu',
        'postgres',
        'psql',
        '-h',
        '/var/run/postgresql',
        '-U',
        'postgres',
        '-d',
        'ensemus',
        '-XAtc',
        'select label from public.pitr_probe order by label',
      );
      expect(rows.trim().split('\n')).toEqual(['before']);
      compose({}, '--profile', 'drill', 'rm', '-sfv', 'pg-drill');
    });

    it('runs the whole drill, with the reconcile report against the scratch copy, and writes the record', () => {
      const record = join(folder, 'record.json');
      const result = spawnSync(
        process.execPath,
        [
          join(repoRoot, 'infrastructure', 'scripts', 'pg-pitr-drill.mjs'),
          '--record',
          record,
          ...FILES.flatMap((file) => ['--compose-file', join(repoRoot, file)]),
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      const written = JSON.parse(readFileSync(record, 'utf8'));
      expect(written.outcome).toMatchObject({ ok: true, recovered: true, failed: [] });
      expect(written.reconcile.ran).toBe(true);
      // 0 or 1 both mean the report ran against the copy; which it is says what a person would have to review.
      expect([0, 1]).toContain(written.reconcile.exitCode);
      expect(written.steps.cleanup.ok).toBe(true);
      expect([0, 1]).toContain(result.status);
    });
  },
);
