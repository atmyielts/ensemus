// Owned by the import slice (COMM-05). See docs/06-delivery/m6-slices.md and ADR-030 D8 and D9. An archive is
// hostile input until proven otherwise, it goes only into an organization with nothing in it, and it starts
// nothing. It runs in an operator's command, so the private key that opens it stays in that one process.
import { createHash, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import {
  artifacts,
  blobLifecycle,
  clients,
  connections,
  importedPeople,
  importedRecords,
  memberships,
  organizationImportParts,
  organizationImports,
  projects,
  teamMemberships,
  teams,
  withTenantTx,
  workAssignments,
  workUnits,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  exportManifestSchema,
  coreRecordSchema,
  validatePortableRecord,
  type CoreRecord,
  type ExportManifest,
} from '@ensemus/contracts/portability-records';
import {
  artifactPartPath,
  knowledgePartPath,
  matchesPortabilityInventory,
  assertPortabilitySections,
  EXPORT_MANIFEST_PATH,
  EXPORT_SECTIONS,
  isArchivePath,
  MAX_ARCHIVE_PARTS,
  MAX_PART_PLAINTEXT_BYTES,
  MAX_RECORD_BYTES,
  MAX_RECORDS_PER_PART,
  type CoreExportSection,
  type ExportSection,
  type ImportFailureCode,
  type ImportStatus,
  type ImportWarningCode,
  type ImportedRecordType,
} from '@ensemus/domain/portability';
import { can, canManageWork, type Classification } from '@ensemus/domain/policy';
import {
  AGGREGATE_ORGANIZATION_IMPORT,
  importTargetRef,
  NOTIFY_IMPORT_FINISHED,
  ORGANIZATION_IMPORT_FINISHED,
  ORGANIZATION_IMPORT_REQUESTED,
} from '@ensemus/domain/sovereign-events';
import {
  ledgerPrefixFor,
  parseLedgerEntry,
  parseLedgerKey,
} from '@ensemus/domain/tombstone-ledger';
import { MAX_FILE_BYTES } from '@ensemus/domain/work-unit';
import {
  open,
  parseRecipientPrivateKey,
  recipientKeyId,
  SealedRefused,
  sealedRecipientId,
} from '@ensemus/sovereign/sealed';
import { readTarEntries, type TarEntry } from '@ensemus/sovereign/tar';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { objectKey, type ObjectStore } from './artifacts';
import { AppError, pgCode } from './errors';
import { emit } from './events';
import { canonicalId, idSchema } from './ids';
import {
  listImportHoldings,
  recordImportedTombstone,
  RecordRefused,
  validateCoreRecord,
  type ImportHolding,
} from './portability-sections-import';
import type { ImportScope, PortabilitySection } from './sovereign-ports';
import type { LedgerReader } from './tombstone-ledger';
import { assertJoinedPortabilitySchema, quarantinePortableRecord } from './portability-extensions';
import { queryRows } from './portability-sql';

export { parentsFirst } from './portability-sections-import';

import {
  assertActiveMember,
  auditAction,
  loadChangeable,
  loadReadable,
  notify,
  setOwner,
} from './work';

export type OrganizationImportView = {
  id: string;
  status: ImportStatus;
  requestedAt: Date;
  finishedAt: Date | null;
  sourceOrganizationId: string | null;
  exportedAt: Date | null;
  sourceRelease: string | null;
  appliedCounts: Readonly<Record<string, number>>;
  warningCounts: Readonly<Partial<Record<ImportWarningCode, number>>>;
  failureCode: ImportFailureCode | null;
};

type ImportRow = typeof organizationImports.$inferSelect;
type WarningCounts = Partial<Record<ImportWarningCode, number>>;

const toView = (row: ImportRow): OrganizationImportView => ({
  id: row.id,
  status: row.status as ImportStatus,
  requestedAt: row.requestedAt,
  finishedAt: row.finishedAt,
  sourceOrganizationId: row.sourceOrganizationId,
  exportedAt: row.exportedAt,
  sourceRelease: row.sourceRelease,
  appliedCounts: row.appliedCounts as Record<string, number>,
  warningCounts: row.warningCounts as WarningCounts,
  failureCode: row.failureCode as ImportFailureCode | null,
});

const requireImportRight = (context: TenantContext) => {
  if (context.actorType !== 'service' && !can(context.role, 'organization.import')) {
    throw new AppError('FORBIDDEN');
  }
};

const countOf = async (tx: Tx, table: PgTable) => {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(table);
  return row?.n ?? 0;
};

/** What makes an organization not empty, by the record kind that fills it. People are counted separately. */
const countsOfContent = async (tx: Tx, importId?: string) => {
  await assertJoinedPortabilitySchema(tx);
  const extra = await queryRows<{ kind: string; n: number }>(
    tx,
    sql`
    select 'knowledge_source' as kind,count(*)::int as n from knowledge.sources
    union all select 'knowledge_document',count(*)::int from knowledge.documents d
      ${importId ? sql`where d.id not in(select sovereign.reserved_import_document_ids(${importId}::uuid))` : sql``}
    union all select 'model_profile',count(*)::int from ai.model_profiles
    union all select 'agent_definition',count(*)::int from ai.agent_definitions
    union all select 'budget',count(*)::int from platform.budgets`,
  );
  return {
    work_unit: await countOf(tx, workUnits),
    client: await countOf(tx, clients),
    project: await countOf(tx, projects),
    team: await countOf(tx, teams),
    artifact: await countOf(tx, artifacts),
    connection: await countOf(tx, connections),
    ...Object.fromEntries(extra.map((row) => [row.kind, row.n])),
  };
};

/**
 * An owner saying this organization is to take an archive. Needs `organization.import`. Refuses with
 * `IMPORT_TARGET_NOT_EMPTY` unless the organization holds no work, clients, projects, teams or artifacts and
 * has this one member, and `IMPORT_ALREADY_USED` if it has already taken one. `fallback_membership_id` is the
 * caller. Writes the row, `auditAction` and `emit(ORGANIZATION_IMPORT_REQUESTED)`.
 */
export async function requestOrganizationImport(
  database: AppDatabase,
  context: TenantContext,
): Promise<OrganizationImportView> {
  // A service has no membership to hold what is not linked yet, so this is only ever a person.
  if (!can(context.role, 'organization.import')) throw new AppError('FORBIDDEN');
  try {
    return await withTenantTx(database, context, async (tx) => {
      const earlier = await tx
        .select({ status: organizationImports.status })
        .from(organizationImports);
      if (earlier.some(({ status }) => status !== 'failed')) {
        throw new AppError('IMPORT_ALREADY_USED');
      }
      const content = await countsOfContent(tx);
      const [startedBefore] = await tx
        .select({ path: organizationImportParts.path })
        .from(organizationImportParts)
        .limit(1);
      if (
        Object.values(content).some((count) => count > 0) ||
        (await countOf(tx, memberships)) !== 1 ||
        // A failed import that got partway is run again, so that nothing is taken in twice.
        startedBefore
      ) {
        throw new AppError('IMPORT_TARGET_NOT_EMPTY');
      }
      const [row] = await tx
        .insert(organizationImports)
        .values({
          organizationId: context.organizationId,
          requestedByMembershipId: context.membershipId,
          fallbackMembershipId: context.membershipId,
        })
        .returning();
      if (!row) throw new AppError('IMPORT_ALREADY_USED');
      await auditAction(tx, context, 'organization_import.requested', importTargetRef(row.id));
      await emit(tx, context, {
        eventType: ORGANIZATION_IMPORT_REQUESTED,
        aggregateType: AGGREGATE_ORGANIZATION_IMPORT,
        aggregateId: row.id,
        aggregateVersion: 1,
        classification: 'internal',
        payload: { import_id: row.id },
      });
      return toView(row);
    });
  } catch (error) {
    // Two owners asking at once: the partial unique index lets one through.
    if (pgCode(error) === '23505') throw new AppError('IMPORT_ALREADY_USED');
    throw error;
  }
}

export async function getOrganizationImport(
  database: AppDatabase,
  context: TenantContext,
  importId: string,
): Promise<OrganizationImportView> {
  requireImportRight(context);
  const id = idSchema.safeParse(importId);
  if (!id.success) throw new AppError('NOT_FOUND');
  const [row] = await withTenantTx(database, context, (tx) =>
    tx.select().from(organizationImports).where(eq(organizationImports.id, id.data)),
  );
  if (!row) throw new AppError('NOT_FOUND');
  return toView(row);
}

export type ArchiveReader = {
  totalBytes: number;
  readAt(offset: number, length: number): Promise<Buffer>;
};

export type ImportRunDeps = {
  sections: readonly PortabilitySection[];
  /**
   * The ledger this store holds. Anything the source organization's ledger says was deleted stays deleted,
   * even if the archive is older than the deletion. On another installation the source ledger is not there,
   * which the operator's guide states as a limit (ADR-030 D8).
   */
  ledger: Pick<LedgerReader, 'listPages' | 'get'>;
  /** Where a file's bytes go, under this organization's own key, before its row is written. */
  store: Pick<ObjectStore, 'put' | 'exists' | 'delete'>;
};

export type ImportRunResult = {
  status: 'completed' | 'completed_with_warnings' | 'failed';
  failureCode: ImportFailureCode | null;
  appliedCounts: Readonly<Record<string, number>>;
  warningCounts: Readonly<Partial<Record<ImportWarningCode, number>>>;
  /** With `WRONG_KEY`, the key this archive says it is for, which is a hash and safe to show. */
  archiveKeyId: string | null;
};

/** How an import stops. A code from the fixed list, so no text from an archive can reach a log or a page. */
class ImportFailure extends Error {
  override name = 'ImportFailure';
  constructor(
    readonly code: ImportFailureCode,
    readonly archiveKeyId: string | null = null,
  ) {
    super(code);
  }
}

/** What sealing adds around a part: a header of at most 4096 bytes, and a little more. */
const SEALED_OVERHEAD_BYTES = 8192;
const MAX_SEALED_PART_BYTES = MAX_PART_PLAINTEXT_BYTES + SEALED_OVERHEAD_BYTES;
/** A manifest grows with its parts, and one part's entry is under 512 bytes in the manifest's own schema. */
const MAX_SEALED_MANIFEST_BYTES = MAX_ARCHIVE_PARTS * 512 + SEALED_OVERHEAD_BYTES;
const ARCHIVE_HASH_CHUNK_BYTES = 4 * 1024 * 1024;
const KEY_ID = /^[0-9a-f]{32}$/;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

type ManifestPart = ExportManifest['parts'][number];

type OpenedArchive = {
  archive: ArchiveReader;
  key: KeyObject;
  keyId: string;
  manifest: ExportManifest;
  entries: ReadonlyMap<string, TarEntry>;
  sha256: string;
};

async function readBytes(archive: ArchiveReader, offset: number, length: number) {
  let bytes: Buffer;
  try {
    bytes = await archive.readAt(offset, length);
  } catch {
    throw new ImportFailure('ARCHIVE_UNREADABLE');
  }
  if (bytes.length !== length) throw new ImportFailure('ARCHIVE_UNREADABLE');
  return bytes;
}

/** Walks the tar and notes where each file is. A path that is not exactly one this format makes stops here. */
async function indexArchive(archive: ArchiveReader) {
  const entries = new Map<string, TarEntry>();
  try {
    const read = (offset: number, length: number) => readBytes(archive, offset, length);
    for await (const entry of readTarEntries(read, archive.totalBytes)) {
      if (!isArchivePath(entry.path)) throw new ImportFailure('PATH_REFUSED');
      if (entries.has(entry.path)) throw new ImportFailure('MANIFEST_INVALID');
      entries.set(entry.path, entry);
    }
  } catch (error) {
    // Anything else is the tar reader refusing it, which says no more than that.
    if (error instanceof ImportFailure) throw error;
    throw new ImportFailure('ARCHIVE_UNREADABLE');
  }
  return entries;
}

async function hashArchive(archive: ArchiveReader) {
  const hash = createHash('sha256');
  for (let at = 0; at < archive.totalBytes; at += ARCHIVE_HASH_CHUNK_BYTES) {
    const length = Math.min(ARCHIVE_HASH_CHUNK_BYTES, archive.totalBytes - at);
    hash.update(await readBytes(archive, at, length));
  }
  return hash.digest('hex');
}

/** The key's own short name, for comparing with what a sealed object says it is for. */
const idOfPrivateKey = (key: KeyObject) => recipientKeyId(createPublicKey(key));

/** What a hostile header says goes no further unless it has the shape of a key's name. */
function claimedRecipient(sealed: Buffer) {
  const id = sealedRecipientId(sealed);
  return id && KEY_ID.test(id) ? id : null;
}

function parseManifest(plain: Buffer): ExportManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(plain.toString('utf8'));
  } catch {
    throw new ImportFailure('MANIFEST_INVALID');
  }
  const fields = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  // Named on its own, so someone with an archive from a newer release is told that and not that it is damaged.
  if (
    fields.format === 'ensemus.organization_export' &&
    typeof fields.schema_version === 'number' &&
    fields.schema_version !== 1 &&
    fields.schema_version !== 2
  ) {
    throw new ImportFailure('FORMAT_NOT_SUPPORTED');
  }
  const parsed = exportManifestSchema.safeParse(raw);
  if (!parsed.success) throw new ImportFailure('MANIFEST_INVALID');
  if (parsed.data.schema_version === 2 && !matchesPortabilityInventory(parsed.data.inventory))
    throw new ImportFailure('FORMAT_NOT_SUPPORTED');
  return parsed.data;
}

