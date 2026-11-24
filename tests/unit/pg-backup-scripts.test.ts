// The real archive_command and base-backup scripts from compose.backup.yaml, run by sh and bash against
// throwaway folders, with fake pg_basebackup and pg_verifybackup first on PATH. Nothing reaches PostgreSQL.
// What a real server and store do with them is tests/stack/pg-backup.test.ts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseBackupMetadata } from '../../infrastructure/scripts/pg-backup-rules.mjs';
import { repoRoot } from '../helpers/stack';

const SCRIPTS = join(repoRoot, 'infrastructure', 'compose', 'postgres', 'backup');
// Windows' system bash is a WSL launcher and does not inherit this fixture's environment.
// Prefer Git's native shells, which use the /c paths that the fixture supplies below.
const nativeShell = (name: string) => {
  if (process.platform !== 'win32') return name;
  const gitShell = join(
    process.env.ProgramFiles ?? 'C:\\Program Files',
    'Git',
    'bin',
    `${name}.exe`,
  );
  return existsSync(gitShell) ? gitShell : name;
};
const sh = nativeShell('sh');
const bash = nativeShell('bash');
const has = (shell: string, tools: string) =>
  spawnSync(shell, ['-c', `command -v ${tools} >/dev/null`], { stdio: 'ignore' }).status === 0;
const shReady = has(sh, 'cmp cp mv touch');
const bashReady = has(bash, 'tar sha256sum stat sed find mapfile');

// Git's sh on Windows reads C:\... in a variable, but tar takes "C:" for a remote host, so paths go in POSIX form.
const shellPath = (path: string) =>
  process.platform === 'win32'
    ? path
        .replace(/^([A-Za-z]):\\/, (_m, drive: string) => `/${drive.toLowerCase()}/`)
        .replace(/\\/g, '/')
    : path;

