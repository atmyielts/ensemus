// Owned by the export slice (COMM-05). See docs/06-delivery/m6-slices.md and ADR-030 D7 and D10. The service
// and the worker's steps. Nothing about a record crosses Temporal: Activities take IDs, and this keeps its
// place in the export's own row.
//
// The order of an export is what keeps a deletion honest. Sections first, then each file's bytes, then the
// records about files, then tombstones last, then the manifest. A file deleted along the way loses its bytes
// from the archive at the manifest step, and if the records about files may already name it, those are read
// again. A file deleted after the tombstones were read is not in the archive's tombstones at all, so the archive
// cannot be downloaded (`EXPORT_SUPERSEDED`), and upkeep removes it.
import { createHash, randomUUID } from 'node:crypto';
import { coreRecordSchema, exportManifestSchema } from '@ensemus/contracts/portability-records';
import {
  organizationExportParts,
  organizationExports,
  tombstones,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { can } from '@ensemus/domain/policy';
import {
  artifactPartPath,
  CORE_EXPORT_SECTIONS,
  EXPORT_FAILURE_CODES,
  EXPORT_MANIFEST_PATH,
  EXPORT_SECTIONS,
  exportObjectKey,
  MAX_ARCHIVE_PARTS,
  MAX_PART_PLAINTEXT_BYTES,
  MAX_RECORD_BYTES,
  MAX_RECORDS_PER_PART,
  recordPartPath,
  type ExportFailureCode,
  type ExportSection,
  type ExportStatus,
} from '@ensemus/domain/portability';
import {
  AGGREGATE_ORGANIZATION_EXPORT,
  exportTargetRef,
  NOTIFY_EXPORT_FAILED,
  NOTIFY_EXPORT_READY,
  ORGANIZATION_EXPORT_FAILED,
  ORGANIZATION_EXPORT_READY,
  ORGANIZATION_EXPORT_REQUESTED,
} from '@ensemus/domain/sovereign-events';
import {
  exportRecipientPublicKey,
  parseRecipientPublicKey,
  recipientKeyId,
  seal,
} from '@ensemus/sovereign/sealed';
import { tarEnd, tarHeader, tarPadding } from '@ensemus/sovereign/tar';
import { and, asc, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ObjectStore } from './artifacts';
import { AppError } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import { CORE_SECTION_EXPORTERS, nextExportableFile } from './portability-sections-export';
import type { ExportPage, PortabilitySection } from './sovereign-ports';
import { auditAction, notify } from './work';

export type OrganizationExportView = {
  id: string;
  status: ExportStatus;
  scope: 'standard';
  recipientKeyId: string;
  requestedAt: Date;
  finishedAt: Date | null;
  expiresAt: Date | null;
  partCount: number;
  recordCount: number;
  archiveBytes: number;
  excluded: { restrictedWork: number; restrictedArtifacts: number; restrictedClients: number };
  failureCode: ExportFailureCode | null;
  /** False once anything has been deleted since it was made, or it has expired. */
  downloadable: boolean;
};

export type ExportDeps = {
  sections: readonly PortabilitySection[];
  /** This release, for the manifest and the row. */
  sourceRelease: string;
  /** Hours an archive stays in the store. Configuration: `ENSEMUS_EXPORT_RETENTION_HOURS`. */
  retentionHours: number;
  now?: () => Date;
};

/** The store could not answer. Worth retrying, and after long enough the export says so by this code. */
export class ExportStoreUnavailable extends Error {
  override name = 'ExportStoreUnavailable';
  constructor() {
    super('The object store did not answer');
  }
}

const SEALED_MIME = 'application/octet-stream';
const MAX_PUBLIC_KEY_CHARS = 512;
const VIEW_PAGE = 50;
const PART_PAGE = 500;
/**
 * A step past this has probably been given up on and retried, so it must not write bytes the retry may
 * already have recorded. Well inside the Activity's limit, which is in portability-workflow.ts.
 */
const STEP_DEADLINE_MS = 8 * 60 * 1000;
/** How much of what is left one call to `finishExport` takes on, so a normal archive finishes in one. */
const FINISH_PIECES = 8;
const FINISH_BUDGET_MS = 60 * 1000;
/**
 * How often the records about files are read again because a file was deleted meanwhile. On a tenant deleting
 * files without pause it stops here. Those records can then name a deleted file, and the tombstones beside
 * them tell an import to skip it (ADR-030 D8).
 */
const MAX_RECORD_PASSES = 5;
const PURGE_ROWS = 20;
/** How long one sweep keeps deleting, so a store that hangs cannot use up the whole upkeep Activity. */
const PURGE_BUDGET_MS = 30 * 1000;

const excludedSchema = z.object({
  work: z.int().min(0),
  artifacts: z.int().min(0),
  clients: z.int().min(0),
});
type ExcludedCounts = z.infer<typeof excludedSchema>;

/** Where an export has got to, kept in its row. Only section names, cursors, IDs and counters. */
const progressSchema = z.object({
  stage: z.enum(['sections', 'files', 'artifact_records', 'tombstones', 'manifest', 'done']),
  completedSections: z.array(z.string()),
  cursor: z.string().nullable(),
  fileAfter: z.uuid().nullable(),
  /** The last part number used, for each section and kind. */
  sequences: z.record(z.string(), z.int()),
  recordPass: z.int().min(0),
  excludedBeforeRecords: excludedSchema.nullable(),
  artifactTombstonesAtRecords: z.int().min(0).nullable(),
  tombstonesRead: z.int().min(0),
  artifactTombstonesRead: z.int().min(0),
  /** Parts written and then given up, because of a deletion. Not in the manifest, and their bytes are gone. */
  droppedPaths: z.array(z.string()),
  purgeAfter: z.string().nullable(),
});
type Progress = z.infer<typeof progressSchema>;

const FIRST_PROGRESS: Progress = {
  stage: 'sections',
  completedSections: [],
  cursor: null,
  fileAfter: null,
  sequences: {},
  recordPass: 0,
  excludedBeforeRecords: null,
  artifactTombstonesAtRecords: null,
  tombstonesRead: 0,
  artifactTombstonesRead: 0,
  droppedPaths: [],
  purgeAfter: null,
};

type ExportRow = typeof organizationExports.$inferSelect;

/** A row nothing has claimed yet holds an empty object, which means nothing has been done. */
function readProgress(row: ExportRow): Progress {
  const parsed = progressSchema.safeParse(row.progress);
  return parsed.success ? parsed.data : FIRST_PROGRESS;
}

const nowOf = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function requireOwner(context: TenantContext) {
  if (!can(context.role, 'organization.export')) throw new AppError('FORBIDDEN');
}

/**
 * These read past every person's own view, because `standard` scope has its own rule about what stays out. So
 * only the worker may call them, and a person only ever reaches an export through the capability above.
 */
function requireWorker(context: TenantContext) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
}

