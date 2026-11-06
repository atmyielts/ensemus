#!/usr/bin/env node
// FOUND-07: produces SBOMs and a signed release manifest, then verifies them with no network.
//   node infrastructure/scripts/build-release.mjs
// With ENSEMUS_RELEASE_SIGNER_COMMAND and ENSEMUS_RELEASE_PUBLIC_KEY_FILE set, the command signs, and
// the private key never enters this script. With neither set, a THROWAWAY key signs, marked as such in
// the manifest, so the verifier will not call the result a release. Which key is real, and who holds it,
// waits for the owner's key-custody decision (ADR-037 D4).
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_SIGNER_MARKER,
  createThrowawaySigner,
  signerFromEnv,
  signManifest,
  THROWAWAY_MARKER,
  verifierFlags,
} from './release-signing.mjs';
import { SYFT } from './tool-images.mjs';

// First, so a signer named wrongly fails before the slow part and before anything is written.
const signer = signerFromEnv(process.env) ?? createThrowawaySigner();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, '.local', 'release');
// Beside the release and not in it, as an operator's copy of the key would be. The controls live
// outside it too, so a manifest made to be rejected can never be mistaken for part of a release.
const trust = join(root, '.local', 'release-trust');
const controls = join(root, '.local', 'release-controls');
mkdirSync(out, { recursive: true });
mkdirSync(trust, { recursive: true });

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
    SYFT.image,
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

// 3. Sign with Ed25519, which also proves the signature, before any of the signed set is written. Only
// the public key goes in the release folder.
const writeSignedSet = (folder, signed, publicKeyPem) => {
  writeFileSync(join(folder, 'release-manifest.json'), signed.bytes);
  writeFileSync(join(folder, 'release-manifest.sig'), signed.signature);
  writeFileSync(join(folder, 'release-signing-public.pem'), publicKeyPem);
};
writeSignedSet(out, signManifest(manifest, signer), signer.publicKeyPem);
writeFileSync(join(trust, 'release-signing-public.pem'), signer.publicKeyPem);
copyFileSync(
  join(root, 'infrastructure/scripts/verify-release.mjs'),
  join(out, 'verify-release.mjs'),
);

// 4. Verify in a container with no network at all, as a Sovereign operator would: the verifier from the
// release, and the key from outside it.
const mount = (folder, target) => ['-v', `${folder.replaceAll('\\', '/')}:${target}:ro`];
const verify = ({ folder = out, keyFolder = trust, flags = verifierFlags(signer) } = {}) =>
  spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network=none',
      ...mount(out, '/release'),
      ...mount(folder, '/target'),
      ...mount(keyFolder, '/trust'),
      NODE,
      'node',
      '/release/verify-release.mjs',
      '/target',
      '/trust/release-signing-public.pem',
      ...flags,
    ],
    { encoding: 'utf8' },
  );

let failed = false;
const good = verify();
process.stdout.write(good.stdout);
if (good.status !== 0) {
  console.error(good.stderr?.slice(0, 500));
  failed = true;
}

// A rejection counts only as the verifier's own refusal, for the reason the control is about. Docker
// failing to start, or a control folder built wrongly, must not read as a control that passed.
const report = (label, result, reason) => {
  const rejected = result.status === 1 && result.stderr.includes(reason);
  console.log(`Control, ${label}: ${rejected ? 'rejected' : 'ACCEPTED'}`);
  if (!rejected) failed = true;
};

// 5. Controls: a changed manifest and a changed SBOM must both be rejected.
const reject = (label, file, reason) => {
  const path = join(out, file);
  const original = readFileSync(path);
  writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]));
  const result = verify();
  writeFileSync(path, original);
  report(label, result, reason);
};
reject('tampered manifest', 'release-manifest.json', 'signature');
reject('tampered SBOM', sboms.web.file, 'sbom:web');

// 6. Controls: the test marker and the flag. These need both kinds of manifest whichever signer ran, so
// they get their own folders and their own throwaway key, and the real key signs nothing extra.
const controlSigner = createThrowawaySigner();
const controlFolder = (name, marker) => {
  const folder = join(controls, name);
  mkdirSync(folder, { recursive: true });
  for (const { file } of Object.values(sboms)) {
    copyFileSync(join(out, file), join(folder, file));
  }
  const signed = signManifest({ ...manifest, release: 'control' }, { ...controlSigner, marker });
  writeSignedSet(folder, signed, controlSigner.publicKeyPem);
  return folder;
};
const controlKeys = join(controls, 'trust');
mkdirSync(controlKeys, { recursive: true });
writeFileSync(join(controlKeys, 'release-signing-public.pem'), controlSigner.publicKeyPem);

report(
  'test release with no flag',
  verify({
    folder: controlFolder('test-marked', THROWAWAY_MARKER),
    keyFolder: controlKeys,
    flags: [],
  }),
  'test release',
);
report(
  'real-marked manifest with the flag',
  verify({
    folder: controlFolder('real-marked', COMMAND_SIGNER_MARKER),
    keyFolder: controlKeys,
    flags: ['--allow-test-key'],
  }),
  '--allow-test-key',
);

process.exit(failed ? 1 : 0);
