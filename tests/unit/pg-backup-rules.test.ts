// The decisions behind scheduled PostgreSQL backups and the point-in-time drill (OPS-02, LIFE-02), without
// Docker, a database or a store. infrastructure/scripts/pg-backup-rules.mjs holds them.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  drillEventsFrom,
  drillOutcome,
  isBackupId,
  parseBackupMetadata,
  parseDrillOptions,
  parseRetentionPolicy,
  parseTargetTime,
  planPrune,
  walOrderKey,
} from '../../infrastructure/scripts/pg-backup-rules.mjs';
import { parsePruneCommand } from '../../infrastructure/scripts/pg-backup-prune.mjs';
import {
  DEFAULT_COMPOSE_FILES,
  parseDrillCommand,
} from '../../infrastructure/scripts/pg-pitr-drill.mjs';
import { repoRoot } from '../helpers/stack';

const NOW = new Date('2026-11-12T12:00:00Z');
const backup = (id: string, finishedAt: string, startWal: string) => ({
  id,
  finishedAt,
  startWal,
  sha256: 'a'.repeat(64),
  bytes: 10,
});

describe('retention comes only from the operator (LIFE-02)', () => {
  it('takes both numbers when given', () => {
    expect(parseRetentionPolicy({ keepCount: '7', keepDays: '35' })).toEqual({
      keepCount: 7,
      keepDays: 35,
    });
  });

  it.each([
    [{}, 'BACKUP_KEEP_COUNT_REQUIRED'],
    [{ keepCount: '7' }, 'BACKUP_KEEP_DAYS_REQUIRED'],
    [{ keepDays: '35' }, 'BACKUP_KEEP_COUNT_REQUIRED'],
    [{ keepCount: '0', keepDays: '1' }, 'BACKUP_KEEP_COUNT_REQUIRED'],
    [{ keepCount: '07', keepDays: '1' }, 'BACKUP_KEEP_COUNT_REQUIRED'],
    [{ keepCount: '-1', keepDays: '1' }, 'BACKUP_KEEP_COUNT_REQUIRED'],
    [{ keepCount: '1.5', keepDays: '1' }, 'BACKUP_KEEP_COUNT_REQUIRED'],
    [{ keepCount: '1', keepDays: ' 1' }, 'BACKUP_KEEP_DAYS_REQUIRED'],
    [{ keepCount: '1', keepDays: '1e3' }, 'BACKUP_KEEP_DAYS_REQUIRED'],
    [{ keepCount: 7, keepDays: 35 }, 'BACKUP_KEEP_COUNT_REQUIRED'],
  ])('refuses %j', (input, code) => {
    expect(() => parseRetentionPolicy(input)).toThrow(code);
  });

  it('has no retention number in the overlay: every one is required from the environment', () => {
    const overlay = readFileSync(`${repoRoot}/infrastructure/compose/compose.backup.yaml`, 'utf8');
    for (const name of [
      'ENSEMUS_BACKUP_INTERVAL_SECONDS',
      'ENSEMUS_BACKUP_LOCAL_KEEP',
      'ENSEMUS_BACKUP_ARCHIVE_TIMEOUT_SECONDS',
      'ENSEMUS_BACKUP_SHIP_INTERVAL_SECONDS',
    ])
      expect(overlay).toMatch(new RegExp(`\\$\\{${name}:\\?`));
    expect(overlay).not.toMatch(/ENSEMUS_BACKUP_LOCAL_KEEP:-/);
  });
});

