// The customer's own tool for an organization archive, and the "not trapped" promise as code: Node and a
// private key are all it takes to get their data back, with no Ensemus deployment and no vendor (ADR-030 D7).
// docs/05-operations/sovereign/archive-format.md describes the format well enough to write another one.
//   node open-archive.mjs --archive <file.tar> --key-file <private key> --out <folder that does not exist>
//
// An archive is treated as hostile however it arrived, since anyone with the public key can seal one. So every
// name is checked by isArchivePath, which is an allowlist, and every part against the manifest, before anything
// is written. What it opens goes to a folder beside the one named, which takes that name only once all of it
// has checked out, so a folder with that name is always a whole archive and never part of one.
import { createHash, randomUUID, type KeyObject } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, open as openFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  EXPORT_MANIFEST_PATH,
  isArchivePath,
  MAX_ARCHIVE_PARTS,
  MAX_PART_PLAINTEXT_BYTES,
  EXPORT_SECTIONS,
  matchesPortabilityInventory,
  type ImportFailureCode,
} from '@ensemus/domain/portability';
import {
  open as openSealed,
  parseRecipientPrivateKey,
  sealedRecipientId,
  SealedRefused,
} from '@ensemus/sovereign/sealed';
import { readTarEntries, TarRefused, type TarEntry } from '@ensemus/sovereign/tar';

/** The seal adds its magic, a header of at most 4 KiB, and a tag, to at most this much plain text. */
const MAX_SEALED_PART_BYTES = MAX_PART_PLAINTEXT_BYTES + 8 * 1024;
/** Enough for a manifest listing MAX_ARCHIVE_PARTS parts, each of which takes about 300 bytes to list. */
const MAX_SEALED_MANIFEST_BYTES = 320 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_FOLDER = 0o700;

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

type ManifestPart = {
  path: string;
  section: string;
  records: number;
  plaintext_sha256: string;
  sealed_sha256: string;
  sealed_bytes: number;
};

export type OpenArchiveRefusal = Extract<
  ImportFailureCode,
  | 'ARCHIVE_UNREADABLE'
  | 'WRONG_KEY'
  | 'MANIFEST_INVALID'
  | 'PART_MISSING'
  | 'PART_CHANGED'
  | 'PATH_REFUSED'
  | 'FORMAT_NOT_SUPPORTED'
>;

export type OpenArchiveResult =
  | { ok: true; exportId: string; parts: number; records: number; bytes: number }
  | {
      ok: false;
      code: OpenArchiveRefusal;
      /** With `WRONG_KEY`, the key this archive says it is for, so someone can go and find it. */
      recipientKeyId?: string | null;
    };

class Refused extends Error {
  constructor(
    readonly code: OpenArchiveRefusal,
    readonly recipientKeyId?: string | null,
  ) {
    super(code);
  }
}

function isManifestPart(value: unknown): value is ManifestPart {
  if (value === null || typeof value !== 'object') return false;
  const part = value as Record<string, unknown>;
  return (
    typeof part.path === 'string' &&
    typeof part.section === 'string' &&
    Number.isSafeInteger(part.records) &&
    (part.records as number) >= 0 &&
    typeof part.plaintext_sha256 === 'string' &&
    SHA256.test(part.plaintext_sha256) &&
    typeof part.sealed_sha256 === 'string' &&
    SHA256.test(part.sealed_sha256) &&
    Number.isSafeInteger(part.sealed_bytes) &&
    (part.sealed_bytes as number) >= 0
  );
}

/**
 * Checks only what this tool relies on, by hand, because it has to run with nothing but Node and has no use
 * for the rest of the manifest. An import checks the whole thing against the full schema.
 */
