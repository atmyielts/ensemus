// What a backup set is, and the one rule that keeps deleted files deleted through a restore: nothing is ever
// written back under the tombstone ledger (ADR-026, ADR-030 D11). Generated keys only.
import { createHash, randomUUID } from 'node:crypto';
import { MAX_PART_PLAINTEXT_BYTES } from '@ensemus/domain/portability';
import { ledgerKeyFor } from '@ensemus/domain/tombstone-ledger';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_COMPONENTS,
  backupManifestSchema,
  BackupRefused,
  checkComponentParts,
  mayRestoreObject,
  objectManifestText,
  objectsFromParts,
  openBackupPart,
  OBJECT_PREFIXES_NEVER_RESTORED,
  parseObjectManifest,
  partFileFor,
  sealBackupPart,
  splitIntoParts,
  tombstoneEntryKeyForObject,
  type BackupPart,
} from './backup';
import { generateRecipientKeyPair, recipientKeyId } from './sealed';

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function* chunks(...items: Buffer[]) {
  for (const item of items) yield item;
}

async function collect<T>(source: AsyncIterable<T>) {
  const all: T[] = [];
  for await (const item of source) all.push(item);
  return all;
}

const refusal = (code: string) => expect.objectContaining({ name: 'BackupRefused', code });

describe('what a restore may write', () => {
  const ledgerKey = `tombstone-ledger/v1/${randomUUID()}/artifact/${randomUUID()}.json`;
  const quarantineKey = `tombstone-ledger-quarantine/v1/${randomUUID()}/artifact/${randomUUID()}.json`;

  it('names both prefixes, so the list and the check cannot drift apart', () => {
    for (const prefix of OBJECT_PREFIXES_NEVER_RESTORED) {
      expect(mayRestoreObject(`${prefix}anything`)).toBe(false);
    }
  });

  it.each([
    ['a ledger key', ledgerKey],
    ['a quarantine key', quarantineKey],
    ['the prefix alone', 'tombstone-ledger/'],
    ['the quarantine prefix alone', 'tombstone-ledger-quarantine/'],
    ['the name with no slash', 'tombstone-ledger'],
    ['a leading slash', `/${ledgerKey}`],
    ['several leading slashes', `///${ledgerKey}`],
    ['a leading slash on quarantine', `/${quarantineKey}`],
    ['a leading dot segment', `./${ledgerKey}`],
    ['dot segments and slashes', `.//./${ledgerKey}`],
    ['a backslash', ledgerKey.replaceAll('/', '\\')],
    ['a leading backslash', `\\${ledgerKey}`],
    ['capitals', ledgerKey.replace('tombstone-ledger', 'TOMBSTONE-LEDGER')],
    ['mixed case on quarantine', quarantineKey.replace('tombstone', 'ToMbStOnE')],
    ['a percent-encoded slash', ledgerKey.replace('/', '%2F')],
    ['a lower-case encoded slash', ledgerKey.replace('/', '%2f')],
    ['an encoded hyphen', ledgerKey.replace('-', '%2D')],
    ['an encoded leading slash', `%2F${ledgerKey}`],
    ['encoded twice', ledgerKey.replace('/', '%252F')],
    ['encoded three times', ledgerKey.replace('/', '%25252F')],
    ['a trailing dot on the folder', ledgerKey.replace('tombstone-ledger/', 'tombstone-ledger./')],
    [
      'a trailing space on the folder',
      ledgerKey.replace('tombstone-ledger/', 'tombstone-ledger /'),
    ],
    ['a walk out and back', `abc/../${ledgerKey}`],
    ['an encoded walk out and back', `abc/%2E%2E/${ledgerKey}`],
    ['a walk out of the store', `../${ledgerKey}`],
    ['a leading space', ` ${ledgerKey}`],
    ['a trailing space', `${ledgerKey} `],
    ['a leading tab', `\t${ledgerKey}`],
    ['a null byte', `\u0000${ledgerKey}`],
    ['an encoded null byte', `%00${ledgerKey}`],
    ['a zero-width space', ledgerKey.replace('-', '​-')],
    ['full-width characters', ledgerKey.replace('tombstone', 'ｔombstone')],
    ['a broken percent sequence', `${ledgerKey}%`],
    ['an empty key', ''],
    ['nothing but slashes', '///'],
    ['nothing but dots', './.'],
  ])('refuses %s', (_name, key) => {
    expect(mayRestoreObject(key)).toBe(false);
  });

  it.each([
    ['a file', `${randomUUID()}/artifacts/${randomUUID()}`],
    [
      'an export part',
      `organization-exports/v1/${randomUUID()}/${randomUUID()}/manifest.json.sealed`,
    ],
    ['a key that only starts alike', 'tombstone-ledger-notes/report.txt'],
    ['a key that only ends alike', 'old-tombstone-ledger/report.txt'],
    ['the name further down a path', `${randomUUID()}/tombstone-ledger/v1/x.json`],
  ])('allows %s', (_name, key) => {
    expect(mayRestoreObject(key)).toBe(true);
  });
});