/** The parts present have to be exactly the parts listed, before anything is believed about any of them. */
function assertPartsAreExact(entries: ReadonlyMap<string, TarEntry>, manifest: ExportManifest) {
  const listed = new Set<string>();
  for (const part of manifest.parts) {
    if (listed.has(part.path) || part.path === EXPORT_MANIFEST_PATH) {
      throw new ImportFailure('MANIFEST_INVALID');
    }
    if (!isArchivePath(part.path) || part.path.split('/')[0] !== part.section) {
      throw new ImportFailure('MANIFEST_INVALID');
    }
    listed.add(part.path);
  }
  for (const path of listed) if (!entries.has(path)) throw new ImportFailure('PART_MISSING');
  for (const path of entries.keys()) {
    if (path !== EXPORT_MANIFEST_PATH && !listed.has(path)) {
      throw new ImportFailure('MANIFEST_INVALID');
    }
  }
}

/** Steps 2 and 3 of the order below. Touches no database and no store. */
async function openArchive(archive: ArchiveReader, privateKeyPem: string): Promise<OpenedArchive> {
  const entries = await indexArchive(archive);
  const manifestEntry = entries.get(EXPORT_MANIFEST_PATH);
  if (!manifestEntry || manifestEntry.size > MAX_SEALED_MANIFEST_BYTES) {
    throw new ImportFailure('MANIFEST_INVALID');
  }
  const sealed = await readBytes(archive, manifestEntry.offset, manifestEntry.size);
  const claimed = claimedRecipient(sealed);
  let key: KeyObject;
  try {
    key = parseRecipientPrivateKey(privateKeyPem);
  } catch {
    // Node's words about a key stay here, whatever they might quote.
    throw new ImportFailure('WRONG_KEY', claimed);
  }
  const keyId = idOfPrivateKey(key);
  let plain: Buffer;
  try {
    plain = open(sealed, key);
  } catch (error) {
    if (error instanceof SealedRefused && error.code === 'WRONG_KEY_OR_DAMAGED') {
      if (claimed !== keyId) throw new ImportFailure('WRONG_KEY', claimed);
    }
    throw new ImportFailure('MANIFEST_INVALID');
  }
  const manifest = parseManifest(plain);
  if (manifest.encryption.recipient_key_id !== keyId) throw new ImportFailure('MANIFEST_INVALID');
  assertPartsAreExact(entries, manifest);
  return { archive, key, keyId, manifest, entries, sha256: await hashArchive(archive) };
}

