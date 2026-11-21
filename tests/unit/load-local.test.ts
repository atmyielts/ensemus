// The local-stack runner and its profiles (OPS-01), without a stack: what it refuses, and that what it writes
// is what run.mjs accepts. Nothing here sends a request.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateProfile, validateTarget } from '../load/harness.mjs';
import { hostContext, machineRef, parseLocalCommand } from '../load/local.mjs';
import { profiles } from '../load/profiles.mjs';
import { repoRoot } from '../helpers/stack';

const PROFILE_FILES = join(repoRoot, 'tests', 'load', 'profiles');

describe('the local load runner', () => {
  it('takes a loopback origin, a profile and a new folder', () => {
    expect(
      parseLocalCommand([
        '--profile',
        'small',
        '--base-url',
        'https://localhost:8443',
        '--dir',
        'out',
        '--release',
        'abc123',
      ]),
    ).toEqual({
      profile: 'small',
      baseUrl: 'https://localhost:8443',
      dir: 'out',
      profileFile: undefined,
      release: 'abc123',
    });
  });

  it.each([
    [['--base-url', 'https://localhost:8443', '--dir', 'o'], 'PROFILE_REQUIRED'],
    [
      ['--profile', 'huge', '--base-url', 'https://localhost:8443', '--dir', 'o'],
      'PROFILE_REQUIRED',
    ],
    [['--profile', 'small', '--base-url', 'https://localhost:8443'], 'DIR_REQUIRED'],
    [['--profile', 'small', '--dir', 'o'], 'LOOPBACK_TEST_TARGET_REQUIRED'],
    [
      ['--profile', 'small', '--dir', 'o', '--base-url', 'https://app.example.com'],
      'LOOPBACK_TEST_TARGET_REQUIRED',
    ],
    [
      ['--profile', 'small', '--dir', 'o', '--base-url', 'https://localhost.example.com'],
      'LOOPBACK_TEST_TARGET_REQUIRED',
    ],
    [
      ['--profile', 'small', '--dir', 'o', '--base-url', 'https://u:p@localhost:8443'],
      'LOOPBACK_TEST_TARGET_REQUIRED',
    ],
    [
      ['--profile', 'small', '--dir', 'o', '--base-url', 'https://localhost:8443/x'],
      'LOOPBACK_TEST_TARGET_REQUIRED',
    ],
    [
      ['--profile', 'small', '--dir', 'o', '--base-url', 'not a url'],
      'LOOPBACK_TEST_TARGET_REQUIRED',
    ],
    [
      [
        '--profile',
        'small',
        '--dir',
        'o',
        '--base-url',
        'https://localhost:8443',
        '--release',
        'a b',
      ],
      'RELEASE_REF_INVALID',
    ],
  ])('refuses %j', (args, code) => {
    expect(() => parseLocalCommand(args)).toThrow(code);
  });

  it('refuses an option it does not know', () => {
    expect(() =>
      parseLocalCommand([
        '--profile',
        'small',
        '--base-url',
        'https://localhost:8443',
        '--dir',
        'o',
        '--target',
        'x',
      ]),
    ).toThrow();
  });

  it('writes a context that run.mjs accepts, from this machine alone', () => {
    const context = hostContext(
      {
        cpus: [{ model: 'Intel(R) Core(TM) i7 @ 2.80GHz' }, {}],
        totalmem: 16 * 1024 ** 3,
        platform: 'linux',
        arch: 'x64',
        release: '6.8.0-45-generic',
      },
      'local',
    );
    expect(context.hardware).toEqual({
      cpuModelRef: 'Intel-R-Core-TM-i7-2.80GHz',
      logicalCpus: 2,
      memoryBytes: 16 * 1024 ** 3,
      osRef: 'linux-x64-6.8.0-45-generic',
    });
    const profile = validateProfile(profiles.small);
    const tenants = [
      {
        organizationId: '11111111-1111-4111-8111-111111111111',
        actors: Array.from({ length: profile.concurrencyPerTenant }, (_, index) => ({
          userId: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
          email: `load-${index}@example.invalid`,
          cookie: `test_session=generated-${index}`,
        })),
      },
    ];
    expect(() =>
      validateTarget(profile, {
        baseUrl: 'https://localhost:8443',
        tenants,
        generated: true,
        context,
      }),
    ).not.toThrow();
  });

  it('never leaves a reference empty or unsafe', () => {
    expect(machineRef(undefined)).toBe('unknown');
    expect(machineRef('  ')).toBe('unknown');
    expect(machineRef('a/b\\c d')).toBe('a-b-c-d');
    expect(machineRef('x'.repeat(500))).toHaveLength(120);
  });
});

describe('the documented local profiles', () => {
  const files = readdirSync(PROFILE_FILES).filter((name) => name.endsWith('.json'));

  it('exist', () => {
    expect(files).toEqual(expect.arrayContaining(['local-smoke.json', 'local-sustained.json']));
  });

  it.each(files)('%s is valid on top of every built-in profile', (file) => {
    const overrides = JSON.parse(readFileSync(join(PROFILE_FILES, file), 'utf8'));
    for (const base of Object.values(profiles))
      expect(() => validateProfile({ ...base, ...overrides })).not.toThrow();
  });

  it('is documented, with the command that runs it', () => {
    const readme = readFileSync(join(repoRoot, 'tests', 'load', 'README.md'), 'utf8');
    expect(readme).toContain('tests/load/local.mjs');
    for (const file of files) expect(readme).toContain(file);
  });
});