function exportIdFrom(exportId: string) {
  const parsed = idSchema.safeParse(exportId);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data;
}

const exportIs = (context: TenantContext, exportId: string) =>
  and(
    eq(organizationExports.organizationId, context.organizationId),
    eq(organizationExports.id, exportId),
  );

async function findExport(tx: Tx, context: TenantContext, exportId: string, lock = false) {
  const query = tx.select().from(organizationExports).where(exportIs(context, exportId));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}

/**
 * Whether something was deleted that this archive does not know about. The time alone is not enough: a
 * deletion commits after its own timestamp, so one in flight when the tombstones were read has an earlier
 * time and was not seen. The count catches that. A tombstone is never removed, so a different count means one
 * the archive does not hold, and the ledger re-apply writing an old time is caught the same way.
 */
async function isSuperseded(tx: Tx, context: TenantContext, row: ExportRow) {
  if (!row.tombstonesThrough) return true;
  const [totals] = await tx
    .select({
      total: sql<number>`count(*)::int`,
      newer: sql<number>`(count(*) filter (where ${tombstones.createdAt} > (
        select e.tombstones_through from sovereign.organization_exports e
        where e.organization_id = ${context.organizationId} and e.id = ${row.id})))::int`,
    })
    .from(tombstones)
    .where(eq(tombstones.organizationId, context.organizationId));
  if (!totals) return true;
  if (totals.newer > 0) return true;
  const progress = progressSchema.safeParse(row.progress);
  return progress.success && progress.data.stage === 'done'
    ? totals.total !== progress.data.tombstonesRead
    : false;
}

const isPastItsTime = (row: ExportRow, now: Date) =>
  row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();

function viewOf(row: ExportRow, downloadable: boolean): OrganizationExportView {
  return {
    id: row.id,
    status: row.status as ExportStatus,
    scope: 'standard',
    recipientKeyId: row.recipientKeyId,
    requestedAt: row.requestedAt,
    finishedAt: row.finishedAt,
    expiresAt: row.expiresAt,
    partCount: row.partCount,
    recordCount: row.recordCount,
    archiveBytes: row.archiveBytes,
    excluded: {
      restrictedWork: row.excludedRestrictedWork,
      restrictedArtifacts: row.excludedRestrictedArtifacts,
      restrictedClients: row.excludedRestrictedClients,
    },
    failureCode: row.failureCode as ExportFailureCode | null,
    downloadable,
  };
}

async function viewFrom(tx: Tx, context: TenantContext, row: ExportRow, now: Date) {
  const downloadable =
    row.status === 'ready' && !isPastItsTime(row, now) && !(await isSuperseded(tx, context, row));
  return viewOf(row, downloadable);
}

/**
 * Needs `organization.export`, which only an owner has. Refuses a key that is not X25519 with `INVALID_INPUT`,
 * and a second running export with `EXPORT_ALREADY_RUNNING`. Writes the row, `auditAction` and
 * `emit(ORGANIZATION_EXPORT_REQUESTED)` in one transaction.
 */
