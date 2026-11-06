#!/usr/bin/env node
// COMM-04, SOV-03: builds a signed offline bundle: a folder, with a manifest listing every file in it, that an
// operator checks with `verify-bundle` against a trust root they already hold (ADR-030 D4).
//   node workers/workflow/scripts/build-sovereign-tools.mjs
//   node infrastructure/scripts/build-bundle.mjs <version> --signer <pem> --key-id <id> \
//     --out <folder> --line 2.0 --kind patch --published-on 2027-01-31 --git-commit <40 hex> \
//     --workflow-compatibility <text> --image web=ensemus/web:local --image worker=ensemus/worker:local \
//     [--security] [--upgrade-from <version>]... [--rollback-to <version>]... [--rollback-constraint <CODE>]... \
//     [--sbom <file>]... [--notice <file>]... [--advisory <file>]... [--support-policy <file>]... \
//     [--release-manifest <file>] [--model <name>=<file>=<license reference>]...
//
// Every signature it makes is THROWAWAY, and says so inside what is signed, as build-release.mjs does, until the
// owner decides who holds the real key. The signer file is a generated key for a rehearsal. Do not point this at
// anything else: no real key is stored or used until that decision and outside review have happened.
//
// It never pulls: an image that is not on this machine is refused. Facts about the release come from arguments,
// so nothing here chooses them, and the manifest's own schema is applied by the verifier the operator runs.
import { execFile } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SIGNING_MARK = 'THROWAWAY-TEST-KEY-NOT-FOR-DISTRIBUTION';
const MANIFEST_FILE = 'bundle-manifest.dsse.json';
const PAYLOAD_TYPE = 'application/vnd.ensemus.bundle+json';

/** The codes upgrade-and-rollback.md explains. A test holds this to the list the tools print. */
export const ROLLBACK_CONSTRAINT_CODES = [
  'MIGRATIONS_NOT_REVERSIBLE',
  'RESTORE_LOSES_LATER_WORK',
  'WORKFLOW_HISTORY_NOT_COMPATIBLE',
  'PLAN_RUNS_MUST_DRAIN',
  'EXTERNAL_EFFECTS_NOT_UNDONE',
];

/** The name each third-party image the stack pins goes by in a bundle, which the overlay relies on. */
const THIRD_PARTY_NAMES = [
  [/^caddy[:@]/, 'proxy'],
  [/^pgvector\/pgvector[:@]/, 'postgres'],
  [/^temporalio\/admin-tools[:@]/, 'temporal-admin-tools'],
  [/^temporalio\/server[:@]/, 'temporal'],
  [/^valkey\/valkey[:@]/, 'valkey'],
  [/^chrislusf\/seaweedfs[:@]/, 'objects'],
];

const BUNDLE_PATH = /^[a-z0-9][a-z0-9_.-]*(\/[a-z0-9][a-z0-9_.-]*)*$/;
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const LINE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const IMAGE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const SCHEMA_FILE = /^[0-9]{4}_[a-z0-9_]+\.sql$/;

export class BundleBuildError extends Error {
  name = 'BundleBuildError';
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}
const refuse = (code, detail) => {
  throw new BundleBuildError(code, detail);
};

/** Every image a stack pins has to travel with it, so a pin with no name here stops the build. */
export function thirdPartyImages(composeText) {
  const pins = new Set(
    [...composeText.matchAll(/image:\s*(\S+@sha256:[0-9a-f]{64})/g)].map((match) => match[1]),
  );
  return [...pins].map((ref) => {
    const known = THIRD_PARTY_NAMES.find(([pattern]) => pattern.test(ref));
    if (!known) refuse('THIRD_PARTY_IMAGE_NOT_NAMED', ref);
    return { name: known[1], ref };
  });
}