function readManifest(plain: Buffer) {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Refused('MANIFEST_INVALID');
  }
  if (manifest === null || typeof manifest !== 'object') throw new Refused('MANIFEST_INVALID');
  if (manifest.format !== 'ensemus.organization_export') throw new Refused('MANIFEST_INVALID');
  if (typeof manifest.schema_version === 'number' && manifest.schema_version > 2) {
    throw new Refused('FORMAT_NOT_SUPPORTED');
  }
  if (manifest.schema_version !== 1 && manifest.schema_version !== 2)
    throw new Refused('MANIFEST_INVALID');
  const encryption = manifest.encryption as { scheme?: unknown } | undefined;
  if (encryption?.scheme !== 'ensemus.sealed/v1') throw new Refused('FORMAT_NOT_SUPPORTED');
  if (typeof manifest.export_id !== 'string' || !Array.isArray(manifest.parts)) {
    throw new Refused('MANIFEST_INVALID');
  }
  if (manifest.parts.length > MAX_ARCHIVE_PARTS) throw new Refused('MANIFEST_INVALID');

  const seen = new Set<string>();
  for (const part of manifest.parts) {
    if (!isManifestPart(part) || part.path === EXPORT_MANIFEST_PATH) {
      throw new Refused('MANIFEST_INVALID');
    }
    if (!isArchivePath(part.path)) throw new Refused('PATH_REFUSED');
    if (part.path.split('/')[0] !== part.section || seen.has(part.path)) {
      throw new Refused('MANIFEST_INVALID');
    }
    seen.add(part.path);
  }
  if (manifest.schema_version === 2) {
    if (!matchesPortabilityInventory(manifest.inventory, manifest.inventory_version))
      throw new Refused('FORMAT_NOT_SUPPORTED');
    const totals = manifest.sections;
    if (totals === null || typeof totals !== 'object' || Array.isArray(totals))
      throw new Refused('MANIFEST_INVALID');
    const declared = totals as Record<string, { records?: unknown; parts?: unknown }>;
    if (
      Object.keys(declared).length !== EXPORT_SECTIONS.length ||
      EXPORT_SECTIONS.some((name) => !(name in declared))
    )
      throw new Refused('MANIFEST_INVALID');
    for (const name of EXPORT_SECTIONS) {
      const parts = (manifest.parts as ManifestPart[]).filter((part) => part.section === name);
      const total = declared[name];
      if (
        total === null ||
        typeof total !== 'object' ||
        Array.isArray(total) ||
        Object.keys(total).sort().join(',') !== 'parts,records' ||
        !Number.isSafeInteger(total.records) ||
        !Number.isSafeInteger(total.parts) ||
        total.parts !== parts.length ||
        total.records !== parts.reduce((sum, part) => sum + part.records, 0)
      )
        throw new Refused('MANIFEST_INVALID');
    }
    if (
      declared.skills?.parts !== 0 ||
      declared['custom-objects']?.parts !== 0 ||
      !Number.isSafeInteger(manifest.generated_bodies_excluded) ||
      (manifest.generated_bodies_excluded as number) < 0
    )
      throw new Refused('MANIFEST_INVALID');
  }
  return { exportId: manifest.export_id, parts: manifest.parts as ManifestPart[] };
}

/** Where a part's plain bytes go: its own path without `.sealed`, which cannot leave the folder. */
function plainPath(folder: string, archivePath: string) {
  const target = resolve(folder, archivePath.slice(0, -'.sealed'.length));
  // isArchivePath already rules this out. A second check costs nothing beside a customer's own files.
  if (!target.startsWith(resolve(folder) + sep)) throw new Refused('PATH_REFUSED');
  return target;
}

async function writePlain(target: string, bytes: Buffer) {
  await mkdir(dirname(target), { recursive: true, mode: OWNER_ONLY_FOLDER });
  await writeFile(target, bytes, { flag: 'wx', mode: OWNER_ONLY_FILE });
}

/** Everything but the writing of the folder. Takes a key object, so the key's text never reaches here. */
async function walkAndOpen(input: { archivePath: string; key: KeyObject; working: string }) {
  const { archivePath, key, working } = input;
  // A link could point anywhere, and the customer named a file.
  const stats = await lstat(archivePath).catch(() => null);
  if (!stats?.isFile()) throw new Refused('ARCHIVE_UNREADABLE');

  const handle = await openFile(archivePath, 'r');
  try {
    const readAt = async (offset: number, length: number) => {
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    };

    // The whole walk comes first: a cut-off archive or a bad name stops it before anything is opened.
    const entries = new Map<string, TarEntry>();
    try {
      for await (const entry of readTarEntries(readAt, stats.size)) {
        if (!isArchivePath(entry.path) || entries.has(entry.path)) {
          throw new Refused('PATH_REFUSED');
        }
        const limit =
          entry.path === EXPORT_MANIFEST_PATH ? MAX_SEALED_MANIFEST_BYTES : MAX_SEALED_PART_BYTES;
        if (entry.size > limit || entries.size > MAX_ARCHIVE_PARTS) {
          throw new Refused('ARCHIVE_UNREADABLE');
        }
        entries.set(entry.path, entry);
      }
    } catch (error) {
      if (error instanceof TarRefused) throw new Refused('ARCHIVE_UNREADABLE');
      throw error;
    }

    const manifestEntry = entries.get(EXPORT_MANIFEST_PATH);
    if (!manifestEntry) throw new Refused('MANIFEST_INVALID');
    const sealedManifest = await readAt(manifestEntry.offset, manifestEntry.size);
    let plainManifest: Buffer;
    try {
      plainManifest = openSealed(sealedManifest, key);
    } catch (error) {
      if (error instanceof SealedRefused && error.code === 'WRONG_KEY_OR_DAMAGED') {
        throw new Refused('WRONG_KEY', sealedRecipientId(sealedManifest));
      }
      throw new Refused('MANIFEST_INVALID');
    }
    const { exportId, parts } = readManifest(plainManifest);

    // The parts have to be exactly the manifest's, both ways, before a single one is opened.
    const listed = new Set(parts.map(({ path }) => path));
    for (const path of entries.keys()) {
      if (path !== EXPORT_MANIFEST_PATH && !listed.has(path)) throw new Refused('PATH_REFUSED');
    }
    for (const { path } of parts) if (!entries.has(path)) throw new Refused('PART_MISSING');

    await mkdir(working, { recursive: true, mode: OWNER_ONLY_FOLDER });
    await writePlain(join(working, 'manifest.json'), plainManifest);

    let records = 0;
    let bytes = 0;
    for (const part of parts) {
      const entry = entries.get(part.path) as TarEntry;
      if (entry.size !== part.sealed_bytes) throw new Refused('PART_CHANGED');
      const sealed = await readAt(entry.offset, entry.size);
      if (hash(sealed) !== part.sealed_sha256) throw new Refused('PART_CHANGED');
      let plain: Buffer;
      try {
        plain = openSealed(sealed, key);
      } catch {
        // The manifest opened with this key and this part's bytes are the ones listed, so it was sealed
        // for someone else, and saying which is what helps.
        throw new Refused('WRONG_KEY', sealedRecipientId(sealed));
      }
      if (hash(plain) !== part.plaintext_sha256) throw new Refused('PART_CHANGED');
      await writePlain(plainPath(working, part.path), plain);
      records += part.records;
      bytes += plain.length;
    }
    return { ok: true as const, exportId, parts: parts.length, records, bytes };
  } finally {
    await handle.close();
  }
}

