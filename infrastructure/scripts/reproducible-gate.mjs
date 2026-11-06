#!/usr/bin/env node
// FOUND-01, ADR-037 D1: builds each image twice with no cache, compares them, and names the files that
// differ. Needs Docker, and runs in CI and run-all-gates.sh.
//   node infrastructure/scripts/reproducible-gate.mjs [--report-only]
//
// With --report-only, images that differ still pass, and the log and report.json say so. A build that
// fails does not. ADR-037 D1 says when the flag goes: the web image differs on its random Server Action
// key until the Dockerfile changes.
//
// Writes names, digests and paths to .local/reproducible/report.json, and no file contents. Each tarball
// is a whole image and the owner's disk is small, so they go as soon as they have been compared, and
// whatever is left goes in `finally`. This never prunes anything: it removes only what it made.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip, createZstdDecompress } from 'node:zlib';
import {
  exitCodeFor,
  filesThatDiffer,
  IMAGE_NAMES,
  imageDescriptor,
  imageResult,
  isIndexDescriptor,
  listTar,
  parseTarHeader,
  reportFailures,
  verdictFor,
} from './reproducible-rules.mjs';

/**
 * What the builder runs. Buildx's default is a tag that moves, and both builds of a comparison share a
 * builder, so this would not make them differ, but it would change what a pass means. It has no place in
 * tool-images.mjs yet, so it is pinned here, and it ships nowhere.
 */
const BUILDKIT =
  'moby/buildkit:v0.34.2@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe';
const BUILDS = {
  web: {
    dockerfile: 'infrastructure/containers/Dockerfile.web',
    buildArgs: ['ENSEMUS_RELEASE=reproducible'],
  },
  worker: { dockerfile: 'infrastructure/containers/Dockerfile.worker', buildArgs: [] },
};
/** report.json is for reading. Past this it says how many there were. */
const MAX_PATHS = 500;
const MAX_INDEX_DEPTH = 4;
const BLOCK = 512;

/** A failure the gate expected, with a message that is safe to put in the report. */
class GateFailure extends Error {}

export const createBuilderArguments = (builder) => [
  'buildx',
  'create',
  '--name',
  builder,
  '--driver',
  'docker-container',
  '--driver-opt',
  `image=${BUILDKIT}`,
  '--bootstrap',
];

export const removeBuilderArguments = (builder) => ['buildx', 'rm', '--force', builder];

/**
 * --provenance=false because the default attestation records when the build ran. The dest is relative
 * because the output option is parsed as CSV, and a path can hold what that treats as special.
 */
export const buildArguments = ({ builder, dockerfile, buildArgs, epoch, dest }) => [
  'buildx',
  'build',
  '--builder',
  builder,
  '--no-cache',
  '--provenance=false',
  '--progress=plain',
  '--file',
  dockerfile,
  '--build-arg',
  `SOURCE_DATE_EPOCH=${epoch}`,
  ...buildArgs.flatMap((buildArg) => ['--build-arg', buildArg]),
  '--output',
  `type=oci,dest=${dest},rewrite-timestamp=true`,
  '.',
];

