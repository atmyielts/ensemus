#!/usr/bin/env node
// Runs a restore from a clean instance and writes the evidence record (OPS-02, ADR-030 D11). The fields are
// described in docs/05-operations/sovereign/restore-drill-record.md. It wipes the compose project it is given,
// so that project's name has to say it is a drill, and has to be given twice.
//
//   node infrastructure/scripts/restore-drill.mjs --project <name with "drill" in it> --wipe-project <same name>
//     --backup <folder> --key <private key file> --record <new file>
//     --object-endpoint <url> --object-access-key-file <file> --object-secret-key-file <file>
//     [--bucket ensemus] [--compose-file <file>]...
//
// It asks who ran it, on the terminal, and writes down what they say. There is no flag for that and no default:
// the plan's exit needs someone other than the owner to have done this, and code cannot supply that. With no
// answer the field stays empty, the record says so, and the command exits non-zero. It records what it saw and
// judges nothing, so it states no time to beat and no target.
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { compose, repoRoot, stop } from './sovereign-backup.mjs';

const OPTIONS = {
  project: { type: 'string' },
  'wipe-project': { type: 'string' },
  backup: { type: 'string' },
  key: { type: 'string' },
  record: { type: 'string' },
  'object-endpoint': { type: 'string' },
  'object-access-key-file': { type: 'string' },
  'object-secret-key-file': { type: 'string' },
  bucket: { type: 'string' },
  'compose-file': { type: 'string', multiple: true, default: [] },
};

/** The one-shot service that holds what the command needs. See the operator notes. */
const RECONCILE_SERVICE = 'restore-reconcile';

async function ask(question) {
  if (!stdin.isTTY) return null;
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await terminal.question(`${question} `)).trim();
    return answer === '' ? null : answer;
  } finally {
    terminal.close();
  }
}