/** Opens a whole archive into `outFolder`, or leaves nothing behind. The key is used and goes nowhere. */
export async function openArchive(input: {
  archivePath: string;
  recipientPrivateKeyPem: string;
  outFolder: string;
}): Promise<OpenArchiveResult> {
  const key = parseRecipientPrivateKey(input.recipientPrivateKeyPem);
  const out = resolve(input.outFolder);
  // Beside the named folder, so the last step is a rename on one file system.
  const working = `${out}.opening-${randomUUID()}`;
  try {
    const opened = await walkAndOpen({ archivePath: input.archivePath, key, working });
    await rename(working, out);
    return opened;
  } catch (error) {
    await rm(working, { recursive: true, force: true });
    if (error instanceof Refused) {
      return {
        ok: false,
        code: error.code,
        ...(error.recipientKeyId === undefined ? {} : { recipientKeyId: error.recipientKeyId }),
      };
    }
    throw error;
  }
}

export type ToolIo = { out(line: string): void; err(line: string): void };

const REFUSED = 1;
const BAD_INPUT = 2;

export async function openArchiveCommand(args: readonly string[], io: ToolIo): Promise<number> {
  let values;
  try {
    values = parseArgs({
      args: [...args],
      options: {
        archive: { type: 'string' },
        'key-file': { type: 'string' },
        out: { type: 'string' },
      },
    }).values;
  } catch {
    io.err('NOT_AN_OPTION');
    return BAD_INPUT;
  }
  const { archive, 'key-file': keyFile, out } = values;
  if (!archive || !keyFile || !out) {
    io.err('ARGUMENTS_REQUIRED: --archive <file> --key-file <private key> --out <new folder>');
    return BAD_INPUT;
  }
  // Refused rather than merged into, so an old open and a new one can never be mistaken for one archive.
  if (await lstat(out).catch(() => null)) {
    io.err('OUT_EXISTS: name a folder that does not exist yet');
    return BAD_INPUT;
  }
  let recipientPrivateKeyPem: string;
  try {
    recipientPrivateKeyPem = await readFile(keyFile, 'utf8');
    parseRecipientPrivateKey(recipientPrivateKeyPem);
  } catch {
    // Fixed text: what parsing a key throws is nothing that should be repeated.
    io.err('KEY_UNREADABLE: the key file could not be read as an X25519 private key');
    return BAD_INPUT;
  }

  let result: OpenArchiveResult;
  try {
    result = await openArchive({ archivePath: archive, recipientPrivateKeyPem, outFolder: out });
  } catch {
    io.err('OUT_NOT_WRITTEN');
    return REFUSED;
  }
  if (!result.ok) {
    io.err(
      result.code === 'WRONG_KEY' && result.recipientKeyId
        ? `WRONG_KEY: this archive is sealed for key ${result.recipientKeyId}`
        : result.code,
    );
    return REFUSED;
  }
  io.out(
    `Opened export ${result.exportId}: ${result.parts} parts, ${result.records} records, ${result.bytes} bytes. Every hash matched.`,
  );
  return 0;
}

// Only when run directly, because a test imports this file. A bundle's own path is what Node was told to run.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await openArchiveCommand(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
