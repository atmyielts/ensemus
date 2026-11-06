#!/usr/bin/env node
// Takes a backup set (OPS-02, ADR-030 D11), in the order docs/05-operations/sovereign/backup-and-restore.md
// gives: drain the ledger backlog, take the database, then Temporal, then objects. Each store is taken at its
// own moment, and that document says what the gaps between them mean. Nothing here is scheduled, and it
// promises nothing about how long anything takes.
//
//   node infrastructure/scripts/sovereign-backup.mjs --out <new folder> --recipient <public key file>
//     --release <version> --schema-version <last migration>
//     --object-endpoint <url> --object-access-key-file <file> --object-secret-key-file <file>
//     [--bucket ensemus] [--license-file <file>]... [--config-file <file>]...
//     [--compose-file <file>]... [--project <name>] [--accept-ledger-backlog]
//
// It holds only a public key, so nothing that ran this can read the result. The tombstone ledger is never in
// it: a backup that held the ledger could roll it back on restore, which would forget deletions (ADR-026).
//
// Run from a checkout of the release with its dependencies installed, after building the tools into
// workers/workflow/dist/tools. Prints one line of JSON per step: IDs, counts, hashes and times, and no names.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const toolsFolder = join(repoRoot, 'workers', 'workflow', 'dist', 'tools');

export const say = (fields) => process.stdout.write(`${JSON.stringify(fields)}\n`);

export function stop(reasonCode) {
  process.stderr.write(`Refused: ${reasonCode}\n`);
  process.exit(1);
}

/** The bundled tool, which is the one copy of the rules. Nothing here decides anything about a key. */
export async function loadTool(name) {
  const path = join(toolsFolder, `${name}.mjs`);
  if (!existsSync(path)) stop(`TOOL_NOT_BUILT_${name}`);
  return import(pathToFileURL(path).href);
}

/** The existing storage adapter, loaded from source: Node strips its types, and it uses nothing else. */
export async function openStore(values) {
  const { S3ObjectStore } = await import(
    pathToFileURL(join(repoRoot, 'packages', 'storage', 'src', 'index.ts')).href
  );
  return new S3ObjectStore({
    endpoint: values['object-endpoint'],
    bucket: values.bucket ?? 'ensemus',
    accessKey: readFileSync(values['object-access-key-file'], 'utf8').trim(),
    secretKey: readFileSync(values['object-secret-key-file'], 'utf8').trim(),
  });
}

export function composeArguments(values) {
  const files = values['compose-file']?.length
    ? values['compose-file']
    : [join(repoRoot, 'infrastructure', 'compose', 'compose.yaml')];
  return [
    'compose',
    ...(values.project ? ['-p', values.project] : []),
    ...files.flatMap((file) => ['-f', file]),
  ];
}

