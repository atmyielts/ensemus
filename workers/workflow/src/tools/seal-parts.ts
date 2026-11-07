// Seals what a backup takes, for a key whose private half is the customer's (ADR-030 D11). It holds only a
// public key, so nothing that ran this can read the result back. It needs nothing but Node and touches no
// network, so it can run on the same isolated machine as the rest of the tools.
//   seal-parts part --component <name> --recipient <public key file> --out <folder>   (reads standard input)
//   seal-parts manifest --recipient <public key file> --out <folder> --release <v> --schema-version <name> --components <json file>
// Each prints one line of JSON: the parts it wrote, or the manifest's hash.
import { createHash, randomUUID, type KeyObject } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BACKUP_COMPONENTS,
  BACKUP_MANIFEST_FILE,
  backupManifestSchema,
  sealBackupPart,
  splitIntoParts,
  type BackupComponent,
  type BackupManifest,
  type BackupPart,
} from '@ensemus/sovereign/backup';
import { parseRecipientPublicKey, recipientKeyId, seal } from '@ensemus/sovereign/sealed';

/** Refuses to replace a file, so a second backup into the same folder cannot damage the first. */
async function writeNew(path: string, body: Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { mode: 0o600, flag: 'wx' });
}

/** Seals a stream into its parts, holding at most one part in memory, and says what it wrote. */
export async function sealComponent(
  source: AsyncIterable<Uint8Array>,
  options: { component: BackupComponent; recipient: KeyObject; folder: string; maxBytes?: number },
): Promise<BackupPart[]> {
  const parts: BackupPart[] = [];
  for await (const plain of splitIntoParts(source, options.maxBytes)) {
    const { part, sealed } = sealBackupPart(
      plain,
      options.recipient,
      options.component,
      parts.length + 1,
    );
    await writeNew(join(options.folder, part.file), sealed);
    parts.push(part);
  }
  return parts;
}

/**
 * Writes the sealed manifest. The schema has the last word: `excludes_tombstone_ledger` is always true here,
 * and a manifest that would not read back is refused now and not found out during a restore.
 */
export async function writeSealedManifest(input: {
  folder: string;
  recipient: KeyObject;
  releaseVersion: string;
  databaseSchemaVersion: string;
  components: BackupManifest['components'];
  backupId?: string;
  takenAt?: Date;
}): Promise<{ manifest: BackupManifest; sealedSha256: string }> {
  const manifest = backupManifestSchema.parse({
    format: 'ensemus.backup',
    format_version: 1,
    backup_id: input.backupId ?? randomUUID(),
    taken_at: (input.takenAt ?? new Date()).toISOString(),
    release_version: input.releaseVersion,
    database_schema_version: input.databaseSchemaVersion,
    recipient_key_id: recipientKeyId(input.recipient),
    components: input.components,
    excludes_tombstone_ledger: true,
  });
  const sealed = seal(Buffer.from(JSON.stringify(manifest)), input.recipient);
  await writeNew(join(input.folder, BACKUP_MANIFEST_FILE), sealed);
  return { manifest, sealedSha256: createHash('sha256').update(sealed).digest('hex') };
}

export const readRecipient = async (path: string) =>
  parseRecipientPublicKey((await readFile(path, 'utf8')).trim());

const isComponent = (value: string): value is BackupComponent =>
  (BACKUP_COMPONENTS as readonly string[]).includes(value);

async function main(args: string[]) {
  const [command, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      component: { type: 'string' },
      recipient: { type: 'string' },
      out: { type: 'string' },
      release: { type: 'string' },
      'schema-version': { type: 'string' },
      components: { type: 'string' },
    },
  });
  if (!values.recipient || !values.out) return 2;
  const recipient = await readRecipient(values.recipient);
  if (command === 'part') {
    if (!values.component || !isComponent(values.component)) return 2;
    const parts = await sealComponent(process.stdin, {
      component: values.component,
      recipient,
      folder: values.out,
    });
    process.stdout.write(`${JSON.stringify({ component: values.component, parts })}\n`);
    return 0;
  }
  if (command === 'manifest') {
    if (!values.release || !values['schema-version'] || !values.components) return 2;
    const { manifest, sealedSha256 } = await writeSealedManifest({
      folder: values.out,
      recipient,
      releaseVersion: values.release,
      databaseSchemaVersion: values['schema-version'],
      components: JSON.parse(await readFile(values.components, 'utf8')) as never,
    });
    process.stdout.write(
      `${JSON.stringify({ backup_id: manifest.backup_id, manifest_sealed_sha256: sealedSha256 })}\n`,
    );
    return 0;
  }
  return 2;
}

// Only when run as a program. The backup script imports the functions above from the bundled tool.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // The code and nothing else: an error here can quote a path or a value.
      const code = (error as { code?: unknown } | null)?.code;
      process.stderr.write(`Refused: ${typeof code === 'string' ? code : 'SEAL_FAILED'}\n`);
      process.exitCode = 1;
    });
}
