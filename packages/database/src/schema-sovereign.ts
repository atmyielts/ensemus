// M6 tables: signed license documents and the organization archive (ADR-030). Roles, grants, RLS and
// triggers are in reviewed SQL, migration 0301.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { memberships, organizations } from './schema';
import { invitations } from './schema-work';

const moment = () => timestamp({ withTimezone: true });
const createdAt = () => moment().notNull().defaultNow();
const tenantId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id);

export const sovereignSchema = pgSchema('sovereign');

/**
 * A license as it was delivered, per tenant (the data model's `license_records`). The envelope is the
 * fact, and is checked against the trust root each time it is read. The other columns are for finding and
 * listing, and nothing may decide anything from them. There is no column for validity, because a stored
 * answer could go stale, or be written by someone other than the verifier.
 */
export const licenseRecords = sovereignSchema.table(
  'license_records',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    licenseId: uuid().notNull(),
    edition: text().notNull(),
    licensedVersion: text().notNull(),
    termKind: text().notNull(),
    keyIds: text().array().notNull(),
    envelope: text().notNull(),
    envelopeSha256: text().notNull(),
    issuedAt: moment().notNull(),
    /** Null when an operator's command installed it. */
    installedByMembershipId: uuid(),
    installedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    // Installing the same file twice is one row, so it is safe to repeat.
    unique('license_records_envelope_unique').on(t.organizationId, t.envelopeSha256),
    foreignKey({
      name: 'license_records_installed_by_fk',
      columns: [t.organizationId, t.installedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('license_records_issued_idx').on(t.organizationId, t.issuedAt),
    check('license_records_term_check', sql`${t.termKind} in ('perpetual','pilot')`),
    check('license_records_sha256_format', sql`${t.envelopeSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Maintenance statements, advisories and support policies, on the same rule as a license. */
export const signedDocuments = sovereignSchema.table(
  'signed_documents',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    documentType: text().notNull(),
    documentId: text().notNull(),
    /** For a maintenance statement, the license it is about. */
    subjectLicenseId: uuid(),
    keyIds: text().array().notNull(),
    envelope: text().notNull(),
    envelopeSha256: text().notNull(),
    issuedAt: moment().notNull(),
    installedByMembershipId: uuid(),
    installedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('signed_documents_envelope_unique').on(t.organizationId, t.envelopeSha256),
    foreignKey({
      name: 'signed_documents_installed_by_fk',
      columns: [t.organizationId, t.installedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('signed_documents_type_idx').on(t.organizationId, t.documentType, t.issuedAt),
    check(
      'signed_documents_type_check',
      sql`${t.documentType} in ('maintenance','advisory','support_policy')`,
    ),
    check('signed_documents_sha256_format', sql`${t.envelopeSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * One archive of one tenant (COMM-05). The recipient's public key is what the worker seals to, so nothing
 * here could open the archive. `progress` is where the batch loop has got to, which lives here so that
 * nothing about records has to cross Temporal.
 */
export const organizationExports = sovereignSchema.table(
  'organization_exports',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    status: text().notNull().default('requested'),
    /** Only `standard`, which leaves restricted work out (ADR-030 D10). A wider scope is a migration. */
    scope: text().notNull().default('standard'),
    /** Pinned once at the real begin transition. Legacy/missing pins never authorize download. */
    exportEpoch: bigint({ mode: 'bigint' }),
    /** SQL pins the actual projection contract on begin. Legacy NULL is unknown. */
    inventoryVersion: text(),
    recipientPublicKey: text().notNull(),
    recipientKeyId: text().notNull(),
    requestedByMembershipId: uuid().notNull(),
    sourceRelease: text().notNull(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    progress: jsonb().notNull().default({}),
    snapshotAt: moment(),
    /** Tombstones are read last, so anything deleted up to this moment is known to the archive. */
    tombstonesThrough: moment(),
    manifestSealedSha256: text(),
    partCount: integer().notNull().default(0),
    recordCount: bigint({ mode: 'number' }).notNull().default(0),
    archiveBytes: bigint({ mode: 'number' }).notNull().default(0),
    excludedRestrictedWork: integer().notNull().default(0),
    excludedRestrictedArtifacts: integer().notNull().default(0),
    excludedRestrictedClients: integer().notNull().default(0),
    /** A code from EXPORT_FAILURE_CODES. Text from a store or a record never goes here. */
    failureCode: text(),
    requestedAt: createdAt(),
    startedAt: moment(),
    finishedAt: moment(),
    expiresAt: moment(),
    purgedAt: moment(),
    updatedAt: moment().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      name: 'organization_exports_requested_by_fk',
      columns: [t.organizationId, t.requestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('organization_exports_page_idx').on(t.organizationId, t.requestedAt, t.id),
    // One at a time for a tenant, since each one reads the whole of it.
    uniqueIndex('organization_exports_one_active')
      .on(t.organizationId)
      .where(sql`${t.status} in ('requested','running')`),
    index('organization_exports_expiry_idx')
      .on(t.organizationId, t.expiresAt)
      .where(sql`${t.status} = 'ready'`),
    check(
      'organization_exports_status_check',
      sql`${t.status} in ('requested','running','ready','failed','expired')`,
    ),
    check('organization_exports_scope_check', sql`${t.scope} in ('standard')`),
    check(
      'organization_exports_inventory_version_check',
      sql`${t.inventoryVersion} is null or ${t.inventoryVersion}='ensemus.m3-m7/3'`,
    ),
    check('organization_exports_key_id_format', sql`${t.recipientKeyId} ~ '^[0-9a-f]{32}$'`),
    check('organization_exports_version_check', sql`${t.version} > 0`),
  ],
);

/** Each sealed part in the object store. Inserted after its bytes are written, so a retry finds its place. */
export const organizationExportParts = sovereignSchema.table(
  'organization_export_parts',
  {
    organizationId: uuid().notNull(),
    exportId: uuid().notNull(),
    path: text().notNull(),
    section: text().notNull(),
    recordCount: integer().notNull(),
    plaintextSha256: text().notNull(),
    sealedSha256: text().notNull(),
    sealedBytes: bigint({ mode: 'number' }).notNull(),
    objectKey: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'organization_export_parts_pk',
      columns: [t.organizationId, t.exportId, t.path],
    }),
    foreignKey({
      name: 'organization_export_parts_export_fk',
      columns: [t.organizationId, t.exportId],
      foreignColumns: [organizationExports.organizationId, organizationExports.id],
    }),
    check('organization_export_parts_record_count_check', sql`${t.recordCount} >= 0`),
    check('organization_export_parts_bytes_check', sql`${t.sealedBytes} >= 0`),
  ],
);

/**
 * One archive coming in, to a new organization and only ever one (ADR-030 D8). `fallbackMembershipId` is
 * who holds what belonged to people who have not joined here yet, which is recorded as such.
 */
export const organizationImports = sovereignSchema.table(
  'organization_imports',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    status: text().notNull().default('requested'),
    requestedByMembershipId: uuid().notNull(),
    fallbackMembershipId: uuid().notNull(),
    /** Trigger-only native admission, independent of a later live session row. Legacy NULL refuses effects. */
    intentAuthorizedAt: moment(),
    intentAuthorizedMembershipId: uuid(),
    intentAuthorizedSessionId: uuid(),
    sourceOrganizationId: uuid(),
    sourceExportId: uuid(),
    sourceRelease: text(),
    archiveSha256: text(),
    exportedAt: moment(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    /** Counts by record kind. */
    appliedCounts: jsonb().notNull().default({}),
    /** Counts by code from IMPORT_WARNING_CODES. */
    warningCounts: jsonb().notNull().default({}),
    /** A code from IMPORT_FAILURE_CODES. */
    failureCode: text(),
    requestedAt: createdAt(),
    startedAt: moment(),
    finishedAt: moment(),
    updatedAt: moment().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      name: 'organization_imports_requested_by_fk',
      columns: [t.organizationId, t.requestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      name: 'organization_imports_fallback_fk',
      columns: [t.organizationId, t.fallbackMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      name: 'import_intent_authorized_member',
      columns: [t.organizationId, t.intentAuthorizedMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check(
      'import_intent_authorization_complete',
      sql`(${t.intentAuthorizedAt} is null and ${t.intentAuthorizedMembershipId} is null and ${t.intentAuthorizedSessionId} is null) or (${t.intentAuthorizedAt} is not null and ${t.intentAuthorizedMembershipId}=${t.requestedByMembershipId} and ${t.intentAuthorizedSessionId} is not null)`,
    ),
    uniqueIndex('organization_imports_one_only')
      .on(t.organizationId)
      .where(sql`${t.status} <> 'failed'`),
    check(
      'organization_imports_status_check',
      sql`${t.status} in ('requested','running','completed','completed_with_warnings','failed')`,
    ),
    check('organization_imports_version_check', sql`${t.version} > 0`),
  ],
);

/** Parts finished, written in the transaction that applied them, so a re-run applies nothing twice. */
export const organizationImportParts = sovereignSchema.table(
  'organization_import_parts',
  {
    organizationId: uuid().notNull(),
    importId: uuid().notNull(),
    path: text().notNull(),
    section: text().notNull(),
    recordCount: integer().notNull(),
    warningCount: integer().notNull().default(0),
    finishedAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'organization_import_parts_pk',
      columns: [t.organizationId, t.importId, t.path],
    }),
    foreignKey({
      name: 'organization_import_parts_import_fk',
      columns: [t.organizationId, t.importId],
      foreignColumns: [organizationImports.organizationId, organizationImports.id],
    }),
  ],
);

/**
 * Someone from the source organization. An import makes no accounts: they join through an ordinary
 * invitation, and an owner links them, which grants nothing further (ADR-030 D9). Until then, what they owned
 * is held by the import's fallback membership. Personal data, so reading this is for owners.
 */
export const importedPeople = sovereignSchema.table(
  'imported_people',
  {
    organizationId: uuid().notNull(),
    importId: uuid().notNull(),
    sourceMembershipId: uuid().notNull(),
    displayName: text().notNull(),
    email: text().notNull(),
    sourceRole: text().notNull(),
    sourceStatus: text().notNull(),
    targetMembershipId: uuid(),
    invitationId: uuid(),
    linkedAt: moment(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'imported_people_pk',
      columns: [t.organizationId, t.sourceMembershipId],
    }),
    foreignKey({
      name: 'imported_people_import_fk',
      columns: [t.organizationId, t.importId],
      foreignColumns: [organizationImports.organizationId, organizationImports.id],
    }),
    foreignKey({
      name: 'imported_people_target_fk',
      columns: [t.organizationId, t.targetMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      name: 'imported_people_invitation_fk',
      columns: [t.organizationId, t.invitationId],
      foreignColumns: [invitations.organizationId, invitations.id],
    }),
    index('imported_people_unlinked_idx').on(t.organizationId, t.linkedAt),
    check('imported_people_role_check', sql`${t.sourceRole} in ('owner','admin','member')`),
  ],
);

/**
 * What happened elsewhere, kept read-only as it was exported: approvals, decisions, status changes, sends and
 * their receipts (ADR-030 D9). None of it can be acted on or repeated. `workUnitId` decides who may read a
 * row, using that work's own rules, and a row with none is for owners.
 */
export const importedRecords = sovereignSchema.table(
  'imported_records',
  {
    organizationId: uuid().notNull(),
    importId: uuid().notNull(),
    recordType: text().notNull(),
    sourceId: uuid().notNull(),
    workUnitId: uuid(),
    occurredAt: moment().notNull(),
    record: jsonb().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'imported_records_pk',
      columns: [t.organizationId, t.importId, t.recordType, t.sourceId],
    }),
    foreignKey({
      name: 'imported_records_import_fk',
      columns: [t.organizationId, t.importId],
      foreignColumns: [organizationImports.organizationId, organizationImports.id],
    }),
    index('imported_records_work_idx').on(t.organizationId, t.workUnitId, t.occurredAt),
    check(
      'imported_records_type_check',
      sql`${t.recordType} in ('approval','approval_decision','work_transition','external_action','external_action_receipt','audit_event')`,
    ),
  ],
);

/** Verified archive/part metadata only; record bodies are never retained in these receipts. */
export const organizationImportManifests = sovereignSchema.table(
  'organization_import_manifests',
  {
    organizationId: uuid().notNull(),
    importId: uuid().notNull(),
    path: text().notNull(),
    archiveSha256: text().notNull(),
    plaintextSha256: text().notNull(),
    section: text().notNull(),
    recordCount: integer().notNull(),
    recordDigests: jsonb().notNull(),
    manifest: jsonb(),
    verifiedAt: moment(),
    createdAt: moment()
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({
      name: 'organization_import_manifests_pkey',
      columns: [t.organizationId, t.importId, t.path],
    }),
    foreignKey({
      name: 'import_manifest_import_fk',
      columns: [t.organizationId, t.importId],
      foreignColumns: [organizationImports.organizationId, organizationImports.id],
    }),
    check(
      'organization_import_manifests_archive_sha256_check',
      sql`${t.archiveSha256}~'^[0-9a-f]{64}$'`,
    ),
    check(
      'organization_import_manifests_plaintext_sha256_check',
      sql`${t.plaintextSha256}~'^[0-9a-f]{64}$'`,
    ),
    check('organization_import_manifests_record_count_check', sql`${t.recordCount}>=0`),
    check(
      'organization_import_manifests_record_digests_check',
      sql`jsonb_typeof(${t.recordDigests})='array'`,
    ),
    check(
      'import_manifest_kind_check',
      sql`(${t.path}='manifest.json.sealed')=(${t.manifest} is not null)`,
    ),
    check(
      'import_manifest_verified_kind',
      sql`${t.verifiedAt} is null or ${t.path}='manifest.json.sealed'`,
    ),
  ],
);
export const organizationImportEffects = sovereignSchema.table(
  'organization_import_effects',
  {
    organizationId: uuid().notNull(),
    importId: uuid().notNull(),
    partPath: text().notNull(),
    operation: text().notNull(),
    targetKey: text().notNull(),
    expectedSha256: text().notNull(),
    sourceSha256: text().notNull(),
    consumedAt: moment(),
    createdTarget: boolean().notNull().default(false),
  },
  (t) => [
    primaryKey({
      name: 'organization_import_effects_pkey',
      columns: [t.organizationId, t.importId, t.partPath, t.operation, t.targetKey],
    }),
    foreignKey({
      name: 'import_effect_part_fk',
      columns: [t.organizationId, t.importId, t.partPath],
      foreignColumns: [
        organizationImportManifests.organizationId,
        organizationImportManifests.importId,
        organizationImportManifests.path,
      ],
    }),
    check(
      'organization_import_effects_expected_sha256_check',
      sql`${t.expectedSha256}~'^[0-9a-f]{64}$'`,
    ),
    check(
      'organization_import_effects_source_sha256_check',
      sql`${t.sourceSha256}~'^[0-9a-f]{64}$'`,
    ),
    check(
      'organization_import_effects_operation_check',
      sql`${t.operation} in('team_insert','team_parent','team_member','connection_insert')`,
    ),
  ],
);

/** Unknown-origin archive bytes are separate inert custody. Source IDs are immutable archive
 * references, never live artifact FKs; this header survives until physical deletion is proven. */
export const importedArchiveFiles = sovereignSchema.table(
  'imported_archive_files',
  {
    organizationId: uuid().notNull(),
    importId: uuid().notNull(),
    sourceArtifactId: uuid().notNull(),
    metadataPartPath: text().notNull(),
    metadataSha256: text().notNull(),
    binaryPartPath: text().notNull(),
    binarySha256: text().notNull(),
    name: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: bigint({ mode: 'number' }).notNull(),
    classification: text().notNull(),
    custodianMembershipId: uuid().notNull(),
    writeToken: uuid().notNull(),
    objectKey: text().notNull(),
    state: text().notNull(),
    writeState: text().notNull(),
    held: boolean().notNull().default(false),
    writeFinishedAt: moment(),
    writeFencedAt: moment(),
    closedAt: moment(),
    physicalPurgedAt: moment(),
    createdAt: moment()
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({
      name: 'imported_archive_files_pkey',
      columns: [t.organizationId, t.importId, t.sourceArtifactId],
    }),
    foreignKey({
      name: 'archive_file_import_fk',
      columns: [t.organizationId, t.importId],
      foreignColumns: [organizationImports.organizationId, organizationImports.id],
    }),
    foreignKey({
      name: 'archive_file_metadata_part_fk',
      columns: [t.organizationId, t.importId, t.metadataPartPath],
      foreignColumns: [
        organizationImportManifests.organizationId,
        organizationImportManifests.importId,
        organizationImportManifests.path,
      ],
    }),
    foreignKey({
      name: 'archive_file_binary_part_fk',
      columns: [t.organizationId, t.importId, t.binaryPartPath],
      foreignColumns: [
        organizationImportManifests.organizationId,
        organizationImportManifests.importId,
        organizationImportManifests.path,
      ],
    }),
    foreignKey({
      name: 'archive_file_custodian_fk',
      columns: [t.organizationId, t.custodianMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check(
      'imported_archive_files_metadata_sha256_check',
      sql`${t.metadataSha256}~'^[0-9a-f]{64}$'`,
    ),
    check('imported_archive_files_binary_sha256_check', sql`${t.binarySha256}~'^[0-9a-f]{64}$'`),
    check('imported_archive_files_size_bytes_check', sql`${t.sizeBytes} between 1 and 26214400`),
    check(
      'imported_archive_files_classification_check',
      sql`${t.classification} in('public','internal','confidential')`,
    ),
    check(
      'imported_archive_files_state_check',
      sql`${t.state} in('writing','unknown','quarantined','closing','purged')`,
    ),
    check(
      'imported_archive_files_write_state_check',
      sql`${t.writeState} in('active','settled','fenced')`,
    ),
    check(
      'archive_file_key',
      sql`${t.objectKey}=${t.organizationId}::text||'/archive-quarantine/'||${t.importId}::text||'/'||${t.sourceArtifactId}::text||'/'||${t.writeToken}::text`,
    ),
    check(
      'archive_file_finished',
      sql`(${t.state}<>'quarantined' or(${t.writeState} in('settled','fenced') and ${t.writeFinishedAt} is not null and ${t.closedAt} is null)) and(${t.state}<>'purged' or(${t.writeState} in('settled','fenced') and ${t.physicalPurgedAt} is not null and ${t.closedAt} is not null))`,
    ),
  ],
);