/** Compose, waited for, with its output returned. A failure stops everything. */
export function compose(values, ...args) {
  const result = spawnSync('docker', [...composeArguments(values), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) stop(`COMPOSE_FAILED_${args[0]}`);
  return result.stdout;
}

/** The deletions a restore could not put back if the database were lost now (ADR-026). */
function checkLedgerBacklog(values) {
  const output = compose(
    values,
    'run',
    '--rm',
    '--no-deps',
    'dispatcher',
    'node',
    'dist/ledger-backlog.js',
  );
  const line = output
    .split('\n')
    .reverse()
    .find((text) => text.includes('tombstone_ledger.backlog'));
  if (!line) stop('LEDGER_BACKLOG_NOT_READ');
  const { queued, dead, oldestSeconds } = JSON.parse(line);
  say({ event: 'sovereign_backup.ledger_backlog', queued, dead, oldestSeconds });
  if ((queued > 0 || dead > 0) && !values['accept-ledger-backlog']) stop('LEDGER_BACKLOG_NOT_DRAINED');
}

/** A custom-format dump on standard output, sealed as it comes. It is never on disk in the open. */
async function sealDump(values, tools, recipient, folder, component, database) {
  const child = spawn(
    'docker',
    [
      ...composeArguments(values),
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '-U',
      'postgres',
      '-d',
      database,
      '-Fc',
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const exited = new Promise((done) => child.once('exit', done));
  const parts = await tools.sealComponent(child.stdout, { component, recipient, folder });
  if ((await exited) !== 0) stop(`DUMP_FAILED_${database}`);
  say({
    event: 'sovereign_backup.step',
    component,
    parts: parts.length,
    finished_at: new Date().toISOString(),
  });
  return { component, parts };
}

/**
 * Every object but the ledger, one after another, with a manifest of keys and hashes. A key is checked before
 * its bytes are read, so the ledger's bytes are never in this process at all. An object gone by the time it
 * is reached was deleted during the backup, so it is left out and counted.
 */
async function sealObjects(tools, store, recipient, folder) {
  const lines = [];
  const counts = { objects: 0, ledger_objects_left_out: 0, gone_while_reading: 0 };
  async function* bytes() {
    for await (const page of store.listPages('')) {
      for (const key of page) {
        if (!tools.mayRestoreObject(key)) {
          counts.ledger_objects_left_out += 1;
          continue;
        }
        let body;
        try {
          body = await store.get(key);
        } catch (error) {
          if (await store.exists(key)) throw error;
          counts.gone_while_reading += 1;
          continue;
        }
        lines.push({
          key,
          sha256: createHash('sha256').update(body).digest('hex'),
          bytes: body.length,
        });
        counts.objects += 1;
        yield body;
      }
    }
  }
  const parts = await tools.sealComponent(bytes(), { component: 'objects', recipient, folder });
  const text = Buffer.from(tools.objectManifestText(lines));
  async function* once() {
    yield text;
  }
  const manifestParts = await tools.sealComponent(once(), {
    component: 'object_manifest',
    recipient,
    folder,
  });
  say({
    event: 'sovereign_backup.step',
    component: 'objects',
    parts: parts.length,
    ...counts,
    object_manifest_sha256: createHash('sha256').update(text).digest('hex'),
    finished_at: new Date().toISOString(),
  });
  return [
    { component: 'objects', parts },
    { component: 'object_manifest', parts: manifestParts },
  ];
}

/** Each file the operator named, as one JSON line, sealed. The documents are signed, so they travel whole. */
async function sealLicenseDocuments(tools, files, recipient, folder) {
  async function* bytes() {
    for (const file of files) {
      const body = readFileSync(file);
      yield Buffer.from(
        `${JSON.stringify({ name: basename(file), base64: body.toString('base64') })}\n`,
      );
    }
  }
  const component = 'license_documents';
  return { component, parts: await tools.sealComponent(bytes(), { component, recipient, folder }) };
}

/** A hash of each file, so a restore can tell if configuration changed. Never its value. */
async function sealConfigurationHashes(tools, files, recipient, folder) {
  async function* bytes() {
    for (const file of files) {
      const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
      yield Buffer.from(`${JSON.stringify({ name: basename(file), sha256 })}\n`);
    }
  }
  const component = 'configuration_hashes';
  return { component, parts: await tools.sealComponent(bytes(), { component, recipient, folder }) };
}

const OPTIONS = {
  out: { type: 'string' },
  recipient: { type: 'string' },
  release: { type: 'string' },
  'schema-version': { type: 'string' },
  'object-endpoint': { type: 'string' },
  'object-access-key-file': { type: 'string' },
  'object-secret-key-file': { type: 'string' },
  bucket: { type: 'string' },
  'license-file': { type: 'string', multiple: true, default: [] },
  'config-file': { type: 'string', multiple: true, default: [] },
  'compose-file': { type: 'string', multiple: true, default: [] },
  project: { type: 'string' },
  'accept-ledger-backlog': { type: 'boolean', default: false },
};

async function main() {
  const { values } = parseArgs({ options: OPTIONS });
  for (const required of [
    'out',
    'recipient',
    'release',
    'schema-version',
    'object-endpoint',
    'object-access-key-file',
    'object-secret-key-file',
  ]) {
    if (!values[required]) stop(`MISSING_${required}`);
  }
  const folder = resolve(values.out);
  if (existsSync(folder)) stop('OUT_FOLDER_EXISTS');

  const tools = { ...(await loadTool('seal-parts')), ...(await loadTool('open-parts')) };
  const recipient = await tools.readRecipient(values.recipient);
  const store = await openStore(values);

  checkLedgerBacklog(values);

  const components = [
    await sealDump(values, tools, recipient, folder, 'postgres_ensemus', 'ensemus'),
    await sealDump(values, tools, recipient, folder, 'postgres_temporal', 'temporal'),
    await sealDump(
      values,
      tools,
      recipient,
      folder,
      'postgres_temporal_visibility',
      'temporal_visibility',
    ),
    ...(await sealObjects(tools, store, recipient, folder)),
    await sealLicenseDocuments(tools, values['license-file'], recipient, folder),
    await sealConfigurationHashes(tools, values['config-file'], recipient, folder),
  ];

  const { manifest, sealedSha256 } = await tools.writeSealedManifest({
    folder,
    recipient,
    releaseVersion: values.release,
    databaseSchemaVersion: values['schema-version'],
    components,
  });
  say({
    event: 'sovereign_backup.finished',
    backup_id: manifest.backup_id,
    taken_at: manifest.taken_at,
    recipient_key_id: manifest.recipient_key_id,
    excludes_tombstone_ledger: manifest.excludes_tombstone_ledger,
    manifest_sealed_sha256: sealedSha256,
  });
}

// Only when run as a program, since the restore script shares the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // The code and nothing else: an error here can quote a path or a key.
    stop(typeof error?.code === 'string' ? error.code : 'BACKUP_FAILED');
  });
}
