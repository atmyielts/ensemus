// One-shot offline recovery command. Only invalidate needs the native crypto key/auth login.
// Begin/inspect/reconcile/acknowledge need only the actual migrator login. No command starts readers.
import { createHash } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSecret } from '@ensemus/config';
import { invalidateAuthenticationAfterRestore } from '@ensemus/auth/restore';
import { runMigrations } from '@ensemus/database/migrate';
import {
  acknowledgeAuthenticationRestore,
  AUTH_RESTORE_REVIEW_MAX_BYTES,
  beginAuthenticationRestore,
  inspectAuthenticationRestore,
  reconcileAuthenticationRestore,
} from '@ensemus/database/auth-restore-operator';
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const reasons = new Set([
  'AUTH_RESTORE_ARGUMENT_REQUIRED',
  'AUTH_RESTORE_FILE_REFUSED',
  'AUTH_RESTORE_COMMAND_REFUSED',
  'AUTH_RESTORE_OPERATOR_REQUIRED',
  'AUTH_RESTORE_GENERATION_CHANGED',
  'AUTH_RESTORE_REVIEW_CHANGED',
  'AUTH_RESTORE_REVIEW_REQUIRED',
  'AUTH_RESTORE_COOLDOWN_REQUIRED',
  'AUTH_RESTORE_OWNER_REPAIR_REQUIRED',
  'AUTH_RESTORE_READERS_STILL_CONNECTED',
  'AUTH_RESTORE_REVIEW_TOO_LARGE',
  'AUTH_RESTORE_TARGET_MISSING',
  'AUTH_RESTORE_RECONCILE_REFUSED',
  'AUTH_RESTORE_PROOF_NOT_CURRENT',
  'AUTH_RESTORE_KEY_REFUSED',
]);
export function restoreCommandReason(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    if ('message' in current && typeof current.message === 'string' && reasons.has(current.message))
      return current.message;
    if ('code' in current) {
      if (current.code === '55P03') return 'AUTH_RESTORE_BUSY';
      if (current.code === '42883') return 'AUTH_RESTORE_SCHEMA_UNAVAILABLE';
      // A database guard's own refusal is a fixed code (RAISE EXCEPTION 'CODE'), never a value, so an
      // operator can see which guard stopped the step. Any other database message is not repeated.
      if (
        typeof current.code === 'string' &&
        /^[0-9A-Z]{5}$/.test(current.code) &&
        'message' in current &&
        typeof current.message === 'string' &&
        /^[A-Z][A-Z0-9_]{2,79}$/.test(current.message)
      )
        return current.message;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return 'AUTH_RESTORE_COMMAND_REFUSED';
}
export async function readBoundedRestoreFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes)
      throw new Error('AUTH_RESTORE_FILE_REFUSED');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length < 1 || length > maxBytes) throw new Error('AUTH_RESTORE_FILE_REFUSED');
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
function required(value: string | undefined): string {
  if (!value) throw new Error('AUTH_RESTORE_ARGUMENT_REQUIRED');
  return value;
}
const safe = (event: string, fields: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
export async function authenticationRestoreCommand(args: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      generation: { type: 'string' },
      backup: { type: 'string' },
      manifest: { type: 'string' },
      snapshot: { type: 'string' },
      actions: { type: 'string' },
      review: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (positionals.length !== 1) throw new Error('AUTH_RESTORE_ARGUMENT_REQUIRED');
  const command = positionals[0];
  const allowed: Record<string, readonly string[]> = {
    migrate: [],
    begin: ['backup', 'manifest'],
    invalidate: ['generation'],
    inspect: ['generation', 'out'],
    reconcile: ['generation', 'snapshot', 'actions'],
    acknowledge: ['generation', 'manifest', 'snapshot', 'review'],
  };
  const fields = command ? allowed[command] : undefined;
  if (!fields || Object.keys(values).some((key) => !fields.includes(key)))
    throw new Error('AUTH_RESTORE_ARGUMENT_REQUIRED');
  if (command === 'invalidate') {
    const result = await invalidateAuthenticationAfterRestore({
      databaseUrl: readSecret('DATABASE_URL_AUTH'),
      secret: readSecret('AUTH_SECRET'),
      generation: required(values.generation),
    });
    safe('auth_restore.invalidated', {
      generation: result.generation,
      already_invalidated: result.alreadyInvalidated,
      ...result.proof,
    });
    return;
  }
  const url = readSecret('DATABASE_URL_MIGRATOR');
  if (command === 'migrate') {
    await runMigrations(url, resolve(dirname(fileURLToPath(import.meta.url)), '../migrations'));
    safe('auth_restore.schema_ready', {});
    return;
  }
  if (command === 'begin') {
    const generation = await beginAuthenticationRestore(url, {
      backupId: required(values.backup),
      manifestSha256: required(values.manifest),
    });
    safe('auth_restore.pending', { generation });
    return;
  }
  if (command === 'inspect') {
    const inspection = await inspectAuthenticationRestore(url, required(values.generation));
    const body = Buffer.from(JSON.stringify(inspection, null, 2) + '\n');
    // Never overwrite a prior review. Snapshot contains only bounded explicit metadata/hashes and
    // stays in a caller-selected private file; stdout holds no emails/config/cookie/assertion/body.
    await writeFile(required(values.out), body, { flag: 'wx', mode: 0o600 });
    safe('auth_restore.inspected', {
      generation: inspection.generation,
      phase: inspection.phase,
      security_sha256: inspection.securitySha256,
      snapshot_sha256: hash(body),
    });
    return;
  }
  if (command === 'reconcile') {
    const actions = await readBoundedRestoreFile(required(values.actions), 131072);
    let parsed: unknown;
    try {
      parsed = JSON.parse(actions.toString('utf8'));
    } catch {
      throw new Error('AUTH_RESTORE_FILE_REFUSED');
    }
    const result = await reconcileAuthenticationRestore(url, {
      generation: required(values.generation),
      securitySha256: required(values.snapshot),
      actions: parsed,
    });
    safe('auth_restore.reconciled', {
      generation: result.generation,
      changed: result.changed,
      security_sha256: result.securitySha256,
    });
    return;
  }
  if (command === 'acknowledge') {
    const review = await readBoundedRestoreFile(
      required(values.review),
      AUTH_RESTORE_REVIEW_MAX_BYTES,
    );
    const generation = await acknowledgeAuthenticationRestore(url, {
      generation: required(values.generation),
      manifestSha256: required(values.manifest),
      securitySha256: required(values.snapshot),
      review,
    });
    safe('auth_restore.admitted', {
      generation,
      review_sha256: hash(review),
      review_bytes: review.byteLength,
    });
    return;
  }
  throw new Error('AUTH_RESTORE_COMMAND_REFUSED');
}
// This entry is not imported by ordinary workers. The exact direct-entry check also lets bounded
// file/parser tests import it without running a privileged command or reading environment secrets.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  authenticationRestoreCommand(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(restoreCommandReason(error) + '\n');
    process.exitCode = 1;
  });
}