export async function requestOrganizationExport(
  database: AppDatabase,
  context: TenantContext,
  input: { recipientPublicKey: string; sourceRelease: string },
): Promise<OrganizationExportView> {
  requireOwner(context);
  if (input.recipientPublicKey.length > MAX_PUBLIC_KEY_CHARS) throw new AppError('INVALID_INPUT');
  if (input.sourceRelease.length < 1 || input.sourceRelease.length > 64) {
    throw new AppError('INVALID_INPUT');
  }
  let recipient: ReturnType<typeof parseRecipientPublicKey>;
  try {
    recipient = parseRecipientPublicKey(input.recipientPublicKey);
  } catch {
    throw new AppError('INVALID_INPUT');
  }
  const id = randomUUID();
  return withTenantTx(database, context, async (tx) => {
    // The partial unique index is what holds the one-at-a-time rule, so two owners asking at once cannot pass.
    const [row] = await tx
      .insert(organizationExports)
      .values({
        organizationId: context.organizationId,
        id,
        // One spelling of the key, so what is stored is exactly what is sealed to.
        recipientPublicKey: exportRecipientPublicKey(recipient),
        recipientKeyId: recipientKeyId(recipient),
        requestedByMembershipId: context.membershipId,
        sourceRelease: input.sourceRelease,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new AppError('EXPORT_ALREADY_RUNNING');
    await auditAction(tx, context, 'organization_export.requested', exportTargetRef(id));
    await emit(tx, context, {
      eventType: ORGANIZATION_EXPORT_REQUESTED,
      aggregateType: AGGREGATE_ORGANIZATION_EXPORT,
      aggregateId: id,
      aggregateVersion: row.version,
      classification: 'internal',
      payload: { export_id: id },
    });
    return viewOf(row, false);
  });
}

export async function listOrganizationExports(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly OrganizationExportView[]> {
  requireOwner(context);
  const now = new Date();
  return withTenantTx(database, context, async (tx) => {
    const rows = await tx
      .select()
      .from(organizationExports)
      .where(eq(organizationExports.organizationId, context.organizationId))
      .orderBy(desc(organizationExports.requestedAt), desc(organizationExports.id))
      .limit(VIEW_PAGE);
    const views: OrganizationExportView[] = [];
    for (const row of rows) views.push(await viewFrom(tx, context, row, now));
    return views;
  });
}

export async function getOrganizationExport(
  database: AppDatabase,
  context: TenantContext,
  exportId: string,
): Promise<OrganizationExportView> {
  requireOwner(context);
  const id = exportIdFrom(exportId);
  return withTenantTx(database, context, async (tx) =>
    viewFrom(tx, context, await findExport(tx, context, id), new Date()),
  );
}

export type ExportArchive = {
  fileName: string;
  totalBytes: number;
  /** Tar framing and sealed parts in order, reading one part at a time from the store. */
  chunks: AsyncIterable<Buffer>;
};

type PartRow = typeof organizationExportParts.$inferSelect;

/** Every part of an export in path order, a page at a time, with no transaction left open between pages. */
async function* partPages(
  database: AppDatabase,
  context: TenantContext,
  exportId: string,
  startAfter: string | null = null,
): AsyncGenerator<readonly PartRow[]> {
  let after = startAfter;
  for (;;) {
    const page: readonly PartRow[] = await withTenantTx(database, context, (tx) =>
      tx
        .select()
        .from(organizationExportParts)
        .where(
          and(
            eq(organizationExportParts.organizationId, context.organizationId),
            eq(organizationExportParts.exportId, exportId),
            after ? gt(organizationExportParts.path, after) : undefined,
          ),
        )
        .orderBy(asc(organizationExportParts.path))
        .limit(PART_PAGE),
    );
    if (page.length > 0) yield page;
    const last = page.at(-1);
    if (!last || page.length < PART_PAGE) return;
    after = last.path;
  }
}

/** What one file adds to a tar: its header, its bytes and the padding after them. */
export const tarEntryBytes = (size: number) =>
  tarHeader('x', size).length + size + tarPadding(size).length;

async function* archiveChunks(
  database: AppDatabase,
  store: Pick<ObjectStore, 'get'>,
  context: TenantContext,
  row: ExportRow,
): AsyncGenerator<Buffer> {
  const dropped = new Set(readProgress(row).droppedPaths);
  const mtime = Math.floor((row.finishedAt ?? row.requestedAt).getTime() / 1000);

  async function* entry(path: string, key: string, expectedSha256: string | null) {
    const body = await fromStore(() => store.get(key));
    // Whoever is downloading gets what was recorded or nothing. An import would refuse it anyway.
    if (sha256(body) !== expectedSha256) throw new AppError('EXPORT_NOT_READY');
    yield tarHeader(path, body.length, mtime);
    yield body;
    yield tarPadding(body.length);
  }

  yield* entry(
    EXPORT_MANIFEST_PATH,
    exportObjectKey(context.organizationId, row.id, EXPORT_MANIFEST_PATH),
    row.manifestSealedSha256,
  );
  for await (const page of partPages(database, context, row.id)) {
    // A long download can outlive a deletion. Stopping leaves a tar with no end, which no reader accepts.
    const superseded = await withTenantTx(database, context, (tx) =>
      isSuperseded(tx, context, row),
    );
    if (superseded) throw new AppError('EXPORT_SUPERSEDED');
    for (const part of page) {
      if (dropped.has(part.path)) continue;
      yield* entry(part.path, part.objectKey, part.sealedSha256);
    }
  }
  yield tarEnd();
}

/**
 * Hands over the archive for download. Needs `organization.export`. Refuses `EXPORT_NOT_READY` unless it is
 * `ready`, and `EXPORT_SUPERSEDED` if any tombstone is newer than `tombstones_through`, since then the archive
 * holds something its owner has since deleted (ADR-030 D10). Audits who took it.
 */
export async function openExportArchive(
  database: AppDatabase,
  store: Pick<ObjectStore, 'get'>,
  context: TenantContext,
  exportId: string,
): Promise<ExportArchive> {
  requireOwner(context);
  const id = exportIdFrom(exportId);
  const row = await withTenantTx(database, context, async (tx) => {
    const found = await findExport(tx, context, id);
    if (found.status !== 'ready' || isPastItsTime(found, new Date())) {
      throw new AppError('EXPORT_NOT_READY');
    }
    if (await isSuperseded(tx, context, found)) throw new AppError('EXPORT_SUPERSEDED');
    await auditAction(tx, context, 'organization_export.downloaded', exportTargetRef(id));
    return found;
  });
  return {
    fileName: `ensemus-export-${row.id}.tar`,
    totalBytes: row.archiveBytes,
    chunks: archiveChunks(database, store, context, row),
  };
}

/** What the worker's steps answer with. Counters and enums, because these go through Temporal. */
export type ExportStep =
  | { state: 'continue'; parts: number; records: number }
  | { state: 'finished'; parts: number; records: number }
  | { state: 'failed'; code: ExportFailureCode };

const counters = (row: ExportRow) => ({ parts: row.partCount, records: row.recordCount });

/** The answer for an export that is not running any more, or null while it is. */
function settledStep(row: ExportRow): ExportStep | null {
  switch (row.status) {
    case 'ready':
    case 'expired':
      return { state: 'finished', ...counters(row) };
    case 'failed':
      return { state: 'failed', code: (row.failureCode ?? 'SECTION_FAILED') as ExportFailureCode };
    default:
      return null;
  }
}

const stepOf = (row: ExportRow): ExportStep =>
  settledStep(row) ?? { state: 'continue', ...counters(row) };

/** Moves it to `running` and records `snapshot_at`. On a row already finished, answers `finished`. */
export async function beginExport(
  database: AppDatabase,
  context: TenantContext,
  input: { exportId: string },
  deps: ExportDeps,
): Promise<ExportStep> {
  requireWorker(context);
  const id = exportIdFrom(input.exportId);
  return withTenantTx(database, context, async (tx) => {
    const row = await findExport(tx, context, id, true);
    if (row.status !== 'requested') return stepOf(row);
    const [claimed] = await tx
      .update(organizationExports)
      .set({
        status: 'running',
        // The database's own clock, because every row this is compared with was stamped by it.
        snapshotAt: sql`now()`,
        startedAt: nowOf(deps),
        progress: FIRST_PROGRESS,
        version: row.version + 1,
        updatedAt: nowOf(deps),
      })
      .where(exportIs(context, id))
      .returning();
    if (!claimed) throw new AppError('NOT_FOUND');
    await auditAction(tx, context, 'organization_export.started', exportTargetRef(id));
    return stepOf(claimed);
  });
}

type EncodedPage =
  { ok: true; body: Buffer; count: number } | { ok: false; why: 'refused' | 'too_big' };

const isCoreSection = (section: string) =>
  (CORE_EXPORT_SECTIONS as readonly string[]).includes(section);

/**
 * A later milestone's section has its own schema, and these are the rules no section may break: a record is an
 * object, it does not name a tenant, and it is not restricted.
 */
function checkPortRecord(record: unknown): unknown {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const fields = record as Record<string, unknown>;
  if ('organization_id' in fields || 'organizationId' in fields) return undefined;
  if (fields.classification === 'restricted') return undefined;
  return record;
}

/**
 * One page as JSONL. Each core record goes through its strict schema and what comes out is what is written, so
 * a new column, a credential or a restricted class has nowhere to go. No text from a record reaches the answer.
 */
export function encodeExportPage(section: string, records: readonly unknown[]): EncodedPage {
  const core = isCoreSection(section);
  const lines: Buffer[] = [];
  let total = 0;
  for (const record of records) {
    let checked: unknown;
    if (core) {
      const parsed = coreRecordSchema.safeParse(record);
      if (!parsed.success) return { ok: false, why: 'refused' };
      checked = parsed.data;
    } else {
      checked = checkPortRecord(record);
      if (checked === undefined) return { ok: false, why: 'refused' };
    }
    const line = Buffer.from(`${JSON.stringify(checked)}\n`);
    if (line.length > MAX_RECORD_BYTES) return { ok: false, why: 'refused' };
    total += line.length;
    if (total > MAX_PART_PLAINTEXT_BYTES) return { ok: false, why: 'too_big' };
    lines.push(line);
  }
  return { ok: true, body: Buffer.concat(lines, total), count: lines.length };
}

/** Turns anything the store throws into one fixed error, so none of its text travels any further. */
async function fromStore<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw new ExportStoreUnavailable();
  }
}

type Run = {
  database: AppDatabase;
  store: ObjectStore;
  context: TenantContext;
  row: ExportRow;
  progress: Progress;
  deps: ExportDeps;
  startedAtMs: number;
};

type PartValues = typeof organizationExportParts.$inferInsert;

/** Seals one part and writes its object. Outside any transaction, and the part row comes after. */
async function storePart(
  run: Run,
  section: ExportSection,
  path: string,
  recordCount: number,
  plaintext: Buffer,
): Promise<PartValues> {
  const { context, row, store } = run;
  const sealed = seal(plaintext, parseRecipientPublicKey(row.recipientPublicKey));
  const objectKey = exportObjectKey(context.organizationId, row.id, path);
  if (Date.now() - run.startedAtMs > STEP_DEADLINE_MS) throw new ExportStoreUnavailable();
  await fromStore(() => store.put(objectKey, sealed, SEALED_MIME));
  return {
    organizationId: context.organizationId,
    exportId: row.id,
    path,
    section,
    recordCount,
    plaintextSha256: sha256(plaintext),
    sealedSha256: sha256(sealed),
    sealedBytes: sealed.length,
    objectKey,
  };
}

type CommitChange = {
  part?: PartValues;
  /** Added to what the row has. */
  excluded?: Readonly<Record<string, number>>;
  /** Worked out under the row's lock, because some of it depends on what the tables say at that moment. */
  next(
    tx: Tx,
    current: ExportRow,
  ): Promise<{
    progress: Progress;
    resetExcluded?: ExcludedCounts;
    markTombstonesThrough?: boolean;
  }>;
};

/**
 * The part row and the new place, in one transaction, so there is never one without the other. If the row has
 * moved since this step read it, another attempt got there first, and this one writes nothing and says where
 * things stand. So a retry repeats nothing.
 */
function commitStep(run: Run, change: CommitChange): Promise<ExportStep> {
  const { database, context, row, deps } = run;
  return withTenantTx(database, context, async (tx) => {
    const current = await findExport(tx, context, row.id, true);
    if (current.status !== 'running' || current.version !== row.version) return stepOf(current);
    if (change.part) {
      await tx.insert(organizationExportParts).values(change.part).onConflictDoNothing();
    }
    const outcome = await change.next(tx, current);
    const base: ExcludedCounts = outcome.resetExcluded ?? {
      work: current.excludedRestrictedWork,
      artifacts: current.excludedRestrictedArtifacts,
      clients: current.excludedRestrictedClients,
    };
    const [saved] = await tx
      .update(organizationExports)
      .set({
        progress: outcome.progress,
        version: current.version + 1,
        updatedAt: nowOf(deps),
        partCount: current.partCount + (change.part ? 1 : 0),
        recordCount: current.recordCount + (change.part?.recordCount ?? 0),
        archiveBytes: current.archiveBytes + (change.part?.sealedBytes ?? 0),
        excludedRestrictedWork: base.work + (change.excluded?.restricted_work ?? 0),
        excludedRestrictedArtifacts: base.artifacts + (change.excluded?.restricted_artifacts ?? 0),
        excludedRestrictedClients: base.clients + (change.excluded?.restricted_clients ?? 0),
        // Read off the database's clock after the last page, so nothing read can be newer than this.
        ...(outcome.markTombstonesThrough ? { tombstonesThrough: sql`clock_timestamp()` } : {}),
      })
      .where(exportIs(context, row.id))
      .returning();
    if (!saved) throw new AppError('NOT_FOUND');
    return stepOf(saved);
  });
}

async function failStep(run: Run, code: ExportFailureCode): Promise<ExportStep> {
  await failExport(run.database, run.context, { exportId: run.row.id, code });
  return { state: 'failed', code };
}

/** How many tombstones name a file right now, as this transaction sees them. */
async function countFileTombstones(tx: Tx, context: TenantContext) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(tombstones)
    .where(
      and(
        eq(tombstones.organizationId, context.organizationId),
        eq(tombstones.targetType, 'artifact'),
      ),
    );
  return row?.n ?? 0;
}

