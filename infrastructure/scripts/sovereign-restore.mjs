#!/usr/bin/env node
// Restores a backup set (OPS-02, ADR-030 D11), in the order docs/05-operations/sovereign/backup-and-restore.md
// gives. It checks the whole backup before it touches anything. Every object key goes through
// `mayRestoreObject`, so nothing is ever written under the tombstone ledger, whatever the backup holds. It does
// not start the web tier, the workers or the connector worker, and it does not run the reconcile: those are the
// next steps, and they are a person's to take. Nothing here is scheduled, and it promises nothing about how
// long anything takes.
//
//   node infrastructure/scripts/sovereign-restore.mjs --backup <folder> --key <private key file>
//     --replace-databases-of <compose project name>
//     --object-endpoint <url> --object-access-key-file <file> --object-secret-key-file <file>
//     [--bucket ensemus] [--compose-file <file>]... [--project <name>] [--also-stop <service>]...
//
// --replace-databases-of has to repeat the project's name, because this replaces three databases.
//
// Prints one line of JSON per step: IDs, counts, hashes and times. The private key is read from its file and
// goes nowhere else. A file deleted after this backup was taken has an entry in the ledger: its bytes are not
// written back, and the reconcile's re-apply then needs no decision about it (ADR-026 D3). They stay in the
// sealed backup, so a forged entry costs a restore of that file and not the file.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  compose,
  composeArguments,
  loadTool,
  openStore,
  repoRoot,
  say,
  stop,
} from './sovereign-backup.mjs';

const OPTIONS = {
  backup: { type: 'string' },
  key: { type: 'string' },
  'replace-databases-of': { type: 'string' },
  'object-endpoint': { type: 'string' },
  'object-access-key-file': { type: 'string' },
  'object-secret-key-file': { type: 'string' },
  bucket: { type: 'string' },
  'compose-file': { type: 'string', multiple: true, default: [] },
  project: { type: 'string' },
  'also-stop': { type: 'string', multiple: true, default: [] },
};

/**
 * Everything that reads or writes what is about to be replaced. Web comes down first, because a process left
 * running can serve for a while before it notices (ADR-026). The connector worker comes down with the rest,
 * and it is the last thing anyone should start again.
 */
const STOPPED_FIRST = [
  'proxy',
  'web',
  'connector-worker',
  'agent-worker',
  'knowledge-worker',
  'worker',
  'dispatcher',
  'temporal',
];

/** Stop every configured project reader, including overlay replicas; retain only restore stores. */
export function restoreServicesToStop(knownServices, alsoStop = []) {
  const known = new Set(knownServices);
  if (
    !known.has('postgres') ||
    !known.has('objects') ||
    alsoStop.some((name) => !known.has(name) || ['postgres', 'objects'].includes(name))
  ) {
    throw Object.assign(new Error('RESTORE_SERVICE_INVENTORY_REFUSED'), {
      code: 'RESTORE_SERVICE_INVENTORY_REFUSED',
    });
  }
  const services = [...known].filter((name) => !['postgres', 'objects'].includes(name));
  return [
    ...STOPPED_FIRST.filter((name) => services.includes(name)),
    ...services.filter((name) => !STOPPED_FIRST.includes(name)).sort(),
  ];
}

function stopEverything(values) {
  const known = compose(values, '--profile', '*', 'config', '--services')
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);
  const services = restoreServicesToStop(known, values['also-stop']);
  compose(values, '--profile', '*', 'stop', '--timeout', '60', ...services);
  const stillRunning = compose(values, '--profile', '*', 'ps', '--services', '--status', 'running')
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);
  if (stillRunning.some((name) => !['postgres', 'objects'].includes(name)))
    stop('RESTORE_READERS_STILL_RUNNING');
  // Process exit is a local reader fence, not evidence that a previously sent remote effect ended.
  say({ event: 'sovereign_restore.stopped', services, finished_at: new Date().toISOString() });
}

/**
 * The runtime roles 0422's identity.begin_auth_restore refuses to see connected to the database it is
 * about to fence (AUTH_RESTORE_READERS_STILL_CONNECTED). Stopping every service does not end a session
 * held from outside the project, so the restore asks before it replaces anything: refusing at begin
 * would leave the databases already replaced, with the backup's own authentication state in them.
 */
export const RESTORE_READER_ROLES = Object.freeze([
  'ensemus_app',
  'ensemus_agent',
  'ensemus_auth',
  'ensemus_dispatcher',
  'ensemus_secrets',
  'ensemus_operator',
  'ensemus_support',
  'ensemus_eraser',
]);

export const RESTORE_READER_SESSIONS_SQL = `select usename, count(*) from pg_stat_activity where datname = 'ensemus' and usename in (${RESTORE_READER_ROLES.map((role) => `'${role}'`).join(', ')}) group by usename order by usename`;

