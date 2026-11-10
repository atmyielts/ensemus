// COMM-04, OPS-03, QA-022: an offline bundle with real image archives and a real Docker. It needs the overlay
// in infrastructure/compose/sovereign/ and the images the stack was built from. It runs beside the test stack
// and never touches it, using its own Compose project name for the one place it starts Docker work. The full
// upgrade and rollback is infrastructure/scripts/bundle-rehearsal.mjs, which brings up a whole stack of its own.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUNDLE_MANIFEST_FILE, verifyBundleDirectory } from '@ensemus/sovereign/bundle';
import type { BundleManifest } from '@ensemus/sovereign/documents';
import { generateTestSigningKey, signForTest, testTrustRootText } from '@ensemus/sovereign/testing';
import { parseTrustRoot } from '@ensemus/sovereign/trust-root';
import { repoRoot } from '../helpers/stack';

const BUILD_TIMEOUT = 600_000;
const PROJECT = 'ensemus-bundle-test';
const key = generateTestSigningKey('bundle-key');

let work: string;
let bundle: string;
let trustRoot: string;
let manifest: BundleManifest;

const node = (script: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });

const tool = (name: string) => join(repoRoot, 'workers/workflow/dist/tools', name);

const docker = (...args: string[]) =>
  spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/**
 * The overlay `install-bundle` lays over compose.yaml, infrastructure/compose/sovereign/compose.sovereign.yaml.
 * build-bundle.mjs refuses with OVERLAY_MISSING without it (a refusal with its own unit test in tests/unit), so
 * a missing overlay fails the build below, and is never a reason for this not to run.
 */
describe('a bundle with real image archives', () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ensemus-bundle-stack-'));
    bundle = join(work, 'bundle');
    trustRoot = join(work, 'trust-root.json');
    const signer = join(work, 'signer.pem');
    writeFileSync(signer, key.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(trustRoot, testTrustRootText([key]));

    const tools = node(join(repoRoot, 'workers/workflow/scripts/build-sovereign-tools.mjs'), []);
    expect(tools.stderr).toBe('');
    expect(tools.status).toBe(0);

    const built = node(join(repoRoot, 'infrastructure/scripts/build-bundle.mjs'), [
      '2.0.1',
      '--signer',
      signer,
      '--key-id',
      key.keyId,
      '--out',
      bundle,
      '--line',
      '2.0',
      '--kind',
      'patch',
      '--published-on',
      '2027-01-31',
      '--git-commit',
      'a'.repeat(40),
      '--workflow-compatibility',
      'replay corpus of this commit',
      '--image',
      'web=ensemus/web:local',
      '--image',
      'worker=ensemus/worker:local',
      '--upgrade-from',
      '2.0.0',
      '--rollback-to',
      '2.0.0',
      '--rollback-constraint',
      'MIGRATIONS_NOT_REVERSIBLE',
    ]);
    expect(built.stderr).toBe('');
    expect(built.status).toBe(0);

    const verdict = await verifyBundleDirectory(
      bundle,
      parseTrustRoot(readFileSync(trustRoot, 'utf8')),
    );
    if (!verdict.ok) throw new Error(`The bundle was refused: ${verdict.code}`);
    manifest = verdict.manifest;
  }, BUILD_TIMEOUT);

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  const installArgs = (extra: string[]) => [
    bundle,
    '--trust-root',
    trustRoot,
    '--state-dir',
    join(work, 'state'),
    '--project',
    PROJECT,
    ...extra,
  ];

  it('verifies, through the built tool', { timeout: BUILD_TIMEOUT }, () => {
    const result = node(tool('verify-bundle.mjs'), [bundle, '--trust-root', trustRoot]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('accepted');
    expect(result.stdout).toMatch(/generated test key/i);
  });

  it('holds an archive for every image the stack pins, and both of ours', () => {
    expect(manifest.images.map((image) => image.name).sort()).toEqual(
      [
        'objects',
        'postgres',
        'proxy',
        'temporal',
        'temporal-admin-tools',
        'valkey',
        'web',
        'worker',
      ].sort(),
    );
  });

  it(
    'loads, from each archive, exactly the image its digest says',
    { timeout: BUILD_TIMEOUT },
    () => {
      for (const image of manifest.images) {
        const loaded = docker('load', '-i', join(bundle, ...image.file.split('/')));
        expect(loaded.status).toBe(0);
        const references = [...loaded.stdout.matchAll(/^Loaded image(?: ID)?: (\S+)\s*$/gm)].map(
          (match) => match[1] as string,
        );
        expect(references.length).toBeGreaterThan(0);
        for (const reference of references) {
          const id = docker('image', 'inspect', '--format', '{{.Id}}', reference).stdout.trim();
          expect(id).toBe(image.digest);
        }
      }
    },
  );

  it('dry-runs with no Docker on the path at all', { timeout: BUILD_TIMEOUT }, () => {
    const result = node(tool('install-bundle.mjs'), installArgs(['--dry-run']), {
      ...process.env,
      PATH: '',
      Path: '',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('load_image');
    expect(result.stdout).toContain('no Docker was called');
    expect(existsSync(join(work, 'state'))).toBe(false);
  });

  it(
    'stops on a digest that differs, with nothing started and nothing recorded',
    { timeout: BUILD_TIMEOUT },
    () => {
      const manifestPath = join(bundle, BUNDLE_MANIFEST_FILE);
      const good = readFileSync(manifestPath);
      const wrong = structuredClone(manifest) as BundleManifest;
      const [first] = wrong.images;
      if (!first) throw new Error('A bundle has at least one image');
      first.digest = `sha256:${'0'.repeat(64)}`;
      writeFileSync(manifestPath, signForTest('bundle', wrong, [key]));
      try {
        const result = node(
          tool('install-bundle.mjs'),
          installArgs(['--operator', 'stack test', '--backup-reference', 'none']),
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('IMAGE_DIGEST_DIFFERS');
        expect(result.stderr).toMatch(/running version was not touched/i);
        const containers = docker(
          'ps',
          '-aq',
          '--filter',
          `label=com.docker.compose.project=${PROJECT}`,
        );
        expect(containers.stdout.trim()).toBe('');
        expect(existsSync(join(work, 'state', 'installation-record.jsonl'))).toBe(false);
      } finally {
        writeFileSync(manifestPath, good);
      }
    },
  );

  it('refuses a real archive changed by one byte', { timeout: BUILD_TIMEOUT }, async () => {
    const [image] = manifest.images;
    if (!image) throw new Error('A bundle has at least one image');
    const file = join(bundle, ...image.file.split('/'));
    const original = readFileSync(file);
    const changed = Buffer.from(original);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    writeFileSync(file, changed);
    try {
      const result = node(tool('verify-bundle.mjs'), [bundle, '--trust-root', trustRoot]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('FILE_CHANGED');
    } finally {
      writeFileSync(file, original);
    }
  });
});