/** Reads one page, smaller if it would not fit one part, and writes it. An empty page writes no part. */
async function writeRecords(
  run: Run,
  section: ExportSection,
  exportPage: PortabilitySection['exportPage'],
  next: (
    page: ExportPage,
    sequences: Progress['sequences'],
    tx: Tx,
    current: ExportRow,
  ) => ReturnType<CommitChange['next']>,
): Promise<ExportStep> {
  const { database, context, row, progress } = run;
  let limit = MAX_RECORDS_PER_PART;
  let page: ExportPage;
  let encoded: EncodedPage;
  for (;;) {
    const size = limit;
    page = await withTenantTx(database, context, (tx) =>
      exportPage(tx, context, { cursor: progress.cursor, limit: size }),
    );
    encoded = encodeExportPage(section, page.records);
    if (encoded.ok || encoded.why === 'refused' || limit === 1) break;
    limit = Math.max(1, Math.floor(limit / 2));
  }
  if (!encoded.ok) return failStep(run, 'RECORD_REFUSED');

  const read = page;
  const excluded = read.excluded ? { excluded: read.excluded } : {};
  if (encoded.count === 0) {
    return commitStep(run, {
      ...excluded,
      next: (tx, current) => next(read, progress.sequences, tx, current),
    });
  }

  const sequenceKey = `${section}:${read.recordKind}`;
  const sequence = (progress.sequences[sequenceKey] ?? 0) + 1;
  if (row.partCount >= MAX_ARCHIVE_PARTS || sequence > 999_999) {
    return failStep(run, 'TOO_MANY_PARTS');
  }
  let path: string;
  try {
    path = recordPartPath(section, read.recordKind, sequence);
  } catch {
    return failStep(run, 'RECORD_REFUSED');
  }
  const part = await storePart(run, section, path, encoded.count, encoded.body);
  const sequences = { ...progress.sequences, [sequenceKey]: sequence };
  return commitStep(run, {
    part,
    ...excluded,
    next: (tx, current) => next(read, sequences, tx, current),
  });
}

