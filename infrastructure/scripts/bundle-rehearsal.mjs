#!/usr/bin/env node
// OPS-03, OPS-11, QA-022: the whole upgrade and rollback, from a clean stack, for when the owner runs it. Builds
// two bundles with a throwaway key, installs the older, shows what gets refused, upgrades, goes back through a
// real restore, and writes down what happened.
//   node infrastructure/scripts/bundle-rehearsal.mjs --operator <name> [--from 2.0.0] [--to 2.0.1]
//     [--from-image web=<ref>]... [--to-image web=<ref>]... [--keep]
//
// It needs Docker, the images, `pnpm stack:secrets`, the overlay in infrastructure/compose/sovereign/, and the
// restore slice's sovereign-backup.mjs and sovereign-restore.mjs. It refuses to start without them, since a
// rollback rehearsed with no restore would prove the wrong thing.
//
// With no --from-image and --to-image both bundles hold the same images, which rehearses the mechanics and not a
// real difference between two releases. The record says which it was. A rehearsal is evidence about this run on
// this machine, and is not evidence about any customer's site or any network: SEC-05's capture is that.
//
// It runs as its own Compose project on its own port, and removes that project and its signing key afterwards.
// Two bundles of the full image set take several GB of disk.
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildBundle, signManifest, SIGNING_MARK } from './build-bundle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT = 'ensemus-bundle-rehearsal';
const PORT = process.env.ENSEMUS_REHEARSAL_PORT ?? '18643';
const NETWORK_PREFIX = process.env.ENSEMUS_REHEARSAL_NETWORK_PREFIX ?? '172.31';
const MANIFEST_FILE = 'bundle-manifest.dsse.json';
const KEY_ID = 'rehearsal-throwaway';

const { values } = parseArgs({
  options: {
    operator: { type: 'string' },
    from: { type: 'string', default: '2.0.0' },
    to: { type: 'string', default: '2.0.1' },
    'from-image': { type: 'string', multiple: true, default: [] },
    'to-image': { type: 'string', multiple: true, default: [] },
    keep: { type: 'boolean', default: false },
  },
});
if (!values.operator) {
  console.error('Usage: bundle-rehearsal.mjs --operator <who is running this> [--from] [--to]');
  process.exit(2);
}

const work = join(root, '.local', 'bundle-rehearsal', randomUUID());
const signerFile = join(work, 'throwaway-signer.pem');
const trustRoot = join(work, 'trust-root.json');
const stateDir = join(work, 'state');
const envFile = join(work, 'rehearsal.env');
const toolsDir = join(root, 'workers', 'workflow', 'dist', 'tools');
const composeDir = join(root, 'infrastructure', 'compose');
const backupScript = join(root, 'infrastructure', 'scripts', 'sovereign-backup.mjs');
const restoreScript = join(root, 'infrastructure', 'scripts', 'sovereign-restore.mjs');

const evidence = {
  kind: 'bundle rehearsal, with a throwaway key',
  signing: SIGNING_MARK,
  operator: values.operator,
  started_at: new Date().toISOString(),
  git_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  images_differ_between_bundles: false,
  steps: [],
  result: 'not finished',
};
const note = (step, result) => {
  evidence.steps.push({ step, result, at: new Date().toISOString() });
  console.log(`${step}: ${result}`);
};
class RehearsalFailed extends Error {}
const fail = (step, detail) => {
  evidence.steps.push({ step, result: `FAILED: ${detail}`, at: new Date().toISOString() });
  throw new RehearsalFailed(`${step}: ${detail}`);
};

const dockerOnThisMachine = (args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
};

