// What the reproducibility gate decides, apart from the Docker it runs on, so that a unit test can show it
// failing. See tests/unit/reproducible-rules.test.ts. Anything that cannot be compared is a failure and
// never reads as "same": two missing digests are equal, and that must not pass.
import { createHash } from 'node:crypto';

/** The images the gate has to build. A report that leaves one out has not shown it to be reproducible. */
export const IMAGE_NAMES = ['web', 'worker'];

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const INDEX_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

export const isIndexDescriptor = (descriptor) => INDEX_MEDIA_TYPES.has(descriptor?.mediaType);

/** The one thing an OCI index points at, or null when there is none or several to choose from. */
export function imageDescriptor(index) {
  const manifests = Array.isArray(index?.manifests) ? index.manifests : [];
  // An attestation sits beside the image and holds build times, so it says nothing about the image.
  const images = manifests.filter(
    (descriptor) =>
      descriptor?.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest',
  );
  return images.length === 1 ? images[0] : null;
}

function manifestDigestOf(image) {
  const digest = imageDescriptor(image?.index)?.digest;
  return DIGEST.test(digest ?? '') ? digest : null;
}

const layerDigestsOf = (image) =>
  Array.isArray(image?.manifest?.layers) ? image.manifest.layers.map((layer) => layer?.digest) : [];

/**
 * Compares two images, each `{ index, manifest }` as parsed from an OCI layout. The manifest digest
 * covers the config and every layer, so it decides. The layers only say where a difference lies.
 */
export function compareImages(a, b) {
  const digestA = manifestDigestOf(a);
  const digestB = manifestDigestOf(b);
  if (!digestA || !digestB) {
    return { same: false, differentLayers: [], reason: 'an image has no manifest to compare' };
  }
  if (digestA === digestB) return { same: true, differentLayers: [] };

  const layersA = layerDigestsOf(a);
  const layersB = layerDigestsOf(b);
  const differentLayers = [];
  for (let index = 0; index < Math.max(layersA.length, layersB.length); index += 1) {
    if (layersA[index] !== layersB[index]) {
      differentLayers.push({ index, a: layersA[index] ?? null, b: layersB[index] ?? null });
    }
  }
  return differentLayers.length > 0
    ? { same: false, differentLayers }
    : { same: false, differentLayers, reason: 'the layers match, so the image config differs' };
}

/** The paths that were added, removed or changed between two listings of `{ path, size, hash }`. */
export function filesThatDiffer(listingA, listingB) {
  const byPath = (listing) =>
    new Map(listing.map(({ path, size, hash }) => [path, `${size}:${hash}`]));
  const a = byPath(listingA);
  const b = byPath(listingB);
  return [...new Set([...a.keys(), ...b.keys()])].filter((path) => a.get(path) !== b.get(path)).sort();
}

function buildFailure(build) {
  if (!build) return 'the build did not run';
  if (build.status !== 0) return 'the build failed';
  if (!build.tarball) return 'the build left no tarball';
  if (!manifestDigestOf(build.image)) return 'the tarball holds no image manifest';
  return null;
}

/**
 * One image's entry in the report, from its two builds. Each build is `{ status, tarball, image }`.
 * Holds digests and reasons, and no file contents.
 */
export function imageResult(name, first, second) {
  const builds = [first, second].map((build) => {
    const reason = buildFailure(build);
    return {
      ok: reason === null,
      manifestDigest: manifestDigestOf(build?.image),
      configDigest: build?.image?.manifest?.config?.digest ?? null,
      ...(reason ? { reason } : {}),
    };
  });
  if (builds.some((build) => !build.ok)) {
    return { name, failed: true, same: false, differentLayers: [], builds };
  }
  return { name, failed: false, ...compareImages(first.image, second.image), builds };
}

/** Why this report proves nothing either way. Empty means it can be believed. */
export function reportFailures(report) {
  if (report === null || typeof report !== 'object') return ['there is no report'];
  const images = Array.isArray(report.images) ? report.images : [];
  const failures = report.error ? [String(report.error)] : [];
  if (images.length === 0) failures.push('the report has no images');
  for (const name of IMAGE_NAMES) {
    if (images.length > 0 && !images.some((image) => image?.name === name)) {
      failures.push(`the report leaves out ${name}`);
    }
  }
  for (const image of images) {
    const label = image?.name ?? 'an image';
    const builds = Array.isArray(image?.builds) ? image.builds : [];
    if (image?.failed) failures.push(`${label}: ${image.reason ?? 'a build failed'}`);
    else if (builds.length !== 2 || builds.some((build) => build?.ok !== true)) {
      failures.push(`${label}: does not have two good builds`);
    } else if (typeof image.same !== 'boolean') failures.push(`${label}: was not compared`);
  }
  return failures;
}

/** Report-only forgives images that differ, and nothing else. A failed build fails in either mode. */
export function exitCodeFor(report, { reportOnly = false } = {}) {
  if (reportFailures(report).length > 0) return 1;
  if (report.images.every((image) => image.same === true)) return 0;
  return reportOnly === true ? 0 : 1;
}

export function verdictFor(report, { reportOnly = false } = {}) {
  if (reportFailures(report).length > 0) return 'Reproducible: NO';
  if (report.images.every((image) => image.same === true)) return 'Reproducible: yes';
  return reportOnly === true ? 'Reproducible: NO (report only)' : 'Reproducible: NO';
}

// Reading a tar, with no library, because these scripts run on plain Node.

