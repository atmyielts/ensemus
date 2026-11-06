// The organization archive's rules (COMM-05, ADR-030 D7-D10). Pure, so export, import and the operator's
// tools agree on every name, and a path in an archive can only ever be one this module would have made.

/** Follows docs/07-commercial/03-data-portability-and-exit.md section 2, plus what an import needs. */
export const EXPORT_SECTIONS = [
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
  // Each belongs to a later milestone's tables, which fill it through the PortabilitySection port.
  'knowledge',
  'agents',
  'skills',
  'policy',
  'custom-objects',
] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

/** The sections the core reads and writes itself. The rest arrive through the port or stay empty. */
export const CORE_EXPORT_SECTIONS = [
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
] as const satisfies readonly ExportSection[];
export type CoreExportSection = (typeof CORE_EXPORT_SECTIONS)[number];

export const EXPORT_MANIFEST_PATH = 'manifest.json.sealed';
export const EXPORT_OBJECT_PREFIX = 'organization-exports/v1/';

/** One sealed part holds at most this much plain text, which also bounds what a worker holds in memory. */
export const MAX_PART_PLAINTEXT_BYTES = 32 * 1024 * 1024;
export const MAX_RECORDS_PER_PART = 5_000;
export const MAX_RECORD_BYTES = 1024 * 1024;
export const MAX_ARCHIVE_PARTS = 1_000_000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IS_UUID = new RegExp(`^${UUID}$`);
const PART = /^([a-z-]+)\/([a-z_]+-\d{6}\.jsonl|[0-9a-f-]{36}\.bin)\.sealed$/;

export const isExportSection = (value: string): value is ExportSection =>
  (EXPORT_SECTIONS as readonly string[]).includes(value);

/** `work/work_units-000001.jsonl.sealed`. Throws on anything that would not read back. */
export function recordPartPath(section: ExportSection, recordKind: string, sequence: number) {
  if (!/^[a-z_]+$/.test(recordKind) || !Number.isInteger(sequence) || sequence < 1) {
    throw new Error('Not a valid part');
  }
  return `${section}/${recordKind}-${String(sequence).padStart(6, '0')}.jsonl.sealed`;
}

/** `artifacts/{id}.bin.sealed`. The artifact's own ID, so a name never reaches a path. */
export function artifactPartPath(artifactId: string) {
  if (!IS_UUID.test(artifactId)) throw new Error('Not a valid part');
  return `artifacts/${artifactId}.bin.sealed`;
}

/**
 * Whether a path from an archive is one this format makes. An archive is untrusted input, so this is an
 * allowlist rather than a hunt for `..`: a path that is not exactly this shape is refused, whatever it
 * would have meant to a file system.
 */
export function isArchivePath(path: string): boolean {
  if (path === EXPORT_MANIFEST_PATH) return true;
  const match = PART.exec(path);
  if (!match) return false;
  const [, section, file] = match as unknown as [string, string, string];
  if (!isExportSection(section)) return false;
  return file.endsWith('.bin') ? section === 'artifacts' && IS_UUID.test(file.slice(0, 36)) : true;
}

export const exportObjectKey = (organizationId: string, exportId: string, path: string) => {
  if (!IS_UUID.test(organizationId) || !IS_UUID.test(exportId) || !isArchivePath(path)) {
    throw new Error('Not a valid export object');
  }
  return `${EXPORT_OBJECT_PREFIX}${organizationId}/${exportId}/${path}`;
};

export const EXPORT_STATUSES = ['requested', 'running', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];
/** Migration 0301 holds the same list in a trigger, and a test holds the two together. */
export const EXPORT_TRANSITIONS: Record<ExportStatus, readonly ExportStatus[]> = {
  requested: ['running', 'failed'],
  running: ['ready', 'failed'],
  ready: ['expired'],
  failed: [],
  expired: [],
};

export const IMPORT_STATUSES = [
  'requested',
  'running',
  'completed',
  'completed_with_warnings',
  'failed',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
export const IMPORT_TRANSITIONS: Record<ImportStatus, readonly ImportStatus[]> = {
  requested: ['running', 'failed'],
  // A failed run can be run again: every part it finished is remembered, and is not applied twice.
  running: ['completed', 'completed_with_warnings', 'failed'],
  completed: [],
  completed_with_warnings: [],
  failed: ['running'],
};

/** Why an export stopped. A code, so no text from a store or a record can reach a page or a log. */
export const EXPORT_FAILURE_CODES = [
  'STORE_UNAVAILABLE',
  'BYTES_MISSING',
  'BYTES_CHANGED',
  'RECORD_REFUSED',
  'TOO_MANY_PARTS',
  'SECTION_FAILED',
] as const;
export type ExportFailureCode = (typeof EXPORT_FAILURE_CODES)[number];

export const IMPORT_FAILURE_CODES = [
  'ARCHIVE_UNREADABLE',
  'WRONG_KEY',
  'MANIFEST_INVALID',
  'PART_MISSING',
  'PART_CHANGED',
  'PATH_REFUSED',
  'RECORD_REFUSED',
  'FORMAT_NOT_SUPPORTED',
  'TARGET_NOT_EMPTY',
  'STORE_UNAVAILABLE',
] as const;
export type ImportFailureCode = (typeof IMPORT_FAILURE_CODES)[number];

/** Things the person who imported needs to look at. Recorded with counts, and never as a silent loss. */
export const IMPORT_WARNING_CODES = [
  'RESTRICTED_EXCLUDED_AT_SOURCE',
  'TOMBSTONED_SKIPPED',
  'PERSON_NOT_LINKED',
  'CONNECTION_NEEDS_CREDENTIAL',
  'SECTION_NOT_SUPPORTED',
  'BYTES_MISSING',
  'RELATION_DANGLING',
  'WORK_PAUSED_ON_IMPORT',
] as const;
export type ImportWarningCode = (typeof IMPORT_WARNING_CODES)[number];

/**
 * An import starts nothing. Work that was moving when it was exported has no workflow here, and a pending
 * decision belongs to a context that has gone, so anything in flight waits for a person (ADR-030 D9).
 */
export function importedWorkStatus(status: string): 'queued' | 'ready' | 'blocked' | TerminalWork {
  switch (status) {
    case 'queued':
    case 'ready':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return status;
    default:
      return 'blocked';
  }
}
type TerminalWork = 'completed' | 'failed' | 'cancelled';

/**
 * Records kept as history, read-only, instead of being made live again. An approval or a send that ran
 * elsewhere must never be actionable or repeatable here, and pointing it at whoever imported it would be
 * saying something false about who decided what.
 */
export const IMPORTED_RECORD_TYPES = [
  'approval',
  'approval_decision',
  'work_transition',
  'external_action',
  'external_action_receipt',
  'audit_event',
] as const;
export type ImportedRecordType = (typeof IMPORTED_RECORD_TYPES)[number];