/** Runs a built tool, and insists on how it ended. A refusal that does not happen fails the rehearsal. */
function tool(step, name, args, expected) {
  const result = spawnSync(process.execPath, [join(toolsDir, name), ...args], {
    cwd: work,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (expected.code) {
    if (result.status !== 1 || !output.includes(expected.code)) {
      fail(step, `expected ${expected.code}, and got exit ${result.status}: ${output.slice(-800)}`);
    }
    note(step, `refused with ${expected.code}`);
  } else {
    if (result.status !== 0) fail(step, `exit ${result.status}: ${output.slice(-800)}`);
    note(step, 'passed');
  }
  return output;
}

const install = (step, bundle, extra, expected = {}) =>
  tool(
    step,
    'install-bundle.mjs',
    [
      bundle,
      '--trust-root',
      trustRoot,
      '--state-dir',
      stateDir,
      '--project',
      PROJECT,
      '--env-file',
      envFile,
      '--operator',
      values.operator,
      ...extra,
    ],
    expected,
  );

const recordedVersions = () =>
  readFileSync(join(stateDir, 'installation-record.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

/** Whatever Compose has running for this project, with no compose files needed to ask. */
const runningServices = () =>
  execFileSync(
    'docker',
    ['ps', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--format', '{{.Image}}'],
    {
      encoding: 'utf8',
    },
  )
    .trim()
    .split('\n')
    .filter(Boolean);

function requireThings() {
  const missing = [
    [join(composeDir, 'sovereign', 'compose.sovereign.yaml'), 'the Compose overlay'],
    [backupScript, 'the backup script'],
    [restoreScript, 'the restore script'],
    [join(root, '.local', 'secrets'), 'generated test secrets (pnpm stack:secrets)'],
  ].filter(([path]) => !existsSync(path));
  if (missing.length > 0) {
    throw new RehearsalFailed(
      `Not ready to run. Missing: ${missing.map(([, what]) => what).join(', ')}`,
    );
  }
}

function generateThrowawayKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(signerFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(
    trustRoot,
    JSON.stringify({
      format: 'ensemus.trust_root',
      format_version: 1,
      keys: [
        {
          key_id: KEY_ID,
          algorithm: 'ed25519',
          public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          purposes: ['bundle'],
          test_only: true,
        },
      ],
    }),
  );
  return privateKey;
}

const imagesFrom = (given) =>
  given.length > 0
    ? given.map((text) => {
        const at = text.indexOf('=');
        return { name: text.slice(0, at), ref: text.slice(at + 1) };
      })
    : [
        { name: 'web', ref: 'ensemus/web:local' },
        { name: 'worker', ref: 'ensemus/worker:local' },
      ];

const buildOne = async (version, images, compatibility) => {
  const outDir = join(work, 'bundles', version);
  const { manifest } = await buildBundle(
    {
      version,
      line: version.split('.').slice(0, 2).join('.'),
      kind: 'patch',
      security: false,
      publishedOn: new Date().toISOString().slice(0, 10),
      gitCommit: evidence.git_commit,
      outDir,
      signerFile,
      keyId: KEY_ID,
      images,
      workflowCompatibility: 'replay corpus of this commit',
      nodeVersion: readFileSync(join(root, '.nvmrc'), 'utf8').trim(),
      composeDir,
      migrationsDir: join(root, 'packages', 'database', 'migrations'),
      toolsDir,
      docsDir: join(root, 'docs', '05-operations', 'sovereign'),
      models: [],
      sboms: [],
      notices: [],
      advisories: [],
      supportPolicies: [],
      ...compatibility,
    },
    {
      docker: async (args) => dockerOnThisMachine(args),
      now: () => new Date(),
      log: (line) => console.log(line),
    },
  );
  return { outDir, manifest };
};

async function rehearse() {
  requireThings();
  mkdirSync(work, { recursive: true });
  execFileSync(
    process.execPath,
    [join(root, 'workers/workflow/scripts/build-sovereign-tools.mjs')],
    {
      stdio: 'inherit',
    },
  );
  const privateKey = generateThrowawayKey();
  writeFileSync(
    envFile,
    [
      `ENSEMUS_SECRETS_DIR=${join(root, '.local', 'secrets').replaceAll('\\', '/')}`,
      `ENSEMUS_HTTPS_PORT=${PORT}`,
      `ENSEMUS_NETWORK_PREFIX=${NETWORK_PREFIX}`,
      `ENSEMUS_PUBLIC_URL=https://localhost:${PORT}`,
      '',
    ].join('\n'),
  );

  const older = await buildOne(values.from, imagesFrom(values['from-image']), {
    upgradeFrom: [],
    rollbackTo: [],
    rollbackConstraints: [],
  });
  const newer = await buildOne(values.to, imagesFrom(values['to-image']), {
    upgradeFrom: [values.from],
    rollbackTo: [values.from],
    rollbackConstraints: [
      'MIGRATIONS_NOT_REVERSIBLE',
      'RESTORE_LOSES_LATER_WORK',
      'EXTERNAL_EFFECTS_NOT_UNDONE',
    ],
  });
  const digests = ({ manifest }) => manifest.images.map((image) => image.digest).join();
  evidence.images_differ_between_bundles = digests(older) !== digests(newer);
  evidence.bundles = [older, newer].map(({ manifest }) => ({
    version: manifest.release.version,
    bundle_id: manifest.bundle_id,
    images: manifest.images.map(({ name, digest }) => ({ name, digest })),
  }));
  note('built two bundles', `${values.from} and ${values.to}`);

  // Refusals that need no stack.
  tool(
    'verify the older bundle',
    'verify-bundle.mjs',
    [older.outDir, '--trust-root', trustRoot],
    {},
  );
  tool(
    'verify the newer bundle',
    'verify-bundle.mjs',
    [newer.outDir, '--trust-root', trustRoot],
    {},
  );
  const planted = join(newer.outDir, 'planted.txt');
  writeFileSync(planted, 'not signed');
  tool('an added file', 'verify-bundle.mjs', [newer.outDir, '--trust-root', trustRoot], {
    code: 'FILE_NOT_LISTED',
  });
  rmSync(planted);
  const composeInBundle = join(newer.outDir, 'compose', 'compose.yaml');
  const composeText = readFileSync(composeInBundle);
  writeFileSync(composeInBundle, Buffer.concat([composeText, Buffer.from('# changed\n')]));
  tool('a changed file', 'verify-bundle.mjs', [newer.outDir, '--trust-root', trustRoot], {
    code: 'FILE_CHANGED',
  });
  writeFileSync(composeInBundle, composeText);
  const rootInside = join(newer.outDir, 'trust-root.json');
  writeFileSync(rootInside, readFileSync(trustRoot));
  tool(
    'a trust root inside the bundle',
    'verify-bundle.mjs',
    [newer.outDir, '--trust-root', rootInside],
    {
      code: 'TRUST_ROOT_INSIDE_BUNDLE',
    },
  );
  rmSync(rootInside);

  // A first install, on a stack with nothing behind it.
  install('install the older bundle', older.outDir, [
    '--backup-reference',
    'first install, nothing to back up',
  ]);
  if (runningServices().length === 0) fail('install the older bundle', 'nothing is running');
  install('the same version again', older.outDir, ['--backup-reference', 'none'], {
    code: 'SAME_VERSION',
  });
  install('an upgrade with no backup named', newer.outDir, [], { code: 'BACKUP_REQUIRED' });

  // A signed manifest whose digest differs from the archive: it must stop before touching the running stack.
  const manifestPath = join(newer.outDir, MANIFEST_FILE);
  const goodManifest = readFileSync(manifestPath);
  const wrong = structuredClone(newer.manifest);
  wrong.images[0].digest = `sha256:${'0'.repeat(64)}`;
  writeFileSync(manifestPath, signManifest(wrong, privateKey, KEY_ID));
  const before = runningServices().sort().join();
  install(
    'a loaded image that differs from the manifest',
    newer.outDir,
    ['--backup-reference', 'none'],
    {
      code: 'IMAGE_DIGEST_DIFFERS',
    },
  );
  writeFileSync(manifestPath, goodManifest);
  if (runningServices().sort().join() !== before) {
    fail('a loaded image that differs from the manifest', 'the running stack changed');
  }
  note('the running stack after that refusal', 'unchanged');

  // Back up first. The restore slice owns these scripts, and the backup is the only way back.
  const backupFolder = join(work, 'backup');
  const backup = spawnSync(
    process.execPath,
    [backupScript, '--project', PROJECT, '--out', backupFolder],
    {
      stdio: 'inherit',
    },
  );
  if (backup.status !== 0) fail('back up', `exit ${backup.status}`);
  note('back up', backupFolder);

  install('upgrade to the newer bundle', newer.outDir, ['--backup-reference', backupFolder]);

  install(
    'the older bundle replayed as an upgrade',
    older.outDir,
    ['--backup-reference', backupFolder],
    {
      code: 'ROLLBACK_NOT_REQUESTED',
    },
  );
  if (recordedVersions().at(-1).version !== values.to) {
    fail('the older bundle replayed as an upgrade', 'the record moved');
  }

  // Going back. The tool stops at the restore, a person restores, and it carries on.
  const back = ['--rollback', '--backup-reference', backupFolder];
  install('a rollback with no restore yet', older.outDir, back, { code: 'RESTORE_REQUIRED' });
  const restore = spawnSync(
    process.execPath,
    [restoreScript, '--project', PROJECT, '--from', backupFolder],
    {
      stdio: 'inherit',
    },
  );
  if (restore.status !== 0) fail('restore', `exit ${restore.status}`);
  note('restore', backupFolder);
  install('finish the rollback', older.outDir, [...back, '--backup-restored']);

  const record = recordedVersions();
  evidence.installation_record = record;
  const directions = record.map(({ direction, version }) => `${direction} ${version}`).join(', ');
  const expected = `install ${values.from}, upgrade ${values.to}, rollback ${values.from}`;
  if (directions !== expected) fail('the installation record', directions);
  note('the installation record', directions);
  evidence.result = 'passed';
}

async function main() {
  let status = 0;
  try {
    await rehearse();
  } catch (error) {
    status = 1;
    evidence.result = `failed: ${error instanceof RehearsalFailed ? error.message : 'unexpected error'}`;
    console.error(evidence.result);
    if (!(error instanceof RehearsalFailed)) console.error(error);
  } finally {
    // The key goes whatever happened, as with build-release.mjs, so it can never sign anything else.
    rmSync(signerFile, { force: true });
    evidence.finished_at = new Date().toISOString();
    if (existsSync(work)) {
      const file = join(work, 'evidence.json');
      writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(`Record: ${file}`);
      if (!values.keep) rmSync(join(work, 'bundles'), { recursive: true, force: true });
    }
    if (!values.keep) {
      spawnSync(
        'docker',
        ['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`],
        { encoding: 'utf8' },
      )
        .stdout?.trim()
        .split('\n')
        .filter(Boolean)
        .forEach((id) => spawnSync('docker', ['rm', '-f', '-v', id]));
      for (const kind of ['volume', 'network']) {
        const names = spawnSync(
          'docker',
          [kind, 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`],
          { encoding: 'utf8' },
        ).stdout?.trim();
        for (const name of names ? names.split('\n') : []) spawnSync('docker', [kind, 'rm', name]);
      }
    }
  }
  console.log(
    `Rehearsal ${evidence.result}. This was one run on this machine, with a throwaway key.`,
  );
  process.exit(status);
}

await main();
