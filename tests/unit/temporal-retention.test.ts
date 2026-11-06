// ADR-037 D6: runs the real setup-namespace.sh with sh, and a fake `temporal` first on PATH that records
// exactly what it was given. Nothing here reaches a Temporal server. A fake `sleep` keeps the wait for health
// from costing real time.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SETTING = 'ENSEMUS_TEMPORAL_RETENTION';
const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../infrastructure/compose/temporal/setup-namespace.sh',
);
const ADDRESS = 'passthrough:///temporal:7233';
const HEALTH = '[operator][cluster][health]';
const DESCRIBE = '[operator][namespace][describe][--namespace][default]';
const created = (retention: string) =>
  `[operator][namespace][create][--namespace][default][--retention][${retention}]`;
const updated = (retention: string) =>
  `[operator][namespace][update][--namespace][default][--retention][${retention}]`;
/** The script gives up when this many checks in a row have failed. */
const HEALTH_ATTEMPTS = 91;

// Each argument is bracketed so a value split or joined by bad quoting shows up in the comparison.
const FAKE_TEMPORAL = `#!/bin/sh
line=
for arg in "$@"; do line="$line[$arg]"; done
printf '%s\\n' "$line" >> "$FAKE_DIR/calls"
printf '%s\\n' "\${TEMPORAL_ADDRESS-unset}" >> "$FAKE_DIR/addresses"
case "$line" in
  '${HEALTH}')
    printf 'x' >> "$FAKE_DIR/health-tries"
    tries=$(wc -c < "$FAKE_DIR/health-tries")
    if [ "$tries" -le "\${FAKE_HEALTH_FAILS:-0}" ]; then exit 1; fi
    exit 0
    ;;
  '[operator][namespace][describe]'*) exit "\${FAKE_DESCRIBE_EXIT:-1}" ;;
  '[operator][namespace][update]'*) exit "\${FAKE_UPDATE_EXIT:-0}" ;;
  '[operator][namespace][create]'*) exit "\${FAKE_CREATE_EXIT:-0}" ;;
esac
exit 64
`;

const shPresent = spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0;
const title = shPresent
  ? 'setup-namespace.sh'
  : 'setup-namespace.sh (SKIPPED: no sh on PATH, so the real script cannot run here)';