/** DSSE's pre-authentication encoding, the same bytes `@ensemus/sovereign/envelope` checks. */
const preAuthEncoding = (type, payload) =>
  Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `),
    payload,
  ]);

/** Signs manifest text and checks the result against the key's own public half before anyone relies on it. */
export function signManifest(manifest, privateKey, keyId) {
  const payload = Buffer.from(JSON.stringify(manifest));
  const encoded = preAuthEncoding(PAYLOAD_TYPE, payload);
  const signature = sign(null, encoded, privateKey);
  if (!verify(null, encoded, createPublicKey(privateKey), signature)) refuse('SIGNATURE_NOT_GOOD');
  return JSON.stringify({
    payloadType: PAYLOAD_TYPE,
    payload: payload.toString('base64'),
    signatures: [{ keyid: keyId, sig: signature.toString('base64') }],
  });
}

function readSigner(signerFile) {
  let privateKey;
  try {
    privateKey = createPrivateKey(readFileSync(signerFile));
  } catch {
    // Fixed text. An error from a key parser is not something to print.
    refuse('SIGNER_UNREADABLE');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') refuse('SIGNER_UNREADABLE');
  return privateKey;
}

const isInside = (candidate, folder) => {
  const path = relative(resolve(folder), resolve(candidate));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

/** Refused before Docker is touched, since each of these is a mistake in what was asked for. */
function checkRequest(options) {
  const facts = [
    VERSION.test(options.version ?? ''),
    LINE.test(options.line ?? ''),
    ['major', 'minor', 'patch'].includes(options.kind),
    DAY.test(options.publishedOn ?? ''),
    /^[0-9a-f]{40}$/.test(options.gitCommit ?? ''),
    typeof options.workflowCompatibility === 'string' && options.workflowCompatibility.trim() !== '',
    typeof options.keyId === 'string' && /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(options.keyId),
    options.images.length > 0,
    options.images.every(({ name, ref }) => IMAGE_NAME.test(name) && Boolean(ref)),
    [...options.upgradeFrom, ...options.rollbackTo].every((version) => VERSION.test(version)),
  ];
  if (facts.includes(false)) refuse('BAD_RELEASE_FACTS');
  for (const code of options.rollbackConstraints) {
    if (!ROLLBACK_CONSTRAINT_CODES.includes(code)) refuse('UNKNOWN_ROLLBACK_CONSTRAINT', code);
  }
  // A model's weights have their own license, so a bundle cannot carry one without saying which (ADR-030).
  for (const model of options.models) {
    if (!model.licenseReference?.trim()) refuse('MODEL_WITHOUT_LICENSE_REFERENCE', model.name);
  }
  if (isInside(options.signerFile, options.outDir)) refuse('SIGNER_INSIDE_BUNDLE');
}

const lowerName = (name) => {
  const lowered = name.toLowerCase();
  if (!BUNDLE_PATH.test(lowered)) refuse('NAME_NOT_ALLOWED_IN_A_BUNDLE', name);
  return lowered;
};

/**
 * Copies one source folder under a new name, lower-casing as the manifest's path rule needs. The overlay points
 * at these names, including `compose/proxy/caddyfile`, which is why it remounts that one file.
 */
async function copyFolder(source, target) {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    // The proxy's test configuration stays in the repository, since it is not what a site runs.
    if (entry.name.endsWith('.test')) continue;
    const from = join(source, entry.name);
    const to = join(target, lowerName(entry.name));
    if (existsSync(to)) refuse('NAME_NOT_ALLOWED_IN_A_BUNDLE', entry.name);
    if (entry.isDirectory()) await copyFolder(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else refuse('LINK_IN_A_SOURCE_FOLDER', entry.name);
  }
}

const hashFile = (file) =>
  new Promise((done, failed) => {
    const hash = createHash('sha256');
    let bytes = 0;
    createReadStream(file)
      .on('data', (chunk) => {
        hash.update(chunk);
        bytes += chunk.length;
      })
      .on('error', failed)
      .on('end', () => done({ sha256: hash.digest('hex'), bytes }));
  });

const ROLE_BY_FOLDER = {
  images: 'image',
  compose: 'compose',
  migrations: 'migration',
  sboms: 'sbom',
  notices: 'notice',
  tools: 'tool',
  advisories: 'advisory',
  'support-policy': 'support_policy',
  release: 'release_manifest',
  models: 'model',
  docs: 'documentation',
};

/** Lists everything really in the folder, so nothing can be there and not be signed. */
async function listFiles(folder, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(folder, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(folder, path)));
    } else {
      const role = ROLE_BY_FOLDER[path.split('/')[0]];
      if (!role || !BUNDLE_PATH.test(path)) refuse('NAME_NOT_ALLOWED_IN_A_BUNDLE', path);
      files.push({ path, ...(await hashFile(join(folder, path))), role });
    }
  }
  return files;
}

/**
 * Builds the bundle. `io.docker` runs one command and answers `{ status, stdout }`, so everything except
 * Docker itself can be tested with no Docker there.
 */
export async function buildBundle(options, io) {
  checkRequest(options);

  const outDir = resolve(options.outDir);
  if (existsSync(outDir) && (await readdir(outDir)).length > 0) refuse('OUT_NOT_EMPTY', outDir);
  const privateKey = readSigner(options.signerFile);

  const composeFile = join(options.composeDir, 'compose.yaml');
  const overlay = join(options.composeDir, 'sovereign', 'compose.sovereign.yaml');
  if (!existsSync(overlay)) refuse('OVERLAY_MISSING', overlay);
  const toolFiles = existsSync(options.toolsDir)
    ? (await readdir(options.toolsDir)).filter((name) => name.endsWith('.mjs'))
    : [];
  if (toolFiles.length === 0) refuse('TOOLS_NOT_BUILT', 'run build-sovereign-tools.mjs first');

  const images = [
    ...options.images,
    ...thirdPartyImages(readFileSync(composeFile, 'utf8')).filter(
      ({ name }) => !options.images.some((image) => image.name === name),
    ),
  ];

  await mkdir(join(outDir, 'images'), { recursive: true });
  const manifestImages = [];
  for (const { name, ref } of images) {
    const inspected = await io.docker(['image', 'inspect', '--format', '{{.Id}}', ref]);
    const id = inspected.stdout.trim();
    if (inspected.status !== 0 || !IMAGE_ID.test(id)) refuse('IMAGE_NOT_FOUND', ref);
    // By the ID just read, so a tag moving between these two commands cannot change what ships.
    const file = `images/${name}.tar`;
    const saved = await io.docker(['save', '-o', join(outDir, ...file.split('/')), id]);
    if (saved.status !== 0) refuse('IMAGE_SAVE_FAILED', ref);
    manifestImages.push({ name, digest: id, file });
    io.log(`saved ${name} ${id}`);
  }

  const place = async (folder, source) => {
    await mkdir(join(outDir, folder), { recursive: true });
    await copyFile(source, join(outDir, folder, lowerName(basename(source))));
  };

  await place('compose', composeFile);
  await place('compose', overlay);
  for (const part of ['proxy', 'postgres', 'temporal']) {
    const source = join(options.composeDir, part);
    if (existsSync(source)) await copyFolder(source, join(outDir, 'compose', part));
  }

  const migrations = (await readdir(options.migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const schemaVersion = migrations.at(-1);
  if (!schemaVersion || !SCHEMA_FILE.test(schemaVersion)) refuse('BAD_RELEASE_FACTS', 'migrations');
  for (const name of migrations) await place('migrations', join(options.migrationsDir, name));

  for (const name of toolFiles) await place('tools', join(options.toolsDir, name));
  if (existsSync(options.docsDir)) {
    for (const name of await readdir(options.docsDir)) {
      if (name.endsWith('.md')) await place('docs', join(options.docsDir, name));
    }
  }
  for (const file of options.sboms) await place('sboms', file);
  for (const file of options.notices) await place('notices', file);
  for (const file of options.advisories) await place('advisories', file);
  for (const file of options.supportPolicies) await place('support-policy', file);
  if (options.releaseManifest) await place('release', options.releaseManifest);
  const models = [];
  for (const { name, file, licenseReference } of options.models) {
    await place('models', file);
    models.push({
      name,
      file: `models/${lowerName(basename(file))}`,
      license_reference: licenseReference.trim(),
    });
  }

  const manifest = {
    format: 'ensemus.bundle',
    format_version: 1,
    bundle_id: randomUUID(),
    issued_at: io.now().toISOString(),
    // Not read by anything. It is inside what is signed, so whoever opens the file can see it for themselves.
    signing: SIGNING_MARK,
    release: {
      version: options.version,
      line: options.line,
      kind: options.kind,
      security: Boolean(options.security),
      published_on: options.publishedOn,
      git_commit: options.gitCommit,
    },
    files: await listFiles(outDir),
    images: manifestImages,
    compatibility: {
      upgrade_from: options.upgradeFrom,
      rollback_to: options.rollbackTo,
      rollback_constraints: options.rollbackConstraints,
      database_schema_version: schemaVersion,
      workflow_compatibility: options.workflowCompatibility.trim(),
      node_version: options.nodeVersion,
    },
    models,
  };

  // Written last, so a folder with a manifest in it is a finished folder.
  await writeFile(join(outDir, MANIFEST_FILE), signManifest(manifest, privateKey, options.keyId));
  io.log(`wrote ${outDir}, ${manifest.files.length} files, signed ${SIGNING_MARK}`);
  return { outDir, manifest };
}

/** `name=reference`, where a reference may itself hold no equals sign worth keeping apart. */
function parseImage(text) {
  const at = text.indexOf('=');
  return at < 1 ? refuse('BAD_RELEASE_FACTS', text) : { name: text.slice(0, at), ref: text.slice(at + 1) };
}

function parseModel(text) {
  const [name, file, ...reference] = text.split('=');
  return { name, file, licenseReference: reference.join('=') };
}

const dockerOnThisMachine = (args) =>
  new Promise((done) => {
    execFile('docker', args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && stderr) process.stderr.write(stderr);
      done({ status: error ? 1 : 0, stdout });
    });
  });

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      signer: { type: 'string' },
      'key-id': { type: 'string' },
      out: { type: 'string' },
      line: { type: 'string' },
      kind: { type: 'string' },
      security: { type: 'boolean', default: false },
      'published-on': { type: 'string' },
      'git-commit': { type: 'string' },
      'workflow-compatibility': { type: 'string' },
      image: { type: 'string', multiple: true, default: [] },
      'upgrade-from': { type: 'string', multiple: true, default: [] },
      'rollback-to': { type: 'string', multiple: true, default: [] },
      'rollback-constraint': { type: 'string', multiple: true, default: [] },
      sbom: { type: 'string', multiple: true, default: [] },
      notice: { type: 'string', multiple: true, default: [] },
      advisory: { type: 'string', multiple: true, default: [] },
      'support-policy': { type: 'string', multiple: true, default: [] },
      'release-manifest': { type: 'string' },
      model: { type: 'string', multiple: true, default: [] },
    },
  });
  const [version] = positionals;
  if (!version || !values.signer) refuse('BAD_RELEASE_FACTS', '<version> and --signer are needed');
  await buildBundle(
    {
      version,
      line: values.line,
      kind: values.kind,
      security: values.security,
      publishedOn: values['published-on'],
      gitCommit: values['git-commit'],
      outDir: values.out ?? join(root, '.local', 'bundles', version),
      signerFile: values.signer,
      keyId: values['key-id'],
      images: values.image.map(parseImage),
      upgradeFrom: values['upgrade-from'],
      rollbackTo: values['rollback-to'],
      rollbackConstraints: values['rollback-constraint'],
      workflowCompatibility: values['workflow-compatibility'],
      nodeVersion: readFileSync(join(root, '.nvmrc'), 'utf8').trim(),
      composeDir: join(root, 'infrastructure', 'compose'),
      migrationsDir: join(root, 'packages', 'database', 'migrations'),
      toolsDir: join(root, 'workers', 'workflow', 'dist', 'tools'),
      docsDir: join(root, 'docs', '05-operations', 'sovereign'),
      models: values.model.map(parseModel),
      sboms: values.sbom,
      notices: values.notice,
      advisories: values.advisory,
      supportPolicies: values['support-policy'],
      releaseManifest: values['release-manifest'],
    },
    {
      docker: dockerOnThisMachine,
      now: () => new Date(),
      log: (line) => console.log(line),
    },
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof BundleBuildError ? error.message : 'Building the bundle failed');
    process.exit(1);
  });
}