const sectionNamed = (deps: ExportDeps, name: ExportSection) =>
  deps.sections.find((section) => section.section === name);

/** Every section but the two with their own place in the order. */
function nextPlainSection(deps: ExportDeps, progress: Progress) {
  return deps.sections.find(
    (section) =>
      section.section !== 'artifacts' &&
      section.section !== 'tombstones' &&
      !progress.completedSections.includes(section.section),
  );
}

async function sectionsPiece(run: Run): Promise<ExportStep> {
  const { progress, deps } = run;
  const section = nextPlainSection(deps, progress);
  if (!section) {
    // No section for files means no records about them, so bytes on their own have no place here either.
    const stage = sectionNamed(deps, 'artifacts') ? 'files' : 'tombstones';
    return commitStep(run, {
      next: async () => ({ progress: { ...progress, stage, cursor: null } }),
    });
  }
  return writeRecords(run, section.section, section.exportPage, async (page, sequences) => ({
    progress: {
      ...progress,
      sequences,
      cursor: page.nextCursor,
      completedSections: page.nextCursor
        ? progress.completedSections
        : [...progress.completedSections, section.section],
    },
  }));
}

/** One file's bytes, checked and sealed. A tombstoned file is never read. */
async function filesPiece(run: Run): Promise<ExportStep> {
  const { database, store, context, progress, row } = run;
  const file = await withTenantTx(database, context, (tx) =>
    nextExportableFile(tx, context, progress.fileAfter),
  );
  if (!file) return startRecordPass(run, progress.recordPass);
  if (file.sizeBytes > MAX_PART_PLAINTEXT_BYTES) return failStep(run, 'RECORD_REFUSED');
  if (row.partCount >= MAX_ARCHIVE_PARTS) return failStep(run, 'TOO_MANY_PARTS');

  const moveOn = () =>
    commitStep(run, {
      next: async () => ({ progress: { ...progress, fileAfter: file.id } }),
    });

  let body: Buffer;
  try {
    body = await store.get(file.objectKey);
  } catch {
    if (await fromStore(() => store.exists(file.objectKey))) throw new ExportStoreUnavailable();
    // Gone. Being deleted just now is an ordinary reason. Otherwise something lost a file nobody deleted.
    const stillThere = await withTenantTx(database, context, async (tx) =>
      nextExportableFile(tx, context, progress.fileAfter),
    );
    return stillThere?.id === file.id ? failStep(run, 'BYTES_MISSING') : moveOn();
  }
  if (sha256(body) !== file.sha256) return failStep(run, 'BYTES_CHANGED');

  const part = await storePart(run, 'artifacts', artifactPartPath(file.id), 0, body);
  return commitStep(run, {
    part,
    next: async () => ({ progress: { ...progress, fileAfter: file.id } }),
  });
}