function cleanEnv() {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name.toUpperCase() !== 'PATH' && !name.startsWith('ENSEMUS_'))
      env[name] = value;
  return env;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ensemus-pg-backup-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!shReady)('archive-wal.sh', () => {
  const run = (source: string, name: string) => {
    const result = spawnSync(sh, ['-s', '--', shellPath(source), name], {
      input: readFileSync(join(SCRIPTS, 'archive-wal.sh'), 'utf8'),
      encoding: 'utf8',
      env: {
        ...cleanEnv(),
        PATH: process.env.PATH ?? process.env.Path ?? '',
        ENSEMUS_WAL_ARCHIVE_DIR: shellPath(join(dir, 'archive')),
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const NAME = '000000010000000000000003';

  beforeEach(() => {
    mkdirSync(join(dir, 'archive'));
    writeFileSync(join(dir, 'segment'), 'wal bytes');
  });

  it('archives a finished file under its name, and leaves no partial copy', () => {
    expect(run(join(dir, 'segment'), NAME).status).toBe(0);
    expect(readFileSync(join(dir, 'archive', NAME), 'utf8')).toBe('wal bytes');
    expect(readdirSync(join(dir, 'archive'))).toEqual([NAME]);
  });

  it('accepts being asked again for the same bytes', () => {
    expect(run(join(dir, 'segment'), NAME).status).toBe(0);
    expect(run(join(dir, 'segment'), NAME).status).toBe(0);
  });

  it('refuses different bytes under a name already archived, and keeps the first', () => {
    expect(run(join(dir, 'segment'), NAME).status).toBe(0);
    writeFileSync(join(dir, 'other'), 'a second server');
    const second = run(join(dir, 'other'), NAME);
    expect(second.status).not.toBe(0);
    expect(second.output).toContain('DIFFERENT_FILE_ALREADY_ARCHIVED');
    expect(readFileSync(join(dir, 'archive', NAME), 'utf8')).toBe('wal bytes');
  });

  it.each(['', '../escape', 'a/b', '.hidden'])('refuses the name %j', (name) => {
    const result = run(join(dir, 'segment'), name);
    expect(result.status).not.toBe(0);
    expect(readdirSync(join(dir, 'archive'))).toEqual([]);
  });

  it('fails, so PostgreSQL keeps the file, when the copy cannot be made', () => {
    expect(run(join(dir, 'missing'), NAME).status).not.toBe(0);
    expect(existsSync(join(dir, 'archive', NAME))).toBe(false);
  });
});

const FAKE_BASEBACKUP = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DIR/calls"
[ "\${FAKE_BASEBACKUP_EXIT:-0}" = 0 ] || exit "$FAKE_BASEBACKUP_EXIT"
while [ $# -gt 0 ]; do case $1 in -D) shift; target=$1 ;; esac; shift; done
mkdir -p "$target"
printf 'START WAL LOCATION: 0/5000028 (file 000000010000000000000005)\\nCHECKPOINT LOCATION: 0/5000060\\n' > "$target/backup_label"
printf '17\\n' > "$target/PG_VERSION"
`;
const FAKE_VERIFY = `#!/bin/sh
printf 'verify\\n' >> "$FAKE_DIR/calls"
exit "\${FAKE_VERIFY_EXIT:-0}"
`;

describe.skipIf(!bashReady)('base-backup.sh', { timeout: 60_000 }, () => {
  let backups: string;
  let wal: string;

  beforeEach(() => {
    backups = join(dir, 'backups');
    wal = join(dir, 'wal');
    mkdirSync(join(backups, 'base'), { recursive: true });
    mkdirSync(wal);
    mkdirSync(join(dir, 'bin'));
    for (const [name, body] of [
      ['pg_basebackup', FAKE_BASEBACKUP],
      ['pg_verifybackup', FAKE_VERIFY],
    ] as const) {
      writeFileSync(join(dir, 'bin', name), body);
      chmodSync(join(dir, 'bin', name), 0o755);
    }
    writeFileSync(join(dir, 'password'), 'pass:with\\colon');
  });

  const run = (settings: Record<string, string | undefined>, fake: Record<string, string> = {}) => {
    const env: Record<string, string> = {
      ...cleanEnv(),
      PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
      FAKE_DIR: shellPath(dir),
      ENSEMUS_BACKUP_DIR: shellPath(backups),
      ENSEMUS_WAL_ARCHIVE_DIR: shellPath(wal),
      ENSEMUS_BACKUP_PASSWORD_FILE: shellPath(join(dir, 'password')),
      ENSEMUS_BACKUP_ONCE: '1',
      ...fake,
    };
    for (const [name, value] of Object.entries(settings))
      if (value !== undefined) env[name] = value;
    const result = spawnSync(bash, ['-s'], {
      input: readFileSync(join(SCRIPTS, 'base-backup.sh'), 'utf8'),
      encoding: 'utf8',
      env,
    });
    const calls = existsSync(join(dir, 'calls'))
      ? readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean)
      : [];
    return { status: result.status, output: `${result.stdout}${result.stderr}`, calls };
  };
  const GOOD = {
    ENSEMUS_BACKUP_INTERVAL_SECONDS: '86400',
    ENSEMUS_BACKUP_LOCAL_KEEP: '2',
    ENSEMUS_BACKUP_OFFSITE: 'off',
  };

  describe('refuses a setting before it connects to anything', () => {
    it.each([
      [
        { ...GOOD, ENSEMUS_BACKUP_INTERVAL_SECONDS: undefined },
        'ENSEMUS_BACKUP_INTERVAL_SECONDS_INVALID',
      ],
      [
        { ...GOOD, ENSEMUS_BACKUP_INTERVAL_SECONDS: '60' },
        'ENSEMUS_BACKUP_INTERVAL_SECONDS_INVALID',
      ],
      [
        { ...GOOD, ENSEMUS_BACKUP_INTERVAL_SECONDS: '086400' },
        'ENSEMUS_BACKUP_INTERVAL_SECONDS_INVALID',
      ],
      [
        { ...GOOD, ENSEMUS_BACKUP_INTERVAL_SECONDS: '1d' },
        'ENSEMUS_BACKUP_INTERVAL_SECONDS_INVALID',
      ],
      [
        { ...GOOD, ENSEMUS_BACKUP_INTERVAL_SECONDS: '9'.repeat(40) },
        'ENSEMUS_BACKUP_INTERVAL_SECONDS_INVALID',
      ],
      [{ ...GOOD, ENSEMUS_BACKUP_LOCAL_KEEP: undefined }, 'ENSEMUS_BACKUP_LOCAL_KEEP_INVALID'],
      [{ ...GOOD, ENSEMUS_BACKUP_LOCAL_KEEP: '0' }, 'ENSEMUS_BACKUP_LOCAL_KEEP_INVALID'],
      [
        { ...GOOD, ENSEMUS_BACKUP_LOCAL_KEEP: '$(touch pwned)' },
        'ENSEMUS_BACKUP_LOCAL_KEEP_INVALID',
      ],
      [{ ...GOOD, ENSEMUS_BACKUP_OFFSITE: undefined }, 'ENSEMUS_BACKUP_OFFSITE_INVALID'],
      [{ ...GOOD, ENSEMUS_BACKUP_OFFSITE: 'yes' }, 'ENSEMUS_BACKUP_OFFSITE_INVALID'],
    ])('%j', (settings, code) => {
      const { status, output, calls } = run(settings);
      expect(status).not.toBe(0);
      expect(output).toContain(code);
      expect(calls).toEqual([]);
      expect(existsSync('pwned')).toBe(false);
    });
  });

  it('takes one backup, verified, packed with its hash, and named only once it is whole', () => {
    const { status, output, calls } = run(GOOD);
    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('-X stream');
    expect(calls[0]).toContain('--manifest-checksums=SHA256');
    expect(calls[1]).toBe('verify');
    expect(output).toContain('"event":"pg_backup.completed"');
    const names = readdirSync(join(backups, 'base'));
    const json = names.find((name) => name.endsWith('.json'));
    expect(json).toBeDefined();
    const metadata = parseBackupMetadata(readFileSync(join(backups, 'base', json!), 'utf8'));
    expect(metadata.startWal).toBe('000000010000000000000005');
    const archive = readFileSync(join(backups, 'base', `${metadata.id}.tar.gz`));
    expect(createHash('sha256').update(archive).digest('hex')).toBe(metadata.sha256);
    expect(metadata.bytes).toBe(archive.byteLength);
    expect(names.filter((name) => name.includes('partial'))).toEqual([]);
    expect(readdirSync(join(backups, 'work'))).toEqual([]);
    // The password never reaches the output.
    expect(output).not.toContain('with');
  });

  it('names nothing when the manifest check fails, and the run fails', () => {
    const { status, output } = run(GOOD, { FAKE_VERIFY_EXIT: '1' });
    expect(status).not.toBe(0);
    expect(output).toContain('VERIFY_FAILED');
    expect(readdirSync(join(backups, 'base'))).toEqual([]);
  });

  it('names nothing when the base backup fails', () => {
    const { status, output } = run(GOOD, { FAKE_BASEBACKUP_EXIT: '2' });
    expect(status).not.toBe(0);
    expect(output).toContain('BASEBACKUP_FAILED');
    expect(readdirSync(join(backups, 'base'))).toEqual([]);
  });

  const seed = (id: string, startWal: string) => {
    writeFileSync(join(backups, 'base', `${id}.tar.gz`), 'old');
    writeFileSync(
      join(backups, 'base', `${id}.json`),
      JSON.stringify({ kind: 'ensemus-pg-base-backup-v1', id, startWal }),
    );
  };
  const WAL = [
    '000000010000000000000001',
    '000000010000000000000002',
    '000000010000000000000003.00000028.backup',
    '000000010000000000000004',
    '000000010000000000000005',
    '00000001.history',
  ];

  it('keeps the newest backups it is told to, and WAL from the oldest kept start on', () => {
    seed('20200101T000000Z', '000000010000000000000001');
    seed('20200102T000000Z', '000000010000000000000004');
    for (const name of WAL) writeFileSync(join(wal, name), name);
    const { status } = run(GOOD);
    expect(status).toBe(0);
    const base = readdirSync(join(backups, 'base'));
    expect(base).not.toContain('20200101T000000Z.json');
    expect(base).not.toContain('20200101T000000Z.tar.gz');
    expect(base).toContain('20200102T000000Z.json');
    expect(readdirSync(wal).sort()).toEqual(
      ['000000010000000000000004', '000000010000000000000005', '00000001.history'].sort(),
    );
  });

  it('keeps all WAL while the offsite copy has not finished once', () => {
    seed('20200101T000000Z', '000000010000000000000004');
    for (const name of WAL) writeFileSync(join(wal, name), name);
    const { status, output } = run({
      ...GOOD,
      ENSEMUS_BACKUP_LOCAL_KEEP: '1',
      ENSEMUS_BACKUP_OFFSITE: 'on',
    });
    expect(status).toBe(0);
    expect(output).toContain('OFFSITE_NOT_YET_COPIED');
    expect(readdirSync(wal)).toHaveLength(WAL.length);
  });

  it('lets WAL go only when a finished offsite copy started after it appeared', () => {
    seed('20200101T000000Z', '000000010000000000000004');
    for (const name of WAL) writeFileSync(join(wal, name), name);
    mkdirSync(join(backups, 'state'), { recursive: true });
    const marker = join(backups, 'state', 'offsite-shipped-through');
    writeFileSync(marker, '');
    const past = new Date('2026-01-01T00:00:00Z');
    const later = new Date('2026-06-01T00:00:00Z');
    utimesSync(marker, past, past);
    for (const name of WAL) utimesSync(join(wal, name), past, past);
    // Arrived after the last finished copy started, so it may not be offsite yet.
    utimesSync(join(wal, '000000010000000000000002'), later, later);
    const { status } = run({ ...GOOD, ENSEMUS_BACKUP_OFFSITE: 'on' });
    expect(status).toBe(0);
    expect(readdirSync(wal).sort()).toEqual(
      [
        '000000010000000000000002',
        '000000010000000000000004',
        '000000010000000000000005',
        '00000001.history',
      ].sort(),
    );
  });
});

// Each argument bracketed, so quoting mistakes show. A `copy` from the remote writes what fetch expects.
const FAKE_RCLONE = `#!/bin/sh
line=
for arg in "$@"; do line="$line[$arg]"; done
printf '%s\n' "$line" >> "$FAKE_DIR/calls"
printf '%s\n' "\${RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY-unset}" >> "$FAKE_DIR/secrets-seen"
case "$1" in
  lsf) printf '20261110T000000Z.json\n20261111T000000Z.json\nnotes.txt\n' ;;
  copy)
    case "$2" in
      offsite:*/postgres/base) printf '{}' > "$3/20261111T000000Z.json"; printf 'x' > "$3/20261111T000000Z.tar.gz" ;;
    esac
    exit "\${FAKE_COPY_EXIT:-0}" ;;
esac
`;

describe.skipIf(!shReady)('offsite.sh', { timeout: 60_000 }, () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'bin'));
    for (const [name, body] of [
      ['rclone', FAKE_RCLONE],
      ['chown', '#!/bin/sh\nexit 0\n'],
    ] as const) {
      writeFileSync(join(dir, 'bin', name), body);
      chmodSync(join(dir, 'bin', name), 0o755);
    }
    mkdirSync(join(dir, 'backups', 'base'), { recursive: true });
    mkdirSync(join(dir, 'backups', 'state'));
    mkdirSync(join(dir, 'wal'));
    writeFileSync(join(dir, 'key'), 'BACKUPKEYID');
    writeFileSync(join(dir, 'secret'), 'CANARYBACKUPSECRET');
  });

  const run = (args: string[], settings: Record<string, string | undefined> = {}) => {
    const env: Record<string, string> = {
      ...cleanEnv(),
      PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
      FAKE_DIR: shellPath(dir),
      ENSEMUS_BACKUP_DIR: shellPath(join(dir, 'backups')),
      ENSEMUS_WAL_ARCHIVE_DIR: shellPath(join(dir, 'wal')),
      ENSEMUS_DRILL_FETCH_DIR: shellPath(join(dir, 'fetch')),
      ENSEMUS_BACKUP_ACCESS_KEY_FILE: shellPath(join(dir, 'key')),
      ENSEMUS_BACKUP_SECRET_KEY_FILE: shellPath(join(dir, 'secret')),
      ENSEMUS_BACKUP_BUCKET: 'ensemus-backups',
      ENSEMUS_BACKUP_OBJECT_ENDPOINT: 'http://objects:8333',
      ENSEMUS_BACKUP_SHIP_INTERVAL_SECONDS: '300',
      ENSEMUS_BACKUP_ONCE: '1',
    };
    for (const [name, value] of Object.entries(settings)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    const result = spawnSync(sh, ['-s', '--', ...args], {
      input: readFileSync(join(SCRIPTS, 'offsite.sh'), 'utf8'),
      encoding: 'utf8',
      env,
    });
    const lines = (file: string) =>
      existsSync(join(dir, file))
        ? readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean)
        : [];
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      calls: lines('calls'),
      secretsSeen: lines('secrets-seen'),
    };
  };

  it('ships WAL, then archives, then metadata, only adding, and marks the copy finished', () => {
    const { status, calls, output, secretsSeen } = run(['ship']);
    expect(status).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatch(
      /^\[copy\]\[.*wal\]\[offsite:ensemus-backups\/postgres\/wal\]\[--immutable\]\[--exclude\]\[\.\*\]/,
    );
    expect(calls[1]).toContain('[--include][*.tar.gz]');
    expect(calls[2]).toContain('[--include][*.json]');
    for (const call of calls) {
      expect(call).toContain('[--immutable]');
      expect(call).not.toMatch(/\[(delete|sync|purge|move|deletefile|rmdirs)\]/);
      // The key reaches rclone by its environment, never on a command line or in the output.
      expect(call).not.toContain('CANARYBACKUPSECRET');
    }
    expect(secretsSeen[0]).toBe('CANARYBACKUPSECRET');
    expect(output).not.toContain('CANARYBACKUPSECRET');
    expect(existsSync(join(dir, 'backups', 'state', 'offsite-shipped-through'))).toBe(true);
    expect(existsSync(join(dir, 'backups', 'state', 'offsite-ship-started'))).toBe(false);
  });

  it('leaves the finished mark alone when a copy fails, so no local WAL is let go', () => {
    const { status, output } = run(['ship'], { FAKE_COPY_EXIT: '1' });
    expect(status).not.toBe(0);
    expect(output).toContain('COPY_FAILED');
    expect(existsSync(join(dir, 'backups', 'state', 'offsite-shipped-through'))).toBe(false);
  });

  it.each([
    [{ ENSEMUS_BACKUP_BUCKET: undefined }, 'ENSEMUS_BACKUP_BUCKET_INVALID'],
    [{ ENSEMUS_BACKUP_BUCKET: 'Backups/../x' }, 'ENSEMUS_BACKUP_BUCKET_INVALID'],
    [{ ENSEMUS_BACKUP_OBJECT_ENDPOINT: 'objects:8333' }, 'ENSEMUS_BACKUP_OBJECT_ENDPOINT_INVALID'],
    [{ ENSEMUS_BACKUP_SECRET_KEY_FILE: '/nowhere/secret' }, 'CREDENTIAL_FILE_UNREADABLE'],
    [
      { ENSEMUS_BACKUP_SHIP_INTERVAL_SECONDS: undefined },
      'ENSEMUS_BACKUP_SHIP_INTERVAL_SECONDS_INVALID',
    ],
    [{ ENSEMUS_BACKUP_SHIP_INTERVAL_SECONDS: '5' }, 'ENSEMUS_BACKUP_SHIP_INTERVAL_SECONDS_INVALID'],
    [
      { ENSEMUS_BACKUP_SHIP_INTERVAL_SECONDS: '0300' },
      'ENSEMUS_BACKUP_SHIP_INTERVAL_SECONDS_INVALID',
    ],
  ])('refuses %j before calling rclone', (settings, code) => {
    const { status, output, calls } = run(['ship'], settings);
    expect(status).not.toBe(0);
    expect(output).toContain(code);
    expect(calls).toEqual([]);
  });

  it('refuses a mode it does not know', () => {
    expect(run(['delete']).output).toContain('MODE_INVALID');
  });

  it('fetches the latest backup by its metadata, and refuses a bad name', () => {
    const latest = run(['fetch', 'latest']);
    expect(latest.status).toBe(0);
    expect(latest.output).toContain('"id":"20261111T000000Z"');
    expect(existsSync(join(dir, 'fetch', 'base', '20261111T000000Z.tar.gz'))).toBe(true);
    const bad = run(['fetch', '../20261111T000000Z']);
    expect(bad.status).not.toBe(0);
    expect(bad.output).toContain('BACKUP_ID_INVALID');
  });
});