describe('finding the ledger entry for a file', () => {
  const organizationId = randomUUID();
  const targetId = randomUUID();

  it('names the entry a deletion of this file would have written', () => {
    expect(tombstoneEntryKeyForObject(`${organizationId}/artifacts/${targetId}`)).toBe(
      ledgerKeyFor({ organizationId, targetType: 'artifact', targetId }),
    );
  });

  it.each([
    [
      'an export part',
      `organization-exports/v1/${organizationId}/${targetId}/manifest.json.sealed`,
    ],
    ['a name that is not an ID', `${organizationId}/artifacts/report.pdf`],
    ['a tenant that is not an ID', `tenant/artifacts/${targetId}`],
    ['something under a file', `${organizationId}/artifacts/${targetId}/more`],
  ])('finds none for %s', (_name, key) => {
    expect(tombstoneEntryKeyForObject(key)).toBeNull();
  });
});

describe('the manifest', () => {
  const manifest = {
    format: 'ensemus.backup',
    format_version: 1,
    backup_id: randomUUID(),
    taken_at: '2026-11-06T10:00:00.000Z',
    release_version: '2.0.0',
    database_schema_version: '0301_sovereign_security',
    recipient_key_id: '0'.repeat(32),
    components: [],
    excludes_tombstone_ledger: true,
  };

  it('accepts one that keeps the ledger out', () => {
    expect(backupManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it.each([
    ['claims to hold the ledger', { excludes_tombstone_ledger: false }],
    ['does not say', { excludes_tombstone_ledger: undefined }],
    ['is a later format', { format_version: 2 }],
    ['has a field nobody reviewed', { extra: 'x' }],
    [
      'names a part outside its folder',
      {
        components: [
          {
            component: 'objects',
            parts: [
              {
                file: '../objects/000001.sealed',
                plaintext_sha256: sha256('x'),
                sealed_sha256: sha256('y'),
                sealed_bytes: 1,
              },
            ],
          },
        ],
      },
    ],
  ])('refuses one that %s', (_name, change) => {
    expect(backupManifestSchema.safeParse({ ...manifest, ...change }).success).toBe(false);
  });
});

describe('splitting into parts', () => {
  const totalOf = (parts: Buffer[]) => Buffer.concat(parts);

  it('never makes a part over the limit, and loses nothing', async () => {
    const body = Buffer.from(Array.from({ length: 1000 }, (_, at) => at % 251));
    const parts = await collect(
      splitIntoParts(
        chunks(body.subarray(0, 333), body.subarray(333, 334), body.subarray(334)),
        64,
      ),
    );
    expect(parts.every((part) => part.length <= 64)).toBe(true);
    expect(totalOf(parts).equals(body)).toBe(true);
    expect(parts.length).toBe(Math.ceil(1000 / 64));
  });

  it('makes no part from nothing', async () => {
    expect(await collect(splitIntoParts(chunks()))).toEqual([]);
    expect(await collect(splitIntoParts(chunks(Buffer.alloc(0))))).toEqual([]);
  });

  it('uses the same limit as an archive by default', async () => {
    const body = Buffer.alloc(MAX_PART_PLAINTEXT_BYTES + 1);
    const parts = await collect(splitIntoParts(chunks(body)));
    expect(parts.map((part) => part.length)).toEqual([MAX_PART_PLAINTEXT_BYTES, 1]);
  });
});

describe('a sealed part', () => {
  const owner = generateRecipientKeyPair();
  const stranger = generateRecipientKeyPair();
  const plain = Buffer.from('a dump, in test form');

  it('opens with the right key and says what it holds', () => {
    const { part, sealed } = sealBackupPart(plain, owner.publicKey, 'objects', 1);
    expect(part).toMatchObject({
      file: 'objects/000001.sealed',
      plaintext_sha256: sha256(plain),
      sealed_sha256: sha256(sealed),
      sealed_bytes: sealed.length,
    });
    expect(openBackupPart(part, sealed, owner.privateKey).equals(plain)).toBe(true);
    expect(sealed.includes(plain)).toBe(false);
  });

  it('refuses one that changed, before trying to open it', () => {
    const { part, sealed } = sealBackupPart(plain, owner.publicKey, 'objects', 1);
    const changed = Buffer.from(sealed);
    changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
    expect(() => openBackupPart(part, changed, owner.privateKey)).toThrow(
      refusal('PART_HASH_DIFFERS'),
    );
  });

  it('refuses the wrong key, and names the key it was sealed to', () => {
    const { part, sealed } = sealBackupPart(plain, owner.publicKey, 'objects', 1);
    expect(() => openBackupPart(part, sealed, stranger.privateKey)).toThrow(
      expect.objectContaining({ code: 'WRONG_KEY', sealedTo: recipientKeyId(owner.publicKey) }),
    );
  });

  it('refuses a plain hash that does not match what opened', () => {
    const { part, sealed } = sealBackupPart(plain, owner.publicKey, 'objects', 1);
    expect(() =>
      openBackupPart({ ...part, plaintext_sha256: sha256('other') }, sealed, owner.privateKey),
    ).toThrow(refusal('PLAIN_HASH_DIFFERS'));
  });
});

describe('the order of parts', () => {
  const partAt = (file: string): BackupPart => ({
    file,
    plaintext_sha256: sha256('x'),
    sealed_sha256: sha256('y'),
    sealed_bytes: 1,
  });

  it('accepts parts in place, for every component', () => {
    for (const component of BACKUP_COMPONENTS) {
      const parts = [partAt(partFileFor(component, 1)), partAt(partFileFor(component, 2))];
      expect(() => checkComponentParts(component, parts)).not.toThrow();
    }
  });

  it.each([
    ['shuffled', ['objects/000002.sealed', 'objects/000001.sealed']],
    ['with a gap', ['objects/000001.sealed', 'objects/000003.sealed']],
    ['starting late', ['objects/000002.sealed']],
    ['from another component', ['postgres_ensemus/000001.sealed']],
  ])('refuses parts %s', (_name, files) => {
    expect(() => checkComponentParts('objects', files.map(partAt))).toThrow(
      refusal('PARTS_OUT_OF_ORDER'),
    );
  });
});

describe('the object manifest', () => {
  const line = (key: string, body: Buffer) => ({ key, sha256: sha256(body), bytes: body.length });

  it('reads back what was written', () => {
    const lines = [line('a/artifacts/b', Buffer.from('one')), line('c', Buffer.from('two'))];
    expect(parseObjectManifest(objectManifestText(lines))).toEqual(lines);
  });

  it('is empty for an empty store', () => {
    expect(parseObjectManifest('')).toEqual([]);
  });

  it.each([
    ['is not JSON', 'nope\n'],
    ['has a field nobody reviewed', '{"key":"a","sha256":"x","bytes":1,"name":"secret"}\n'],
    ['has a blank line', `${JSON.stringify(line('a', Buffer.from('x')))}\n\n`],
  ])('refuses one that %s', (_name, text) => {
    expect(() => parseObjectManifest(text)).toThrow(refusal('OBJECT_MANIFEST_NOT_VALID'));
  });

  it('holds no ledger key, and says so by refusing one when it is written', () => {
    const key = `tombstone-ledger/v1/${randomUUID()}/artifact/${randomUUID()}.json`;
    expect(() => objectManifestText([line(key, Buffer.from('x'))])).toThrow(
      refusal('OBJECT_MANIFEST_NOT_VALID'),
    );
  });
});

describe('reading objects back out of their parts', () => {
  const one = Buffer.from('first object');
  const two = Buffer.from('the second object is longer');
  const lines = [
    { key: 'a', sha256: sha256(one), bytes: one.length },
    { key: 'b', sha256: sha256(two), bytes: two.length },
    { key: 'empty', sha256: sha256(''), bytes: 0 },
  ];

  it('gives each object whole, wherever the part boundaries fell', async () => {
    const all = Buffer.concat([one, two]);
    const found = await collect(
      objectsFromParts(lines, chunks(all.subarray(0, 3), all.subarray(3, 20), all.subarray(20))),
    );
    expect(found.map(({ line, body }) => [line.key, body.toString()])).toEqual([
      ['a', one.toString()],
      ['b', two.toString()],
      ['empty', ''],
    ]);
  });

  it('refuses an object whose bytes differ, before anyone gets them', async () => {
    const damaged = Buffer.concat([Buffer.from('FIRST object'), two]);
    await expect(collect(objectsFromParts(lines, chunks(damaged)))).rejects.toEqual(
      refusal('OBJECT_HASH_DIFFERS'),
    );
  });

  it('refuses a stream that ends early', async () => {
    await expect(collect(objectsFromParts(lines, chunks(one)))).rejects.toEqual(
      refusal('OBJECTS_TRUNCATED'),
    );
  });

  it('refuses bytes nobody listed', async () => {
    const extra = Buffer.concat([one, two, Buffer.from('more')]);
    await expect(collect(objectsFromParts(lines, chunks(extra)))).rejects.toEqual(
      refusal('OBJECTS_HAVE_EXTRA_BYTES'),
    );
  });

  it('is what BackupRefused is, so a tool can print its code', () => {
    expect(new BackupRefused('OBJECTS_TRUNCATED').code).toBe('OBJECTS_TRUNCATED');
  });
});
