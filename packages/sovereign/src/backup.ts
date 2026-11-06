// Owned by the restore slice (OPS-02). See docs/06-delivery/m6-slices.md and ADR-030 D11. What a backup set
// is, as data, so the operator's script and the drill check the same thing. A backup is split into sealed
// parts with a sealed manifest, so a customer's private key is all it takes to open one, on any machine.
import { createHash, type KeyObject } from 'node:crypto';
import { MAX_PART_PLAINTEXT_BYTES } from '@ensemus/domain/portability';
import { ledgerKeyFor } from '@ensemus/domain/tombstone-ledger';
import { z } from 'zod';
import { open, seal, sealedRecipientId, SealedRefused } from './sealed';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const BACKUP_COMPONENTS = [
  'postgres_ensemus',
  'postgres_temporal',
  'postgres_temporal_visibility',
  'object_manifest',
  'objects',
  'license_documents',
  'configuration_hashes',
] as const;
export type BackupComponent = (typeof BACKUP_COMPONENTS)[number];

export const backupManifestSchema = z.strictObject({
  format: z.literal('ensemus.backup'),
  format_version: z.literal(1),
  backup_id: z.uuid(),
  taken_at: z.iso.datetime({ offset: true }),
  release_version: z.string().min(1).max(32),
  database_schema_version: z.string().min(1).max(128),
  /** Sealed to this key. The private key is the customer's, and is never in a backup. */
  recipient_key_id: z.string().regex(/^[0-9a-f]{32}$/),
  components: z.array(
    z.strictObject({
      component: z.enum(BACKUP_COMPONENTS),
      /** Parts in order. Their position is part of what is checked, so they cannot be shuffled. */
      parts: z.array(
        z.strictObject({
          file: z.string().regex(/^[a-z0-9_-]+\/[0-9]{6}\.sealed$/),
          plaintext_sha256: sha256,
          sealed_sha256: sha256,
          sealed_bytes: z.int().min(0),
        }),
      ),
    }),
  ),
  /**
   * The ledger stays out, always (ADR-026). A backup that held it could roll it back on restore, which
   * would forget deletions, so a manifest saying otherwise is refused by the schema.
   */
  excludes_tombstone_ledger: z.literal(true),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;
export type BackupPart = BackupManifest['components'][number]['parts'][number];

/** The sealed manifest's name in a backup folder. Everything else in the folder is a part it lists. */
export const BACKUP_MANIFEST_FILE = 'manifest.json.sealed';

export const OBJECT_PREFIXES_NEVER_RESTORED = [
  'tombstone-ledger/',
  'tombstone-ledger-quarantine/',
] as const;

const FOLDERS_NEVER_RESTORED: ReadonlySet<string> = new Set(
  OBJECT_PREFIXES_NEVER_RESTORED.map((prefix) => prefix.slice(0, -1)),
);

/** Every key this product writes is IDs and known words, so anything else has no business in a restore. */
const PLAIN_KEY = /^[\x20-\x7e]+$/;
/** Enough for any encoding that happened by accident. A key still encoded after this is refused. */
const MAX_DECODES = 4;

function fullyDecoded(key: string): string | null {
  let current = key;
  for (let round = 0; round < MAX_DECODES; round += 1) {
    if (!current.includes('%')) return current;
    try {
      current = decodeURIComponent(current);
    } catch {
      return null;
    }
  }
  return current.includes('%') ? null : current;
}

/**
 * Whether a restore may write this key. Anything under the ledger is refused, whatever the backup holds.
 *
 * A store takes a key as bytes, but what sits between a backup and a store may not: a proxy decodes it, a
 * file-backed store folds its case, a path library walks its dots. So this asks what the key could come to
 * mean, and refuses anything it cannot be sure of. Writing back an old ledger would forget deletions, and
 * refusing a key that was never going to be written costs nothing.
 */
export function mayRestoreObject(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  const decoded = fullyDecoded(key);
  if (decoded === null || !PLAIN_KEY.test(decoded) || decoded !== decoded.trim()) return false;
  // Trailing dots and spaces count as nothing, because some file systems drop them.
  const segments = decoded
    .replaceAll('\\', '/')
    .split('/')
    .map((segment) => ({ segment, plain: segment.replace(/[. ]+$/, '') }));
  if (segments.some(({ segment, plain }) => plain === '' && segment !== '' && segment !== '.')) {
    return false;
  }
  const first = segments.find(({ plain }) => plain !== '');
  return first !== undefined && !FOLDERS_NEVER_RESTORED.has(first.plain.toLowerCase());
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ARTIFACT_KEY = new RegExp(`^(${UUID})/artifacts/(${UUID})$`);

/**
 * The ledger entry that would say this file was deleted, or null if the key is not a file. Lets a restore
 * leave out the bytes of a file deleted after the backup, instead of writing them back and then asking a
 * person whether to destroy what it just wrote (ADR-026 D3).
 */
export function tombstoneEntryKeyForObject(key: string): string | null {
  const match = ARTIFACT_KEY.exec(key);
  if (!match) return null;
  return ledgerKeyFor({
    organizationId: match[1] as string,
    targetType: 'artifact',
    targetId: match[2] as string,
  });
}

/** Why a backup was refused. Codes only, so a tool can print one without printing anything it read. */
export type BackupRefusalCode =
  | 'MANIFEST_NOT_VALID'
  | 'PARTS_OUT_OF_ORDER'
  | 'PART_SIZE_DIFFERS'
  | 'PART_HASH_DIFFERS'
  | 'PLAIN_HASH_DIFFERS'
  | 'WRONG_KEY'
  | 'FILE_NOT_LISTED'
  | 'LINK_REFUSED'
  | 'COMPONENT_NOT_LISTED'
  | 'OBJECT_MANIFEST_NOT_VALID'
  | 'OBJECT_HASH_DIFFERS'
  | 'OBJECTS_TRUNCATED'
  | 'OBJECTS_HAVE_EXTRA_BYTES';

export class BackupRefused extends Error {
  override name = 'BackupRefused';
  readonly code: BackupRefusalCode;
  /** With `WRONG_KEY`, the key this was sealed to, so someone can find the right one. Only ever a hash. */
  readonly sealedTo: string | null;
  constructor(code: BackupRefusalCode, sealedTo: string | null = null) {
    super(code);
    this.code = code;
    this.sealedTo = sealedTo;
  }
}

const hashOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Where a component's part lives in the folder. Its position is in the name. */
export const partFileFor = (component: BackupComponent, sequence: number) =>
  `${component}/${String(sequence).padStart(6, '0')}.sealed`;

/** Refuses parts that are shuffled, have a gap, or belong to another component. */
export function checkComponentParts(component: BackupComponent, parts: readonly BackupPart[]) {
  parts.forEach((part, index) => {
    if (part.file !== partFileFor(component, index + 1)) {
      throw new BackupRefused('PARTS_OUT_OF_ORDER');
    }
  });
}

/** Cuts a stream into pieces no larger than one part may be, holding at most one piece in memory. */
export async function* splitIntoParts(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number = MAX_PART_PLAINTEXT_BYTES,
): AsyncGenerator<Buffer> {
  let held: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    let rest = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    while (rest.length > 0) {
      const taken = rest.subarray(0, maxBytes - size);
      held.push(taken);
      size += taken.length;
      rest = rest.subarray(taken.length);
      if (size === maxBytes) {
        yield Buffer.concat(held);
        held = [];
        size = 0;
      }
    }
  }
  if (size > 0) yield Buffer.concat(held);
}

export function sealBackupPart(
  plaintext: Buffer,
  recipient: KeyObject,
  component: BackupComponent,
  sequence: number,
): { part: BackupPart; sealed: Buffer } {
  const sealed = seal(plaintext, recipient);
  return {
    sealed,
    part: {
      file: partFileFor(component, sequence),
      plaintext_sha256: hashOf(plaintext),
      sealed_sha256: hashOf(sealed),
      sealed_bytes: sealed.length,
    },
  };
}

/** Opens one part. The sealed hash comes first, so damage is told from a wrong key. */
export function openBackupPart(part: BackupPart, sealed: Buffer, privateKey: KeyObject): Buffer {
  if (sealed.length !== part.sealed_bytes) throw new BackupRefused('PART_SIZE_DIFFERS');
  if (hashOf(sealed) !== part.sealed_sha256) throw new BackupRefused('PART_HASH_DIFFERS');
  const plain = openWith(sealed, privateKey);
  if (hashOf(plain) !== part.plaintext_sha256) throw new BackupRefused('PLAIN_HASH_DIFFERS');
  return plain;
}

function openWith(sealed: Buffer, privateKey: KeyObject) {
  try {
    return open(sealed, privateKey);
  } catch (error) {
    if (error instanceof SealedRefused) {
      throw new BackupRefused('WRONG_KEY', sealedRecipientId(sealed));
    }
    throw error;
  }
}

/** Opens the sealed manifest and holds it to the schema. A manifest that fails it is not read further. */
export function openBackupManifest(sealed: Buffer, privateKey: KeyObject): BackupManifest {
  const plain = openWith(sealed, privateKey);
  let raw: unknown;
  try {
    raw = JSON.parse(plain.toString('utf8'));
  } catch {
    throw new BackupRefused('MANIFEST_NOT_VALID');
  }
  const parsed = backupManifestSchema.safeParse(raw);
  if (!parsed.success) throw new BackupRefused('MANIFEST_NOT_VALID');
  for (const { component, parts } of parsed.data.components) checkComponentParts(component, parts);
  return parsed.data;
}

/** One object in the backup, in the order its bytes appear in the `objects` component. */
export const objectManifestLineSchema = z.strictObject({
  key: z.string().min(1).max(1024),
  sha256,
  bytes: z.int().min(0),
});
export type ObjectManifestLine = z.infer<typeof objectManifestLineSchema>;

/**
 * Writes the object manifest, one line to an object. A ledger key is refused here too, so a slip in the
 * script that lists the store cannot put one into a backup and then rely on the restore to catch it.
 */
export function objectManifestText(lines: readonly ObjectManifestLine[]): string {
  return lines
    .map((line) => {
      const parsed = objectManifestLineSchema.safeParse(line);
      if (!parsed.success || !mayRestoreObject(line.key)) {
        throw new BackupRefused('OBJECT_MANIFEST_NOT_VALID');
      }
      return `${JSON.stringify(parsed.data)}\n`;
    })
    .join('');
}

/** Reads the object manifest. It is sealed, and is still held to the schema, line by line. */
export function parseObjectManifest(text: string): ObjectManifestLine[] {
  if (text === '') return [];
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  return lines.map((line) => {
    try {
      return objectManifestLineSchema.parse(JSON.parse(line));
    } catch {
      throw new BackupRefused('OBJECT_MANIFEST_NOT_VALID');
    }
  });
}

/**
 * The `objects` component is every object's bytes, one after another, cut into parts wherever a part fills.
 * This walks them back out against the manifest. No object is handed over until its hash has been checked,
 * so nothing damaged can reach a store, and at most one object and one part are held in memory.
 */
export async function* objectsFromParts(
  lines: readonly ObjectManifestLine[],
  plainParts: AsyncIterable<Buffer>,
): AsyncGenerator<{ line: ObjectManifestLine; body: Buffer }> {
  const source = plainParts[Symbol.asyncIterator]();
  let current: Buffer = Buffer.alloc(0);
  const take = async (bytes: number) => {
    const held: Buffer[] = [];
    let needed = bytes;
    while (needed > 0) {
      if (current.length === 0) {
        const next = await source.next();
        if (next.done) throw new BackupRefused('OBJECTS_TRUNCATED');
        current = next.value;
        continue;
      }
      const piece = current.subarray(0, needed);
      held.push(piece);
      needed -= piece.length;
      current = current.subarray(piece.length);
    }
    return Buffer.concat(held);
  };
  for (const line of lines) {
    const body = await take(line.bytes);
    if (hashOf(body) !== line.sha256) throw new BackupRefused('OBJECT_HASH_DIFFERS');
    yield { line, body };
  }
  while (current.length === 0) {
    const next = await source.next();
    if (next.done) return;
    current = next.value;
  }
  throw new BackupRefused('OBJECTS_HAVE_EXTRA_BYTES');
}