/** Reads `role|sessions` lines. Anything else is not an answer, and the restore does not guess one. */
export function readersStillConnected(output) {
  const readers = [];
  for (const line of output.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const match = /^(ensemus_[a-z]+)\|([1-9][0-9]{0,6})$/.exec(text);
    if (!match || !RESTORE_READER_ROLES.includes(match[1])) {
      throw Object.assign(new Error('RESTORE_READER_CHECK_UNREADABLE'), {
        code: 'RESTORE_READER_CHECK_UNREADABLE',
      });
    }
    readers.push({ role: match[1], sessions: Number(match[2]) });
  }
  return readers;
}

/** Role names and counts only, which say where the session comes from without saying whose it is. */
function refuseConnectedReaders(values) {
  const readers = readersStillConnected(
    compose(
      values,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'ensemus',
      '-v',
      'ON_ERROR_STOP=1',
      '-tA',
      '-F',
      '|',
      '-c',
      RESTORE_READER_SESSIONS_SQL,
    ),
  );
  if (readers.length > 0) {
    say({
      event: 'sovereign_restore.readers_still_connected',
      readers,
      finished_at: new Date().toISOString(),
    });
    stop('RESTORE_READERS_STILL_CONNECTED');
  }
}

export function authRestoreResult(output, event) {
  const matches = [];
  for (const line of output.split('\n')) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value && typeof value === 'object' && value.event === event) matches.push(value);
  }
  if (matches.length !== 1)
    throw Object.assign(new Error('AUTH_RESTORE_RESULT_UNAVAILABLE'), {
      code: 'AUTH_RESTORE_RESULT_UNAVAILABLE',
    });
  const value = matches[0];
  if (
    event !== 'auth_restore.schema_ready' &&
    (typeof value.generation !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.generation))
  ) {
    throw Object.assign(new Error('AUTH_RESTORE_RESULT_UNAVAILABLE'), {
      code: 'AUTH_RESTORE_RESULT_UNAVAILABLE',
    });
  }
  if (event === 'auth_restore.invalidated') {
    const countKeys = [
      'sessionsRemoved',
      'assurancesRemoved',
      'verificationsRemoved',
      'setupTokensRevoked',
      'backupCodeSetsRevoked',
    ];
    const keys = [
      'event',
      'generation',
      'already_invalidated',
      'version',
      'completedAt',
      'emptyBackupCipherSha256',
      ...countKeys,
    ];
    if (
      value.version !== 1 ||
      typeof value.already_invalidated !== 'boolean' ||
      typeof value.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.completedAt)) ||
      typeof value.emptyBackupCipherSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.emptyBackupCipherSha256) ||
      countKeys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0) ||
      Object.keys(value).length !== keys.length ||
      Object.keys(value).some((key) => !keys.includes(key))
    ) {
      throw Object.assign(new Error('AUTH_RESTORE_RESULT_UNAVAILABLE'), {
        code: 'AUTH_RESTORE_RESULT_UNAVAILABLE',
      });
    }
  }
  return value;
}

/** No serving process resumes. A missing helper/job, native key error or incomplete result stops. */
export function fenceRestoredAuthentication(values, manifest, verified) {
  authRestoreResult(
    compose(
      values,
      'run',
      '--rm',
      '--no-deps',
      'migrate',
      'node',
      'dist/auth-restore.js',
      'migrate',
    ),
    'auth_restore.schema_ready',
  );
  const begin = authRestoreResult(
    compose(
      values,
      'run',
      '--rm',
      '--no-deps',
      'migrate',
      'node',
      'dist/auth-restore.js',
      'begin',
      '--backup',
      manifest.backup_id,
      '--manifest',
      verified.manifest_sealed_sha256,
    ),
    'auth_restore.pending',
  );
  // begin rotates 0515's protected material UUID in the same committed SQL transaction, BEFORE
  // any object bytes or reapply. A partial restore retry always begins with fresh generations.
  const invalidated = authRestoreResult(
    compose(
      values,
      '--profile',
      'ops',
      'run',
      '--rm',
      '--no-deps',
      'auth-restore',
      'node',
      'dist/auth-restore.js',
      'invalidate',
      '--generation',
      begin.generation,
    ),
    'auth_restore.invalidated',
  );
  if (invalidated.generation !== begin.generation) stop('AUTH_RESTORE_GENERATION_CHANGED');
  say({
    event: 'sovereign_restore.authentication_pending',
    generation: begin.generation,
    backup_id: manifest.backup_id,
    manifest_sealed_sha256: verified.manifest_sealed_sha256,
  });
  return begin.generation;
}

