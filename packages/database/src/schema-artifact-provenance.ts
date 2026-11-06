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
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
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
    primaryKey({ columns: [t.organizationId, t.artifactId] }),
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
    primaryKey({ columns: [t.organizationId, t.artifactId, t.workUnitId] }),
    foreignKey({
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifactAclCatalog.organizationId, artifactAclCatalog.artifactId],
    }),
    foreignKey({
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
    state: text().notNull(),
    writeId: uuid().notNull(),
    generation: bigint({ mode: 'number' }).notNull(),
    writeState: text().notNull(),
    physicalPurgedAt: timestamp({ withTimezone: true }),
    held: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.artifactId] }),
    foreignKey({
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifactAclCatalog.organizationId, artifactAclCatalog.artifactId],
    }),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
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
    primaryKey({ columns: [t.organizationId, t.artifactId, t.sourceId] }),
    foreignKey({
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifactLineage.organizationId, artifactLineage.artifactId],
    }),
    foreignKey({
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
    primaryKey({ columns: [t.organizationId, t.artifactId, t.packageId] }),
    foreignKey({
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifactLineage.organizationId, artifactLineage.artifactId],
    }),
    foreignKey({
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
    primaryKey({ columns: [t.organizationId, t.artifactId, t.inputArtifactId] }),
    foreignKey({
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifactLineage.organizationId, artifactLineage.artifactId],
    }),
    foreignKey({
      columns: [t.organizationId, t.inputArtifactId],
      foreignColumns: [artifactAclCatalog.organizationId, artifactAclCatalog.artifactId],
    }),
    check(
      'artifact_lineage_input_hash',
      sql`${t.inputSha256} ~ '^[0-9a-f]{64}$' and ${t.artifactId}<>${t.inputArtifactId}`,
    ),
  ],
);
