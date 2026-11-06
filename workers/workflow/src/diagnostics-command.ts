// What `node dist/diagnostics-export.js` does (SOV-06, ADR-030 D12). `collect` writes a report and its review
// text on this machine, for a person to read. `seal` makes a transfer file for one recipient, once a person
// has put their name to those exact bytes. There is no third step: nothing here sends anything, and moving
// that file is the customer's own act.
//   node dist/diagnostics-export.js collect --out <new folder>
//   node dist/diagnostics-export.js seal --report <file> --recipient <public key> --approved-by <name>
// Exit status: 0 when done, 1 when a value or a report was refused, 2 when it refused to start.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  eventBacklog,
  listOrganizationIds,
  outboxBacklog,
  type openDispatcherDatabase,
} from '@ensemus/database/dispatcher';
import { TOMBSTONE_RECORDED } from '@ensemus/domain/tombstone-ledger';
import {
  diagnosticReportSchema,
  renderReviewText,
  reportSha256,
  sealForTransfer,
  serializeReport,
  type DiagnosticReport,
  type TransferApproval,
} from '@ensemus/sovereign/diagnostics';
import { parseRecipientPublicKey, recipientKeyId } from '@ensemus/sovereign/sealed';
import { loadTrustRootFile } from '@ensemus/sovereign/trust-root';
import { verifyDocument } from '@ensemus/sovereign/verify';
import { errorCode, type Logger } from '@ensemus/telemetry';

type DispatcherDatabase = ReturnType<typeof openDispatcherDatabase>['db'];

const REFUSED = 1;
const BAD_INPUT = 2;
const OWNER_ONLY = 0o600;

/**
 * The settings a report may name, and the only ones it looks at. Each is shown by name and with a hash, so
 * support can ask "is this the same as last time" without seeing a value. A hash can still confirm a guess,
 * so nothing on this list identifies a customer: their public address is left off for that reason. No secret
 * is on it, and no `_FILE` setting either. A path says little and a secret file says too much, so neither is
 * looked at, and a test holds this list to that.
 */
export const DIAGNOSTIC_CONFIGURATION_NAMES = [
  'NODE_ENV',
  'ENSEMUS_MODE',
  'ENSEMUS_ALLOW_SIGNUP',
  'ENSEMUS_CONNECTORS_ENABLED',
  'ENSEMUS_RELEASE',
  'ENSEMUS_EXPORT_RETENTION_HOURS',
  'TEMPORAL_ADDRESS',
  'TEMPORAL_NAMESPACE',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_BUCKET',
] as const;

export type DatabaseFacts = {
  tenants: number;
  outbox: { queued: number; dead: number; oldestSeconds: number };
  ledger: { queued: number; dead: number };
  /** The time drizzle stamped on the last migration it ran, or null if this role may not read that. */
  lastMigrationAt: number | null;
  /** Dead events by type. A type is a name from our code, with nothing from a tenant in it. */
  deadEvents: readonly { eventType: string; count: number }[];
};

/** A migration this image ships, from its journal, which also holds the stamp drizzle records. */
export type ShippedMigration = { tag: string; when: number };

/** What a report is built from. Each is narrow, and any of them failing is an answer rather than a crash. */
export type DiagnosticSources = {
  database(): Promise<DatabaseFacts>;
  temporalReachable(): Promise<boolean>;
  objectStoreReachable(): Promise<boolean>;
  release(): Promise<{
    version: string;
    images: readonly { name: string; digest: string }[];
  }>;
  /** Oldest first. Empty if the image has no journal to read. */
  shippedMigrations(): Promise<readonly ShippedMigration[]>;
};

/**
 * Counts, and nothing that could hold content: the dispatcher's role sees event metadata and no tenant data,
 * and these queries ask for less than it may see. `execute` is given fixed SQL, with no value from anywhere.
 */
export async function readDatabaseFacts(db: DispatcherDatabase): Promise<DatabaseFacts> {
  const [organizations, outbox, ledger, oldest, dead, lastMigrationAt] = await Promise.all([
    listOrganizationIds(db),
    outboxBacklog(db),
    eventBacklog(db, TOMBSTONE_RECORDED),
    db.execute<{ oldest_seconds: number }>(
      `SELECT coalesce(extract(epoch FROM now() - min(d.occurred_at)), 0)::int AS oldest_seconds
         FROM platform.outbox_events o
         JOIN platform.domain_events d
           ON d.organization_id = o.organization_id AND d.id = o.event_id
        WHERE o.state IN ('queued', 'dead')`,
    ),
    db.execute<{ event_type: string; count: number }>(
      `SELECT d.event_type, count(*)::int AS count
         FROM platform.outbox_events o
         JOIN platform.domain_events d
           ON d.organization_id = o.organization_id AND d.id = o.event_id
        WHERE o.state = 'dead'
        GROUP BY d.event_type
        ORDER BY d.event_type
        LIMIT 256`,
    ),
    readLastMigrationAt(db),
  ]);
  return {
    tenants: organizations.length,
    outbox: {
      queued: outbox.queued,
      dead: outbox.dead,
      oldestSeconds: oldest.rows[0]?.oldest_seconds ?? 0,
    },
    ledger: { queued: ledger.queued, dead: ledger.dead },
    lastMigrationAt,
    deadEvents: dead.rows.map(({ event_type, count }) => ({ eventType: event_type, count })),
  };
}

