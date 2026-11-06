// 0208: ID-only serving catalogs and retained generated-file lineage. These rows deliberately outlive
// work.artifacts: losing the source -> object key edge before verified erasure is false completion.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { memberships, organizations } from './schema';
import { workUnits } from './schema-work';
import { knowledgeEvidencePackages, knowledgeSources } from './schema-knowledge';

const knowledge = pgSchema('knowledge');
export const artifactAclCatalog = knowledge.table(
  'artifact_acl_catalog',
  {
    organizationId: uuid().notNull(),
    artifactId: uuid().notNull(),
    sha256: text().notNull(),
    classification: text().notNull(),
    sizeBytes: bigint({ mode: 'number' }).notNull(),
    provenanceState: text().notNull(),
    alive: boolean().notNull(),
    /** Trigger-only positive byte/writer proof; survives lineage deletion during whole-tenant erase. */
    physicalPurgedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'artifact_acl_catalog_organization_id_fkey',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }),
    primaryKey({ name: 'artifact_acl_catalog_pkey', columns: [t.organizationId, t.artifactId] }),
    check(
      'artifact_catalog_shape',
      sql`${t.sha256} ~ '^[0-9a-f]{64}$' and ${t.sizeBytes}>=0 and ${t.classification} in ('public','internal','confidential','restricted') and ${t.provenanceState} in ('ordinary','pending','bound','blocked')`,
    ),
  ],
);
export const artifactWorkLinks = knowledge.table(
  'artifact_work_links',
  {
    organizationId: uuid().notNull(),
    artifactId: uuid().notNull(),
    workUnitId: uuid().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'artifact_work_links_pkey',
      columns: [t.organizationId, t.artifactId, t.workUnitId],
    }),
    foreignKey({
      name: 'artifact_work_links_organization_id_artifact_id_fkey',
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifactAclCatalog.organizationId, artifactAclCatalog.artifactId],
    }),
    foreignKey({
      name: 'artifact_work_links_organization_id_work_unit_id_fkey',
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
  ],
);
export const artifactLineage = knowledge.table(
  'artifact_lineage',
  {
    organizationId: uuid().notNull(),
    artifactId: uuid().notNull(),
    workUnitId: uuid(),
    restoreReapplyPending: boolean().notNull().default(false),
    objectKey: text().notNull(),
    artifactSha256: text().notNull(),
    sizeBytes: bigint({ mode: 'number' }).notNull(),
    classification: text().notNull(),
    executionKind: text().notNull(),
    executionId: uuid(),
    executorRef: text().notNull(),
    viewerMembershipId: uuid(),
    inventorySha256: text(),
    inventoryComplete: boolean().notNull().default(false),
    structuredInventoryComplete: boolean().notNull().default(false),
    state: text().notNull(),
    writeId: uuid().notNull(),
    generation: bigint({ mode: 'number' }).notNull(),
    writeState: text().notNull(),
    physicalPurgedAt: timestamp({ withTimezone: true }),
    held: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'artifact_lineage_pkey', columns: [t.organizationId, t.artifactId] }),
    foreignKey({
      name: 'artifact_lineage_organization_id_artifact_id_fkey',
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifactAclCatalog.organizationId, artifactAclCatalog.artifactId],
    }),
    foreignKey({
      name: 'artifact_lineage_organization_id_work_unit_id_fkey',
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      name: 'artifact_lineage_organization_id_viewer_membership_id_fkey',
      columns: [t.organizationId, t.viewerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('artifact_lineage_execution_idx').on(t.organizationId, t.executionId),
    check(
      'artifact_lineage_state_check',
      sql`${t.state} in ('pending','bound','blocked') and ${t.writeState} in ('unknown','active','settled','fenced') and ${t.generation}>0`,
    ),
    check(
      'artifact_lineage_inventory_check',
      sql`not ${t.inventoryComplete} or (${t.inventorySha256} is not null and ${t.inventorySha256} ~ '^[0-9a-f]{64}$' and ${t.executionId} is not null and ${t.workUnitId} is not null)`,
    ),
    check(
      'artifact_lineage_shape',
      sql`${t.artifactSha256} ~ '^[0-9a-f]{64}$' and ${t.sizeBytes}>=0 and ${t.classification} in ('public','internal','confidential','restricted') and ${t.executionKind} in ('unknown','manual','agent_run','system')`,
    ),
  ],
);
export const artifactLineageSources = knowledge.table(
  'artifact_lineage_sources',
  {
    organizationId: uuid().notNull(),
    artifactId: uuid().notNull(),
    sourceId: uuid().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'artifact_lineage_sources_pkey',
      columns: [t.organizationId, t.artifactId, t.sourceId],
    }),
    foreignKey({
      name: 'artifact_lineage_sources_organization_id_artifact_id_fkey',
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifactLineage.organizationId, artifactLineage.artifactId],
    }),
    foreignKey({
      name: 'artifact_lineage_sources_organization_id_source_id_fkey',
      columns: [t.organizationId, t.sourceId],
      foreignColumns: [knowledgeSources.organizationId, knowledgeSources.id],
    }),
    index('artifact_lineage_sources_source_idx').on(t.organizationId, t.sourceId),
  ],
);
export const artifactLineagePackages = knowledge.table(
  'artifact_lineage_packages',
  {
    organizationId: uuid().notNull(),
    artifactId: uuid().notNull(),
    packageId: uuid().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'artifact_lineage_packages_pkey',
      columns: [t.organizationId, t.artifactId, t.packageId],
    }),
    foreignKey({
      name: 'artifact_lineage_packages_organization_id_artifact_id_fkey',
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifactLineage.organizationId, artifactLineage.artifactId],
    }),
    foreignKey({
      name: 'artifact_lineage_packages_organization_id_package_id_fkey',
      columns: [t.organizationId, t.packageId],
      foreignColumns: [knowledgeEvidencePackages.organizationId, knowledgeEvidencePackages.id],
    }),
  ],
);
/** Flattened complete transitive artifact inputs. Current visibility is checked through the catalogs. */
export const artifactLineageInputs = knowledge.table(
  'artifact_lineage_inputs',
  {
    organizationId: uuid().notNull(),
    artifactId: uuid().notNull(),
    inputArtifactId: uuid().notNull(),
    inputSha256: text().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'artifact_lineage_inputs_pkey',
      columns: [t.organizationId, t.artifactId, t.inputArtifactId],
    }),
    foreignKey({
      name: 'artifact_lineage_inputs_organization_id_artifact_id_fkey',
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifactLineage.organizationId, artifactLineage.artifactId],
    }),
    foreignKey({
      name: 'artifact_lineage_inputs_organization_id_input_artifact_id_fkey',
      columns: [t.organizationId, t.inputArtifactId],
      foreignColumns: [artifactAclCatalog.organizationId, artifactAclCatalog.artifactId],
    }),
    check(
      'artifact_lineage_input_hash',
      sql`${t.inputSha256} ~ '^[0-9a-f]{64}$' and ${t.artifactId}<>${t.inputArtifactId}`,
    ),
  ],
);