describe('what the offsite copy may lose', () => {
  const policy = { keepCount: 2, keepDays: 7 };
  const backups = [
    backup('20261001T000000Z', '2026-10-01T00:10:00Z', '000000010000000000000010'),
    backup('20261101T000000Z', '2026-11-01T00:10:00Z', '000000010000000000000020'),
    backup('20261108T000000Z', '2026-11-08T00:10:00Z', '000000010000000000000030'),
    backup('20261111T000000Z', '2026-11-11T00:10:00Z', '000000010000000000000040'),
  ];
  const wal = [
    '00000001000000000000000F',
    '000000010000000000000010',
    '00000001000000000000001F',
    '000000010000000000000020.00000028.backup',
    '000000010000000000000029',
    '00000002000000000000002A',
    '000000010000000000000030',
    '000000010000000000000041',
    '00000002.history',
    'stray.txt',
  ];

  it('keeps the newest N and anything within the age, and WAL from the oldest kept start', () => {
    const plan = planPrune(backups, wal, policy, NOW);
    expect(plan.keep).toEqual(['20261111T000000Z', '20261108T000000Z']);
    expect(plan.drop).toEqual(['20261101T000000Z', '20261001T000000Z']);
    // Compared without the timeline, as pg_archivecleanup does, and the history file always stays.
    expect(plan.dropWal).toEqual([
      '00000001000000000000000F',
      '000000010000000000000010',
      '00000001000000000000001F',
      '000000010000000000000020.00000028.backup',
      '000000010000000000000029',
      '00000002000000000000002A',
    ]);
    expect(plan.unknown).toBe(1);
    expect(plan.keptWal).toBe(4);
  });

  it('keeps an old backup while it is within the age', () => {
    const plan = planPrune(backups, wal, { keepCount: 1, keepDays: 30 }, NOW);
    expect(plan.keep).toEqual(['20261111T000000Z', '20261108T000000Z', '20261101T000000Z']);
    expect(plan.drop).toEqual(['20261001T000000Z']);
  });

  it('always keeps the newest, however old it is', () => {
    const old = [backup('20200101T000000Z', '2020-01-01T00:10:00Z', '000000010000000000000001')];
    const plan = planPrune(old, ['000000010000000000000001'], { keepCount: 1, keepDays: 1 }, NOW);
    expect(plan.keep).toEqual(['20200101T000000Z']);
    expect(plan.drop).toEqual([]);
    expect(plan.dropWal).toEqual([]);
  });

  it('deletes nothing at all when there is no backup', () => {
    expect(planPrune([], wal, policy, NOW)).toMatchObject({ drop: [], dropWal: [] });
  });

  it('refuses a duplicate or a bad clock', () => {
    expect(() => planPrune([backups[0], backups[0]], [], policy, NOW)).toThrow(
      'BACKUP_METADATA_DUPLICATE',
    );
    expect(() => planPrune(backups, [], policy, new Date(Number.NaN))).toThrow(
      'PRUNE_INPUT_INVALID',
    );
  });

  it('orders WAL names without their timeline, and knows nothing else', () => {
    expect(walOrderKey('000000020000000300000004')).toBe('0000000300000004');
    expect(walOrderKey('000000010000000000000004.partial')).toBe('0000000000000004');
    expect(walOrderKey('00000002.history')).toBeNull();
    expect(walOrderKey('.000000010000000000000004.partial')).toBeNull();
    expect(walOrderKey('000000010000000000000004 ')).toBeNull();
  });
});

describe('a backup’s metadata', () => {
  const good = {
    kind: 'ensemus-pg-base-backup-v1',
    id: '20261111T000000Z',
    startWal: '000000010000000000000040',
    sha256: 'b'.repeat(64),
    bytes: 123,
    startedAt: '2026-11-11T00:00:00Z',
    finishedAt: '2026-11-11T00:10:00Z',
  };

  it('reads what base-backup.sh writes', () => {
    expect(parseBackupMetadata(JSON.stringify(good))).toMatchObject({ id: good.id, bytes: 123 });
  });

  it.each([
    ['not json', '{'],
    ['another kind', JSON.stringify({ ...good, kind: 'x' })],
    ['a bad id', JSON.stringify({ ...good, id: '2026-11-11' })],
    [
      'a lower-case WAL name',
      JSON.stringify({ ...good, startWal: good.startWal.toLowerCase() + 'a' }),
    ],
    ['a short hash', JSON.stringify({ ...good, sha256: 'b' })],
    ['no size', JSON.stringify({ ...good, bytes: 0 })],
    ['no finish time', JSON.stringify({ ...good, finishedAt: 'soon' })],
  ])('refuses %s', (_name, text) => {
    expect(() => parseBackupMetadata(text)).toThrow('BACKUP_METADATA_INVALID');
  });

  it('names backups by their start time, so a sort is a sort by time', () => {
    expect(isBackupId('20261111T235959Z')).toBe(true);
    for (const value of ['20261111T235959', '2026-11-11T23:59:59Z', '../20261111T235959Z', ''])
      expect(isBackupId(value)).toBe(false);
  });
});