/** One transaction, so a failure changes nothing, as the runbook's own restore does. */
async function restoreDump(values, tools, manifest, key, component, database) {
  const child = spawn(
    'docker',
    [
      ...composeArguments(values),
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '-U',
      'postgres',
      '-d',
      database,
      '--clean',
      '--if-exists',
      '--single-transaction',
      '--exit-on-error',
    ],
    { cwd: repoRoot, stdio: ['pipe', 'ignore', 'ignore'] },
  );
  const exited = new Promise((done) => child.once('exit', done));
  child.stdin.on('error', () => undefined);
  for await (const plain of tools.openComponent(values.backup, manifest, component, key)) {
    if (!child.stdin.write(plain)) {
      await Promise.race([new Promise((done) => child.stdin.once('drain', done)), exited]);
    }
  }
  child.stdin.end();
  if ((await exited) !== 0) stop(`RESTORE_FAILED_${database}`);
  say({ event: 'sovereign_restore.step', component, finished_at: new Date().toISOString() });
}

async function readWhole(source) {
  const held = [];
  for await (const piece of source) held.push(piece);
  return Buffer.concat(held);
}

/**
 * Writes objects back. A key `mayRestoreObject` refuses is counted and never written. A backup holding one
 * should not exist, since the schema and the backup script both refuse it, so that also fails the command in
 * the end, once everything else is back.
 */
async function restoreObjects(values, tools, manifest, key, store) {
  const text = await readWhole(
    tools.openComponent(values.backup, manifest, 'object_manifest', key),
  );
  const lines = tools.parseObjectManifest(text.toString('utf8'));
  const counts = { objects_written: 0, refused_by_key: 0, left_out_as_tombstoned: 0 };
  for await (const { line, body } of tools.objectsFromParts(
    lines,
    tools.openComponent(values.backup, manifest, 'objects', key),
  )) {
    if (!tools.mayRestoreObject(line.key)) {
      counts.refused_by_key += 1;
      continue;
    }
    const entry = tools.tombstoneEntryKeyForObject(line.key);
    if (entry && (await store.exists(entry))) {
      counts.left_out_as_tombstoned += 1;
      // The file's ID, and the key is IDs alone because tombstoneEntryKeyForObject accepted it.
      say({ event: 'sovereign_restore.left_out_as_tombstoned', object_key: line.key });
      continue;
    }
    await store.put(line.key, body, 'application/octet-stream');
    counts.objects_written += 1;
  }
  say({
    event: 'sovereign_restore.step',
    component: 'objects',
    objects_listed: lines.length,
    ...counts,
    object_manifest_sha256: createHash('sha256').update(text).digest('hex'),
    finished_at: new Date().toISOString(),
  });
  return counts;
}

async function main() {
  const { values } = parseArgs({ options: OPTIONS });
  for (const required of [
    'backup',
    'key',
    'replace-databases-of',
    'object-endpoint',
    'object-access-key-file',
    'object-secret-key-file',
  ]) {
    if (!values[required]) stop(`MISSING_${required}`);
  }
  if (values['replace-databases-of'] !== (values.project ?? 'compose')) {
    stop('REPLACE_DATABASES_OF_DOES_NOT_NAME_THE_PROJECT');
  }
  values.backup = resolve(values.backup);

  const tools = await loadTool('open-parts');
  const key = await tools.readPrivateKey(values.key);
  const store = await openStore(values);

  // All of it first. A damaged backup must cost nothing but the time this takes.
  const verified = await tools.verifyBackup(values.backup, key);
  say({ event: 'sovereign_restore.verified', ...verified });
  const manifest = await tools.readManifest(values.backup, key);

  stopEverything(values);
  refuseConnectedReaders(values);
  await restoreDump(values, tools, manifest, key, 'postgres_ensemus', 'ensemus');
  await restoreDump(values, tools, manifest, key, 'postgres_temporal', 'temporal');
  await restoreDump(
    values,
    tools,
    manifest,
    key,
    'postgres_temporal_visibility',
    'temporal_visibility',
  );
  const authGeneration = fenceRestoredAuthentication(values, manifest, verified);
  const counts = await restoreObjects(values, tools, manifest, key, store);

  say({
    event: 'sovereign_restore.finished',
    backup_id: manifest.backup_id,
    manifest_sealed_sha256: verified.manifest_sealed_sha256,
    auth_restore_generation: authGeneration,
    next: 'INSPECT_RECONCILE_REVIEW_ACKNOWLEDGE_AUTHORITY_THEN_RECONCILE_MATERIAL',
    readers_and_workers: 'STAY_STOPPED_NO_AUTOMATIC_RESUME',
    finished_at: new Date().toISOString(),
  });
  if (counts.refused_by_key > 0) stop('BACKUP_HELD_KEYS_NEVER_RESTORED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // The code and nothing else: an error here can quote a path, and a key must never be near one.
    stop(typeof error?.code === 'string' ? error.code : 'RESTORE_FAILED');
  });
}