/** Checks the sealed bytes against the manifest. Read again each time, so nothing rests on an earlier look. */
async function readSealedPart(opened: OpenedArchive, part: ManifestPart) {
  const entry = opened.entries.get(part.path);
  if (!entry) throw new ImportFailure('PART_MISSING');
  if (entry.size !== part.sealed_bytes || entry.size > MAX_SEALED_PART_BYTES) {
    throw new ImportFailure('PART_CHANGED');
  }
  const sealed = await readBytes(opened.archive, entry.offset, entry.size);
  if (sha256(sealed) !== part.sealed_sha256) throw new ImportFailure('PART_CHANGED');
  return sealed;
}

/** The sealed hash, then opening it, then the plain hash, in that order. */
async function readPart(opened: OpenedArchive, part: ManifestPart) {
  const sealed = await readSealedPart(opened, part);
  let plain: Buffer;
  try {
    plain = open(sealed, opened.key);
  } catch {
    const claimed = claimedRecipient(sealed);
    if (claimed !== opened.keyId) throw new ImportFailure('WRONG_KEY', claimed);
    throw new ImportFailure('PART_CHANGED');
  }
  if (plain.length > MAX_PART_PLAINTEXT_BYTES || sha256(plain) !== part.plaintext_sha256) {
    throw new ImportFailure('PART_CHANGED');
  }
  return plain;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** One part's lines as JSON, in bounds, with as many as the manifest says. Nothing here looks inside yet. */
function readLines(plain: Buffer, part: ManifestPart): unknown[] {
  const lines: unknown[] = [];
  let start = 0;
  while (start < plain.length) {
    const found = plain.indexOf(0x0a, start);
    const end = found === -1 ? plain.length : found;
    if (end - start > MAX_RECORD_BYTES || end === start) throw new RecordRefused();
    if (lines.length >= MAX_RECORDS_PER_PART) throw new RecordRefused();
    try {
      lines.push(JSON.parse(UTF8.decode(plain.subarray(start, end))));
    } catch {
      throw new RecordRefused();
    }
    start = end + 1;
  }
  if (lines.length !== part.records) throw new RecordRefused();
  return lines;
}

const isArtifactBytes = (part: ManifestPart) => part.path.endsWith('.bin.sealed');
const tombstoneKey = (targetType: string, targetId: string) =>
  `${targetType}/${canonicalId(targetId)}`;

const CORE_SECTIONS: ReadonlySet<string> = new Set<CoreExportSection>([
  'organizations',
  'people',
  'clients',
  'projects',
  'work',
  'relations',
  'artifacts',
  'history',
  'connections',
  'tombstones',
  'audit-redacted',
]);

/** The core sections' records, each through its schema and its section's rule, all of a kind. */
function validateCorePart(section: CoreExportSection, lines: readonly unknown[]) {
  const records = lines.map((line) => validateCoreRecord(section, line));
  const [first] = records;
  if (first && records.some((record) => record.kind !== first.kind)) throw new RecordRefused();
  return records;
}

function validatePart(section: string, lines: readonly unknown[]) {
  const records = lines.map((raw) => {
    try {
      const core = coreRecordSchema.safeParse(raw);
      return core.success
        ? validateCoreRecord(section as CoreExportSection, raw)
        : validatePortableRecord(section, raw);
    } catch {
      throw new RecordRefused();
    }
  });
  if (records.some((record) => record.kind !== records[0]?.kind)) throw new RecordRefused();
  return records;
}

type TombstoneSet = Map<
  string,
  { targetType: string; targetId: string; deletedAt: Date; onlyInLedger?: true }
>;

/** Every tombstone the archive holds, which the rest of the checks and the whole import depend on. */
async function readArchiveTombstones(opened: OpenedArchive) {
  const found: TombstoneSet = new Map();
  for (const part of opened.manifest.parts) {
    if (part.section !== 'tombstones') continue;
    const lines = readLines(await readPart(opened, part), part);
    for (const record of validateCorePart('tombstones', lines)) {
      if (record.kind !== 'tombstone') throw new RecordRefused();
      found.set(tombstoneKey(record.target_type, record.target_id), {
        targetType: record.target_type,
        targetId: record.target_id,
        deletedAt: new Date(record.deleted_at),
      });
    }
  }
  return found;
}

/**
 * Looks at every part before anything is written, so damage anywhere in an archive leaves the organization as
 * it was. A file that was deleted is not opened at all, even here. One part at a time, so a worker holds at
 * most one. A section nobody here implements has its hashes checked, and that section reports on its own.
 */
async function verifyEveryPart(opened: OpenedArchive, tombstoned: TombstoneSet) {
  const bytesParts = new Map<string, ManifestPart>();
  for (const part of opened.manifest.parts) {
    if (isArtifactBytes(part)) bytesParts.set(part.path, part);
  }
  for (const part of opened.manifest.parts) {
    if (part.section === 'tombstones') continue;
    if (isArtifactBytes(part)) {
      const artifactId = part.path.slice(part.section.length + 1, -'.bin.sealed'.length);
      if (tombstoned.has(tombstoneKey('artifact', artifactId))) {
        await readSealedPart(opened, part);
      } else {
        await readPart(opened, part);
      }
      continue;
    }
    const lines = readLines(await readPart(opened, part), part);
    for (const record of validatePart(part.section, lines)) {
      if (coreRecordSchema.safeParse(record).success)
        assertArtifactFacts(record as CoreRecord, bytesParts);
      if (record.kind === 'knowledge_document') {
        const bytes = bytesParts.get(knowledgePartPath(record.id));
        if (!bytes || bytes.plaintext_sha256 !== record.content_sha256)
          throw new ImportFailure('PART_CHANGED');
      }
    }
  }
}

/** A file's record has to agree with the bytes listed for it. The bytes were hashed against the manifest. */
function assertArtifactFacts(record: CoreRecord, bytesParts: ReadonlyMap<string, ManifestPart>) {
  if (record.kind !== 'artifact') return;
  if (record.size_bytes > MAX_FILE_BYTES) throw new RecordRefused();
  const part = bytesParts.get(artifactPartPath(record.id));
  if (part && part.plaintext_sha256 !== record.sha256) throw new ImportFailure('PART_CHANGED');
}

/**
 * What can be said about an archive without a database or a store: is it readable, does its manifest hold, do
 * its parts match it, and does each record pass. `runOrganizationImport` does this before it writes anything.
 * Exposed so that a hostile archive can be tested on its own, and it only ever answers with a named failure.
 */
export async function inspectOrganizationArchive(
  archive: ArchiveReader,
  recipientPrivateKeyPem: string,
): Promise<
  | { ok: true; manifest: ExportManifest }
  | { ok: false; code: ImportFailureCode; archiveKeyId: string | null }
> {
  try {
    const opened = await openArchive(archive, recipientPrivateKeyPem);
    await verifyEveryPart(opened, await readArchiveTombstones(opened));
    return { ok: true, manifest: opened.manifest };
  } catch (error) {
    const failure = namedFailure(error);
    return { ok: false, code: failure.code, archiveKeyId: failure.archiveKeyId };
  }
}

/**
 * Everything that goes wrong becomes one of the fixed codes. Bad data is the archive's fault, however far in it
 * was found: a database refusing a value is that too. Anything else, such as a connection going away, is an
 * outage, and running it again is safe.
 */
function namedFailure(error: unknown): ImportFailure {
  if (error instanceof ImportFailure) return error;
  if (error instanceof RecordRefused) return new ImportFailure('RECORD_REFUSED');
  const code = pgCode(error);
  if (code && /^(22|23|EN)/.test(code)) return new ImportFailure('RECORD_REFUSED');
  if (error instanceof AppError) return new ImportFailure('RECORD_REFUSED');
  return new ImportFailure('STORE_UNAVAILABLE');
}

/**
 * The order things go in, and not quite `CORE_EXPORT_SECTIONS`: tombstones come first, so that nothing deleted
 * is ever written, and files before links, because a link to a file has to find its file.
 */
const SECTION_ORDER: readonly ExportSection[] = [
  'tombstones',
  'organizations',
  'people',
  'clients',
  'projects',
  'work',
  'artifacts',
  'relations',
  'history',
  'connections',
  'audit-redacted',
  ...EXPORT_SECTIONS.filter((section) => !CORE_SECTIONS.has(section)),
];

/** Inside a section, things before links to them, whatever order their names sort in. */
const KIND_ORDER = [
  'organization',
  'person',
  'team',
  'team_membership',
  'client',
  'project',
  'work_unit',
  'work_dependency',
  'work_assignment',
  'artifact',
  'work_artifact',
  'service_identity',
  'agent_definition',
  'agent_version',
  'model_profile',
  'rate_card',
  'agent_run',
  'execution_step',
  'agent_assignment',
  'budget',
  'usage_entry',
  'policy_definition',
  'external_resource',
  'external_acl',
  'mcp_definition',
  'client_reader',
  'knowledge_source',
  'source_grant',
  'knowledge_document',
  'embedding_space',
  'fact_definition',
  'fact_evidence',
  'graph_edge',
  'artifact_citation',
];

const recordKindOf = (path: string) =>
  /\/([a-z_]+)-\d{6}\.jsonl\.sealed$/.exec(path)?.[1] ?? 'records';

function kindRank(path: string) {
  const name = recordKindOf(path);
  const singular = KIND_ORDER.includes(name)
    ? name
    : name === 'people'
      ? 'person'
      : name.replace(/ies$/, 'y').replace(/s$/, '');
  const rank = KIND_ORDER.indexOf(singular);
  return rank === -1 ? KIND_ORDER.length : rank;
}

/** Record parts in the order to apply them. A file's bytes are applied with its record, and never by path. */
function partsInOrder(manifest: ExportManifest) {
  const sectionRank = (section: string) => {
    const rank = SECTION_ORDER.indexOf(section as ExportSection);
    return rank === -1 ? SECTION_ORDER.length : rank;
  };
  return manifest.parts
    .filter((part) => !isArtifactBytes(part))
    .sort(
      (a, b) =>
        sectionRank(a.section) - sectionRank(b.section) ||
        kindRank(a.path) - kindRank(b.path) ||
        a.path.localeCompare(b.path),
    );
}

type RunState = {
  row: ImportRow;
  done: Set<string>;
  applied: Record<string, number>;
  warnings: WarningCounts;
};

const addWarnings = (into: WarningCounts, more: WarningCounts | undefined) => {
  for (const [code, count] of Object.entries(more ?? {})) {
    const key = code as ImportWarningCode;
    into[key] = (into[key] ?? 0) + (count ?? 0);
  }
};
const totalOf = (warnings: WarningCounts) =>
  Object.values(warnings).reduce<number>((sum, count) => sum + (count ?? 0), 0);

/** Step 1: only one process gets to run this, and only from `requested` or `failed`. */
function claimImport(database: AppDatabase, context: TenantContext, importId: string) {
  return withTenantTx(database, context, async (tx): Promise<RunState> => {
    const [row] = await tx
      .select()
      .from(organizationImports)
      .where(eq(organizationImports.id, importId))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (row.status !== 'requested' && row.status !== 'failed') {
      throw new AppError('INVALID_STATE');
    }
    await tx
      .update(organizationImports)
      .set({
        status: 'running',
        failureCode: null,
        finishedAt: null,
        startedAt: new Date(),
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(organizationImports.id, importId));
    const finished = await tx
      .select({ path: organizationImportParts.path })
      .from(organizationImportParts)
      .where(eq(organizationImportParts.importId, importId));
    return {
      row,
      done: new Set(finished.map(({ path }) => path)),
      applied: { ...(row.appliedCounts as Record<string, number>) },
      warnings: { ...(row.warningCounts as WarningCounts) },
    };
  });
}

/**
 * Checked again here, since time has passed since it was asked for. Whatever this import has itself taken in is
 * allowed for, and nothing else, so a run after a failure still refuses anyone else's work in between.
 */
async function assertStillEmpty(database: AppDatabase, context: TenantContext, state: RunState) {
  const fits = await withTenantTx(database, context, async (tx) => {
    const content = await countsOfContent(tx, state.row.id);
    // Fewer is fine: the ledger may have taken something back out since.
    const only = Object.entries(content).every(
      ([kind, count]) => count <= (kind === 'knowledge_document' ? 0 : (state.applied[kind] ?? 0)),
    );
    return only && (state.done.size > 0 || (await countOf(tx, memberships)) === 1);
  });
  if (!fits) throw new ImportFailure('TARGET_NOT_EMPTY');
}

/** A run after a failure carries on with the same archive, or it would be merging two of them. */
function assertSameArchive(opened: OpenedArchive, state: RunState) {
  if (state.done.size === 0) return;
  if (
    state.row.archiveSha256 !== opened.sha256 ||
    state.row.sourceExportId !== opened.manifest.export_id
  ) {
    throw new ImportFailure('TARGET_NOT_EMPTY');
  }
}

/**
 * What the source's own ledger knows, if this store has it. Reading it failing stops the import, since going on
 * would be guessing that nothing was deleted. Trust leans the safe way here: a key that names a target keeps
 * that target out even if its body will not read, and all that costs is a warning someone can look into.
 */
async function readSourceLedger(
  ledger: ImportRunDeps['ledger'],
  sourceOrganizationId: string,
  tombstoned: TombstoneSet,
) {
  try {
    for await (const page of ledger.listPages(ledgerPrefixFor(sourceOrganizationId))) {
      for (const key of page) {
        const named = parseLedgerKey(key);
        if (!named || named.organizationId !== sourceOrganizationId) continue;
        const entry = parseLedgerEntry(key, (await ledger.get(key)).toString('utf8'));
        const id = tombstoneKey(named.targetType, named.targetId);
        if (tombstoned.has(id)) continue;
        tombstoned.set(id, {
          targetType: named.targetType,
          targetId: named.targetId,
          deletedAt: entry?.deletedAt ?? new Date(),
          onlyInLedger: true,
        });
      }
    }
  } catch {
    throw new ImportFailure('STORE_UNAVAILABLE');
  }
}

const LEDGER_BATCH = 200;

/**
 * Writes what the source's ledger knew and the archive did not. On a run after a failure the ledger may have
 * grown, so anything already taken in that any tombstone now names is taken back out, bytes and row.
 */
async function applyLedgerTombstones(
  database: AppDatabase,
  context: TenantContext,
  store: ImportRunDeps['store'],
  tombstoned: TombstoneSet,
  isRerun: boolean,
) {
  const all = [...tombstoned.values()];
  const onlyInLedger = all.filter((tombstone) => tombstone.onlyInLedger);
  for (let at = 0; at < onlyInLedger.length; at += LEDGER_BATCH) {
    const batch = onlyInLedger.slice(at, at + LEDGER_BATCH);
    await withTenantTx(database, context, async (tx) => {
      for (const tombstone of batch) await recordImportedTombstone(tx, context, tombstone);
    });
  }
  if (!isRerun) return;
  for (const { targetType, targetId } of all) {
    if (targetType !== 'artifact') continue;
    await withTenantTx(database, context, (tx) =>
      tx.delete(artifacts).where(eq(artifacts.id, targetId)),
    );
    const key = objectKey(context.organizationId, targetId);
    try {
      if (await store.exists(key)) await store.delete(key);
    } catch {
      throw new ImportFailure('STORE_UNAVAILABLE');
    }
  }
}

const UPLOAD_GRACE_MS = 60 * 60 * 1000;

/**
 * Puts one page of files' bytes in the store, and says which records go on to get rows. The same two steps
 * `addArtifact` takes: a row saying bytes are arriving, so a crash cannot strand them, then the bytes, and later
 * the artifact's own row. No transaction stays open while the store is being called.
 */
async function storeArtifactBytes(
  opened: OpenedArchive,
  database: AppDatabase,
  context: TenantContext,
  store: ImportRunDeps['store'],
  lines: readonly unknown[],
  tombstoned: TombstoneSet,
  bytesParts: ReadonlyMap<string, ManifestPart>,
) {
  const keep: unknown[] = [];
  const finishedPaths: ManifestPart[] = [];
  const warnings: WarningCounts = {};
  for (const line of lines) {
    const record = validateCoreRecord('artifacts', line);
    if (record.kind !== 'artifact') {
      keep.push(line);
      continue;
    }
    const part = bytesParts.get(artifactPartPath(record.id));
    if (tombstoned.has(tombstoneKey('artifact', record.id))) {
      keep.push(line);
      if (part) finishedPaths.push(part);
      continue;
    }
    if (!part) {
      addWarnings(warnings, { BYTES_MISSING: 1 });
      continue;
    }
    const plain = await readPart(opened, part);
    if (sha256(plain) !== record.sha256 || plain.length !== record.size_bytes) {
      throw new ImportFailure('PART_CHANGED');
    }
    const key = objectKey(context.organizationId, record.id);
    await withTenantTx(database, context, (tx) =>
      tx
        .insert(blobLifecycle)
        .values({
          organizationId: context.organizationId,
          artifactId: record.id,
          objectKey: key,
          state: 'uploading',
          purgeAfter: new Date(Date.now() + UPLOAD_GRACE_MS),
        })
        .onConflictDoNothing(),
    );
    try {
      await store.put(key, plain, record.mime_type);
    } catch {
      throw new ImportFailure('STORE_UNAVAILABLE');
    }
    keep.push(line);
    finishedPaths.push(part);
  }
  return { keep, finishedPaths, warnings };
}

const loadPeople = async (database: AppDatabase, context: TenantContext) =>
  new Map(
    (
      await withTenantTx(database, context, (tx) =>
        tx
          .select({
            source: importedPeople.sourceMembershipId,
            target: importedPeople.targetMembershipId,
          })
          .from(importedPeople),
      )
    ).map(({ source, target }) => [source, target]),
  );

async function saveProgress(tx: Tx, state: RunState, applied: object, warnings: object) {
  await tx
    .update(organizationImports)
    .set({ appliedCounts: applied, warningCounts: warnings, updatedAt: new Date() })
    .where(eq(organizationImports.id, state.row.id));
}

/** Step 5. Each page and its part row are one transaction, so a run after a failure skips what finished. */
async function applyParts(
  opened: OpenedArchive,
  database: AppDatabase,
  context: TenantContext,
  deps: ImportRunDeps,
  state: RunState,
  tombstoned: TombstoneSet,
) {
  const implemented = new Map(deps.sections.map((section) => [section.section as string, section]));
  const bytesParts = new Map(
    opened.manifest.parts.filter(isArtifactBytes).map((part) => [part.path, part]),
  );
  const ordered = partsInOrder(opened.manifest);
  const { row } = state;
  const insertPart = (tx: Tx, part: ManifestPart, recordCount: number, warningCount: number) =>
    tx
      .insert(organizationImportParts)
      .values({
        organizationId: context.organizationId,
        importId: row.id,
        path: part.path,
        section: part.section,
        recordCount,
        warningCount,
      })
      .onConflictDoNothing();

  const applyOne = async (part: ManifestPart, people: Map<string, string | null>) => {
    const section = implemented.get(part.section);
    const warnings: WarningCounts = {};
    if (!section) {
      throw new ImportFailure('FORMAT_NOT_SUPPORTED');
    }
    const lines = readLines(await readPart(opened, part), part);
    let records: readonly unknown[] = lines;
    let filesFinished: readonly ManifestPart[] = [];
    if (part.section === 'artifacts') {
      const stored = await storeArtifactBytes(
        opened,
        database,
        context,
        deps.store,
        lines,
        tombstoned,
        bytesParts,
      );
      records = stored.keep;
      filesFinished = stored.finishedPaths;
      addWarnings(warnings, stored.warnings);
    }
    const scope: ImportScope = {
      importId: row.id,
      membershipFor(source) {
        const target = people.get(canonicalId(source));
        if (target) return target;
        addWarnings(warnings, { PERSON_NOT_LINKED: 1 });
        // Someone the archive never listed is a foreign ID, and is said so as well.
        if (target === undefined) addWarnings(warnings, { RELATION_DANGLING: 1 });
        return row.fallbackMembershipId;
      },
      isTombstoned: (targetType, targetId) => tombstoned.has(tombstoneKey(targetType, targetId)),
    };
    if (part.section === 'knowledge') {
      const stored = await storeKnowledgeBytes(
        opened,
        database,
        context,
        deps.store,
        records,
        tombstoned,
        bytesParts,
        scope,
      );
      records = stored.keep;
      filesFinished = stored.finishedPaths;
      addWarnings(warnings, stored.warnings);
    }
    const kind = (lines[0] as { kind?: unknown } | undefined)?.kind;
    const countKey = typeof kind === 'string' ? kind : part.section;
    const nextApplied = { ...state.applied };
    const nextWarnings = { ...state.warnings };
    await withTenantTx(database, context, async (tx) => {
      const page = await section.importPage(tx, context, scope, {
        recordKind: recordKindOf(part.path),
        records,
      });
      addWarnings(warnings, page.warnings);
      nextApplied[countKey] = (nextApplied[countKey] ?? 0) + page.applied;
      addWarnings(nextWarnings, warnings);
      await insertPart(tx, part, page.applied, totalOf(warnings));
      for (const file of filesFinished) await insertPart(tx, file, 1, 0);
      await saveProgress(tx, state, nextApplied, nextWarnings);
    });
    state.applied = nextApplied;
    state.warnings = nextWarnings;
    state.done.add(part.path);
    for (const file of filesFinished) state.done.add(file.path);
    if (kind === 'person') {
      const fresh = await loadPeople(database, context);
      people.clear();
      for (const [source, target] of fresh) people.set(source, target);
    }
  };

  const isRerun = state.done.size > 0;
  const people = await loadPeople(database, context);
  const tombstoneParts = ordered.filter((part) => part.section === 'tombstones');
  for (const part of tombstoneParts) {
    if (!state.done.has(part.path)) await applyOne(part, people);
  }
  await applyLedgerTombstones(database, context, deps.store, tombstoned, isRerun);
  for (const part of ordered) {
    if (part.section !== 'tombstones' && !state.done.has(part.path)) await applyOne(part, people);
  }

  // Bytes no record asked for. They were never opened past their hashes, and go no further.
  const orphans = [...bytesParts.values()].filter((part) => !state.done.has(part.path));
  if (orphans.length > 0) {
    const next = { ...state.warnings };
    addWarnings(next, { RELATION_DANGLING: orphans.length });
    await withTenantTx(database, context, async (tx) => {
      for (const part of orphans) await insertPart(tx, part, 0, 1);
      await saveProgress(tx, state, state.applied, next);
    });
    state.warnings = next;
  }
}

/** Reserve the exact document/writer before any store call. A crashed or unknown writer must be
 * positively fenced by the knowledge recovery adapter; neither a lease nor an absent HEAD clears it. */
async function storeKnowledgeBytes(
  opened: OpenedArchive,
  database: AppDatabase,
  context: TenantContext,
  store: Pick<ObjectStore, 'put' | 'delete' | 'exists'> & Partial<Pick<ObjectStore, 'get'>>,
  raw: readonly unknown[],
  tombstoned: TombstoneSet,
  parts: ReadonlyMap<string, ManifestPart>,
  scope: ImportScope,
) {
  const keep: unknown[] = [],
    finishedPaths: ManifestPart[] = [];
  const warnings: WarningCounts = {};
  for (const value of raw) {
    const record = validatePortableRecord('knowledge', value);
    if (record.kind !== 'knowledge_document') {
      keep.push(record);
      continue;
    }
    const part = parts.get(knowledgePartPath(record.id));
    if (!part) throw new ImportFailure('PART_MISSING');
    if (
      tombstoned.has(tombstoneKey('knowledge_source', record.source_id)) ||
      tombstoned.has(tombstoneKey('knowledge_document', record.id))
    ) {
      addWarnings(warnings, { TOMBSTONED_SKIPPED: 1 });
      finishedPaths.push(part);
      continue;
    }
    const token = randomUUID();
    const key = `${context.organizationId}/knowledge/${record.id}`;
    const reservation = await withTenantTx(database, context, async (tx) => {
      const [source] = await queryRows<{ id: string; state: string; classification: string }>(
        tx,
        sql`select id,state,classification
        from knowledge.sources where organization_id=${context.organizationId}::uuid and id=${record.source_id}::uuid
        and kind='upload' for update`,
      );
      if (!source) return 'provider' as const;
      if (source.state !== 'active' || source.classification === 'restricted')
        throw new RecordRefused();
      await quarantinePortableRecord(tx, context, scope, record);
      const [existing] = await queryRows<{ state: string; content_sha256: string }>(
        tx,
        sql`select state,content_sha256
        from knowledge.documents where organization_id=${context.organizationId}::uuid and id=${record.id}::uuid for update`,
      );
      const [writer] = await queryRows<{ state: string }>(
        tx,
        sql`select state from knowledge.object_writers
        where organization_id=${context.organizationId}::uuid and document_id=${record.id}::uuid for update`,
      );
      if (
        existing?.content_sha256 !== undefined &&
        existing.content_sha256 !== record.content_sha256
      )
        throw new RecordRefused();
      if (writer?.state === 'active') throw new RecordRefused();
      if (existing) {
        if (writer?.state !== 'settled') throw new RecordRefused();
        return 'already' as const;
      }
      await tx.execute(sql`insert into knowledge.documents(organization_id,id,source_id,version_no,title,
        content_sha256,size_bytes,media_type,object_key,classification,state,superseded_at,created_at,source_version)
        values(${context.organizationId}::uuid,${record.id}::uuid,${record.source_id}::uuid,${record.version_no},${record.title},
          ${record.content_sha256},${record.size_bytes},${record.media_type},${key},${record.classification},
          ${record.superseded_at ? 'failed' : 'received'},${record.superseded_at}::timestamptz,${record.created_at}::timestamptz,${record.source_version})`);
      await tx.execute(sql`insert into knowledge.object_writers(organization_id,document_id,source_id,generation,write_id,state)
        values(${context.organizationId}::uuid,${record.id}::uuid,${record.source_id}::uuid,1,${token}::uuid,'active')`);
      return 'write' as const;
    });
    if (reservation === 'provider') {
      keep.push(record);
      finishedPaths.push(part);
      addWarnings(warnings, { PROVIDER_RECONNECTION_REQUIRED: 1 });
      continue;
    }
    const bytes = await readPart(opened, part);
    if (bytes.length !== record.size_bytes || sha256(bytes) !== record.content_sha256)
      throw new ImportFailure('PART_CHANGED');
    if (reservation === 'already') {
      if (!store.get) throw new RecordRefused();
      const existing = await store.get(key);
      if (existing.length !== record.size_bytes || sha256(existing) !== record.content_sha256)
        throw new ImportFailure('PART_CHANGED');
    } else {
      await store.put(key, bytes, record.media_type);
      await withTenantTx(database, context, async (tx) => {
        const [source] = await queryRows<{ state: string }>(
          tx,
          sql`select state from knowledge.sources
          where organization_id=${context.organizationId}::uuid and id=${record.source_id}::uuid for update`,
        );
        if (source?.state !== 'active') throw new RecordRefused();
        const settled = await tx.execute(sql`update knowledge.object_writers set state='settled'
          where organization_id=${context.organizationId}::uuid and document_id=${record.id}::uuid
          and write_id=${token}::uuid and generation=1 and state='active' returning document_id`);
        if (settled.rows.length !== 1) throw new RecordRefused();
      });
    }
    keep.push(record);
    finishedPaths.push(part);
    addWarnings(warnings, { SOURCE_REQUIRES_REINGEST: 1 });
  }
  return { keep, finishedPaths, warnings };
}

/** Step 6. Facts only, and nothing starts from them. */
async function settle(
  database: AppDatabase,
  context: TenantContext,
  state: RunState,
  status: ImportRunResult['status'],
  failureCode: ImportFailureCode | null,
) {
  const importId = state.row.id;
  await withTenantTx(database, context, async (tx) => {
    const [current] = await tx
      .select({ version: organizationImports.version })
      .from(organizationImports)
      .where(eq(organizationImports.id, importId))
      .for('update');
    const version = (current?.version ?? state.row.version) + 1;
    await tx
      .update(organizationImports)
      .set({
        status,
        failureCode,
        appliedCounts: state.applied,
        warningCounts: state.warnings,
        finishedAt: new Date(),
        updatedAt: new Date(),
        version,
      })
      .where(eq(organizationImports.id, importId));
    await emit(tx, context, {
      eventType: ORGANIZATION_IMPORT_FINISHED,
      aggregateType: AGGREGATE_ORGANIZATION_IMPORT,
      aggregateId: importId,
      aggregateVersion: version,
      classification: 'internal',
      payload: { import_id: importId, status, failure_code: failureCode },
    });
    await auditAction(
      tx,
      context,
      'organization_import.finished',
      importTargetRef(importId),
      failureCode ?? status.toUpperCase(),
    );
    await notify(
      tx,
      context,
      [state.row.requestedByMembershipId],
      NOTIFY_IMPORT_FINISHED,
      importTargetRef(importId),
    );
  });
}

/**
 * The whole import, run by the operator's command with a service context. The order is what makes it safe:
 *
 * 1. Refuse unless the row is `requested` or `failed`, and unless the organization is still empty.
 * 2. Walk the tar, refusing a path `isArchivePath` refuses. Open the manifest first, and check its schema,
 *    its `schema_version`, and that the archive's parts are exactly its parts.
 * 3. Check each part's sealed hash, then open it, then check its plain hash, and each record against its
 *    schema, all before anything is written. A part is checked again when it is applied.
 * 4. Read `tombstones` first, along with what the source's ledger knows. Then the rest in `SECTION_ORDER`,
 *    each page in one tenant transaction that also writes its `organization_import_parts` row.
 * 5. Skip a tombstoned artifact entirely, and add the tombstone with `tombstone.recorded` so the new
 *    organization's ledger holds it too.
 * 6. Finish with counts and warnings, and notify whoever asked.
 *
 * No record's own fields can name a tenant, and nothing is started: no workflow, no event a workflow listens
 * to, no pending approval and no connection with a credential. The private key is used to open things and
 * goes nowhere else: not to a log, an error or a row. A failure is a code in the result, and only a refusal to
 * begin at all (no right, no such import, or one not in a state to run) is thrown, before the archive is read.
 */
export async function runOrganizationImport(
  database: AppDatabase,
  context: TenantContext,
  input: {
    importId: string;
    archive: ArchiveReader;
    /** PEM, read from the operator's own mounted file. Never logged, stored or passed on. */
    recipientPrivateKeyPem: string;
  },
  deps: ImportRunDeps,
): Promise<ImportRunResult> {
  requireImportRight(context);
  const id = idSchema.safeParse(input.importId);
  if (!id.success) throw new AppError('NOT_FOUND');
  const state = await claimImport(database, context, id.data);
  try {
    await assertStillEmpty(database, context, state);
    const opened = await openArchive(input.archive, input.recipientPrivateKeyPem);
    assertSameArchive(opened, state);
    const { manifest } = opened;
    if (manifest.schema_version === 2) {
      try {
        assertPortabilitySections(deps.sections.map((section) => section.section));
      } catch {
        throw new ImportFailure('FORMAT_NOT_SUPPORTED');
      }
      await withTenantTx(database, context, assertJoinedPortabilitySchema);
    } else state.warnings.CORE_ONLY_ARCHIVE = 1;
    const tombstoned = await readArchiveTombstones(opened);
    await readSourceLedger(deps.ledger, manifest.organization_id, tombstoned);
    await verifyEveryPart(opened, tombstoned);

    await withTenantTx(database, context, (tx) =>
      tx
        .update(organizationImports)
        .set({
          sourceOrganizationId: manifest.organization_id,
          sourceExportId: manifest.export_id,
          sourceRelease: manifest.source_release,
          archiveSha256: opened.sha256,
          exportedAt: new Date(manifest.exported_at),
          updatedAt: new Date(),
        })
        .where(eq(organizationImports.id, state.row.id)),
    );

    await applyParts(opened, database, context, deps, state, tombstoned);

    // Set rather than added, since this is a fact about the archive and a re-run must not count it twice.
    const excluded =
      manifest.excluded.restricted_work +
      manifest.excluded.restricted_artifacts +
      manifest.excluded.restricted_clients;
    if (excluded > 0) state.warnings.RESTRICTED_EXCLUDED_AT_SOURCE = excluded;

    const status = totalOf(state.warnings) > 0 ? 'completed_with_warnings' : 'completed';
    await settle(database, context, state, status, null);
    return {
      status,
      failureCode: null,
      appliedCounts: state.applied,
      warningCounts: state.warnings,
      archiveKeyId: null,
    };
  } catch (error) {
    const failure = namedFailure(error);
    // If even this cannot be written, the operator still gets the answer, and `--interrupted` clears the row.
    await settle(database, context, state, 'failed', failure.code).catch(() => undefined);
    return {
      status: 'failed',
      failureCode: failure.code,
      appliedCounts: state.applied,
      warningCounts: state.warnings,
      archiveKeyId: failure.archiveKeyId,
    };
  }
}

/**
 * An operator saying that the process running this import has died, which only they can know: power went, or it
 * was killed. Moves it from `running` to `failed` with no code, because nothing was found wrong, so it can be
 * run again. Refuses anything else. Running two at once is what the row's status prevents, so this is not to be
 * said while one is still going.
 */
export async function markOrganizationImportInterrupted(
  database: AppDatabase,
  context: TenantContext,
  importId: string,
): Promise<OrganizationImportView> {
  requireImportRight(context);
  const id = idSchema.safeParse(importId);
  if (!id.success) throw new AppError('NOT_FOUND');
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(organizationImports)
      .where(eq(organizationImports.id, id.data))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (row.status !== 'running') throw new AppError('INVALID_STATE');
    const [updated] = await tx
      .update(organizationImports)
      .set({ status: 'failed', version: row.version + 1, updatedAt: new Date() })
      .where(eq(organizationImports.id, id.data))
      .returning();
    await auditAction(
      tx,
      context,
      'organization_import.interrupted',
      importTargetRef(id.data),
      'OPERATOR_SAID_INTERRUPTED',
    );
    return toView(updated as ImportRow);
  });
}