const INSUFFICIENT_PRIVILEGE = '42501';

/** Needs a grant the dispatcher's role does not hold today, so it answers null until one is added. */
async function readLastMigrationAt(db: DispatcherDatabase): Promise<number | null> {
  try {
    const { rows } = await db.execute<{ created_at: string | number }>(
      'SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1',
    );
    return rows[0] ? Number(rows[0].created_at) : null;
  } catch (error) {
    if (errorCode(error) === INSUFFICIENT_PRIVILEGE) return null;
    throw error;
  }
}

/**
 * Which migration to name. What the database ran, where this role may read that and the image knows the
 * stamp. Otherwise the last this image ships, marked as such, because the two are not the same claim.
 */
export function schemaVersionFor(
  lastMigrationAt: number | null,
  shipped: readonly ShippedMigration[],
): string {
  const applied = shipped.find(({ when }) => when === lastMigrationAt);
  if (applied) return applied.tag;
  const last = shipped.at(-1);
  return last ? `image:${last.tag}` : 'unknown';
}

/**
 * The release from the installed bundle manifest, once verified against the trust root this deployment
 * holds, or the setting if there is none to check. Both of those files are public documents, not secrets. A
 * manifest that fails to verify says nothing about what runs here, so it is reported and not believed.
 */
export async function readReleaseFacts(input: {
  release: string;
  bundleManifestFile: string | null;
  trustRootFile: string | null;
  log: Logger;
}) {
  if (input.bundleManifestFile && input.trustRootFile) {
    const verdict = verifyDocument(
      'bundle',
      await readFile(input.bundleManifestFile, 'utf8'),
      loadTrustRootFile(input.trustRootFile),
    );
    if (verdict.ok) {
      return {
        version: verdict.document.release.version,
        images: verdict.document.images.map(({ name, digest }) => ({ name, digest })),
      };
    }
    input.log.warn('diagnostics.manifest_not_verified', { reasonCode: verdict.code });
  }
  return { version: input.release, images: [] };
}

async function attempt<T>(log: Logger, source: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    // An error's message can quote SQL and parameters, so only its code gets as far as a log.
    log.warn('diagnostics.source_failed', { step: source, errorCode: errorCode(error) });
    return null;
  }
}

const hashOf = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Asks every source, and returns the report unchecked. `collect` checks it before writing anything. */
async function gatherReport(
  sources: DiagnosticSources,
  env: NodeJS.ProcessEnv,
  now: Date,
  log: Logger,
): Promise<unknown> {
  const [database, temporal, objectStore, release, shipped] = await Promise.all([
    attempt(log, 'database', () => sources.database()),
    attempt(log, 'temporal', () => sources.temporalReachable()),
    attempt(log, 'object_store', () => sources.objectStoreReachable()),
    attempt(log, 'release', () => sources.release()),
    attempt(log, 'migrations', () => sources.shippedMigrations()),
  ]);
  return {
    format: 'ensemus.diagnostics',
    format_version: 1,
    generated_at: now.toISOString(),
    release_version: release?.version ?? 'unknown',
    images: (release?.images ?? []).map(({ name, digest }) => ({ name, digest })),
    database: {
      schema_version: schemaVersionFor(database?.lastMigrationAt ?? null, shipped ?? []),
      reachable: database !== null,
      tenants: database?.tenants ?? 0,
    },
    temporal: { reachable: temporal === true },
    object_store: { reachable: objectStore === true },
    outbox: {
      queued: database?.outbox.queued ?? 0,
      dead: database?.outbox.dead ?? 0,
      oldest_seconds: database?.outbox.oldestSeconds ?? 0,
    },
    ledger: { queued: database?.ledger.queued ?? 0, dead: database?.ledger.dead ?? 0 },
    configuration: DIAGNOSTIC_CONFIGURATION_NAMES.map((name) => {
      const value = env[name];
      return { name, sha256: value === undefined ? null : hashOf(value) };
    }),
    error_codes: (database?.deadEvents ?? []).map(({ eventType, count }) => ({
      code: `outbox.dead:${eventType}`,
      count,
    })),
  };
}

export type DiagnosticsDependencies = {
  /** Called for `collect` only, so `seal` opens no connection and reads no secret. */
  sources: () => Promise<DiagnosticSources>;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  log: Logger;
  say: (line: string) => void;
};

