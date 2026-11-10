// OPS-03, OPS-11: every row of what an install is allowed to do, then the tool that carries it out and the
// script that builds what it reads. Docker here is a double that lives in this file and records every call,
// so nothing runs and no registry could be reached. tests/stack/bundle-upgrade.test.ts is the real thing.
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUNDLE_MANIFEST_FILE,
  KNOWN_ROLLBACK_CONSTRAINTS,
  planInstall,
  verifyBundleDirectory,
  type InstallationRecord,
} from '@ensemus/sovereign/bundle';
import { bundleManifestSchema, type BundleManifest } from '@ensemus/sovereign/documents';
import {
  generateTestSigningKey,
  signForTest,
  testLicense,
  testMaintenance,
  testTrustRootText,
} from '@ensemus/sovereign/testing';
import {
  BundleBuildError,
  buildBundle,
  ROLLBACK_CONSTRAINT_CODES,
  thirdPartyImages,
} from '../../infrastructure/scripts/build-bundle.mjs';
import { runInstallBundle } from '../../workers/workflow/src/tools/install-bundle';
import { runVerifyBundle } from '../../workers/workflow/src/tools/verify-bundle';
import { repoRoot } from '../helpers/stack';

const WEB = `sha256:${'a'.repeat(64)}`;
const WORKER = `sha256:${'b'.repeat(64)}`;
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

const signer = generateTestSigningKey('bundle-key');
const trustRootText = testTrustRootText([signer]);

const FILES: Record<string, { text: string; role: string }> = {
  'images/web.tar': { text: 'web archive', role: 'image' },
  'images/worker.tar': { text: 'worker archive', role: 'image' },
  'compose/compose.yaml': { text: 'services: {}\n', role: 'compose' },
  'compose/compose.sovereign.yaml': { text: 'services: {}\n', role: 'compose' },
};

type ManifestOptions = {
  version?: string;
  upgradeFrom?: string[];
  rollbackTo?: string[];
  constraints?: string[];
  security?: boolean;
  publishedOn?: string;
  extraFiles?: Record<string, { text: string; role: string }>;
};

function manifestFor(options: ManifestOptions = {}): BundleManifest {
  const version = options.version ?? '2.0.1';
  const files = { ...FILES, ...options.extraFiles };
  return bundleManifestSchema.parse({
    format: 'ensemus.bundle',
    format_version: 1,
    bundle_id: '6f1c2c6e-3333-4333-8333-333333333333',
    issued_at: '2027-02-01T00:00:00.000Z',
    release: {
      version,
      line: version.split('.').slice(0, 2).join('.'),
      kind: 'patch',
      security: options.security ?? false,
      published_on: options.publishedOn ?? '2027-02-01',
      git_commit: 'c'.repeat(40),
    },
    files: Object.entries(files).map(([path, { text, role }]) => ({
      path,
      sha256: sha256(text),
      bytes: Buffer.byteLength(text),
      role,
    })),
    images: [
      { name: 'web', digest: WEB, file: 'images/web.tar' },
      { name: 'worker', digest: WORKER, file: 'images/worker.tar' },
    ],
    compatibility: {
      upgrade_from: options.upgradeFrom ?? ['2.0.0'],
      rollback_to: options.rollbackTo ?? ['2.0.0'],
      rollback_constraints: options.constraints ?? [],
      database_schema_version: '0301_sovereign_security.sql',
      workflow_compatibility: 'replay corpus of this release',
      node_version: '24',
    },
    models: [],
  });
}

const kinds = (plan: ReturnType<typeof planInstall>) =>
  plan.ok ? plan.steps.map((step) => step.kind) : [];

const IMAGE_STEPS = [
  'load_image',
  'check_image_digest',
  'load_image',
  'check_image_digest',
] as const;