describe.skipIf(!shPresent)(title, { timeout: 180_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ensemus-temporal-retention-'));
    for (const [name, content] of [
      ['temporal', FAKE_TEMPORAL],
      ['sleep', '#!/bin/sh\nexit 0\n'],
    ] as const) {
      writeFileSync(join(dir, name), content);
      chmodSync(join(dir, name), 0o755);
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** `retention` undefined means the setting is not there at all, which is not the same as empty. */
  function run(retention: string | undefined, fake: Record<string, string> = {}) {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      // On Windows the name can be Path, and two spellings in one environment leave which wins to chance.
      if (value !== undefined && name.toUpperCase() !== 'PATH') env[name] = value;
    }
    delete env[SETTING];
    delete env.TEMPORAL_ADDRESS;
    const result = spawnSync('sh', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...env,
        PATH: `${dir}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
        FAKE_DIR: dir,
        ...fake,
        ...(retention === undefined ? {} : { [SETTING]: retention }),
      },
    });
    const lines = (file: string) =>
      existsSync(join(dir, file))
        ? readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean)
        : [];
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      calls: lines('calls'),
      addresses: lines('addresses'),
    };
  }

  describe('choosing the retention', () => {
    it('creates with 72h when nothing is set', () => {
      const { status, calls } = run(undefined);
      expect(status).toBe(0);
      expect(calls).toEqual([HEALTH, DESCRIBE, created('72h')]);
    });

    it('creates with a value that is set', () => {
      const { status, calls } = run('168h');
      expect(status).toBe(0);
      expect(calls).toEqual([HEALTH, DESCRIBE, created('168h')]);
    });

    it.each(['24h', '25h', '30h', '99h', '100h', '8760h'])('accepts %s', (value) => {
      const { status, calls } = run(value);
      expect(status).toBe(0);
      expect(calls.at(-1)).toBe(created(value));
    });
  });

  describe('a namespace that exists', () => {
    it('is updated to the default when nothing is set, and not created', () => {
      const { status, calls } = run(undefined, { FAKE_DESCRIBE_EXIT: '0' });
      expect(status).toBe(0);
      expect(calls).toEqual([HEALTH, DESCRIBE, updated('72h')]);
    });

    it('is updated to a value that is set, and not created', () => {
      const { status, calls } = run('96h', { FAKE_DESCRIBE_EXIT: '0' });
      expect(status).toBe(0);
      expect(calls).toEqual([HEALTH, DESCRIBE, updated('96h')]);
    });
  });

  describe('a value it will not take', () => {
    // Text that could not be mistaken for anything the script says of its own accord.
    const LEAK_CANARY = 'CANARYRETENTIONVALUE';

    it.each([
      '1h',
      '23h',
      '0h',
      '72',
      '3d',
      '72h; rm -rf /',
      '',
      // Beyond the list the ADR names, the near misses a sloppy pattern would let through.
      'h',
      '00h',
      '072h',
      '72H',
      '72hh',
      '72m',
      '-24h',
      '+24h',
      '24.5h',
      ' 72h',
      '72h ',
      '72h\n',
      '\n72h',
      '1h2h',
      '$(touch pwned)72h',
      '`touch pwned`72h',
      `${LEAK_CANARY}h`,
    ])('refuses %j before touching Temporal', (value) => {
      const { status, calls, output } = run(value, { FAKE_DESCRIBE_EXIT: '0' });
      expect(status).not.toBe(0);
      // Stricter than "nothing that changes anything": it does not even wait for the server.
      expect(calls).toEqual([]);
      expect(output).toContain(SETTING);
      // One letter or nothing would match the message's own words, so those say nothing about a leak.
      if (value.trim().length > 1) expect(output).not.toContain(value.trim());
      expect(output).not.toContain(LEAK_CANARY);
      expect(existsSync('pwned')).toBe(false);
      expect(existsSync(join(dir, 'pwned'))).toBe(false);
    });

    it('leaves a number too big for a duration to Temporal, and the shell does not repeat it', () => {
      const digits = '9'.repeat(40);
      const { status, calls, output } = run(`${digits}h`, { FAKE_CREATE_EXIT: '1' });
      expect(status).not.toBe(0);
      expect(calls).toEqual([HEALTH, DESCRIBE, created(`${digits}h`)]);
      expect(output).not.toContain(digits);
    });
  });

  describe('a failure in Temporal', () => {
    it('fails the job when the update fails', () => {
      const { status, calls } = run('96h', { FAKE_DESCRIBE_EXIT: '0', FAKE_UPDATE_EXIT: '3' });
      expect(status).not.toBe(0);
      expect(calls).toEqual([HEALTH, DESCRIBE, updated('96h')]);
    });

    it('fails the job when the create fails', () => {
      const { status, calls } = run('96h', { FAKE_CREATE_EXIT: '3' });
      expect(status).not.toBe(0);
      expect(calls).toEqual([HEALTH, DESCRIBE, created('96h')]);
    });
  });

  describe('what stays as it was', () => {
    it('uses the passthrough address for every call', () => {
      const { addresses } = run(undefined, { FAKE_DESCRIBE_EXIT: '0' });
      expect(addresses).toEqual([ADDRESS, ADDRESS, ADDRESS]);
    });

    it('waits for the server to be healthy before it asks about the namespace', () => {
      const { status, calls } = run(undefined, { FAKE_HEALTH_FAILS: '2' });
      expect(status).toBe(0);
      expect(calls).toEqual([HEALTH, HEALTH, HEALTH, DESCRIBE, created('72h')]);
    });

    it('gives up on a server that never becomes healthy, having changed nothing', () => {
      const { status, calls, output } = run(undefined, { FAKE_HEALTH_FAILS: '1000' });
      expect(status).not.toBe(0);
      expect(output).toContain('Temporal did not become healthy');
      expect(calls).toEqual(Array.from({ length: HEALTH_ATTEMPTS }, () => HEALTH));
    });

    it('keeps set -eu, so an unset name cannot be read past', () => {
      expect(readFileSync(SCRIPT, 'utf8')).toMatch(/^set -eu$/m);
    });
  });
});