/**
 * Starts reading the records about files. Notes how many file tombstones exist now, so that the end of the
 * tombstones can tell whether a file was deleted after this point, and these records may name it.
 */
function startRecordPass(run: Run, pass: number): Promise<ExportStep> {
  const { context, progress } = run;
  return commitStep(run, {
    next: async (tx, current) => ({
      progress: {
        ...progress,
        stage: 'artifact_records',
        cursor: null,
        recordPass: pass,
        artifactTombstonesAtRecords: await countFileTombstones(tx, context),
        excludedBeforeRecords: {
          work: current.excludedRestrictedWork,
          artifacts: current.excludedRestrictedArtifacts,
          clients: current.excludedRestrictedClients,
        },
      },
    }),
  });
}

function recordsPiece(run: Run): Promise<ExportStep> {
  const { progress, deps } = run;
  const section = sectionNamed(deps, 'artifacts');
  const exportPage = section?.exportPage ?? CORE_SECTION_EXPORTERS.artifacts;
  return writeRecords(run, 'artifacts', exportPage, async (page, sequences) => ({
    progress: {
      ...progress,
      sequences,
      cursor: page.nextCursor,
      stage: page.nextCursor ? 'artifact_records' : 'tombstones',
    },
  }));
}

/**
 * Tombstones, read last. With the last page, either `tombstones_through` is set, or a file turns out to have
 * been deleted since the records about files were read. Those records and these tombstones are then given up
 * and read again, under new part numbers, so the archive holds no name of a file its owner has deleted.
 */
function tombstonesPiece(run: Run): Promise<ExportStep> {
  const { context, progress, deps, row } = run;
  const exportPage =
    sectionNamed(deps, 'tombstones')?.exportPage ?? CORE_SECTION_EXPORTERS.tombstones;
  return writeRecords(run, 'tombstones', exportPage, async (page, sequences, tx, current) => {
    const fileTombstones = page.records.filter(
      (record) => (record as { target_type?: unknown }).target_type === 'artifact',
    ).length;
    const carried: Progress = {
      ...progress,
      sequences,
      cursor: page.nextCursor,
      tombstonesRead: progress.tombstonesRead + page.records.length,
      artifactTombstonesRead: progress.artifactTombstonesRead + fileTombstones,
    };
    if (page.nextCursor) return { progress: carried };

    const readAgain =
      progress.artifactTombstonesAtRecords !== null &&
      carried.artifactTombstonesRead !== progress.artifactTombstonesAtRecords &&
      progress.recordPass + 1 < MAX_RECORD_PASSES &&
      sectionNamed(deps, 'artifacts') !== undefined;
    if (!readAgain) {
      return { progress: { ...carried, stage: 'manifest' }, markTombstonesThrough: true };
    }

    const givenUp = await tx
      .select({ path: organizationExportParts.path })
      .from(organizationExportParts)
      .where(
        and(
          eq(organizationExportParts.organizationId, context.organizationId),
          eq(organizationExportParts.exportId, row.id),
          or(
            eq(organizationExportParts.section, 'tombstones'),
            and(
              eq(organizationExportParts.section, 'artifacts'),
              sql`${organizationExportParts.path} like '%.jsonl.sealed'`,
            ),
          ),
        ),
      );
    return {
      resetExcluded: progress.excludedBeforeRecords ?? {
        work: current.excludedRestrictedWork,
        artifacts: current.excludedRestrictedArtifacts,
        clients: current.excludedRestrictedClients,
      },
      progress: {
        ...carried,
        stage: 'artifact_records',
        cursor: null,
        recordPass: progress.recordPass + 1,
        artifactTombstonesAtRecords: await countFileTombstones(tx, context),
        tombstonesRead: 0,
        artifactTombstonesRead: 0,
        droppedPaths: [...new Set([...progress.droppedPaths, ...givenUp.map((p) => p.path)])],
      },
    };
  });
}