describe('planInstall', () => {
  const plan = (
    bundle: ManifestOptions,
    installed: { version: string; rollback_to: string[] } | null,
    rollbackRequested = false,
    onInstall: 'proceed' | 'warn' | 'refuse' | null = 'proceed',
  ) => planInstall({ manifest: manifestFor(bundle), installed, rollbackRequested, onInstall });

  it('treats nothing installed as an install, with every step in order', () => {
    const result = plan({}, null);
    expect(result).toMatchObject({ ok: true, direction: 'install' });
    expect(kinds(result)).toEqual([
      'verify_bundle',
      'require_backup',
      ...IMAGE_STEPS,
      'stop_services',
      'run_migrations',
      'start_services',
      'smoke_test',
      'record_installation',
    ]);
  });

  it('upgrades from a version the bundle lists', () => {
    const result = plan({ version: '2.0.1' }, { version: '2.0.0', rollback_to: [] });
    expect(result).toMatchObject({ ok: true, direction: 'upgrade' });
    expect(kinds(result)).not.toContain('restore_backup');
  });

  it('refuses an upgrade from a version the bundle does not list', () => {
    expect(
      plan({ version: '2.2.0', upgradeFrom: ['2.1.0'] }, { version: '2.0.0', rollback_to: [] }),
    ).toEqual({ ok: false, code: 'UPGRADE_PATH_NOT_LISTED' });
  });

  it('compares versions as numbers, so 2.10.0 is newer than 2.9.0', () => {
    expect(
      plan({ version: '2.10.0', upgradeFrom: ['2.9.0'] }, { version: '2.9.0', rollback_to: [] }),
    ).toMatchObject({ ok: true, direction: 'upgrade' });
    expect(plan({ version: '2.9.0' }, { version: '2.10.0', rollback_to: [] })).toEqual({
      ok: false,
      code: 'ROLLBACK_NOT_REQUESTED',
    });
  });

  it('refuses the same version', () => {
    expect(plan({ version: '2.0.1' }, { version: '2.0.1', rollback_to: ['2.0.1'] })).toEqual({
      ok: false,
      code: 'SAME_VERSION',
    });
  });

  it('refuses an old bundle replayed as an upgrade, however good its signature', () => {
    // The old bundle lists everything it can, and it does not help: nobody asked to go back.
    expect(
      plan(
        { version: '2.0.0', upgradeFrom: ['2.0.1', '2.0.2'], rollbackTo: ['2.0.1', '2.0.2'] },
        { version: '2.0.2', rollback_to: ['2.0.0'] },
      ),
    ).toEqual({ ok: false, code: 'ROLLBACK_NOT_REQUESTED' });
  });

  it('refuses a rollback the version going away does not list, whatever the bundle says', () => {
    expect(
      plan(
        { version: '2.0.0', upgradeFrom: ['2.0.2'], rollbackTo: ['2.0.2'] },
        { version: '2.0.2', rollback_to: ['2.0.1'] },
        true,
      ),
    ).toEqual({ ok: false, code: 'ROLLBACK_NOT_LISTED' });
  });

  it('allows a rollback that was asked for and is listed, and makes it restore the backup', () => {
    const result = plan({ version: '2.0.0' }, { version: '2.0.1', rollback_to: ['2.0.0'] }, true);
    expect(result).toMatchObject({ ok: true, direction: 'rollback' });
    const steps = kinds(result);
    expect(steps.indexOf('stop_services')).toBeLessThan(steps.indexOf('restore_backup'));
    expect(steps.indexOf('restore_backup')).toBeLessThan(steps.indexOf('run_migrations'));
  });

  it('ignores a rollback request where nothing is going back, leaving that to the tool', () => {
    expect(plan({}, null, true)).toMatchObject({ ok: true, direction: 'install' });
  });

  it.each([
    ['install', {}, null, false],
    ['upgrade', {}, { version: '2.0.0', rollback_to: [] }, false],
    ['rollback', { version: '2.0.0' }, { version: '2.0.1', rollback_to: ['2.0.0'] }, true],
  ] as const)('on %s, puts rights where they belong', (direction, bundle, installed, back) => {
    const widened = installed && { ...installed, rollback_to: [...installed.rollback_to] };

    expect(plan(bundle, widened, back, 'refuse')).toEqual({
      ok: false,
      code: 'OUTSIDE_RIGHTS_REFUSED',
    });

    const warned = plan(bundle, widened, back, 'warn');
    expect(warned).toMatchObject({ ok: true, direction });
    expect(kinds(warned).slice(0, 3)).toEqual([
      'verify_bundle',
      'confirm_outside_rights',
      'require_backup',
    ]);

    for (const quiet of ['proceed', null] as const) {
      const result = plan(bundle, widened, back, quiet);
      expect(result).toMatchObject({ ok: true, direction });
      expect(kinds(result)).not.toContain('confirm_outside_rights');
    }
  });

  it('says what is wrong with the version before anything about rights', () => {
    expect(
      plan({ version: '2.0.1' }, { version: '2.0.1', rollback_to: [] }, false, 'refuse'),
    ).toEqual({ ok: false, code: 'SAME_VERSION' });
  });

  it.each([
    ['install', {}, null, false, 'proceed'],
    ['upgrade', {}, { version: '2.0.0', rollback_to: [] }, false, null],
    ['rollback', { version: '2.0.0' }, { version: '2.0.1', rollback_to: ['2.0.0'] }, true, 'warn'],
  ] as const)(
    'on %s, backs up before migrating, and checks images before stopping anything',
    (_direction, bundle, installed, back, onInstall) => {
      const steps = kinds(
        plan(
          bundle,
          installed && { ...installed, rollback_to: [...installed.rollback_to] },
          back,
          onInstall,
        ),
      );
      expect(steps.indexOf('require_backup')).toBeGreaterThan(-1);
      expect(steps.indexOf('require_backup')).toBeLessThan(steps.indexOf('run_migrations'));
      expect(steps.lastIndexOf('check_image_digest')).toBeLessThan(steps.indexOf('stop_services'));
      expect(steps.at(-1)).toBe('record_installation');
    },
  );

  it('checks each image straight after loading it, and by the digest the manifest signed', () => {
    const result = plan({}, null);
    if (!result.ok) throw new Error('expected a plan');
    const images = result.steps.filter(
      (step) => step.kind === 'load_image' || step.kind === 'check_image_digest',
    );
    expect(images).toEqual([
      { kind: 'load_image', name: 'web', file: 'images/web.tar', digest: WEB },
      { kind: 'check_image_digest', name: 'web', digest: WEB },
      { kind: 'load_image', name: 'worker', file: 'images/worker.tar', digest: WORKER },
      { kind: 'check_image_digest', name: 'worker', digest: WORKER },
    ]);
  });
});

// The tools, with real files and a recording double for Docker.

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const tempFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), 'ensemus-install-'));
  folders.push(folder);
  return folder;
};

function writeBundle(options: ManifestOptions = {}, document?: object) {
  const folder = tempFolder();
  for (const [path, { text }] of Object.entries({ ...FILES, ...options.extraFiles })) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  writeFileSync(
    join(folder, BUNDLE_MANIFEST_FILE),
    signForTest('bundle', document ?? manifestFor(options), [signer]),
  );
  return folder;
}

type DockerOptions = {
  /** What an archive really holds, whatever the manifest says. */
  loadedId?: (file: string) => string;
  fail?: (args: readonly string[]) => boolean;
  running?: (release: string) => object[];
};

function fakeDocker(options: DockerOptions = {}) {
  const calls: string[][] = [];
  const environments: Record<string, string>[] = [];
  const idOf = (file: string) => (file.includes('worker') ? WORKER : WEB);
  return {
    calls,
    environments,
    composeCalls: () => calls.filter((args) => args[0] === 'compose'),
    docker: async (args: readonly string[], env: Readonly<Record<string, string>>) => {
      calls.push([...args]);
      environments.push({ ...env });
      if (options.fail?.(args)) return { status: 1, stdout: '' };
      if (args[0] === 'load') {
        const id = (options.loadedId ?? idOf)(String(args[2]));
        return { status: 0, stdout: `Loaded image ID: ${id}\n` };
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        return { status: 0, stdout: `${String(args.at(-1))}\n` };
      }
      if (args[0] === 'inspect') {
        return { status: 0, stdout: `${String(args.at(-1)) === 'cworker' ? WORKER : WEB}\n` };
      }
      if (args.includes('ps')) {
        const release = env.ENSEMUS_RELEASE ?? '';
        const running = options.running?.(release) ?? [
          {
            Service: 'web',
            ID: 'cweb',
            State: 'running',
            Health: 'healthy',
            Image: `ensemus-sovereign/web:${release}`,
          },
          {
            Service: 'worker',
            ID: 'cworker',
            State: 'running',
            Health: '',
            Image: `ensemus-sovereign/worker:${release}`,
          },
        ];
        return { status: 0, stdout: running.map((row) => JSON.stringify(row)).join('\n') };
      }
      return { status: 0, stdout: '' };
    },
  };
}

