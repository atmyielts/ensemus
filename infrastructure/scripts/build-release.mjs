#!/usr/bin/env node
// FOUND-07: produces SBOMs and a signed release manifest, then verifies them with no network.
//   node infrastructure/scripts/build-release.mjs
// Signs with a THROWAWAY key, marked as such in the manifest. Real release signing waits for the
// owner's key-custody decision.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, '.local', 'release');
mkdirSync(out, { recursive: true });

const SYFT = 'anchore/syft:v1.56.0';
const NODE = 'node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9';
const IMAGES = { web: 'ensemus/web:local', worker: 'ensemus/worker:local' };

const run = (cmd, args) =>
  execFileSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const imageId = (image) => run('docker', ['inspect', image, '--format', '{{.Id}}']).trim();

// 1. One SBOM per image.
const sboms = {};
for (const [name, image] of Object.entries(IMAGES)) {
  const sbom = run('docker', [
    'run',
    '--rm',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    SYFT,
    image,
    '-o',
    'spdx-json',
    '-q',
  ]);
  const file = `sbom-${name}.spdx.json`;
  writeFileSync(join(out, file), sbom);
  sboms[name] = { file, sha256: sha256(sbom), packages: JSON.parse(sbom).packages.length };
}

// 2. The manifest, following docs/06-delivery/05-environment-and-ci-cd.md.
const compose = readFileSync(join(root, 'infrastructure/compose/compose.yaml'), 'utf8');
const pinned = [...compose.matchAll(/image:\s*(\S+@sha256:[0-9a-f]{64})/g)].map((m) => m[1]);
const migrations = readdirSync(join(root, 'packages/database/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();
const manifest = {
  release: process.env.ENSEMUS_RELEASE ?? 'local',
  git_commit: run('git', ['rev-parse', 'HEAD']).trim(),
  signing: 'THROWAWAY-TEST-KEY-NOT-FOR-DISTRIBUTION',
  images: Object.fromEntries(
    Object.entries(IMAGES).map(([name, image]) => [name, { image, id: imageId(image) }]),
  ),
  third_party_images: pinned.sort(),
  database_schema_version: migrations.at(-1),
  event_schema_major: 1,
  api_major: 1,
  node_version: readFileSync(join(root, '.nvmrc'), 'utf8').trim(),
  temporal_sdk: JSON.parse(readFileSync(join(root, 'workers/workflow/package.json'), 'utf8'))
    .dependencies['@temporalio/worker'],
  supported_modes: ['cloud', 'byom', 'sovereign'],
  sboms,
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(out, 'release-manifest.json'), manifestBytes);

// 3. Sign with Ed25519. Only the public key goes in the release folder; this private key is
// discarded when the script ends, so it can never sign anything else.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
writeFileSync(
  join(out, 'release-signing-public.pem'),
  publicKey.export({ type: 'spki', format: 'pem' }),
);
writeFileSync(
  join(out, 'release-manifest.sig'),
  sign(null, manifestBytes, privateKey).toString('base64'),
);
copyFileSync(
  join(root, 'infrastructure/scripts/verify-release.mjs'),
  join(out, 'verify-release.mjs'),
);

// 4. Verify in a container with no network at all, as a Sovereign operator would.
const verify = () =>
  spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network=none',
      '-v',
      `${out.replaceAll('\\', '/')}:/release:ro`,
      NODE,
      'node',
      '/release/verify-release.mjs',
      '/release',
    ],
    { encoding: 'utf8' },
  );

let failed = false;
const good = verify();
process.stdout.write(good.stdout);
if (good.status !== 0) {
  console.error(good.stderr.slice(0, 500));
  failed = true;
}

// 5. Controls: a changed manifest and a changed SBOM must both be rejected.
const reject = (label, file) => {
  const path = join(out, file);
  const original = readFileSync(path);
  writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]));
  const result = verify();
  writeFileSync(path, original);
  console.log(`Control, ${label}: ${result.status !== 0 ? 'rejected' : 'ACCEPTED'}`);
  if (result.status === 0) failed = true;
};
reject('tampered manifest', 'release-manifest.json');
reject('tampered SBOM', sboms.web.file);

process.exit(failed ? 1 : 0);