export type ImportedPersonView = {
  sourceMembershipId: string;
  displayName: string;
  email: string;
  sourceRole: 'owner' | 'admin' | 'member';
  targetMembershipId: string | null;
  linkedAt: Date | null;
};

type PersonRow = typeof importedPeople.$inferSelect;

const toPersonView = (row: PersonRow): ImportedPersonView => ({
  sourceMembershipId: row.sourceMembershipId,
  displayName: row.displayName,
  email: row.email,
  sourceRole: row.sourceRole as ImportedPersonView['sourceRole'],
  targetMembershipId: row.targetMembershipId,
  linkedAt: row.linkedAt,
});

/** Needs `organization.import`, since this is personal data about people not necessarily here yet. */
export async function listImportedPeople(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly ImportedPersonView[]> {
  requireImportRight(context);
  const rows = await withTenantTx(database, context, (tx) =>
    tx.select().from(importedPeople).orderBy(importedPeople.displayName),
  );
  return rows.map(toPersonView);
}

/** How many times to look again when someone else moved the work in the moment between looking and moving. */
const MOVE_ATTEMPTS = 3;

/**
 * Moves one thing this person had, as reassigning it by hand would. Work somebody has moved since is theirs to
 * have moved, and is left alone, and so is anything the caller may not touch: this does not get around
 * `canManageWork`, and the link holds whether or not everything could be moved.
 */
async function moveWorkToLinked(
  database: AppDatabase,
  context: TenantContext,
  holding: ImportHolding,
  fallback: string,
  membershipId: string,
) {
  for (let attempt = 0; attempt < MOVE_ATTEMPTS; attempt += 1) {
    const [work] = await withTenantTx(database, context, (tx) =>
      tx
        .select({ owner: workUnits.ownerMembershipId, version: workUnits.version })
        .from(workUnits)
        .where(eq(workUnits.id, holding.target_id)),
    );
    if (!work || work.owner !== fallback || work.owner === membershipId) return;
    try {
      await setOwner(database, context, {
        id: holding.target_id,
        expectedVersion: work.version,
        ownerMembershipId: membershipId,
      });
      return;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.code === 'VERSION_CONFLICT') continue;
      if (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND') return;
      throw error;
    }
  }
}

/**
 * Puts them on work they were on. This differs from `assignContributor` in one way: it also covers finished
 * work, because this is not someone new joining. It is keeping what was already true, and without it they could
 * not read confidential work they did at the source. Every other rule and record is the same.
 */
async function assignToLinked(
  database: AppDatabase,
  context: TenantContext,
  holding: ImportHolding,
  membershipId: string,
) {
  const responsibility = holding.responsibility === 'reviewer' ? 'reviewer' : 'contributor';
  try {
    await withTenantTx(database, context, async (tx) => {
      const work = await loadChangeable(tx, context, holding.target_id);
      const onIt = await tx
        .select({ id: workAssignments.membershipId })
        .from(workAssignments)
        .where(
          and(
            eq(workAssignments.workUnitId, work.id),
            eq(workAssignments.membershipId, context.membershipId),
          ),
        );
      const facts = {
        classification: work.classification as Classification,
        ownerMembershipId: work.ownerMembershipId,
        isAssigned: onIt.length > 0,
      };
      if (
        context.actorType !== 'service' &&
        !canManageWork(facts, { membershipId: context.membershipId, role: context.role })
      ) {
        throw new AppError('FORBIDDEN');
      }
      const added = await tx
        .insert(workAssignments)
        .values({
          organizationId: context.organizationId,
          workUnitId: work.id,
          membershipId,
          responsibility,
          actorType: 'human',
        })
        .onConflictDoNothing()
        .returning({ id: workAssignments.membershipId });
      if (added.length === 0) return;
      const reason = work.classification.toUpperCase();
      await emit(tx, context, {
        eventType: 'work.assigned',
        aggregateType: 'work_unit',
        aggregateId: work.id,
        aggregateVersion: work.version,
        classification: work.classification,
        payload: { work_unit_id: work.id, membership_id: membershipId },
      });
      await auditAction(tx, context, 'work.assigned', `membership:${membershipId}`, reason);
      await auditAction(tx, context, 'work.assigned', `work_unit:${work.id}`, reason);
      await notify(tx, context, [membershipId], 'work.assigned', `work_unit:${work.id}`);
    });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code !== 'FORBIDDEN' && error.code !== 'NOT_FOUND') throw error;
  }
}