async function collectCommand(out: string | undefined, deps: DiagnosticsDependencies) {
  const { log, say } = deps;
  if (!out) {
    log.error('diagnostics.refused', { reasonCode: 'OUT_REQUIRED' });
    return BAD_INPUT;
  }
  const gathered = await gatherReport(await deps.sources(), deps.env, deps.now(), log);
  // A value that does not fit stops the report, and is never trimmed to fit: something unexpected in a
  // field is the very thing that must not go out, and a person cannot catch what was cut off quietly.
  const checked = diagnosticReportSchema.safeParse(gathered);
  if (!checked.success) {
    log.error('diagnostics.report_refused', {
      reasonCode: 'VALUE_REFUSED',
      // Field names and positions from our own schema. The value is never in here.
      step: checked.error.issues[0]?.path.join('.') ?? 'report',
      count: checked.error.issues.length,
    });
    return REFUSED;
  }
  const report: DiagnosticReport = checked.data;
  const reviewText = renderReviewText(report);
  try {
    await mkdir(out, { recursive: true });
    // Never replaced, so what someone read is still what is there when they come to approve it.
    const once = { flag: 'wx', mode: OWNER_ONLY };
    await writeFile(join(out, 'report.json'), serializeReport(report), once);
    await writeFile(join(out, 'review.txt'), reviewText, once);
  } catch (error) {
    const exists = (error as NodeJS.ErrnoException).code === 'EEXIST';
    log.error('diagnostics.refused', { reasonCode: exists ? 'OUT_EXISTS' : 'OUT_NOT_WRITTEN' });
    return exists ? BAD_INPUT : REFUSED;
  }
  log.info('diagnostics.collected', { count: report.configuration.length });
  say('Wrote report.json and review.txt. Read review.txt. Nothing has left this machine.');
  return 0;
}

type SealValues = {
  report: string | undefined;
  recipient: string | undefined;
  approver: string | undefined;
  out: string | undefined;
};

async function sealCommand(values: SealValues, deps: DiagnosticsDependencies) {
  const { log, say } = deps;
  const refuse = (reasonCode: string, status = BAD_INPUT) => {
    log.error('diagnostics.refused', { reasonCode });
    return status;
  };
  if (!values.report) return refuse('REPORT_REQUIRED');
  if (!values.recipient) return refuse('RECIPIENT_REQUIRED');
  // Nobody's approval, nothing sealed. There is no other way past this.
  if (!values.approver?.trim()) return refuse('APPROVAL_MISSING');

  let recipientId: string;
  try {
    recipientId = recipientKeyId(parseRecipientPublicKey(values.recipient));
  } catch {
    return refuse('RECIPIENT_REFUSED');
  }
  let reportText: string;
  try {
    reportText = await readFile(values.report, 'utf8');
  } catch {
    return refuse('REPORT_UNREADABLE');
  }
  const approval: TransferApproval = {
    approved_by: values.approver,
    approved_at: deps.now().toISOString(),
    report_sha256: reportSha256(reportText),
    recipient_key_id: recipientId,
  };
  const result = sealForTransfer({
    reportText,
    approval,
    recipientPublicKey: values.recipient,
  });
  if (!result.ok) return refuse(result.code, REFUSED);

  const out = values.out ?? `${values.report}.sealed`;
  try {
    await writeFile(out, result.sealed, { flag: 'wx', mode: OWNER_ONLY });
  } catch (error) {
    const exists = (error as NodeJS.ErrnoException).code === 'EEXIST';
    return exists ? refuse('OUT_EXISTS') : refuse('OUT_NOT_WRITTEN', REFUSED);
  }
  log.info('diagnostics.sealed', { count: 1 });
  say(`Wrote ${out}, for recipient key ${recipientId}, over report ${approval.report_sha256}.`);
  say('Nothing has been sent, and nothing here sends it. Moving that file is up to you.');
  return 0;
}

export async function diagnosticsCommand(
  args: readonly string[],
  deps: DiagnosticsDependencies,
): Promise<number> {
  const [command, ...rest] = args;
  let values;
  try {
    values = parseArgs({
      args: rest,
      options: {
        out: { type: 'string' },
        report: { type: 'string' },
        recipient: { type: 'string' },
        'approved-by': { type: 'string' },
      },
    }).values;
  } catch {
    deps.log.error('diagnostics.refused', { reasonCode: 'NOT_AN_OPTION' });
    return BAD_INPUT;
  }
  if (command === 'collect') return collectCommand(values.out, deps);
  if (command === 'seal') {
    return sealCommand(
      {
        report: values.report,
        recipient: values.recipient,
        approver: values['approved-by'],
        out: values.out,
      },
      deps,
    );
  }
  deps.log.error('diagnostics.refused', { reasonCode: 'COMMAND_UNKNOWN' });
  return BAD_INPUT;
}