/** Writes the manifest from the part rows, and makes the export `ready`, with who asked told. */
async function manifestPiece(run: Run): Promise<ExportStep> {
  const { database, store, context, progress, row, deps } = run;

  // Files deleted after their bytes were sealed. Their part rows stay, since those are append-only, and their
  // bytes go, and neither the manifest nor the download mentions them.
  const deletedFiles = await withTenantTx(database, context, (tx) =>
    tx
      .select({ path: organizationExportParts.path })
      .from(organizationExportParts)
      .innerJoin(
        tombstones,
        and(
          eq(tombstones.organizationId, organizationExportParts.organizationId),
          eq(tombstones.targetType, 'artifact'),
          sql`${organizationExportParts.path} = 'artifacts/' || ${tombstones.targetId}::text || '.bin.sealed'`,
        ),
      )
      .where(
        and(
          eq(organizationExportParts.organizationId, context.organizationId),
          eq(organizationExportParts.exportId, row.id),
        ),
      ),
  );
  const dropped = new Set([...progress.droppedPaths, ...deletedFiles.map((file) => file.path)]);
  for (const path of dropped) {
    const key = exportObjectKey(context.organizationId, row.id, path);
    await fromStore(() => store.delete(key));
  }

  const parts: {
    path: string;
    section: string;
    records: number;
    plaintext_sha256: string;
    sealed_sha256: string;
    sealed_bytes: number;
  }[] = [];
  const sections: Record<string, { records: number; parts: number }> = {};
  for (const name of EXPORT_SECTIONS) sections[name] = { records: 0, parts: 0 };
  let records = 0;
  let archiveBytes = tarEnd().length;
  let manifestEstimate = 0;
  for await (const page of partPages(database, context, row.id)) {
    for (const part of page) {
      if (dropped.has(part.path)) continue;
      parts.push({
        path: part.path,
        section: part.section,
        records: part.recordCount,
        plaintext_sha256: part.plaintextSha256,
        sealed_sha256: part.sealedSha256,
        sealed_bytes: part.sealedBytes,
      });
      const totals = (sections[part.section] ??= { records: 0, parts: 0 });
      totals.records += part.recordCount;
      totals.parts += 1;
      records += part.recordCount;
      archiveBytes += tarEntryBytes(part.sealedBytes);
      manifestEstimate += part.path.length + 256;
      // A manifest is bound by the same limit as any other part, which is well below the part count's own.
      if (parts.length > MAX_ARCHIVE_PARTS || manifestEstimate > MAX_PART_PLAINTEXT_BYTES) {
        return failStep(run, 'TOO_MANY_PARTS');
      }
    }
  }

  const now = nowOf(deps);
  const manifest = exportManifestSchema.safeParse({
    format: 'ensemus.organization_export',
    schema_version: 1,
    export_id: row.id,
    organization_id: context.organizationId,
    exported_at: now.toISOString(),
    snapshot_at: (row.snapshotAt ?? now).toISOString(),
    tombstones_through: (row.tombstonesThrough ?? now).toISOString(),
    initiated_by_membership_id: row.requestedByMembershipId,
    source_release: deps.sourceRelease,
    scope: 'standard',
    excluded: {
      restricted_work: row.excludedRestrictedWork,
      restricted_artifacts: row.excludedRestrictedArtifacts,
      restricted_clients: row.excludedRestrictedClients,
    },
    sections,
    parts,
    encryption: { scheme: 'ensemus.sealed/v1', recipient_key_id: row.recipientKeyId },
  });
  if (!manifest.success) return failStep(run, 'RECORD_REFUSED');

  const plaintext = Buffer.from(JSON.stringify(manifest.data));
  if (plaintext.length > MAX_PART_PLAINTEXT_BYTES) return failStep(run, 'TOO_MANY_PARTS');
  const sealed = seal(plaintext, parseRecipientPublicKey(row.recipientPublicKey));
  const manifestKey = exportObjectKey(context.organizationId, row.id, EXPORT_MANIFEST_PATH);
  if (Date.now() - run.startedAtMs > STEP_DEADLINE_MS) throw new ExportStoreUnavailable();
  await fromStore(() => store.put(manifestKey, sealed, SEALED_MIME));
  archiveBytes += tarEntryBytes(sealed.length);

  return withTenantTx(database, context, async (tx) => {
    const current = await findExport(tx, context, row.id, true);
    if (current.status !== 'running' || current.version !== row.version) return stepOf(current);
    const [ready] = await tx
      .update(organizationExports)
      .set({
        status: 'ready',
        progress: { ...progress, stage: 'done', droppedPaths: [...dropped] },
        version: current.version + 1,
        manifestSealedSha256: sha256(sealed),
        partCount: parts.length,
        recordCount: records,
        archiveBytes,
        finishedAt: now,
        expiresAt: new Date(now.getTime() + deps.retentionHours * 60 * 60 * 1000),
        updatedAt: now,
      })
      .where(exportIs(context, row.id))
      .returning();
    if (!ready) throw new AppError('NOT_FOUND');
    await auditAction(tx, context, 'organization_export.ready', exportTargetRef(row.id));
    await notify(
      tx,
      context,
      [row.requestedByMembershipId],
      NOTIFY_EXPORT_READY,
      exportTargetRef(row.id),
    );
    await emit(tx, context, {
      eventType: ORGANIZATION_EXPORT_READY,
      aggregateType: AGGREGATE_ORGANIZATION_EXPORT,
      aggregateId: row.id,
      aggregateVersion: ready.version,
      classification: 'internal',
      payload: { export_id: row.id, parts: parts.length, records },
    });
    return stepOf(ready);
  });
}

/** Does exactly one thing next, whatever stage the row says it has reached. */
function onePiece(run: Run): Promise<ExportStep> {
  switch (run.progress.stage) {
    case 'sections':
      return sectionsPiece(run);
    case 'files':
      return filesPiece(run);
    case 'artifact_records':
      return recordsPiece(run);
    case 'tombstones':
      return tombstonesPiece(run);
    case 'manifest':
      return manifestPiece(run);
    case 'done':
      return Promise.resolve(stepOf(run.row));
  }
}

async function readRun(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  exportId: string,
  deps: ExportDeps,
): Promise<Run | ExportStep> {
  const row = await withTenantTx(database, context, (tx) => findExport(tx, context, exportId));
  const settled = settledStep(row);
  if (settled) return settled;
  // Nothing has claimed it, so nothing has a snapshot to read against. A workflow always begins first.
  if (row.status === 'requested') throw new AppError('INVALID_STATE');
  return {
    database,
    store,
    context,
    row,
    progress: readProgress(row),
    deps,
    startedAtMs: Date.now(),
  };
}

const isRun = (value: Run | ExportStep): value is Run => 'row' in value;

/**
 * One bounded step: one page of one section, or one file's bytes, sealed and written, then its part row and
 * the new place in `progress`. A part whose row exists is skipped, so a retry repeats nothing. Bytes that do
 * not match the row's hash stop the export with `BYTES_CHANGED`, and a tombstoned file is never read.
 *
 * Answers `finished` once only tombstones and the manifest are left, which are `finishExport`'s.
 */
export async function exportNextBatch(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  input: { exportId: string },
  deps: ExportDeps,
): Promise<ExportStep> {
  requireWorker(context);
  const run = await readRun(database, store, context, exportIdFrom(input.exportId), deps);
  if (!isRun(run)) return run;
  if (run.progress.stage === 'tombstones' || run.progress.stage === 'manifest') {
    return { state: 'finished', ...counters(run.row) };
  }
  return onePiece(run);
}

