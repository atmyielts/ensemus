// Owned by the export slice (COMM-05). See docs/06-delivery/m6-slices.md and ADR-030 D7 and D10. The service
// and the worker's steps. Nothing about a record crosses Temporal: Activities take IDs, and this keeps its
// place in the export's own row.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { ExportFailureCode, ExportStatus } from '@ensemus/domain/portability';
import type { ObjectStore } from './artifacts';
import type { PortabilitySection } from './sovereign-ports';

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

/**
 * Needs `organization.export`, which only an owner has. Refuses a key that is not X25519 with `INVALID_INPUT`,
 * and a second running export with `EXPORT_ALREADY_RUNNING`. Writes the row, `auditAction` and
 * `emit(ORGANIZATION_EXPORT_REQUESTED)` in one transaction.
 */
export function requestOrganizationExport(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { recipientPublicKey: string; sourceRelease: string },
): Promise<OrganizationExportView> {
  throw new Error('NOT_IMPLEMENTED');
}

export function listOrganizationExports(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly OrganizationExportView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getOrganizationExport(
  _database: AppDatabase,
  _context: TenantContext,
  _exportId: string,
): Promise<OrganizationExportView> {
  throw new Error('NOT_IMPLEMENTED');
}

export type ExportArchive = {
  fileName: string;
  totalBytes: number;
  /** Tar framing and sealed parts in order, reading one part at a time from the store. */
  chunks: AsyncIterable<Buffer>;
};

/**
 * Hands over the archive for download. Needs `organization.export`. Refuses `EXPORT_NOT_READY` unless it is
 * `ready`, and `EXPORT_SUPERSEDED` if any tombstone is newer than `tombstones_through`, since then the archive
 * holds something its owner has since deleted (ADR-030 D10). Audits who took it.
 */
export function openExportArchive(
  _database: AppDatabase,
  _store: Pick<ObjectStore, 'get'>,
  _context: TenantContext,
  _exportId: string,
): Promise<ExportArchive> {
  throw new Error('NOT_IMPLEMENTED');
}

/** What the worker's steps answer with. Counters and enums, because these go through Temporal. */
export type ExportStep =
  | { state: 'continue'; parts: number; records: number }
  | { state: 'finished'; parts: number; records: number }
  | { state: 'failed'; code: ExportFailureCode };

/** Moves it to `running` and records `snapshot_at`. On a row already finished, answers `finished`. */
export function beginExport(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { exportId: string },
  _deps: ExportDeps,
): Promise<ExportStep> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * One bounded step: one page of one section, or one file's bytes, sealed and written, then its part row and
 * the new place in `progress`. A part whose row exists is skipped, so a retry repeats nothing. Bytes that do
 * not match the row's hash stop the export with `BYTES_CHANGED`, and a tombstoned file is never read.
 */
export function exportNextBatch(
  _database: AppDatabase,
  _store: ObjectStore,
  _context: TenantContext,
  _input: { exportId: string },
  _deps: ExportDeps,
): Promise<ExportStep> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Reads tombstones last, writes the sealed manifest from the part rows, sets `ready` with `expires_at`, tells
 * who asked through a notification, and emits `ORGANIZATION_EXPORT_READY`. Safe to repeat.
 */
export function finishExport(
  _database: AppDatabase,
  _store: ObjectStore,
  _context: TenantContext,
  _input: { exportId: string },
  _deps: ExportDeps,
): Promise<ExportStep> {
  throw new Error('NOT_IMPLEMENTED');
}

export function failExport(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { exportId: string; code: ExportFailureCode },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The tenant's upkeep. Past its time, or superseded by a deletion, an archive's bytes go and its row becomes
 * `expired`, and that row stays as the record. Returns how many.
 */
export function purgeExpiredExports(
  _database: AppDatabase,
  _store: ObjectStore,
  _context: TenantContext,
  _now: Date,
): Promise<number> {
  throw new Error('NOT_IMPLEMENTED');
}
