#!/usr/bin/env node
// Runs a restore from a clean instance and writes the evidence record (OPS-02, ADR-030 D11). The fields are
// described in docs/05-operations/sovereign/restore-drill-record.md. It wipes the compose project it is given,
// so that project's name has to say it is a drill, and has to be given twice.
//
//   node infrastructure/scripts/restore-drill.mjs --project <name with "drill" in it> --wipe-project <same name>
//     --backup <folder> --key <private key file> --record <new file>
//     --review-directory <empty private folder>
//     --object-endpoint <url> --object-access-key-file <file> --object-secret-key-file <file>
//     [--bucket ensemus] [--compose-file <file>]...
//
// It asks who ran it, on the terminal, and writes down what they say. There is no flag for that and no default:
// the plan's exit needs someone other than the owner to have done this, and code cannot supply that. With no
// answer the field stays empty, the record says so, and the command exits non-zero. It records what it saw and
// judges nothing, so it states no time to beat and no target.
//
// The restore leaves authentication fenced (0422), and the drill takes the operator's steps from
// backup-and-restore.md, in that order, before any reconcile: inspect the restored authority into the review
// folder, apply the revocations an independent review wrote there (if it found any) and inspect again, write the
// review declaration from what the person answers, wait out 0422's cooldown, and acknowledge through the
// migrator's own one-shot. The review folder is mounted at /review and holds every body; the command lines carry
// IDs and hashes only. A reconcile attempted before the acknowledgment is recorded, and must be refused.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  compose,
  composeArguments,
  composeFailureCode,
  repoRoot,
  say,
  stop,
} from './sovereign-backup.mjs';
import { authRestoreResult } from './sovereign-restore.mjs';

const OPTIONS = {
  project: { type: 'string' },
  'wipe-project': { type: 'string' },
  backup: { type: 'string' },
  key: { type: 'string' },
  record: { type: 'string' },
  'review-directory': { type: 'string' },
  'object-endpoint': { type: 'string' },
  'object-access-key-file': { type: 'string' },
  'object-secret-key-file': { type: 'string' },
  bucket: { type: 'string' },
  'compose-file': { type: 'string', multiple: true, default: [] },
};

/** The one-shot service that holds what the command needs. See the operator notes. */
const RECONCILE_SERVICE = 'restore-reconcile';

/**
 * The one-shot whose only database login is ensemus_migrator, the one login 0422 lets inspect, reconcile and
 * acknowledge a restore. Never an app, auth, agent, support, secrets or eraser login (backup-and-restore.md).
 */
export const AUTHORITY_SERVICE = 'migrate';

/** Where the private review folder is mounted in that one-shot. */
export const REVIEW_MOUNT = '/review';

/** The review declaration's fields, exactly, in 0422's order (parseAuthRestoreExternalReview). */
export const REVIEW_FIELDS = Object.freeze([
  'version',
  'generation',
  'backupId',
  'manifestSha256',
  'securitySha256',
  'reviewer',
  'reviewedAt',
  'authorityEvidence',
  'inFlightEffectsEvidence',
]);

/** A margin past 0422's notBefore, so a clock a little behind PostgreSQL's is not refused. */
export const COOLDOWN_MARGIN_MS = 5_000;

const refuse = (code) => Object.assign(new Error(code), { code });

/**
 * The review folder has to be private and empty: it will hold the restored authority snapshot and the review, and
 * an earlier review must never be reused or overwritten. On a system with no owner IDs only the emptiness is
 * checked.
 */
export function checkReviewDirectory(stat, entries, uid) {
  if (!stat.isDirectory()) throw refuse('REVIEW_DIRECTORY_NOT_A_DIRECTORY');
  if (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0)) {
    throw refuse('REVIEW_DIRECTORY_NOT_PRIVATE');
  }
  if (entries.length > 0) throw refuse('REVIEW_DIRECTORY_NOT_EMPTY');
}

