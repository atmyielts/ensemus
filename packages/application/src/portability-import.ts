// Owned by the import slice (COMM-05). See docs/06-delivery/m6-slices.md and ADR-030 D8 and D9. An archive is
// hostile input until proven otherwise, it goes only into an organization with nothing in it, and it starts
// nothing. It runs in an operator's command, so the private key that opens it stays in that one process.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type {
  ImportFailureCode,
  ImportStatus,
  ImportWarningCode,
  ImportedRecordType,
} from '@ensemus/domain/portability';
import type { ObjectStore } from './artifacts';
import type { PortabilitySection } from './sovereign-ports';
import type { LedgerReader } from './tombstone-ledger';

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

/**
 * An owner saying this organization is to take an archive. Needs `organization.import`. Refuses with
 * `IMPORT_TARGET_NOT_EMPTY` unless the organization holds no work, clients, projects, teams or artifacts and
 * has this one member, and `IMPORT_ALREADY_USED` if it has already taken one. `fallback_membership_id` is the
 * caller. Writes the row, `auditAction` and `emit(ORGANIZATION_IMPORT_REQUESTED)`.
 */
export function requestOrganizationImport(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<OrganizationImportView> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getOrganizationImport(
  _database: AppDatabase,
  _context: TenantContext,
  _importId: string,
): Promise<OrganizationImportView> {
  throw new Error('NOT_IMPLEMENTED');
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
};

/**
 * The whole import, run by the operator's command with a service context. The order is what makes it safe:
 *
 * 1. Refuse unless the row is `requested` or `failed`.
 * 2. Walk the tar, refusing a path `isArchivePath` refuses. Open the manifest first, and check its schema,
 *    its `schema_version`, and that the archive's parts are exactly its parts.
 * 3. Check each part's sealed hash, then open it, then check its plain hash.
 * 4. Read `tombstones` first. Then the rest in `CORE_EXPORT_SECTIONS` order, each page in one tenant
 *    transaction that also writes its `organization_import_parts` row.
 * 5. Skip a tombstoned artifact entirely, and add the tombstone with `tombstone.recorded` so the new
 *    organization's ledger holds it too.
 * 6. Finish with counts and warnings, and notify whoever asked.
 *
 * No record's own fields can name a tenant, and nothing is started: no workflow, no event a workflow listens
 * to, no pending approval and no connection with a credential.
 */
export function runOrganizationImport(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    importId: string;
    archive: ArchiveReader;
    /** PEM, read from the operator's own mounted file. Never logged, stored or passed on. */
    recipientPrivateKeyPem: string;
  },
  _deps: ImportRunDeps,
): Promise<ImportRunResult> {
  throw new Error('NOT_IMPLEMENTED');
}

export type ImportedPersonView = {
  sourceMembershipId: string;
  displayName: string;
  email: string;
  sourceRole: 'owner' | 'admin' | 'member';
  targetMembershipId: string | null;
  linkedAt: Date | null;
};

/** Needs `organization.import`, since this is personal data about people not necessarily here yet. */
export function listImportedPeople(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly ImportedPersonView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * An owner saying this member here is that person from the source. Moves their work from the fallback, as
 * an ordinary reassignment would, through `applyTransition`-free updates and the audit log. Grants no role:
 * the member keeps the role they joined with, whatever `source_role` says. Linked once, and never moved.
 */
export function linkImportedPerson(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { sourceMembershipId: string; membershipId: string },
): Promise<ImportedPersonView> {
  throw new Error('NOT_IMPLEMENTED');
}

export type ImportedRecordView = {
  recordType: ImportedRecordType;
  sourceId: string;
  occurredAt: Date;
  record: unknown;
};

/**
 * History that came with a Work Unit, for someone who can read that Work Unit, and not found otherwise.
 * Nothing here can be acted on.
 */
export function listImportedRecordsForWork(
  _database: AppDatabase,
  _context: TenantContext,
  _workUnitId: string,
): Promise<readonly ImportedRecordView[]> {
  throw new Error('NOT_IMPLEMENTED');
}