/**
 * Reads tombstones last, writes the sealed manifest from the part rows, sets `ready` with `expires_at`, tells
 * who asked through a notification, and emits `ORGANIZATION_EXPORT_READY`. Safe to repeat. A large tenant's
 * tombstones take more than one call, each bounded, and `continue` says to call again.
 */
export async function finishExport(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  input: { exportId: string },
  deps: ExportDeps,
): Promise<ExportStep> {
  requireWorker(context);
  const id = exportIdFrom(input.exportId);
  const stopAt = Date.now() + FINISH_BUDGET_MS;
  for (let piece = 0; ; piece += 1) {
    const run = await readRun(database, store, context, id, deps);
    if (!isRun(run)) return run;
    const step = await onePiece(run);
    if (step.state !== 'continue') return step;
    if (piece + 1 >= FINISH_PIECES || Date.now() >= stopAt) return step;
  }
}

export async function failExport(
  database: AppDatabase,
  context: TenantContext,
  input: { exportId: string; code: ExportFailureCode },
): Promise<void> {
  requireWorker(context);
  if (!EXPORT_FAILURE_CODES.includes(input.code)) throw new AppError('INVALID_INPUT');
  const id = exportIdFrom(input.exportId);
  await withTenantTx(database, context, async (tx) => {
    const row = await findExport(tx, context, id, true);
    // Anything already settled stays as it is. A late failure from a stale attempt cannot undo a ready archive.
    if (row.status !== 'requested' && row.status !== 'running') return;
    const now = new Date();
    const [failed] = await tx
      .update(organizationExports)
      .set({
        status: 'failed',
        failureCode: input.code,
        version: row.version + 1,
        finishedAt: now,
        updatedAt: now,
      })
      .where(exportIs(context, id))
      .returning();
    if (!failed) throw new AppError('NOT_FOUND');
    await auditAction(tx, context, 'organization_export.failed', exportTargetRef(id), input.code);
    await notify(
      tx,
      context,
      [row.requestedByMembershipId],
      NOTIFY_EXPORT_FAILED,
      exportTargetRef(id),
    );
    await emit(tx, context, {
      eventType: ORGANIZATION_EXPORT_FAILED,
      aggregateType: AGGREGATE_ORGANIZATION_EXPORT,
      aggregateId: id,
      aggregateVersion: failed.version,
      classification: 'internal',
      payload: { export_id: id, code: input.code },
    });
  });
}

/** Removes one export's bytes, remembering how far it got so a large one finishes over several sweeps. */
async function purgeBytes(
  database: AppDatabase,
  store: Pick<ObjectStore, 'delete'>,
  context: TenantContext,
  row: ExportRow,
  stopAt: number,
): Promise<boolean> {
  const progress = readProgress(row);
  let after = progress.purgeAfter;
  for await (const page of partPages(database, context, row.id, after)) {
    for (const part of page) await store.delete(part.objectKey);
    after = page.at(-1)?.path ?? after;
    const place = after;
    await withTenantTx(database, context, (tx) =>
      tx
        .update(organizationExports)
        .set({ progress: { ...progress, purgeAfter: place } })
        .where(exportIs(context, row.id)),
    );
    if (Date.now() >= stopAt) return false;
  }
  await store.delete(exportObjectKey(context.organizationId, row.id, EXPORT_MANIFEST_PATH));
  return true;
}

/**
 * The tenant's upkeep. Past its time, or superseded by a deletion, an archive's bytes go and its row becomes
 * `expired`, and that row stays as the record. Returns how many. A failed export's partial bytes go too, and
 * its row stays `failed`. A store that will not answer leaves the row for the next sweep, and meanwhile the
 * same checks keep the archive from being downloaded.
 */
export async function purgeExpiredExports(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  now: Date,
): Promise<number> {
  requireWorker(context);
  const due = await withTenantTx(database, context, async (tx) => {
    const rows = await tx
      .select()
      .from(organizationExports)
      .where(
        and(
          eq(organizationExports.organizationId, context.organizationId),
          or(
            eq(organizationExports.status, 'ready'),
            and(eq(organizationExports.status, 'failed'), isNull(organizationExports.purgedAt)),
          ),
        ),
      )
      .orderBy(asc(organizationExports.requestedAt), asc(organizationExports.id))
      .limit(PURGE_ROWS);
    const found: { row: ExportRow; reason: 'EXPORT_EXPIRED' | 'EXPORT_SUPERSEDED' | null }[] = [];
    for (const row of rows) {
      if (row.status === 'failed') found.push({ row, reason: null });
      else if (isPastItsTime(row, now)) found.push({ row, reason: 'EXPORT_EXPIRED' });
      else if (await isSuperseded(tx, context, row)) {
        found.push({ row, reason: 'EXPORT_SUPERSEDED' });
      }
    }
    return found;
  });

  const stopAt = Date.now() + PURGE_BUDGET_MS;
  let expired = 0;
  for (const { row, reason } of due) {
    if (Date.now() >= stopAt) break;
    let finished: boolean;
    try {
      finished = await purgeBytes(database, store, context, row, stopAt);
    } catch {
      // Still recorded as to do, and nothing here can be downloaded meanwhile.
      continue;
    }
    if (!finished) continue;
    await withTenantTx(database, context, async (tx) => {
      const current = await findExport(tx, context, row.id, true);
      if (current.status !== row.status) return;
      await tx
        .update(organizationExports)
        .set({
          ...(reason ? { status: 'expired' } : {}),
          purgedAt: now,
          version: current.version + 1,
          updatedAt: now,
        })
        .where(exportIs(context, row.id));
      await auditAction(
        tx,
        context,
        'organization_export.purged',
        exportTargetRef(row.id),
        reason ?? 'EXPORT_FAILED',
      );
    });
    if (reason) expired += 1;
  }
  return expired;
}