/**
 * The one-shot runs as the operator's own user, so it can write into a folder only that user can open, and as
 * nothing else: the review folder is the only thing mounted, read-only except for inspect.
 */
export function operatorIdentity(proc = process) {
  return typeof proc.getuid === 'function' && typeof proc.getgid === 'function'
    ? `${proc.getuid()}:${proc.getgid()}`
    : null;
}

/** The docker arguments for one auth-restore step: IDs and hashes on the command line, every body in /review. */
export function authorityArguments(values, { reviewDirectory, writable, user }, ...args) {
  return [
    ...composeArguments(values),
    'run',
    '--rm',
    '--no-deps',
    ...(user ? ['--user', user] : []),
    '--volume',
    `${reviewDirectory}:${REVIEW_MOUNT}${writable ? '' : ':ro'}`,
    AUTHORITY_SERVICE,
    'node',
    'dist/auth-restore.js',
    ...args,
  ];
}

/**
 * The snapshot inspect wrote, checked against what it printed: the same bytes, generation and authority hash.
 * Anything else is not the snapshot that step produced, and the drill does not review it.
 */
export function readInspection(directory, name, printed) {
  const bytes = readFileSync(join(directory, name));
  const inspection = JSON.parse(bytes.toString('utf8'));
  if (
    createHash('sha256').update(bytes).digest('hex') !== printed.snapshot_sha256 ||
    inspection?.generation !== printed.generation ||
    inspection?.securitySha256 !== printed.security_sha256 ||
    inspection?.phase !== printed.phase ||
    typeof inspection?.backupId !== 'string' ||
    typeof inspection?.manifestSha256 !== 'string' ||
    !Number.isFinite(Date.parse(inspection?.notBefore))
  ) {
    throw refuse('AUTHORITY_SNAPSHOT_DOES_NOT_MATCH');
  }
  return inspection;
}

/**
 * The review declaration, from the snapshot it reviewed and what the person answered. Nothing is filled in for
 * them: a missing answer refuses before the database is asked.
 */
export function authorityReview(inspection, answers, reviewedAt = new Date()) {
  for (const field of ['reviewer', 'authorityEvidence', 'inFlightEffectsEvidence']) {
    if (typeof answers[field] !== 'string' || answers[field].trim() === '') {
      throw refuse('AUTHORITY_REVIEW_NOT_ANSWERED');
    }
  }
  const review = {
    version: 1,
    generation: inspection.generation,
    backupId: inspection.backupId,
    manifestSha256: inspection.manifestSha256,
    securitySha256: inspection.securitySha256,
    reviewer: answers.reviewer,
    reviewedAt: reviewedAt.toISOString(),
    authorityEvidence: answers.authorityEvidence,
    inFlightEffectsEvidence: answers.inFlightEffectsEvidence,
  };
  return Buffer.from(`${JSON.stringify(review, REVIEW_FIELDS)}\n`);
}

/** How long until 0422 admits an acknowledgment. The cooldown is 0422's, and nothing here shortens it. */
export function cooldownWait(notBefore, now = Date.now()) {
  const at = Date.parse(notBefore);
  if (!Number.isFinite(at)) throw refuse('AUTHORITY_COOLDOWN_UNKNOWN');
  return Math.max(0, at - now + COOLDOWN_MARGIN_MS);
}

/** A reconcile before the acknowledgment has to be refused by 0422's fence, and change nothing. */
export function refusedBeforeAcknowledgment(run) {
  return (
    run.exit_status === 1 &&
    run.failed?.errorCode === 'RESTORE_PENDING' &&
    run.ledger === null &&
    run.finished === null
  );
}

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
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, 'infrastructure', 'scripts', name), ...args],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 256 * 1024 * 1024,
    },
  );
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
    failed: of('restore_reconcile.failed')[0] ?? null,
    tenants: of('restore_reconcile.tenant'),
    findings: of('restore_reconcile.finding'),
  };
}