/**
 * An owner saying this member here is that person from the source. Moves their work from the fallback, as
 * an ordinary reassignment would, one short transaction at a time, each with its own audit record. Grants no
 * role: the member keeps the role they joined with, whatever `source_role` says. Linked once, and never moved.
 *
 * It names the target first, which `linked_at` being empty marks as still under way, and sets `linked_at` once
 * everything has moved. So if it stops partway, asking again for the same member finishes it, and asking for
 * anyone else is refused.
 */
export async function linkImportedPerson(
  database: AppDatabase,
  context: TenantContext,
  input: { sourceMembershipId: string; membershipId: string },
): Promise<ImportedPersonView> {
  if (!can(context.role, 'organization.import')) throw new AppError('FORBIDDEN');
  const source = idSchema.safeParse(input.sourceMembershipId);
  const target = idSchema.safeParse(input.membershipId);
  if (!source.success || !target.success) throw new AppError('INVALID_INPUT');
  const membershipId = target.data;

  const { holdings, fallback, importId } = await withTenantTx(database, context, async (tx) => {
    const [person] = await tx
      .select()
      .from(importedPeople)
      .where(eq(importedPeople.sourceMembershipId, source.data))
      .for('update');
    if (!person) throw new AppError('NOT_FOUND');
    if (person.linkedAt) throw new AppError('IMPORTED_PERSON_ALREADY_LINKED');
    if (person.targetMembershipId && person.targetMembershipId !== membershipId) {
      throw new AppError('IMPORTED_PERSON_ALREADY_LINKED');
    }
    // Row-level security means a member of another organization is simply not found here.
    await assertActiveMember(tx, membershipId);
    const [running] = await tx
      .select({ fallback: organizationImports.fallbackMembershipId })
      .from(organizationImports)
      .where(eq(organizationImports.id, person.importId));
    if (!running) throw new AppError('NOT_FOUND');
    await tx
      .update(importedPeople)
      .set({ targetMembershipId: membershipId })
      .where(eq(importedPeople.sourceMembershipId, source.data));
    return {
      holdings: await listImportHoldings(tx, person.importId, source.data),
      fallback: running.fallback,
      importId: person.importId,
    };
  });

  for (const holding of holdings) {
    if (holding.target_type === 'team') {
      await withTenantTx(database, context, (tx) => joinTeam(tx, context, holding, membershipId));
    } else if (holding.responsibility === 'owner') {
      await moveWorkToLinked(database, context, holding, fallback, membershipId);
    } else {
      await assignToLinked(database, context, holding, membershipId);
    }
  }

  try {
    const [row] = await withTenantTx(database, context, async (tx) => {
      await auditAction(
        tx,
        context,
        'imported_person.linked',
        `membership:${membershipId}`,
        'IMPORT_LINK',
      );
      await auditAction(tx, context, 'imported_person.linked', importTargetRef(importId));
      return tx
        .update(importedPeople)
        .set({ linkedAt: new Date() })
        .where(
          and(
            eq(importedPeople.sourceMembershipId, source.data),
            eq(importedPeople.targetMembershipId, membershipId),
          ),
        )
        .returning();
    });
    if (!row) throw new AppError('IMPORTED_PERSON_ALREADY_LINKED');
    return toPersonView(row);
  } catch (error) {
    if (pgCode(error) === 'EN006') throw new AppError('IMPORTED_PERSON_ALREADY_LINKED');
    throw error;
  }
}