describe('the drill’s options', () => {
  it('defaults to the latest local backup, replayed to the end, with the reconcile report', () => {
    expect(parseDrillOptions({ record: 'r.json' }, NOW)).toEqual({
      record: 'r.json',
      backupId: 'latest',
      source: 'local',
      targetTime: null,
      reconcile: true,
    });
  });

  it('takes a named backup, the offsite copy and a target time', () => {
    expect(
      parseDrillOptions(
        {
          record: 'r.json',
          'backup-id': '20261111T000000Z',
          source: 'offsite',
          'target-time': '2026-11-11T06:30:00Z',
          'skip-reconcile': true,
        },
        NOW,
      ),
    ).toMatchObject({ backupId: '20261111T000000Z', source: 'offsite', reconcile: false });
  });

  it.each([
    [{}, 'DRILL_RECORD_REQUIRED'],
    [{ record: 'r', 'backup-id': '2026' }, 'DRILL_BACKUP_ID_INVALID'],
    [{ record: 'r', 'backup-id': "20261111T000000Z' --x" }, 'DRILL_BACKUP_ID_INVALID'],
    [{ record: 'r', source: 's3' }, 'DRILL_SOURCE_INVALID'],
    [{ record: 'r', 'target-time': '2026-11-11 06:30:00' }, 'DRILL_TARGET_TIME_INVALID'],
    [{ record: 'r', 'target-time': '2026-02-30T06:30:00Z' }, 'DRILL_TARGET_TIME_INVALID'],
    [
      { record: 'r', 'target-time': "2026-11-11T06:30:00Z'; select 1" },
      'DRILL_TARGET_TIME_INVALID',
    ],
    [{ record: 'r', 'target-time': '2026-11-13T00:00:00Z' }, 'DRILL_TARGET_TIME_IN_FUTURE'],
  ])('refuses %j', (values, code) => {
    expect(() => parseDrillOptions(values as Record<string, string>, NOW)).toThrow(code);
  });

  it('parses a target time exactly', () => {
    expect(parseTargetTime('2026-11-11T06:30:00Z', NOW)).toBe('2026-11-11T06:30:00Z');
  });

  it('runs against the base stack and the backup overlay unless told otherwise', () => {
    const command = parseDrillCommand(['--record', 'r.json'], NOW);
    expect(command.compose['compose-file']).toEqual([...DEFAULT_COMPOSE_FILES]);
    expect(() => parseDrillCommand(['--record', 'r.json', '--apply'], NOW)).toThrow();
    expect(() => parseDrillCommand(['--record', 'r.json', '--project', 'Bad Name'], NOW)).toThrow(
      'DRILL_PROJECT_INVALID',
    );
  });
});