/** One auth-restore step through the migrator's one-shot. Any refusal stops the drill, naming its code. */
function authority(values, mount, event, ...args) {
  const result = spawnSync('docker', authorityArguments(values, mount, ...args), {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const code = composeFailureCode(result.stderr);
    stop(`AUTHORITY_${args[0]}_REFUSED${code ? `:${code}` : ''}`);
  }
  return authRestoreResult(result.stdout, event);
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

## Authority review and acknowledgment (0422)

- Generation: ${value(record.authority.generation)}
- Restored authority SHA-256, first inspection: ${value(record.authority.first_security_sha256)}
- Revocations applied: ${value(record.authority.revocations_changed)}
- Authority SHA-256 reviewed: ${value(record.authority.reviewed_security_sha256)}
- Reviewed by: ${value(record.authority.reviewer)}
- Review SHA-256: ${value(record.authority.review_sha256)}
- Cooldown not before: ${value(record.authority.not_before)}
- Acknowledged: ${value(record.authority.admitted_at)}

## Reconcile: attempted before the acknowledgment, and refused

- Exit status: ${value(record.reconcile_before_acknowledgment.exit_status)}
- Refused with: ${value(record.reconcile_before_acknowledgment.failed?.errorCode)}

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
    'review-directory',
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
  const reviewDirectory = resolve(values['review-directory']);
  checkReviewDirectory(
    statSync(reviewDirectory),
    readdirSync(reviewDirectory),
    typeof process.getuid === 'function' ? process.getuid() : undefined,
  );
  // The authority review is a person's, and the drill cannot acknowledge without one.
  if (!stdin.isTTY) stop('DRILL_NEEDS_A_PERSON_AT_A_TERMINAL');

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

  const restoreFinished = restored.find((line) => line.event === 'sovereign_restore.finished');
  if (!restoreFinished) stop('RESTORE_DID_NOT_FINISH');

  // Migrations newer than the backup, before the authority is inspected, so the snapshot is the one acknowledged.
  compose(base, 'run', '--rm', '--no-deps', 'migrate');

  // The authority the restore brought back, as backup-and-restore.md has an operator review it, in order.
  const generation = String(restoreFinished.auth_restore_generation);
  const user = operatorIdentity();
  const writable = { reviewDirectory, writable: true, user };
  const readOnly = { reviewDirectory, writable: false, user };
  const inspect = (name) => {
    const printed = authority(
      base,
      writable,
      'auth_restore.inspected',
      'inspect',
      '--generation',
      generation,
      '--out',
      `${REVIEW_MOUNT}/${name}`,
    );
    return readInspection(reviewDirectory, name, printed);
  };
  // 1. Inspect: a new file in the review folder, and hashes, phase and IDs on the terminal.
  const first = inspect('snapshot-1.json');
  if (
    first.backupId !== restoreFinished.backup_id ||
    first.manifestSha256 !== restoreFinished.manifest_sealed_sha256
  ) {
    stop('AUTHORITY_SNAPSHOT_IS_NOT_THIS_RESTORE');
  }
  say({
    event: 'restore_drill.authority_inspected',
    generation,
    snapshot: join(reviewDirectory, 'snapshot-1.json'),
    security_sha256: first.securitySha256,
    not_before: first.notBefore,
  });

  // 2. The external-authority review: what independent, current authority says the restored dump got wrong.
  const revocationsFile = join(reviewDirectory, 'revocations.json');
  const needsRevocation = await ask(
    `Compare ${join(reviewDirectory, 'snapshot-1.json')} with current independent identity, membership, team, provider and SCIM authority. If anything must be revoked, write it to ${revocationsFile} as a JSON array of exact IDs first. Does it need anything revoked? Write yes or no:`,
  );
  if (needsRevocation !== 'yes' && needsRevocation !== 'no') stop('AUTHORITY_REVIEW_NOT_ANSWERED');
  let reviewed = first;
  let revocationsChanged = 0;
  if (needsRevocation === 'yes') {
    if (!existsSync(revocationsFile) || !statSync(revocationsFile).isFile()) {
      stop('REVOCATIONS_FILE_MISSING');
    }
    const reconciled = authority(
      base,
      readOnly,
      'auth_restore.reconciled',
      'reconcile',
      '--generation',
      generation,
      '--snapshot',
      first.securitySha256,
      '--actions',
      `${REVIEW_MOUNT}/revocations.json`,
    );
    revocationsChanged = reconciled.changed;
    // Any change makes the earlier snapshot stale: the new fingerprint is the one reviewed and acknowledged.
    reviewed = inspect('snapshot-2.json');
    if (reviewed.securitySha256 !== reconciled.security_sha256)
      stop('AUTHORITY_CHANGED_AFTER_REVIEW');
  }

  // 3. The review declaration, from the snapshot reviewed and what the person says. Nothing is filled in.
  const answers = {
    reviewer: await ask('Who reviewed this authority? Write their name:'),
    authorityEvidence: await ask(
      'Which independent identity and provider reports did they compare it with? Name them:',
    ),
    inFlightEffectsEvidence: await ask(
      'What shows no send, charge or other effect was still in flight? Name the evidence:',
    ),
  };
  const review = authorityReview(reviewed, answers);
  writeFileSync(join(reviewDirectory, 'review.json'), review, { flag: 'wx', mode: 0o600 });

  // Before the acknowledgment the reconcile must be refused by 0422's fence. A report, so it changes nothing.
  const reconcileBeforeAcknowledgment = reconcile(values);
  if (!refusedBeforeAcknowledgment(reconcileBeforeAcknowledgment)) {
    stop('RECONCILE_NOT_REFUSED_BEFORE_ACKNOWLEDGMENT');
  }

  // 4. Acknowledge, through the migrator's one-shot, once 0422's cooldown has passed. Not before.
  const wait = cooldownWait(reviewed.notBefore);
  say({ event: 'restore_drill.waiting_for_cooldown', not_before: reviewed.notBefore });
  if (wait > 0) await new Promise((done) => setTimeout(done, wait));
  const admitted = authority(
    base,
    readOnly,
    'auth_restore.admitted',
    'acknowledge',
    '--generation',
    generation,
    '--manifest',
    reviewed.manifestSha256,
    '--snapshot',
    reviewed.securitySha256,
    '--review',
    `${REVIEW_MOUNT}/review.json`,
  );
  if (admitted.generation !== generation) stop('AUTH_RESTORE_GENERATION_CHANGED');
  const admittedAt = new Date().toISOString();

  // 5. Only then the reconcile. Temporal first, because the reconcile asks it about runs. Nothing else.
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
    authority: {
      generation,
      first_security_sha256: first.securitySha256,
      revocations_changed: revocationsChanged,
      reviewed_security_sha256: reviewed.securitySha256,
      reviewer: answers.reviewer,
      review_sha256: admitted.review_sha256,
      not_before: reviewed.notBefore,
      admitted_at: admittedAt,
    },
    reconcile_before_acknowledgment: reconcileBeforeAcknowledgment,
    reconcile_report: reconcileReport,
    reconcile_apply: reconcileApply,
    reconcile_second: reconcileSecond,
  };
  writeFileSync(recordPath, renderRecord(record), { flag: 'wx' });
  writeFileSync(`${recordPath}.json`, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(
    `${JSON.stringify({ event: 'restore_drill.recorded', complete: Boolean(ranBy && isOwner) })}\n`,
  );
  if (!ranBy || !isOwner) stop('NOBODY_SAID_WHO_RAN_THIS');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    stop(typeof error?.code === 'string' ? error.code : 'DRILL_FAILED');
  });
}