/** The caller holds `organization.import`, so this is an owner, who could add them by hand as well. */
async function joinTeam(
  tx: Tx,
  context: TenantContext,
  holding: ImportHolding,
  membershipId: string,
) {
  const [team] = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.id, holding.target_id));
  if (!team) return;
  await tx
    .insert(teamMemberships)
    .values({ organizationId: context.organizationId, teamId: team.id, membershipId })
    .onConflictDoNothing();
  await auditAction(tx, context, 'team.member_added', `membership:${membershipId}`, 'IMPORT_LINK');
}

export type ImportedRecordView = {
  recordType: ImportedRecordType;
  sourceId: string;
  occurredAt: Date;
  record: unknown;
};

/** A hostile archive could attach any number of rows to one Work Unit, so a page reads the newest this many. */
const MAX_RECORDS_FOR_WORK = 1000;

/**
 * History that came with a Work Unit, for someone who can read that Work Unit, and not found otherwise.
 * Nothing here can be acted on.
 */
export async function listImportedRecordsForWork(
  database: AppDatabase,
  context: TenantContext,
  workUnitId: string,
): Promise<readonly ImportedRecordView[]> {
  const id = idSchema.safeParse(workUnitId);
  if (!id.success) throw new AppError('NOT_FOUND');
  const rows = await withTenantTx(database, context, async (tx) => {
    await loadReadable(tx, context, id.data);
    return tx
      .select({
        recordType: importedRecords.recordType,
        sourceId: importedRecords.sourceId,
        occurredAt: importedRecords.occurredAt,
        record: importedRecords.record,
      })
      .from(importedRecords)
      .where(eq(importedRecords.workUnitId, id.data))
      .orderBy(desc(importedRecords.occurredAt))
      .limit(MAX_RECORDS_FOR_WORK);
  });
  return rows.map((row) => ({ ...row, recordType: row.recordType as ImportedRecordType }));
}
