// 0419 pre-put authority proof retained until actual artifact byte/writer disposition.
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentRuns } from './schema-ai';
import { evidencePackageFacts } from './schema-ai-main-inputs';
import { artifactLineage } from './schema-artifact-provenance';
import { workUnits } from './schema-work';

const knowledge = pgSchema('knowledge');
export const artifactAuthorityReceipts = knowledge.table(
  'artifact_authority_receipts',
  {
    organizationId: uuid().notNull(),
    artifactId: uuid().notNull(),
    workUnitId: uuid().notNull(),
    runId: uuid(),
    viewerMembershipId: uuid(),
    protocolVersion: text().notNull(),
    writeId: uuid().notNull(),
    generation: bigint({ mode: 'number' }).notNull(),
    artifactSha256: text().notNull(),
    classification: text().notNull(),
    inputInventory: jsonb().notNull(),
    inventorySha256: text().notNull(),
    capturedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'artifact_authority_receipts_pk',
      columns: [t.organizationId, t.artifactId],
    }),
    foreignKey({
      name: 'artifact_authority_receipts_artifact_fk',
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifactLineage.organizationId, artifactLineage.artifactId],
    }),
    foreignKey({
      name: 'artifact_authority_receipts_work_fk',
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      name: 'artifact_authority_receipts_run_fk',
      columns: [t.organizationId, t.runId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
    check(
      'artifact_authority_receipts_protocol',
      sql`(${t.protocolVersion}='authority-v1' and ${t.runId} is not null and ${t.viewerMembershipId} is not null) or (${t.protocolVersion}='system-template-v1' and ${t.runId} is null and ${t.viewerMembershipId} is null)`,
    ),
    check(
      'artifact_authority_receipts_identity',
      sql`${t.generation}>0 and ${t.artifactSha256} ~ '^[0-9a-f]{64}$' and ${t.inventorySha256} ~ '^[0-9a-f]{64}$' and ${t.classification} in('public','internal','confidential','restricted')`,
    ),
    check(
      'artifact_authority_receipts_inventory',
      sql`jsonb_typeof(${t.inputInventory})='array' and jsonb_array_length(${t.inputInventory}) between 1 and 1000 and octet_length(${t.inputInventory}::text)<=1048576`,
    ),
  ],
);

export const artifactAuthorityRefs = knowledge.table(
  'artifact_authority_refs',
  {
    organizationId: uuid().notNull(),
    artifactId: uuid().notNull(),
    proofKeySha256: text().notNull(),
    refKind: text().notNull(),
    refId: uuid().notNull(),
    contentSha256: text(),
    classification: text().notNull(),
    sourceId: uuid(),
    documentId: uuid(),
    proofKind: text().notNull(),
    factPackageId: uuid(),
  },
  (t) => [
    primaryKey({
      name: 'artifact_authority_refs_pk',
      columns: [t.organizationId, t.artifactId, t.proofKeySha256],
    }),
    foreignKey({
      name: 'artifact_authority_refs_receipt_fk',
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [
        artifactAuthorityReceipts.organizationId,
        artifactAuthorityReceipts.artifactId,
      ],
    }),
    foreignKey({
      name: 'artifact_authority_refs_fact_receipt_fk',
      columns: [t.organizationId, t.factPackageId, t.refId],
      foreignColumns: [
        evidencePackageFacts.organizationId,
        evidencePackageFacts.packageId,
        evidencePackageFacts.factId,
      ],
    }),
    index('artifact_authority_refs_source_idx').on(t.organizationId, t.sourceId, t.artifactId),
    index('artifact_authority_refs_target_idx').on(
      t.organizationId,
      t.refKind,
      t.refId,
      t.artifactId,
    ),
    check(
      'artifact_authority_refs_fact_origin',
      sql`(${t.refKind}='fact')=(${t.factPackageId} is not null)`,
    ),
    check(
      'artifact_authority_refs_shape',
      sql`${t.proofKeySha256} ~ '^[0-9a-f]{64}$' and (${t.contentSha256} is null or ${t.contentSha256} ~ '^[0-9a-f]{64}$') and ${t.refKind} in('work_unit','project','client','object_record','artifact','chunk','document','source','fact','evidence_package','model_call') and ${t.classification} in('public','internal','confidential','restricted') and ${t.proofKind} in('actual_content','read_authority','current_authority','model_metadata') and (${t.proofKind} not in('actual_content','model_metadata') or ${t.contentSha256} is not null) and (${t.proofKind}<>'read_authority' or ${t.contentSha256} is null)`,
    ),
  ],
);