/** 0211: live authorization metadata only. No title, objective, client name or body is copied. */
export const structuredRecordCatalog = knowledge.table(
  'structured_record_catalog',
  {
    organizationId: uuid().notNull(),
    recordKind: text().notNull(),
    recordId: uuid().notNull(),
    /** Projects derive their effective class from the current parent client, or internal with none. */
    classification: text(),
    ownerMembershipId: uuid(),
    parentRecordId: uuid(),
    alive: boolean().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'structured_record_catalog_pk',
      columns: [t.organizationId, t.recordKind, t.recordId],
    }),
    foreignKey({
      name: 'structured_record_catalog_org_fk',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }),
    check(
      'structured_record_catalog_shape',
      sql`${t.recordKind} in ('work_unit','project','client') and ((${t.recordKind}='project' and ${t.classification} is null and ${t.ownerMembershipId} is null) or (${t.recordKind}<>'project' and ${t.classification} is not null and ${t.classification} in ('public','internal','confidential','restricted')))`,
    ),
  ],
);
/** Membership IDs are a live ACL mirror, not a serving body or a historical grant. */
export const structuredWorkAssignments = knowledge.table(
  'structured_work_assignments',
  {
    organizationId: uuid().notNull(),
    workUnitId: uuid().notNull(),
    membershipId: uuid().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'structured_work_assignments_pk',
      columns: [t.organizationId, t.workUnitId, t.membershipId],
    }),
  ],
);
/** Complete flattened structured reads. Multiple hashes preserve actual rereads of mutable records. */
export const artifactLineageRecords = knowledge.table(
  'artifact_lineage_records',
  {
    organizationId: uuid().notNull(),
    artifactId: uuid().notNull(),
    recordKind: text().notNull(),
    recordId: uuid().notNull(),
    recordSha256: text().notNull(),
    classification: text().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'artifact_lineage_records_pk',
      columns: [t.organizationId, t.artifactId, t.recordKind, t.recordId, t.recordSha256],
    }),
    foreignKey({
      name: 'artifact_lineage_records_header_fk',
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifactLineage.organizationId, artifactLineage.artifactId],
    }),
    foreignKey({
      name: 'artifact_lineage_records_source_fk',
      columns: [t.organizationId, t.recordKind, t.recordId],
      foreignColumns: [
        structuredRecordCatalog.organizationId,
        structuredRecordCatalog.recordKind,
        structuredRecordCatalog.recordId,
      ],
    }),
    check(
      'artifact_lineage_records_shape',
      sql`${t.recordKind} in ('work_unit','project','client') and ${t.recordSha256} ~ '^[0-9a-f]{64}$' and ${t.classification} in ('public','internal','confidential','restricted')`,
    ),
    index('artifact_lineage_records_source_idx').on(t.organizationId, t.recordKind, t.recordId),
  ],
);
