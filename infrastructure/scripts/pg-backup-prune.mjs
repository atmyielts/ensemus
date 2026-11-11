#!/usr/bin/env node
// Applies the operator's retention to the offsite PostgreSQL backups (LIFE-02, compose.backup.yaml). The
// sidecar that copies backups never deletes, so this is the only thing that removes one, and it does so only
// with numbers it is given and only with --apply. Without --apply it prints the plan and changes nothing.
//
//   node infrastructure/scripts/pg-backup-prune.mjs --keep-count <n> --keep-days <n>
//     --object-endpoint <url> --object-access-key-file <file> --object-secret-key-file <file>
//     [--bucket ensemus-backups] [--apply]
//
// The rules are in pg-backup-rules.mjs: the newest backup is always kept, a backup is kept when it is one of the
// newest --keep-count or finished within --keep-days, and WAL goes only when it orders before the oldest kept
// backup's start. One unreadable metadata file stops the whole run before anything is deleted. A backup goes
// metadata first, so a half-removed backup is never taken for a whole one.
//
// The credential given here is an operator's, and needs delete on the backup bucket; the sidecar's does not.
// Deletion uses the storage adapter's own checked delete, which refuses a versioned bucket: where versioning or
// object lock protects the bucket, its lifecycle rules do this job instead (11-postgres-backup-and-pitr.md).
//
// Prints one JSON line per step: IDs, counts and codes.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openStore, say, stop } from './sovereign-backup.mjs';
import {
  OFFSITE_BASE_PREFIX,
  OFFSITE_WAL_PREFIX,
  isBackupId,
  parseBackupMetadata,
  parseRetentionPolicy,
  planPrune,
} from './pg-backup-rules.mjs';

const OPTIONS = {
  'keep-count': { type: 'string' },
  'keep-days': { type: 'string' },
  'object-endpoint': { type: 'string' },
  'object-access-key-file': { type: 'string' },
  'object-secret-key-file': { type: 'string' },
  bucket: { type: 'string' },
  apply: { type: 'boolean' },
};

export function parsePruneCommand(args) {
  const { values } = parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: false });
  const policy = parseRetentionPolicy({
    keepCount: values['keep-count'],
    keepDays: values['keep-days'],
  });
  for (const name of ['object-endpoint', 'object-access-key-file', 'object-secret-key-file'])
    if (!values[name]) throw new Error('STORE_OPTIONS_REQUIRED');
  const bucket = values.bucket ?? 'ensemus-backups';
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('BUCKET_INVALID');
  return { policy, bucket, apply: values.apply === true, values: { ...values, bucket } };
}

async function keysUnder(store, prefix) {
  const keys = [];
  for await (const page of store.listPages(prefix)) keys.push(...page);
  return keys;
}

async function main(args) {
  let command;
  try {
    command = parsePruneCommand(args);
  } catch (error) {
    stop(
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'ARGUMENT_INVALID',
    );
  }
  const store = await openStore(command.values);
  try {
    const baseKeys = await keysUnder(store, OFFSITE_BASE_PREFIX);
    const backups = [];
    for (const key of baseKeys) {
      const name = key.slice(OFFSITE_BASE_PREFIX.length);
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!isBackupId(id)) stop('BACKUP_NAME_UNEXPECTED');
      const metadata = parseBackupMetadata((await store.get(key, 4096)).toString('utf8'));
      if (metadata.id !== id) stop('BACKUP_METADATA_MISMATCH');
      backups.push(metadata);
    }
    const walNames = (await keysUnder(store, OFFSITE_WAL_PREFIX)).map((key) =>
      key.slice(OFFSITE_WAL_PREFIX.length),
    );
    const plan = planPrune(backups, walNames, command.policy, new Date());
    say({
      event: 'pg_backup_prune.plan',
      apply: command.apply,
      keep: plan.keep.length,
      drop: plan.drop.length,
      dropWal: plan.dropWal.length,
      keptWal: plan.keptWal,
      unknown: plan.unknown,
    });
    if (!command.apply) return 0;
    for (const id of plan.drop) {
      await store.delete(`${OFFSITE_BASE_PREFIX}${id}.json`);
      await store.delete(`${OFFSITE_BASE_PREFIX}${id}.tar.gz`);
      say({ event: 'pg_backup_prune.backup_removed', id });
    }
    let removed = 0;
    for (const name of plan.dropWal) {
      await store.delete(`${OFFSITE_WAL_PREFIX}${name}`);
      removed += 1;
    }
    say({ event: 'pg_backup_prune.wal_removed', count: removed });
    return 0;
  } finally {
    store.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const code =
        error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'FAILED';
      process.stderr.write(`Refused: ${code}\n`);
      process.exitCode = 1;
    },
  );
}
