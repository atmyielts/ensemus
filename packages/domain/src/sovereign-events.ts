// Outbox event names for licensing and portability (ADR-030). Payloads are IDs and enums only, and the
// dispatcher works from an event's type and aggregate ID alone.

export const AGGREGATE_ORGANIZATION_EXPORT = 'organization_export';
export const AGGREGATE_ORGANIZATION_IMPORT = 'organization_import';
export const AGGREGATE_LICENSE = 'license';

/** Someone asked for an archive. The dispatcher starts organizationExportWorkflow. */
export const ORGANIZATION_EXPORT_REQUESTED = 'organization_export.requested';
/** Facts for projections. Nothing outside PostgreSQL consumes these yet. */
export const ORGANIZATION_EXPORT_READY = 'organization_export.ready';
export const ORGANIZATION_EXPORT_FAILED = 'organization_export.failed';

/**
 * Facts only. An import runs in an operator's command, so nothing starts from these (ADR-030 D8). The
 * private key that opens the archive stays in that one process and never reaches Temporal or a table.
 */
export const ORGANIZATION_IMPORT_REQUESTED = 'organization_import.requested';
export const ORGANIZATION_IMPORT_FINISHED = 'organization_import.finished';

/** A signed document was installed. Facts only, since the document is what counts and not the event. */
export const LICENSE_DOCUMENT_INSTALLED = 'license.document_installed';

/** Notification kinds. The target is `organization_export:{id}` or `organization_import:{id}`. */
export const NOTIFY_EXPORT_READY = 'organization_export.ready';
export const NOTIFY_EXPORT_FAILED = 'organization_export.failed';
export const NOTIFY_IMPORT_FINISHED = 'organization_import.finished';
export const exportTargetRef = (id: string) => `organization_export:${id}`;
export const importTargetRef = (id: string) => `organization_import:${id}`;