describe('what reaches the drill record', () => {
  const log = [
    'PostgreSQL init process complete',
    '{"event":"pg_drill.restored","backupId":"20261111T000000Z"}',
    '{"event":"pg_drill.verified"}',
    '{"event":"pg_drill.recovered","backupId":"20261111T000000Z","seconds":42,"lastReplayed":"2026-11-11T06:29:59.120Z"}',
    '{"event":"pg_drill.check","name":"migrations","count":120,"ok":true}',
    '{"event":"pg_drill.check","name":"organizations","count":3,"ok":true,"detail":"Acme Ltd, row 4 said hello"}',
    '{"event":"pg_other.secret","password":"CANARY"}',
    'LOG:  {"event":"pg_drill.check", broken',
  ].join('\n');

  it('keeps only the drill’s own events and only machine-shaped values', () => {
    const { events, dropped } = drillEventsFrom(log);
    expect(events).toHaveLength(5);
    expect(JSON.stringify(events)).not.toContain('Acme');
    expect(JSON.stringify(events)).not.toContain('CANARY');
    expect(dropped).toBe(2);
  });

  it('says ok only when it recovered and every check passed, within the target', () => {
    const { events } = drillEventsFrom(log);
    expect(drillOutcome(events, '2026-11-11T06:30:00Z')).toMatchObject({ ok: true, checks: 2 });
    expect(drillOutcome(events, '2026-11-11T06:29:00Z')).toMatchObject({
      ok: false,
      beyondTarget: true,
    });
    const failing = [...events, { event: 'pg_drill.check', name: 'invalid_indexes', ok: false }];
    expect(drillOutcome(failing, null)).toMatchObject({ ok: false, failed: ['invalid_indexes'] });
    expect(drillOutcome(events.slice(0, 2), null)).toMatchObject({ ok: false, recovered: false });
    expect(drillOutcome([...events, { event: 'pg_drill.refused', reasonCode: 'X' }], null).ok).toBe(
      false,
    );
  });
});

describe('the prune command', () => {
  const store = [
    '--object-endpoint',
    'http://objects:8333',
    '--object-access-key-file',
    'a',
    '--object-secret-key-file',
    'b',
  ];

  it('plans by default and deletes only with --apply', () => {
    expect(parsePruneCommand(['--keep-count', '3', '--keep-days', '30', ...store])).toMatchObject({
      apply: false,
      bucket: 'ensemus-backups',
      policy: { keepCount: 3, keepDays: 30 },
    });
    expect(
      parsePruneCommand(['--keep-count', '3', '--keep-days', '30', ...store, '--apply']).apply,
    ).toBe(true);
  });

  it('refuses without the operator’s numbers or the store', () => {
    expect(() => parsePruneCommand([...store])).toThrow('BACKUP_KEEP_COUNT_REQUIRED');
    expect(() => parsePruneCommand(['--keep-count', '3', '--keep-days', '30'])).toThrow(
      'STORE_OPTIONS_REQUIRED',
    );
    expect(() =>
      parsePruneCommand(['--keep-count', '3', '--keep-days', '30', ...store, '--bucket', 'A/B']),
    ).toThrow('BUCKET_INVALID');
  });
});

describe('the overlay', () => {
  const overlay = parse(
    readFileSync(`${repoRoot}/infrastructure/compose/compose.backup.yaml`, 'utf8'),
  ) as {
    services: Record<string, Record<string, unknown>>;
  };

  it('pins the PostgreSQL image it reuses by digest, and names no rclone digest of its own', () => {
    for (const name of ['pg-backup-init', 'pg-backup', 'pg-drill'])
      expect(String(overlay.services[name]?.image)).toMatch(/@sha256:[0-9a-f]{64}$/);
    const base = readFileSync(`${repoRoot}/infrastructure/compose/compose.yaml`, 'utf8');
    expect(base).toContain(String(overlay.services['pg-backup']?.image));
  });

  it('gives the scratch server and its report the drill profile, and only reads the live archive', () => {
    expect(overlay.services['pg-drill']?.profiles).toEqual(['drill']);
    expect(overlay.services['restore-reconcile-drill']?.profiles).toEqual(['drill']);
    expect(overlay.services['pg-drill']?.volumes).toEqual(
      expect.arrayContaining(['pg-wal-archive:/wal-archive:ro', 'pg-backups:/backups:ro']),
    );
    // Its `postgres` is the scratch server, so the live server is never what the report reads.
    expect(overlay.services['restore-reconcile-drill']?.extra_hosts).toEqual(
      expect.arrayContaining(['postgres:${ENSEMUS_NETWORK_PREFIX:-172.30}.2.20']),
    );
    expect(overlay.services['restore-reconcile-drill']?.command).toEqual([
      'node',
      'dist/restore-reconcile.js',
    ]);
  });

  it('gives the offsite copy its own bucket credential, and not the application’s', () => {
    expect(overlay.services['pg-backup-offsite']?.secrets).toEqual([
      'objects_backup_access_key',
      'objects_backup_secret_key',
    ]);
  });
});
