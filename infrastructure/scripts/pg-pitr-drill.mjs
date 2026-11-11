#!/usr/bin/env node
// The point-in-time recovery drill for compose.backup.yaml (OPS-02). It restores one base backup into a scratch
// server beside the running stack, replays archived WAL to the end of the archive or to --target-time, runs the
// scratch server's read-only checks, and then restore-reconcile's report against it. It writes what it saw to a
// new record file and removes the scratch server and its data. The live server, its volume and its archive are
// only ever read.
//
//   node infrastructure/scripts/pg-pitr-drill.mjs --record <new file>
//     [--backup-id <id>|latest] [--target-time <YYYY-MM-DDTHH:MM:SSZ>] [--source local|offsite]
//     [--skip-reconcile] [--compose-file <file>]... [--project <name>]
//
// --source offsite first copies the backup and the archived WAL back from the backup bucket, so the drill proves
// the offsite copy and not only the local one. The record says how long each step took, and judges nothing
// against a time: recovery-time and recovery-point objectives are the owner's to set
// (11-postgres-backup-and-pitr.md), and this is evidence for that decision, not a pass against one.
//
// Exit 0: recovered, every check passed and the reconcile report needed nobody. 1: anything else, with the record
// saying what. 2: refused before anything ran. The record holds counts, codes, IDs and times, never a row.
import { spawnSync } from 'node:child_process';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { composeArguments, repoRoot } from './sovereign-backup.mjs';
import { drillEventsFrom, drillOutcome, parseDrillOptions } from './pg-backup-rules.mjs';

const OPTIONS = {
  record: { type: 'string' },
  'backup-id': { type: 'string' },
  'target-time': { type: 'string' },
  source: { type: 'string' },
  'skip-reconcile': { type: 'boolean' },
  'compose-file': { type: 'string', multiple: true, default: [] },
  project: { type: 'string' },
};

export const DEFAULT_COMPOSE_FILES = Object.freeze([
  join(repoRoot, 'infrastructure', 'compose', 'compose.yaml'),
  join(repoRoot, 'infrastructure', 'compose', 'compose.backup.yaml'),
]);

/** How long compose waits for the scratch server's replay. The scratch side has its own limit as well. */
const WAIT_SECONDS = 3900;

export function parseDrillCommand(args, now = new Date()) {
  const { values } = parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: false });
  const options = parseDrillOptions(values, now);
  const files = values['compose-file'].length ? values['compose-file'] : [...DEFAULT_COMPOSE_FILES];
  if (values.project !== undefined && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(values.project))
    throw new Error('DRILL_PROJECT_INVALID');
  return { ...options, compose: { 'compose-file': files, project: values.project } };
}

function docker(command, ...args) {
  return spawnSync(
    'docker',
    [...composeArguments(command.compose), '--profile', 'drill', ...args],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        ENSEMUS_DRILL_BACKUP_ID: command.backupId,
        ENSEMUS_DRILL_SOURCE: command.source,
        ENSEMUS_DRILL_TARGET_TIME: command.targetTime ?? '',
      },
    },
  );
}

const seconds = (from, to) => Math.round((to - from) / 1000);

export async function main(args) {
  let command;
  try {
    command = parseDrillCommand(args);
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'ARGUMENT_INVALID';
    process.stderr.write(`Refused: ${code}\n`);
    return 2;
  }
  // Reserved before anything runs, and never overwritten: evidence is kept, not replaced.
  const descriptor = openSync(command.record, 'wx', 0o600);
  const record = {
    kind: 'ensemus-pg-pitr-drill-record-v1',
    startedAt: new Date().toISOString(),
    source: command.source,
    requestedBackup: command.backupId,
    targetTime: command.targetTime,
    steps: {},
    events: [],
    droppedFields: 0,
    outcome: null,
    reconcile: { ran: false, exitCode: null },
    // Who ran it, and that it was someone other than the author, is for the person to add. Code cannot.
    operator: null,
  };
  let exitCode = 1;
  try {
    // A scratch server left by an earlier, interrupted drill goes first, with its data.
    docker(command, 'rm', '-sfv', 'pg-drill');
    if (command.source === 'offsite') {
      const started = Date.now();
      const fetched = docker(
        command,
        'run',
        '--rm',
        '--no-deps',
        'pg-backup-offsite',
        'fetch',
        command.backupId,
      );
      record.steps.fetch = { ok: fetched.status === 0, seconds: seconds(started, Date.now()) };
      if (fetched.status !== 0) return 1;
    }
    const started = Date.now();
    const up = docker(
      command,
      'up',
      '-d',
      '--no-deps',
      '--wait',
      '--wait-timeout',
      String(WAIT_SECONDS),
      'pg-drill',
    );
    record.steps.restoreAndReplay = { ok: up.status === 0, seconds: seconds(started, Date.now()) };
    const logs = docker(command, 'logs', '--no-color', '--no-log-prefix', 'pg-drill');
    const { events, dropped } = drillEventsFrom(logs.stdout ?? '');
    record.events = events;
    record.droppedFields = dropped;
    record.outcome = drillOutcome(events, command.targetTime);
    if (up.status !== 0 || !record.outcome.ok) return 1;
    if (command.reconcile) {
      const reconcileStarted = Date.now();
      // Report mode only: no argument is ever passed, so --apply cannot reach it from here.
      const reconcile = docker(command, 'run', '--rm', '--no-deps', 'restore-reconcile-drill');
      record.reconcile = {
        ran: true,
        exitCode: reconcile.status,
        seconds: seconds(reconcileStarted, Date.now()),
        // Its report names IDs and keys, so only its size is kept here. Run it by hand to read it.
        reportLines: String(reconcile.stdout ?? '')
          .split('\n')
          .filter(Boolean).length,
      };
      exitCode = reconcile.status === 0 ? 0 : 1;
    } else exitCode = 0;
    return exitCode;
  } finally {
    const removed = docker(command, 'rm', '-sfv', 'pg-drill');
    record.steps.cleanup = { ok: removed.status === 0 };
    record.finishedAt = new Date().toISOString();
    record.exitCode = exitCode;
    const text = `${JSON.stringify(record, null, 2)}\n`;
    writeSync(descriptor, text, 0, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('Refused: DRILL_FAILED\n');
      process.exitCode = 1;
    },
  );
}