/** Where each entry of a tar sits, without reading the blobs. An OCI layout has only short names. */
function tarOffsets(path) {
  const entries = new Map();
  const file = openSync(path, 'r');
  try {
    const { size } = fstatSync(file);
    const block = Buffer.alloc(BLOCK);
    let at = 0;
    while (at + BLOCK <= size) {
      readSync(file, block, 0, BLOCK, at);
      const header = parseTarHeader(block);
      if (!header) break;
      entries.set(header.path.replace(/^\.\//, ''), { offset: at + BLOCK, size: header.size });
      at += BLOCK + Math.ceil(header.size / BLOCK) * BLOCK;
    }
    return entries;
  } finally {
    closeSync(file);
  }
}

function readJsonEntry(path, entries, name) {
  const entry = entries.get(name);
  if (!entry) throw new GateFailure(`the tarball has no ${name}`);
  const bytes = Buffer.alloc(entry.size);
  const file = openSync(path, 'r');
  try {
    readSync(file, bytes, 0, entry.size, entry.offset);
  } finally {
    closeSync(file);
  }
  return JSON.parse(bytes.toString('utf8'));
}

const blobName = (digest) => `blobs/${String(digest).replace(':', '/')}`;

/** A tarball as the rules want it, following an index inside an index. Null if it cannot be read. */
function readImage(path) {
  try {
    const entries = tarOffsets(path);
    let index = readJsonEntry(path, entries, 'index.json');
    for (let depth = 0; isIndexDescriptor(imageDescriptor(index)); depth += 1) {
      if (depth === MAX_INDEX_DEPTH) return null;
      index = readJsonEntry(path, entries, blobName(imageDescriptor(index).digest));
    }
    const descriptor = imageDescriptor(index);
    if (!descriptor) return null;
    return { index, manifest: readJsonEntry(path, entries, blobName(descriptor.digest)), entries };
  } catch {
    return null;
  }
}

function hasTarball(path) {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

/** Everything in one layer of a tarball, with nothing kept but names, sizes and hashes. */
async function listLayer(tarball, image, position) {
  const layer = image.manifest.layers?.[position];
  if (!layer) return [];
  const entry = image.entries.get(blobName(layer.digest));
  if (!entry) throw new GateFailure('a layer named by the manifest is not in the tarball');
  const raw = createReadStream(tarball, {
    start: entry.offset,
    end: entry.offset + entry.size - 1,
  });
  const mediaType = String(layer.mediaType);
  const unpack = mediaType.includes('zstd')
    ? createZstdDecompress()
    : mediaType.includes('gzip')
      ? createGunzip()
      : null;
  if (!unpack) return listTar(raw);
  // pipe() does not pass on a read error, and the listing would wait for ever.
  raw.once('error', (error) => unpack.destroy(error));
  return listTar(raw.pipe(unpack));
}

async function differingPaths(tarballs, images, differentLayers) {
  const paths = new Set();
  for (const { index } of differentLayers) {
    const [listingA, listingB] = await Promise.all([
      listLayer(tarballs[0], images[0], index),
      listLayer(tarballs[1], images[1], index),
    ]);
    for (const path of filesThatDiffer(listingA, listingB)) paths.add(path);
  }
  return [...paths].sort();
}

async function buildTwiceAndCompare({ name, exec, root, scratch, builder, epoch, stopped }) {
  const { dockerfile, buildArgs } = BUILDS[name];
  const builds = [];
  const tarballs = [];
  try {
    for (const run of [1, 2]) {
      if (stopped()) throw new GateFailure('the gate was stopped');
      const dest = `${scratch}/${name}-${run}.tar`;
      const tarball = join(root, dest);
      tarballs.push(tarball);
      const status = await exec(buildArguments({ builder, dockerfile, buildArgs, epoch, dest }));
      const found = hasTarball(tarball);
      builds.push({ status, tarball: found, image: found ? readImage(tarball) : null });
      // A failed first build cannot be compared with anything, so a second would only cost time and disk.
      if (status !== 0) break;
    }

    const result = imageResult(name, builds[0], builds[1]);
    if (result.failed || result.same || result.differentLayers.length === 0) return result;
    try {
      const images = builds.map((build) => build.image);
      const paths = await differingPaths(tarballs, images, result.differentLayers);
      return {
        ...result,
        differingPathCount: paths.length,
        differingPaths: paths.slice(0, MAX_PATHS),
      };
    } catch {
      return { ...result, failed: true, reason: 'a layer that differs could not be read' };
    }
  } finally {
    // Before the next image starts, and not only at the end of the run.
    for (const tarball of tarballs) rmSync(tarball, { force: true });
  }
}

function describe(result) {
  if (result.failed) {
    const reasons = result.builds.flatMap((build) => (build.reason ? [build.reason] : []));
    return `${result.name}: FAILED, ${result.reason ?? reasons.join(', ')}`;
  }
  if (result.same) return `${result.name}: same, ${result.builds[0].manifestDigest}`;
  const lines = [
    `${result.name}: DIFFERENT, ${result.differentLayers.length} layer(s), ${result.differingPathCount ?? 0} path(s)`,
    ...(result.reason ? [`  ${result.reason}`] : []),
    ...(result.differingPaths ?? []).slice(0, 20).map((path) => `  ${path}`),
  ];
  return lines.join('\n');
}

/**
 * Runs the gate and answers its exit code. `exec` runs a docker command and answers its exit status, and
 * `commitEpoch` answers the commit's time, so tests/unit/reproducible-rules.test.ts can drive every path
 * here with no Docker. main() below is the only caller that passes the real ones.
 */
export async function runGate({
  root,
  reportOnly,
  exec,
  commitEpoch,
  stopped = () => false,
  log = console.log,
  warn = console.error,
}) {
  const folder = join(root, '.local', 'reproducible');
  const reportPath = join(folder, 'report.json');
  const id = randomUUID().slice(0, 8);
  const builder = `ensemus-reproducible-${id}`;
  const scratch = `.local/reproducible/tarballs-${id}`;
  const report = { reportOnly, sourceDateEpoch: null, images: [] };

  mkdirSync(folder, { recursive: true });
  // CI keeps this file whatever happens, so an old one must not stand in for a run that crashed.
  rmSync(reportPath, { force: true });

  let reportWritten = false;
  try {
    const epoch = String(commitEpoch()).trim();
    if (!/^\d+$/.test(epoch)) throw new GateFailure('the commit has no usable time');
    report.sourceDateEpoch = epoch;
    mkdirSync(join(root, scratch), { recursive: true });
    if ((await exec(createBuilderArguments(builder))) !== 0) {
      throw new GateFailure('the builder could not be created');
    }
    for (const name of IMAGE_NAMES) {
      const result = await buildTwiceAndCompare({
        name,
        exec,
        root,
        scratch,
        builder,
        epoch,
        stopped,
      });
      report.images.push(result);
      log(describe(result));
    }
  } catch (error) {
    report.error =
      error instanceof GateFailure ? error.message : 'the gate stopped on an unexpected error';
    warn(`Reproducible gate: ${error instanceof Error ? error.message : 'unknown error'}`);
  } finally {
    try {
      rmSync(join(root, scratch), { recursive: true, force: true });
    } catch {
      warn(`Reproducible gate: could not delete ${scratch}. Delete it by hand.`);
    }
    let removed = null;
    try {
      removed = await exec(removeBuilderArguments(builder));
    } catch {
      // Reported just below, the same as a non-zero status.
    }
    if (removed !== 0) warn(`Reproducible gate: could not remove builder ${builder}.`);
    try {
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      reportWritten = true;
    } catch {
      warn(`Reproducible gate: could not write ${reportPath}.`);
    }
  }

  for (const failure of reportFailures(report)) warn(`Reproducible gate: ${failure}`);
  log(verdictFor(report, { reportOnly }));
  return reportWritten ? exitCodeFor(report, { reportOnly }) : 1;
}

async function main() {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== '--report-only')) {
    console.error('Usage: reproducible-gate.mjs [--report-only]');
    process.exitCode = 2;
    return;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let current = null;
  let signalled = false;
  // Ctrl-C has to reach `finally`, because a tarball left behind is a whole image on a small disk.
  const stop = () => {
    signalled = true;
    current?.kill();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  process.exitCode = await runGate({
    root,
    reportOnly: flags.includes('--report-only'),
    stopped: () => signalled,
    commitEpoch: () =>
      execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8' }),
    exec: (args) =>
      new Promise((done) => {
        current = spawn('docker', args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
        current.once('error', () => done(null));
        current.once('close', (status) => done(status));
      }),
  });
}

// tests/unit/reproducible-rules.test.ts runs this file too, because a guard that never matched would
// pass silently.
const entry = process.argv[1];
if (entry && existsSync(entry) && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  await main();
}