function setup() {
  const home = tempFolder();
  const trustRoot = join(home, 'trust-root.json');
  writeFileSync(trustRoot, trustRootText);
  return { home, trustRoot, state: join(home, 'state') };
}

async function install(
  folder: string,
  env: ReturnType<typeof setup>,
  extra: string[] = ['--operator', 'test operator', '--backup-reference', 'backup-1'],
  docker = fakeDocker(),
) {
  const lines: string[] = [];
  const status = await runInstallBundle(
    [folder, '--trust-root', env.trustRoot, '--state-dir', env.state, ...extra],
    {
      docker: docker.docker,
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      now: () => new Date('2027-06-01T00:00:00.000Z'),
    },
  );
  return { status, output: lines.join('\n'), docker };
}

const recordsIn = (state: string) =>
  existsSync(join(state, 'installation-record.jsonl'))
    ? readFileSync(join(state, 'installation-record.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as InstallationRecord)
    : [];

describe('install-bundle --dry-run', () => {
  it('prints the plan, and calls no Docker and writes nothing', async () => {
    const env = setup();
    const { status, output, docker } = await install(writeBundle(), env, ['--dry-run']);
    expect(status).toBe(0);
    for (const step of ['verify_bundle', 'require_backup', 'load_image', 'run_migrations']) {
      expect(output).toContain(step);
    }
    expect(docker.calls).toEqual([]);
    expect(existsSync(env.state)).toBe(false);
  });

  it('says the bundle was signed with a test key', async () => {
    const { output } = await install(writeBundle(), setup(), ['--dry-run']);
    expect(output).toMatch(/generated test key/i);
  });

  it('tells the operator the rollback limits before an upgrade, explained, and unknown ones too', async () => {
    const { output } = await install(
      writeBundle({ constraints: ['MIGRATIONS_NOT_REVERSIBLE', 'SOME_LATER_CODE'] }),
      setup(),
      ['--dry-run'],
    );
    expect(output).toContain('MIGRATIONS_NOT_REVERSIBLE');
    expect(output).toContain(KNOWN_ROLLBACK_CONSTRAINTS.MIGRATIONS_NOT_REVERSIBLE);
    expect(output).toContain('SOME_LATER_CODE');
  });

  it('refuses a changed bundle the same way a real run would', async () => {
    const folder = writeBundle();
    appendFileSync(join(folder, 'images/web.tar'), 'x');
    const { status, output } = await install(folder, setup(), ['--dry-run']);
    expect(status).toBe(1);
    expect(output).toContain('FILE_CHANGED');
  });
});

describe('where the trust root comes from', () => {
  it('needs --trust-root, and there is no other way to give one', async () => {
    const env = setup();
    const lines: string[] = [];
    const status = await runInstallBundle([writeBundle(), '--state-dir', env.state, '--dry-run'], {
      docker: fakeDocker().docker,
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      now: () => new Date(),
    });
    expect(status).toBe(2);
    expect(lines.join('\n')).toContain('--trust-root');
  });

  it('refuses one found inside the bundle, before believing it', async () => {
    const folder = writeBundle();
    const env = setup();
    const inside = join(folder, 'trust-root.json');
    writeFileSync(inside, trustRootText);
    const result = await install(folder, { ...env, trustRoot: inside }, ['--dry-run']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('TRUST_ROOT_INSIDE_BUNDLE');
  });

  it('refuses a trust root it cannot read, rather than going on unsigned', async () => {
    const env = setup();
    writeFileSync(env.trustRoot, 'not a trust root');
    const result = await install(writeBundle(), env, ['--dry-run']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('TRUST_ROOT_UNREADABLE');
  });

  it('refuses a state folder inside the bundle', async () => {
    const folder = writeBundle();
    const env = setup();
    const result = await install(folder, { ...env, state: join(folder, 'state') }, ['--dry-run']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('STATE_INSIDE_BUNDLE');
  });
});

describe('verify-bundle', () => {
  const verify = async (args: string[]) => {
    const lines: string[] = [];
    const status = await runVerifyBundle(args, {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    });
    return { status, output: lines.join('\n') };
  };

  it('accepts a good bundle, and says what it checked', async () => {
    const { trustRoot } = setup();
    const { status, output } = await verify([writeBundle(), '--trust-root', trustRoot]);
    expect(status).toBe(0);
    expect(output).toContain('2.0.1');
    expect(output).toMatch(/generated test key/i);
  });

  it('refuses a changed bundle with its code, and a manifest with its reason', async () => {
    const { trustRoot } = setup();
    const folder = writeBundle();
    writeFileSync(join(folder, 'extra.txt'), 'x');
    expect(await verify([folder, '--trust-root', trustRoot])).toMatchObject({ status: 1 });
    expect((await verify([folder, '--trust-root', trustRoot])).output).toContain('FILE_NOT_LISTED');

    const stranger = writeBundle();
    writeFileSync(
      join(stranger, BUNDLE_MANIFEST_FILE),
      signForTest('bundle', manifestFor(), [generateTestSigningKey('stranger')]),
    );
    const refused = await verify([stranger, '--trust-root', trustRoot]);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('MANIFEST_REFUSED');
    expect(refused.output).toContain('UNKNOWN_KEY');
  });

  it('needs --trust-root, and refuses one inside the folder', async () => {
    expect((await verify([writeBundle()])).status).toBe(2);
    const folder = writeBundle();
    const inside = join(folder, 'root.json');
    writeFileSync(inside, trustRootText);
    const refused = await verify([folder, '--trust-root', inside]);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('TRUST_ROOT_INSIDE_BUNDLE');
  });
});

describe('carrying out an install', () => {
  it('runs every step, appends one record, and remembers what is now installed', async () => {
    const env = setup();
    const { status, docker, output } = await install(writeBundle(), env);
    expect(output).not.toContain('stopped code=');
    expect(status).toBe(0);

    expect(recordsIn(env.state)).toEqual([
      {
        recorded_at: '2027-06-01T00:00:00.000Z',
        direction: 'install',
        bundle_id: '6f1c2c6e-3333-4333-8333-333333333333',
        version: '2.0.1',
        images: [
          { name: 'web', digest: WEB },
          { name: 'worker', digest: WORKER },
        ],
        license_id: null,
        update_right: 'no_license',
        operator: 'test operator',
        backup_reference: 'backup-1',
      },
    ]);
    expect(readdirSync(env.state).sort()).toEqual([
      'installation-record.jsonl',
      'installed-bundle-manifest.dsse.json',
    ]);

    const order = docker.calls.map((args) => (args[0] === 'compose' ? args.at(-1) : args[0]));
    expect(order.indexOf('load')).toBeLessThan(order.indexOf('stop'));
    expect(docker.environments.at(-1)).toMatchObject({ ENSEMUS_RELEASE: '2.0.1' });
  });

  it('never gives Docker a command that could reach a registry', async () => {
    const env = setup();
    const { docker } = await install(writeBundle(), env);
    expect(docker.calls.length).toBeGreaterThan(0);
    for (const args of docker.calls) {
      expect(args).not.toContain('pull');
      expect(args).not.toContain('push');
      expect(args).not.toContain('login');
      expect(args).not.toContain('--build');
      expect(['load', 'image', 'tag', 'inspect', 'compose']).toContain(args[0]);
      if (args[0] === 'image') expect(args[1]).toBe('inspect');
    }
    const starts = docker
      .composeCalls()
      .filter((args) => args.includes('up') || args.includes('run'));
    expect(starts.length).toBe(2);
    for (const args of starts) {
      expect(args.slice(args.indexOf('--pull'), args.indexOf('--pull') + 2)).toEqual([
        '--pull',
        'never',
      ]);
    }
    expect(docker.composeCalls().find((args) => args.includes('up'))).toContain('--no-build');
  });

  it('stops on a loaded image that is not the one signed, before anything starts', async () => {
    const env = setup();
    const docker = fakeDocker({
      loadedId: (file) => (file.includes('worker') ? `sha256:${'9'.repeat(64)}` : WEB),
    });
    const { status, output } = await install(writeBundle(), env, undefined, docker);
    expect(status).toBe(1);
    expect(output).toContain('IMAGE_DIGEST_DIFFERS');
    expect(output).toContain('worker');
    // Nothing touched the running stack, nothing got the release's name, and nothing was recorded.
    expect(docker.composeCalls()).toEqual([]);
    expect(docker.calls.filter((args) => args[0] === 'tag').map((args) => args[1])).toEqual([WEB]);
    expect(recordsIn(env.state)).toEqual([]);
    expect(output).toMatch(/running version was not touched/i);
  });

  it('stops when an archive holds a second image beside the signed one', async () => {
    const env = setup();
    const docker = fakeDocker();
    const original = docker.docker;
    docker.docker = async (args, environment) => {
      if (args[0] === 'load') {
        docker.calls.push([...args]);
        return {
          status: 0,
          stdout: `Loaded image ID: ${WEB}\nLoaded image: planted/image:latest\n`,
        };
      }
      return original(args, environment);
    };
    const { status, output } = await install(writeBundle(), env, undefined, docker);
    expect(status).toBe(1);
    expect(output).toContain('IMAGE_DIGEST_DIFFERS');
    expect(docker.composeCalls()).toEqual([]);
  });

  it('stops when docker load says nothing it can read', async () => {
    const env = setup();
    const docker = fakeDocker({ loadedId: () => 'not a line anyone expects' });
    const original = docker.docker;
    docker.docker = async (args, environment) =>
      args[0] === 'load' ? { status: 0, stdout: 'done\n' } : original(args, environment);
    const { status, output } = await install(writeBundle(), env, undefined, docker);
    expect(status).toBe(1);
    expect(output).toContain('IMAGE_NOT_CONFIRMED');
    expect(docker.composeCalls()).toEqual([]);
  });

  it('stops without a named backup, before loading anything', async () => {
    const env = setup();
    const { status, output, docker } = await install(writeBundle(), env, [
      '--operator',
      'test operator',
    ]);
    expect(status).toBe(1);
    expect(output).toContain('BACKUP_REQUIRED');
    expect(docker.calls).toEqual([]);
  });

  it('says plainly that it takes the backup on trust', async () => {
    const { output } = await install(writeBundle(), setup());
    expect(output).toMatch(/cannot check/i);
  });

  it('needs an operator for a real run', async () => {
    const { status, output, docker } = await install(writeBundle(), setup(), [
      '--backup-reference',
      'backup-1',
    ]);
    expect(status).toBe(2);
    expect(output).toContain('--operator');
    expect(docker.calls).toEqual([]);
  });

  it('keeps a hostile operator name to one line of the record', async () => {
    const env = setup();
    await install(writeBundle(), env, [
      '--operator',
      'name\n{"forged":"line"}',
      '--backup-reference',
      'backup-1',
    ]);
    const lines = readFileSync(join(env.state, 'installation-record.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as InstallationRecord).operator).toBe('name\n{"forged":"line"}');
  });

  it('stops at a failed migration, says the backup is the way back, and records nothing', async () => {
    const env = setup();
    const docker = fakeDocker({ fail: (args) => args.includes('migrate') });
    const { status, output } = await install(writeBundle(), env, undefined, docker);
    expect(status).toBe(1);
    expect(output).toContain('MIGRATIONS_FAILED');
    expect(output).toContain('backup-1');
    expect(docker.composeCalls().some((args) => args.includes('up'))).toBe(false);
    expect(recordsIn(env.state)).toEqual([]);
  });

  it('fails the smoke test on a service running something the bundle did not bring', async () => {
    const env = setup();
    const docker = fakeDocker({
      running: (release) => [
        {
          Service: 'web',
          ID: 'cweb',
          State: 'running',
          Health: 'healthy',
          Image: `ensemus-sovereign/web:${release}`,
        },
        {
          Service: 'worker',
          ID: 'cworker',
          State: 'running',
          Health: '',
          Image: `ensemus-sovereign/worker:${release}`,
        },
        { Service: 'sidecar', ID: 'cside', State: 'running', Health: '', Image: 'other/image:1' },
      ],
    });
    const { status, output } = await install(writeBundle(), env, undefined, docker);
    expect(status).toBe(1);
    expect(output).toContain('SMOKE_TEST_FAILED');
    expect(recordsIn(env.state)).toEqual([]);
  });

  it.each([
    [
      'an unhealthy service',
      [
        { Service: 'web', ID: 'cweb', State: 'running', Health: 'unhealthy', Image: 'WEB' },
        { Service: 'worker', ID: 'cworker', State: 'running', Health: '', Image: 'WORKER' },
      ],
    ],
    [
      'a missing web',
      [{ Service: 'worker', ID: 'cworker', State: 'running', Health: '', Image: 'WORKER' }],
    ],
    ['nothing running', []],
    [
      'a container whose image is not the signed one under the same name',
      [
        { Service: 'web', ID: 'cworker', State: 'running', Health: '', Image: 'WEB' },
        { Service: 'worker', ID: 'cworker', State: 'running', Health: '', Image: 'WORKER' },
      ],
    ],
  ])('fails the smoke test on %s', async (_label, rows) => {
    const env = setup();
    const docker = fakeDocker({
      running: (release) =>
        rows.map((row) => ({
          ...row,
          Image:
            row.Image === 'WEB'
              ? `ensemus-sovereign/web:${release}`
              : `ensemus-sovereign/worker:${release}`,
        })),
    });
    const { status, output } = await install(writeBundle(), env, undefined, docker);
    expect(status).toBe(1);
    expect(output).toContain('SMOKE_TEST_FAILED');
  });

  it('refuses a bundle with no compose files, before touching anything', async () => {
    const env = setup();
    const folder = tempFolder();
    mkdirSync(join(folder, 'images'));
    writeFileSync(join(folder, 'images/web.tar'), 'web');
    const manifest = {
      ...manifestFor(),
      files: [{ path: 'images/web.tar', sha256: sha256('web'), bytes: 3, role: 'image' }],
      images: [{ name: 'web', digest: WEB, file: 'images/web.tar' }],
    };
    writeFileSync(join(folder, BUNDLE_MANIFEST_FILE), signForTest('bundle', manifest, [signer]));
    const { status, output, docker } = await install(folder, env);
    expect(status).toBe(1);
    expect(output).toContain('COMPOSE_FILES_NOT_LISTED');
    expect(docker.calls).toEqual([]);
  });
});

describe('upgrades and rollbacks through the tool', () => {
  const OLD = { version: '2.0.0', upgradeFrom: [], rollbackTo: [] };
  const NEW = { version: '2.0.1', upgradeFrom: ['2.0.0'], rollbackTo: ['2.0.0'] };

  async function installedOld() {
    const env = setup();
    expect((await install(writeBundle(OLD), env)).status).toBe(0);
    return env;
  }

  it('upgrades from what the state folder says is installed, and appends', async () => {
    const env = await installedOld();
    expect((await install(writeBundle(NEW), env)).status).toBe(0);
    expect(recordsIn(env.state).map((record) => [record.direction, record.version])).toEqual([
      ['install', '2.0.0'],
      ['upgrade', '2.0.1'],
    ]);
  });

  it('refuses the same bundle twice, and changes nothing', async () => {
    const env = await installedOld();
    const { status, output, docker } = await install(writeBundle(OLD), env);
    expect(status).toBe(1);
    expect(output).toContain('SAME_VERSION');
    expect(docker.calls).toEqual([]);
    expect(recordsIn(env.state)).toHaveLength(1);
  });

  it('refuses an old bundle replayed as an upgrade, and the new version stays', async () => {
    const env = await installedOld();
    await install(writeBundle(NEW), env);
    const replay = await install(writeBundle(OLD), env);
    expect(replay.status).toBe(1);
    expect(replay.output).toContain('ROLLBACK_NOT_REQUESTED');
    expect(replay.docker.calls).toEqual([]);
    expect(recordsIn(env.state).at(-1)?.version).toBe('2.0.1');
  });

  it('stops a rollback at the restore until a person says it is done, then finishes', async () => {
    const env = await installedOld();
    await install(writeBundle(NEW), env);
    const args = ['--rollback', '--operator', 'test operator', '--backup-reference', 'backup-1'];

    const waiting = await install(writeBundle(OLD), env, args);
    expect(waiting.status).toBe(1);
    expect(waiting.output).toContain('RESTORE_REQUIRED');
    expect(waiting.output).toContain('backup-1');
    expect(waiting.docker.composeCalls().some((call) => call.includes('stop'))).toBe(true);
    expect(waiting.docker.composeCalls().some((call) => call.includes('migrate'))).toBe(false);
    expect(waiting.docker.composeCalls().some((call) => call.includes('up'))).toBe(false);
    expect(recordsIn(env.state).at(-1)?.version).toBe('2.0.1');

    const done = await install(writeBundle(OLD), env, [...args, '--backup-restored']);
    expect(done.status).toBe(0);
    expect(recordsIn(env.state).map((record) => [record.direction, record.version])).toEqual([
      ['install', '2.0.0'],
      ['upgrade', '2.0.1'],
      ['rollback', '2.0.0'],
    ]);
  });

  it('shows the limits of the version going away on a rollback', async () => {
    const env = setup();
    await install(writeBundle(OLD), env);
    await install(writeBundle({ ...NEW, constraints: ['PLAN_RUNS_MUST_DRAIN'] }), env);
    const { output } = await install(writeBundle(OLD), env, ['--dry-run', '--rollback']);
    expect(output).toContain('PLAN_RUNS_MUST_DRAIN');
  });

  it('refuses --rollback when the bundle is not going back', async () => {
    const env = await installedOld();
    const { status, output, docker } = await install(writeBundle(NEW), env, [
      '--rollback',
      '--operator',
      'test operator',
      '--backup-reference',
      'backup-1',
    ]);
    expect(status).toBe(1);
    expect(output).toContain('NOT_A_ROLLBACK');
    expect(docker.calls).toEqual([]);
  });

  it('refuses to guess when the record says something is installed and the manifest is gone', async () => {
    const env = await installedOld();
    rmSync(join(env.state, 'installed-bundle-manifest.dsse.json'));
    const { status, output, docker } = await install(writeBundle(OLD), env);
    expect(status).toBe(1);
    expect(output).toContain('INSTALLED_STATE_MISSING');
    expect(docker.calls).toEqual([]);
  });

  it('refuses an installed manifest the trust root does not accept', async () => {
    const env = await installedOld();
    writeFileSync(
      join(env.state, 'installed-bundle-manifest.dsse.json'),
      signForTest('bundle', manifestFor(OLD), [generateTestSigningKey('stranger')]),
    );
    const { status, output, docker } = await install(writeBundle(NEW), env);
    expect(status).toBe(1);
    expect(output).toContain('INSTALLED_MANIFEST_REFUSED');
    expect(docker.calls).toEqual([]);
  });
});

describe('update rights at install', () => {
  const rights = (outside: 'warn' | 'refuse') => ({
    update_rights: {
      security_patches_after_lapse: 'none',
      major_versions_with_maintenance: 'separate_purchase',
      releases_published_during_maintenance: 'kept_after_lapse',
      outside_rights_on_install: outside,
    },
  });

  function licensed(outside: 'warn' | 'refuse', maintenance = false) {
    const env = setup();
    const license = join(env.home, 'license.dsse.json');
    writeFileSync(license, signForTest('license', testLicense(rights(outside)), [signer]));
    const args = ['--license', license];
    if (maintenance) {
      const agreement = join(env.home, 'maintenance.dsse.json');
      writeFileSync(
        agreement,
        signForTest('maintenance', testMaintenance({ starts_on: '2027-01-01' }), [signer]),
      );
      args.push('--maintenance', agreement);
    }
    return { env, args };
  }
  const REAL = ['--operator', 'test operator', '--backup-reference', 'backup-1'];

  it('proceeds when the release was published under maintenance, and records it as covered', async () => {
    const { env, args } = licensed('refuse', true);
    const { status } = await install(writeBundle(), env, [...REAL, ...args]);
    expect(status).toBe(0);
    expect(recordsIn(env.state)[0]).toMatchObject({
      update_right: 'covered',
      license_id: testLicense().license_id,
    });
  });

  it('asks for a confirmation outside rights, and stops before loading without one', async () => {
    const { env, args } = licensed('warn');
    const refused = await install(writeBundle(), env, [...REAL, ...args]);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('OUTSIDE_RIGHTS_NOT_CONFIRMED');
    expect(refused.docker.calls).toEqual([]);

    const confirmed = await install(writeBundle(), env, [
      ...REAL,
      ...args,
      '--confirm-outside-rights',
    ]);
    expect(confirmed.status).toBe(0);
    expect(recordsIn(env.state)[0]).toMatchObject({ update_right: 'outside_rights_confirmed' });
  });

  it('refuses outside rights where the license says so, touching nothing', async () => {
    const { env, args } = licensed('refuse');
    const { status, output, docker } = await install(writeBundle(), env, [...REAL, ...args]);
    expect(status).toBe(1);
    expect(output).toContain('OUTSIDE_RIGHTS_REFUSED');
    expect(docker.calls).toEqual([]);
  });

  it('counts a support policy from inside the bundle, which can only add', async () => {
    const { env, args } = licensed('refuse');
    const policy = signForTest(
      'support_policy',
      {
        format: 'ensemus.support_policy',
        format_version: 1,
        policy_id: '6f1c2c6e-4444-4444-8444-444444444444',
        issued_at: '2027-02-01T00:00:00.000Z',
        branches: [{ line: '2.0', status: 'supported' }],
        security_patches_after_lapse_grant: 'any_supported_line',
      },
      [signer],
    );
    const options = {
      security: true,
      extraFiles: { 'policy/support-policy.dsse.json': { text: policy, role: 'support_policy' } },
    };
    const { status } = await install(writeBundle(options), env, [...REAL, ...args]);
    expect(status).toBe(0);
    expect(recordsIn(env.state)[0]).toMatchObject({ update_right: 'covered' });
  });

  it('does not count a maintenance statement for another license', async () => {
    const env = setup();
    const license = join(env.home, 'license.dsse.json');
    writeFileSync(license, signForTest('license', testLicense(rights('refuse')), [signer]));
    const agreement = join(env.home, 'maintenance.dsse.json');
    writeFileSync(
      agreement,
      signForTest(
        'maintenance',
        testMaintenance({ license_id: '6f1c2c6e-9999-4999-8999-999999999999' }),
        [signer],
      ),
    );
    const { status, output } = await install(writeBundle(), env, [
      ...REAL,
      '--license',
      license,
      '--maintenance',
      agreement,
    ]);
    expect(status).toBe(1);
    expect(output).toContain('OUTSIDE_RIGHTS_REFUSED');
  });

  it('does not count a forged maintenance statement', async () => {
    const env = setup();
    const license = join(env.home, 'license.dsse.json');
    writeFileSync(license, signForTest('license', testLicense(rights('refuse')), [signer]));
    const agreement = join(env.home, 'maintenance.dsse.json');
    writeFileSync(
      agreement,
      signForTest('maintenance', testMaintenance(), [generateTestSigningKey('bundle-key')]),
    );
    const { status } = await install(writeBundle(), env, [
      ...REAL,
      '--license',
      license,
      '--maintenance',
      agreement,
    ]);
    expect(status).toBe(1);
  });

  it('treats a damaged license as none, says so, and goes on, since no file can stop this', async () => {
    const env = setup();
    const license = join(env.home, 'license.dsse.json');
    writeFileSync(license, 'damaged');
    const { status, output } = await install(writeBundle(), env, [...REAL, '--license', license]);
    expect(status).toBe(0);
    expect(output).toMatch(/could not be verified/i);
    expect(recordsIn(env.state)[0]).toMatchObject({ update_right: 'no_license', license_id: null });
  });
});

// The script that builds a bundle, with Docker doubled the same way.

describe('build-bundle', () => {
  const ID_WEB = `sha256:${'1'.repeat(64)}`;
  const ID_WORKER = `sha256:${'2'.repeat(64)}`;
  const ID_OTHER = `sha256:${'3'.repeat(64)}`;
  const COMMIT = 'd'.repeat(40);

  function buildSetup() {
    const home = tempFolder();
    const signerFile = join(home, 'signer.pem');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(signerFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const trustRoot = join(home, 'trust-root.json');
    writeFileSync(
      trustRoot,
      testTrustRootText([
        {
          keyId: 'rehearsal-key',
          privateKey,
          publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        },
      ]),
    );
    const compose = join(home, 'compose');
    mkdirSync(join(compose, 'proxy'), { recursive: true });
    mkdirSync(join(compose, 'sovereign'), { recursive: true });
    writeFileSync(
      join(compose, 'compose.yaml'),
      `services:\n  proxy:\n    image: caddy:2-alpine@sha256:${'4'.repeat(64)}\n  web:\n    image: ensemus/web:local\n`,
    );
    writeFileSync(join(compose, 'sovereign', 'compose.sovereign.yaml'), 'services: {}\n');
    writeFileSync(join(compose, 'proxy', 'Caddyfile'), ':443\n');
    const migrations = join(home, 'migrations');
    mkdirSync(join(migrations, 'meta'), { recursive: true });
    writeFileSync(join(migrations, '0001_first.sql'), 'SELECT 1;\n');
    writeFileSync(join(migrations, '0301_last.sql'), 'SELECT 2;\n');
    writeFileSync(join(migrations, 'meta', '_journal.json'), '{}\n');
    const tools = join(home, 'tools');
    mkdirSync(tools);
    writeFileSync(join(tools, 'verify-bundle.mjs'), '// built tool\n');
    const docs = join(home, 'docs');
    mkdirSync(docs);
    writeFileSync(join(docs, 'offline-bundle.md'), '# Guide\n');
    return { home, signerFile, trustRoot, compose, migrations, tools, docs };
  }

  function dockerForBuild() {
    const calls: string[][] = [];
    return {
      calls,
      docker: async (args: readonly string[]) => {
        calls.push([...args]);
        if (args[0] === 'image' && args[1] === 'inspect') {
          const ref = String(args.at(-1));
          if (ref.includes('worker')) return { status: 0, stdout: `${ID_WORKER}\n` };
          if (ref.includes('web')) return { status: 0, stdout: `${ID_WEB}\n` };
          return { status: 0, stdout: `${ID_OTHER}\n` };
        }
        if (args[0] === 'save') {
          writeFileSync(String(args[2]), `archive of ${String(args[3])}`);
          return { status: 0, stdout: '' };
        }
        return { status: 1, stdout: '' };
      },
    };
  }

  const optionsFor = (paths: ReturnType<typeof buildSetup>, overrides: object = {}) => ({
    version: '2.0.1',
    line: '2.0',
    kind: 'patch',
    security: false,
    publishedOn: '2027-02-01',
    gitCommit: COMMIT,
    outDir: join(paths.home, 'bundle'),
    signerFile: paths.signerFile,
    keyId: 'rehearsal-key',
    images: [
      { name: 'web', ref: 'ensemus/web:local' },
      { name: 'worker', ref: 'ensemus/worker:local' },
    ],
    upgradeFrom: ['2.0.0'],
    rollbackTo: ['2.0.0'],
    rollbackConstraints: ['MIGRATIONS_NOT_REVERSIBLE'],
    workflowCompatibility: 'replay corpus of this release',
    nodeVersion: '24',
    composeDir: paths.compose,
    migrationsDir: paths.migrations,
    toolsDir: paths.tools,
    docsDir: paths.docs,
    models: [],
    sboms: [],
    notices: [],
    advisories: [],
    supportPolicies: [],
    ...overrides,
  });

  const quiet = (docker: ReturnType<typeof dockerForBuild>) => ({
    docker: docker.docker,
    now: () => new Date('2027-02-01T00:00:00.000Z'),
    log: () => undefined,
  });

  it('builds a bundle the verifier accepts, saved by ID and marked as throwaway signing', async () => {
    const paths = buildSetup();
    const docker = dockerForBuild();
    const options = optionsFor(paths);
    await buildBundle(options, quiet(docker));

    const { parseTrustRoot } = await import('@ensemus/sovereign/trust-root');
    const root = parseTrustRoot(readFileSync(paths.trustRoot, 'utf8'));
    const verdict = await verifyBundleDirectory(options.outDir, root);
    expect(verdict).toMatchObject({ ok: true, testKey: true });
    if (!verdict.ok) throw new Error(verdict.code);

    expect(verdict.manifest.release.version).toBe('2.0.1');
    expect(verdict.manifest.compatibility.database_schema_version).toBe('0301_last.sql');
    expect(verdict.manifest.images.map((image) => [image.name, image.digest])).toEqual([
      ['web', ID_WEB],
      ['worker', ID_WORKER],
      ['proxy', ID_OTHER],
    ]);
    // Saved by what was inspected, so a tag that moved in between cannot change what ships.
    expect(docker.calls.filter((args) => args[0] === 'save').map((args) => args[3])).toEqual([
      ID_WEB,
      ID_WORKER,
      ID_OTHER,
    ]);
    const envelope = JSON.parse(
      readFileSync(join(options.outDir, BUNDLE_MANIFEST_FILE), 'utf8'),
    ) as {
      payload: string;
    };
    expect(Buffer.from(envelope.payload, 'base64').toString()).toContain(
      'THROWAWAY-TEST-KEY-NOT-FOR-DISTRIBUTION',
    );
    const paths_ = verdict.manifest.files.map((file) => file.path);
    expect(paths_).toContain('compose/proxy/caddyfile');
    expect(paths_).toContain('compose/compose.sovereign.yaml');
    expect(paths_).toContain('migrations/0301_last.sql');
    expect(paths_).toContain('tools/verify-bundle.mjs');
    expect(paths_).not.toContain('migrations/meta/_journal.json');
  });

  it('builds what the install tool then installs end to end', async () => {
    const paths = buildSetup();
    const docker = dockerForBuild();
    const options = optionsFor(paths);
    await buildBundle(options, quiet(docker));
    const env = { home: paths.home, trustRoot: paths.trustRoot, state: join(paths.home, 'state') };
    const { status, output } = await install(options.outDir, env, ['--dry-run']);
    expect(output).not.toContain('stopped code=');
    expect(status).toBe(0);
  });

  it.each([
    [
      'a models entry with no license reference',
      { models: [{ name: 'model-a', file: 'x' }] },
      'MODEL_WITHOUT_LICENSE_REFERENCE',
    ],
    [
      'a blank license reference',
      { models: [{ name: 'model-a', file: 'x', licenseReference: '  ' }] },
      'MODEL_WITHOUT_LICENSE_REFERENCE',
    ],
    ['a version that is not one', { version: '2.0' }, 'BAD_RELEASE_FACTS'],
    ['a commit that is not one', { gitCommit: 'main' }, 'BAD_RELEASE_FACTS'],
    [
      'an unknown rollback constraint',
      { rollbackConstraints: ['NOT_A_KNOWN_CODE'] },
      'UNKNOWN_ROLLBACK_CONSTRAINT',
    ],
    ['no images', { images: [] }, 'BAD_RELEASE_FACTS'],
    [
      'a bad image name',
      { images: [{ name: '../web', ref: 'ensemus/web:local' }] },
      'BAD_RELEASE_FACTS',
    ],
  ])('refuses %s, with no Docker call', async (_label, overrides, code) => {
    const paths = buildSetup();
    const docker = dockerForBuild();
    await expect(buildBundle(optionsFor(paths, overrides), quiet(docker))).rejects.toMatchObject({
      code,
    });
    expect(docker.calls).toEqual([]);
  });

  it('carries a model only with its license reference, listed under its own role', async () => {
    const paths = buildSetup();
    const weights = join(paths.home, 'weights.bin');
    writeFileSync(weights, 'weights');
    const options = optionsFor(paths, {
      models: [{ name: 'model-a', file: weights, licenseReference: 'LICENSE-REF-1' }],
    });
    const { manifest } = await buildBundle(options, quiet(dockerForBuild()));
    expect(manifest.models).toEqual([
      { name: 'model-a', file: 'models/weights.bin', license_reference: 'LICENSE-REF-1' },
    ]);
    expect(
      manifest.files.find((file: { path: string }) => file.path === 'models/weights.bin'),
    ).toMatchObject({
      role: 'model',
    });
  });

  it('refuses a folder that already holds something', async () => {
    const paths = buildSetup();
    const out = join(paths.home, 'bundle');
    mkdirSync(out);
    writeFileSync(join(out, 'old.txt'), 'x');
    await expect(buildBundle(optionsFor(paths), quiet(dockerForBuild()))).rejects.toMatchObject({
      code: 'OUT_NOT_EMPTY',
    });
  });

  it('refuses a signer inside the bundle, which would ship the key', async () => {
    const paths = buildSetup();
    const out = join(paths.home, 'bundle');
    mkdirSync(out);
    const signerFile = join(out, 'signer.pem');
    await expect(
      buildBundle(optionsFor(paths, { signerFile }), quiet(dockerForBuild())),
    ).rejects.toMatchObject({ code: 'SIGNER_INSIDE_BUNDLE' });
  });

  it('refuses a signer that is not an Ed25519 private key', async () => {
    const paths = buildSetup();
    writeFileSync(paths.signerFile, 'not a key');
    await expect(buildBundle(optionsFor(paths), quiet(dockerForBuild()))).rejects.toBeInstanceOf(
      BundleBuildError,
    );
  });

  it('refuses to go on without the overlay, the tools or an image', async () => {
    const paths = buildSetup();
    rmSync(join(paths.compose, 'sovereign', 'compose.sovereign.yaml'));
    await expect(buildBundle(optionsFor(paths), quiet(dockerForBuild()))).rejects.toMatchObject({
      code: 'OVERLAY_MISSING',
    });

    const noTools = buildSetup();
    rmSync(join(noTools.tools, 'verify-bundle.mjs'));
    await expect(buildBundle(optionsFor(noTools), quiet(dockerForBuild()))).rejects.toMatchObject({
      code: 'TOOLS_NOT_BUILT',
    });

    const noImage = buildSetup();
    await expect(
      buildBundle(optionsFor(noImage), {
        docker: async () => ({ status: 1, stdout: '' }),
        now: () => new Date(),
        log: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_NOT_FOUND' });
  });

  it('knows a name for every third-party image the stack pins', () => {
    const compose = readFileSync(join(repoRoot, 'infrastructure/compose/compose.yaml'), 'utf8');
    const images = thirdPartyImages(compose);
    expect(images.map((image: { name: string }) => image.name).sort()).toEqual([
      'objects',
      'postgres',
      'proxy',
      'temporal',
      'temporal-admin-tools',
      'valkey',
    ]);
  });

  it('refuses a pinned image it has no name for, so nothing is left out of a bundle', () => {
    expect(() => thirdPartyImages(`image: someone/new@sha256:${'5'.repeat(64)}\n`)).toThrowError(
      BundleBuildError,
    );
  });

  it('accepts exactly the rollback codes the tools can explain', () => {
    expect([...ROLLBACK_CONSTRAINT_CODES].sort()).toEqual(
      Object.keys(KNOWN_ROLLBACK_CONSTRAINTS).sort(),
    );
  });
});