/** Runs a script of ours, and hands back the JSON lines it printed. Any failure stops the drill. */
function runScript(name, args) {
  const result = spawnSync(process.execPath, [join(repoRoot, 'infrastructure', 'scripts', name), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) stop(`${name}_FAILED`);
  return jsonLines(result.stdout);
}

function jsonLines(text) {
  return text.split('\n').flatMap((line) => {
    if (!line.startsWith('{')) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** The command, with its lines. Status 1 means something needs a person, which is what a drill wants to see. */
function reconcile(values, ...args) {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-p',
      values.project,
      ...composeFiles(values).flatMap((file) => ['-f', file]),
      'run',
      '--rm',
      '--no-deps',
      RECONCILE_SERVICE,
      'node',
      'dist/restore-reconcile.js',
      ...args,
    ],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0 && result.status !== 1) stop('RECONCILE_REFUSED');
  const lines = jsonLines(result.stdout);
  const of = (event) => lines.filter((line) => line.event === event);
  return {
    exit_status: result.status,
    ledger: of('restore_reconcile.ledger')[0] ?? null,
    finished: of('restore_reconcile.finished')[0] ?? null,
    tenants: of('restore_reconcile.tenant'),
    findings: of('restore_reconcile.finding'),
  };
}

const composeFiles = (values) =>
  values['compose-file'].length > 0
    ? values['compose-file']
    : [join(repoRoot, 'infrastructure', 'compose', 'compose.yaml')];

const version = (command, ...args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

function renderRecord(record) {
  const value = (text) => (text === null || text === undefined ? 'NOT RECORDED' : String(text));
  const counts = (run) =>
    run
      ? [
          `- Exit status: ${value(run.exit_status)}`,
          `- Needs attention: ${value(run.finished?.needsAttention)}`,
          `- Ledger: ${JSON.stringify(run.ledger)}`,
          ...run.tenants.map((tenant) => `- Tenant: ${JSON.stringify(tenant)}`),
        ].join('\n')
      : '- Not run';
  return `# Restore drill record

What one run of \`restore-drill.mjs\` saw. It records and does not judge. Times are what happened on this run and are not a target for any other.

## Who ran it

- Ran by: ${value(record.ran_by)}
- Is this person the owner: ${value(record.ran_by_is_owner)}
- Complete: ${record.ran_by && record.ran_by_is_owner ? 'yes' : 'NO. Nobody answered, so this is not evidence of anything until someone does.'}

## The backup

- Backup ID: ${value(record.backup_id)}
- Release: ${value(record.release_version)}
- Database schema version: ${value(record.database_schema_version)}
- Sealed to key: ${value(record.recipient_key_id)}
- Manifest SHA-256 (sealed): ${value(record.backup_manifest_sealed_sha256)}
- Parts opened and checked: ${value(record.parts_checked)}

## The restore

- Started: ${value(record.started_at)}
- Finished: ${value(record.finished_at)}
- Object manifest SHA-256: ${value(record.object_manifest_sha256)}
- Objects listed: ${value(record.objects_listed)}
- Objects written: ${value(record.objects_written)}
- Refused by key: ${value(record.refused_by_key)}
- Left out as tombstoned: ${value(record.left_out_as_tombstoned)}

## Versions

- Node: ${value(record.versions.node)}
- Docker: ${value(record.versions.docker)}
- PostgreSQL: ${value(record.versions.postgres)}

## Tenants

${record.tenant_ids.length > 0 ? record.tenant_ids.map((id) => `- ${id}`).join('\n') : '- None found'}

## Reconcile: report, before anything changed

${counts(record.reconcile_report)}

## Reconcile: applied

${counts(record.reconcile_apply)}

## Reconcile: a second run, which should have changed nothing

${counts(record.reconcile_second)}

## What a person still has to do

- Connector worker started only after intents were reviewed, by: ${value(record.intents_reviewed_by)}
`;
}

async function main() {
  const { values } = parseArgs({ options: OPTIONS });
  for (const required of [
    'project',
    'wipe-project',
    'backup',
    'key',
    'record',
    'object-endpoint',
    'object-access-key-file',
    'object-secret-key-file',
  ]) {
    if (!values[required]) stop(`MISSING_${required}`);
  }
  if (!values.project.includes('drill')) stop('PROJECT_NAME_DOES_NOT_SAY_DRILL');
  if (values['wipe-project'] !== values.project) stop('WIPE_PROJECT_DOES_NOT_MATCH');
  const recordPath = resolve(values.record);
  if (existsSync(recordPath)) stop('RECORD_EXISTS');

  const ranBy = await ask('Who is running this drill? Write your own name:');
  const isOwner = await ask('Are you the owner of this product? Write yes or no:');
  const reviewer = await ask(
    'Who will review intents before the connector worker starts? Leave empty if not yet known:',
  );

  const startedAt = new Date().toISOString();
  const base = { ...values, 'compose-file': composeFiles(values) };

  // A clean instance: this project's containers and volumes, and nothing else.
  compose(base, 'down', '--volumes', '--remove-orphans');
  compose(base, 'up', '--detach', '--wait', 'postgres', 'objects');
  compose(base, 'run', '--rm', '--no-deps', 'temporal-schema');

  const restoreArgs = [
    '--backup',
    values.backup,
    '--key',
    values.key,
    '--project',
    values.project,
    '--replace-databases-of',
    values.project,
    '--object-endpoint',
    values['object-endpoint'],
    '--object-access-key-file',
    values['object-access-key-file'],
    '--object-secret-key-file',
    values['object-secret-key-file'],
    ...(values.bucket ? ['--bucket', values.bucket] : []),
    ...base['compose-file'].flatMap((file) => ['--compose-file', file]),
  ];
  const restored = runScript('sovereign-restore.mjs', restoreArgs);
  const verified = restored.find((line) => line.event === 'sovereign_restore.verified') ?? {};
  const objects =
    restored.find(
      (line) => line.event === 'sovereign_restore.step' && line.component === 'objects',
    ) ?? {};

  // Migrations newer than the backup, then Temporal, because the reconcile asks it about runs. Nothing else.
  compose(base, 'run', '--rm', '--no-deps', 'migrate');
  compose(base, 'up', '--detach', '--wait', '--no-deps', 'temporal');

  const reconcileReport = reconcile(values);
  const reconcileApply = reconcile(values, '--apply');
  const reconcileSecond = reconcile(values, '--apply');

  const record = {
    ran_by: ranBy,
    ran_by_is_owner: isOwner,
    intents_reviewed_by: reviewer,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    backup_id: verified.backup_id ?? null,
    release_version: verified.release_version ?? null,
    database_schema_version: verified.database_schema_version ?? null,
    recipient_key_id: verified.recipient_key_id ?? null,
    backup_manifest_sealed_sha256: verified.manifest_sealed_sha256 ?? null,
    parts_checked: verified.parts ?? null,
    object_manifest_sha256: objects.object_manifest_sha256 ?? null,
    objects_listed: objects.objects_listed ?? null,
    objects_written: objects.objects_written ?? null,
    refused_by_key: objects.refused_by_key ?? null,
    left_out_as_tombstoned: objects.left_out_as_tombstoned ?? null,
    tenant_ids: reconcileApply.tenants.map((tenant) => tenant.organizationId),
    versions: {
      node: process.version,
      docker: version('docker', '--version'),
      postgres: compose(
        base,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'postgres',
        '-tAc',
        'show server_version',
      ).trim(),
    },
    reconcile_report: reconcileReport,
    reconcile_apply: reconcileApply,
    reconcile_second: reconcileSecond,
  };
  writeFileSync(recordPath, renderRecord(record), { flag: 'wx' });
  writeFileSync(`${recordPath}.json`, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ event: 'restore_drill.recorded', complete: Boolean(ranBy && isOwner) })}\n`);
  if (!ranBy || !isOwner) stop('NOBODY_SAID_WHO_RAN_THIS');
}

main().catch((error) => {
  stop(typeof error?.code === 'string' ? error.code : 'DRILL_FAILED');
});