const BLOCK = 512;
/** Long names and attributes are small. More than this is not a tar worth trusting. */
const MAX_EXTENDED_HEADER = 1024 * 1024;

const textField = (block, start, length) => {
  const end = block.indexOf(0, start);
  return block.toString('utf8', start, end >= 0 && end < start + length ? end : start + length);
};

function numberField(block, start, length) {
  // GNU tar writes a value too big for octal as base-256, flagged by the top bit.
  if (block[start] & 0x80) {
    let value = block[start] & 0x7f;
    for (let at = start + 1; at < start + length; at += 1) value = value * 256 + block[at];
    return value;
  }
  const text = textField(block, start, length).trim();
  return text === '' ? 0 : parseInt(text, 8);
}

/** One 512-byte tar header, or null for the zero block that ends an archive. Throws on a bad checksum. */
export function parseTarHeader(block) {
  if (block.every((byte) => byte === 0)) return null;
  const stored = numberField(block, 148, 8);
  let sum = 0;
  for (let at = 0; at < BLOCK; at += 1) sum += at >= 148 && at < 156 ? 32 : block[at];
  if (sum !== stored) throw new Error('a tar header has a bad checksum');
  const name = textField(block, 0, 100);
  const isUstar = block.toString('latin1', 257, 262) === 'ustar';
  const prefix = isUstar && block[263] !== 0x20 ? textField(block, 345, 155) : '';
  return {
    path: prefix ? `${prefix}/${name}` : name,
    mode: numberField(block, 100, 8),
    uid: numberField(block, 108, 8),
    gid: numberField(block, 116, 8),
    size: numberField(block, 124, 12),
    mtime: numberField(block, 136, 12),
    type: String.fromCharCode(block[156] || 48),
    linkname: textField(block, 157, 100),
  };
}

function paxRecords(bytes) {
  const records = {};
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at);
    const length = parseInt(bytes.toString('utf8', at, space), 10);
    if (space < 0 || !Number.isInteger(length) || length <= 0 || at + length > bytes.length) {
      throw new Error('a tar extended header is malformed');
    }
    const record = bytes.toString('utf8', space + 1, at + length - 1);
    const equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return records;
}

const normalPath = (path) => path.replace(/^(\.\/)+/, '');
const EXTENDED_TYPES = new Set(['x', 'g', 'L', 'K']);

/**
 * Lists a tar from an async iterable of chunks, as `[{ path, size, hash }]`, holding no contents. The
 * hash covers the mode, the owner, the time and the link target as well as the bytes, because any of
 * them makes a layer differ, and a report that named no file would not help anyone.
 */
export async function listTar(chunks) {
  const listing = [];
  let header = Buffer.alloc(0);
  let sawBlock = false;
  let ended = false;
  let padding = 0;
  let body = null; // What the current entry's bytes go into, while `remaining` of them are left.
  let remaining = 0;
  let extended = {};

  const closeEntry = () => {
    if (body.type === 'x') {
      extended = { ...extended, ...paxRecords(Buffer.concat(body.parts)) };
    } else if (body.type === 'L' || body.type === 'K') {
      const value = Buffer.concat(body.parts).toString('utf8').replace(/\0+$/, '');
      extended = { ...extended, [body.type === 'L' ? 'path' : 'linkpath']: value };
    } else if (body.type !== 'g') {
      listing.push({ path: body.path, size: body.size, hash: body.hash.digest('hex') });
    }
    padding = (BLOCK - (body.size % BLOCK)) % BLOCK;
    body = null;
  };

  const openEntry = (parsed) => {
    if (EXTENDED_TYPES.has(parsed.type)) {
      if (parsed.size > MAX_EXTENDED_HEADER) throw new Error('a tar extended header is too large');
      body = { type: parsed.type, size: parsed.size, parts: [] };
    } else {
      const size = extended.size !== undefined ? Number(extended.size) : parsed.size;
      const facts = [
        parsed.type,
        parsed.mode,
        extended.uid ?? parsed.uid,
        extended.gid ?? parsed.gid,
        extended.mtime ?? parsed.mtime,
        extended.linkpath ?? parsed.linkname,
      ].join('|');
      body = {
        type: parsed.type,
        size,
        path: normalPath(extended.path ?? parsed.path),
        hash: createHash('sha256').update(`${facts}\0`),
      };
      extended = {};
    }
    remaining = body.size;
    if (remaining === 0) closeEntry();
  };

  for await (const chunk of chunks) {
    let at = 0;
    while (at < chunk.length && !ended) {
      if (body) {
        const piece = chunk.subarray(at, at + Math.min(remaining, chunk.length - at));
        if (body.parts) body.parts.push(Buffer.from(piece));
        else body.hash.update(piece);
        at += piece.length;
        remaining -= piece.length;
        if (remaining === 0) closeEntry();
      } else if (padding > 0) {
        const skip = Math.min(padding, chunk.length - at);
        at += skip;
        padding -= skip;
      } else {
        const piece = chunk.subarray(at, at + Math.min(BLOCK - header.length, chunk.length - at));
        header = Buffer.concat([header, piece]);
        at += piece.length;
        if (header.length === BLOCK) {
          sawBlock = true;
          const parsed = parseTarHeader(header);
          header = Buffer.alloc(0);
          if (parsed) openEntry(parsed);
          else ended = true;
        }
      }
    }
  }
  if (!sawBlock) throw new Error('the tar is empty');
  if (body || header.length > 0 || padding > 0) throw new Error('the tar is cut short');
  return listing;
}
