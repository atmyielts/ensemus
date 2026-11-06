// Opens a backup with the customer's private key, on any machine (ADR-030 D11). A sealed part is checked
// before it is opened and again after, and nothing reaches a caller until both have passed. It needs nothing
// but Node and touches no network. The key is read from a file and goes nowhere else.
//   open-parts verify --backup <folder> --key <private key file>                        (one line of JSON)
//   open-parts manifest --backup <folder> --key <private key file>                      (the manifest, as JSON)
//   open-parts component --component <name> --backup <folder> --key <private key file>  (its bytes, to standard output)
// The restore script also imports from the bundled tool, so that everything it knows about a backup,
// `mayRestoreObject` above all, is this one copy of the rule.
import { createHash, type KeyObject } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BACKUP_COMPONENTS,
  BACKUP_MANIFEST_FILE,
  BackupRefused,
  checkComponentParts,
  openBackupManifest,
  openBackupPart,
  type BackupComponent,
  type BackupManifest,
  type BackupPart,
} from '@ensemus/sovereign/backup';
import { parseRecipientPrivateKey } from '@ensemus/sovereign/sealed';

export {
  mayRestoreObject,
  objectManifestText,
  objectsFromParts,
  parseObjectManifest,
  tombstoneEntryKeyForObject,
} from '@ensemus/sovereign/backup';

export const readPrivateKey = async (path: string) =>
  parseRecipientPrivateKey(await readFile(path, 'utf8'));

export async function readManifest(folder: string, key: KeyObject): Promise<BackupManifest> {
  return openBackupManifest(await readFile(join(folder, BACKUP_MANIFEST_FILE)), key);
}

const partsOf = (manifest: BackupManifest, component: BackupComponent): readonly BackupPart[] => {
  const found = manifest.components.find((entry) => entry.component === component);
  if (!found) throw new BackupRefused('COMPONENT_NOT_LISTED');
  checkComponentParts(component, found.parts);
  return found.parts;
};

/** A component's plain bytes, a part at a time, each checked before it is handed over. */
export async function* openComponent(
  folder: string,
  manifest: BackupManifest,
  component: BackupComponent,
  key: KeyObject,
): AsyncGenerator<Buffer> {
  for (const part of partsOf(manifest, component)) {
    // The name passed the schema's pattern, so it cannot leave the folder. A link could, so that is refused.
    const path = join(folder, part.file);
    const info = await lstat(path);
    if (!info.isFile()) throw new BackupRefused('LINK_REFUSED');
    if (info.size !== part.sealed_bytes) throw new BackupRefused('PART_SIZE_DIFFERS');
    yield openBackupPart(part, await readFile(path), key);
  }
}

/** Every file under a folder, by its path inside it. Anything but a file or a folder is refused. */
async function* walk(folder: string, at: string = folder): AsyncGenerator<string> {
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const path = join(at, entry.name);
    if (entry.isDirectory()) yield* walk(folder, path);
    else if (entry.isFile()) yield relative(folder, path).split(sep).join('/');
    else throw new BackupRefused('LINK_REFUSED');
  }
}

/**
 * Opens every part and checks every hash, without keeping any of it, and refuses anything in the folder that
 * the manifest does not list. A restore runs this before it touches anything, so a damaged backup costs
 * nothing but the time this took.
 */
export async function verifyBackup(folder: string, key: KeyObject) {
  const manifest = await readManifest(folder, key);
  const listed = new Set<string>([BACKUP_MANIFEST_FILE]);
  let parts = 0;
  let plainBytes = 0;
  for (const { component, parts: componentParts } of manifest.components) {
    for (const part of componentParts) listed.add(part.file);
    for await (const plain of openComponent(folder, manifest, component, key)) {
      parts += 1;
      plainBytes += plain.length;
    }
  }
  for await (const file of walk(folder)) {
    if (!listed.has(file)) throw new BackupRefused('FILE_NOT_LISTED');
  }
  const sealed = await readFile(join(folder, BACKUP_MANIFEST_FILE));
  return {
    backup_id: manifest.backup_id,
    release_version: manifest.release_version,
    database_schema_version: manifest.database_schema_version,
    recipient_key_id: manifest.recipient_key_id,
    parts,
    plain_bytes: plainBytes,
    manifest_sealed_sha256: createHash('sha256').update(sealed).digest('hex'),
  };
}

const isComponent = (value: string): value is BackupComponent =>
  (BACKUP_COMPONENTS as readonly string[]).includes(value);

async function main(args: string[]) {
  const [command, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      backup: { type: 'string' },
      key: { type: 'string' },
      component: { type: 'string' },
    },
  });
  if (!values.backup || !values.key) return 2;
  const key = await readPrivateKey(values.key);
  if (command === 'verify') {
    process.stdout.write(`${JSON.stringify(await verifyBackup(values.backup, key))}\n`);
    return 0;
  }
  if (command === 'manifest') {
    process.stdout.write(`${JSON.stringify(await readManifest(values.backup, key))}\n`);
    return 0;
  }
  if (command === 'component') {
    if (!values.component || !isComponent(values.component)) return 2;
    const manifest = await readManifest(values.backup, key);
    for await (const plain of openComponent(values.backup, manifest, values.component, key)) {
      if (!process.stdout.write(plain)) await once(process.stdout, 'drain');
    }
    return 0;
  }
  return 2;
}

// Only when run as a program. The restore script imports the functions above from the bundled tool.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof BackupRefused) {
        const forKey = error.sealedTo ? ` (sealed to key ${error.sealedTo})` : '';
        process.stderr.write(`Refused: ${error.code}${forKey}\n`);
      } else {
        // The code and nothing else: an error here can quote a path, and a key must never be near one.
        const code = (error as { code?: unknown } | null)?.code;
        process.stderr.write(`Refused: ${typeof code === 'string' ? code : 'OPEN_FAILED'}\n`);
      }
      process.exitCode = 1;
    });
}
