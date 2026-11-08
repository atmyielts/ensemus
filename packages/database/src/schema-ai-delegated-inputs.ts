// 0419 immutable actual child birth and its frozen referents. No body text or guessed old reads.
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { aiSchema, agentRuns, executionSteps, toolProposals } from './schema-ai';
import { mainInputSnapshots } from './schema-ai-main-inputs';
import { workUnits } from './schema-work';

export const delegatedInputReceipts = aiSchema.table(
  'delegated_input_receipts',
  {
    organizationId: uuid().notNull(),
    childRunId: uuid().notNull(),
    parentRunId: uuid().notNull(),
    childWorkUnitId: uuid().notNull(),
    proposalId: uuid().notNull(),
    snapshotId: uuid().notNull(),
    originalStepId: uuid().notNull(),
    originalAttempt: integer().notNull(),
    toolStepNumber: integer().notNull(),
    requestSha256: text().notNull(),
    proposalPayloadSha256: text().notNull(),
    birthContentSha256: text().notNull(),
    inputInventory: jsonb().notNull(),
    inventorySha256: text().notNull(),
    classification: text().notNull(),
    bornAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Set only by the fixed actual Work-redaction effect after the permanent run fence and hold
    // check. Eraser must separately require file-byte and private-payload proof before dropping refs.
    redactedAt: timestamp({ withTimezone: true }),
    redactedVersion: bigint({ mode: 'number' }),
    dispositionSha256: text(),
  },
  (t) => [
    primaryKey({ name: 'delegated_input_receipts_pk', columns: [t.organizationId, t.childRunId] }),
    unique('delegated_input_receipts_proposal_key').on(t.organizationId, t.proposalId),
    unique('delegated_input_receipts_work_key').on(t.organizationId, t.childWorkUnitId),
    foreignKey({
      name: 'delegated_input_receipts_child_fk',
      columns: [t.organizationId, t.childRunId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
    foreignKey({
      name: 'delegated_input_receipts_parent_fk',
      columns: [t.organizationId, t.parentRunId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
    foreignKey({
      name: 'delegated_input_receipts_work_fk',
      columns: [t.organizationId, t.childWorkUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      name: 'delegated_input_receipts_proposal_fk',
      columns: [t.organizationId, t.proposalId],
      foreignColumns: [toolProposals.organizationId, toolProposals.id],
    }),
    foreignKey({
      name: 'delegated_input_receipts_snapshot_fk',
      columns: [t.organizationId, t.snapshotId],
      foreignColumns: [mainInputSnapshots.organizationId, mainInputSnapshots.id],
    }),
    foreignKey({
      name: 'delegated_input_receipts_step_fk',
      columns: [t.organizationId, t.originalStepId],
      foreignColumns: [executionSteps.organizationId, executionSteps.id],
    }),
    index('delegated_input_receipts_parent_idx').on(t.organizationId, t.parentRunId, t.childRunId),
    check(
      'delegated_input_receipts_identity',
      sql`${t.childRunId}<>${t.parentRunId} and ${t.originalAttempt}>0 and ${t.toolStepNumber}>0`,
    ),
    check(
      'delegated_input_receipts_hashes',
      sql`${t.requestSha256} ~ '^[0-9a-f]{64}$' and ${t.proposalPayloadSha256} ~ '^[0-9a-f]{64}$' and ${t.birthContentSha256} ~ '^[0-9a-f]{64}$' and ${t.inventorySha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'delegated_input_receipts_inventory',
      sql`jsonb_typeof(${t.inputInventory})='array' and jsonb_array_length(${t.inputInventory}) between 1 and 1000 and octet_length(${t.inputInventory}::text)<=1048576`,
    ),
    check(
      'delegated_input_receipts_class',
      sql`${t.classification} in('public','internal','confidential','restricted')`,
    ),
    check(
      'delegated_input_receipts_disposition',
      sql`(${t.redactedAt} is null and ${t.redactedVersion} is null and ${t.dispositionSha256} is null) or (${t.redactedAt} is not null and ${t.redactedVersion} is not null and ${t.redactedVersion}>0 and ${t.dispositionSha256} is not null and ${t.dispositionSha256} ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

/** Flattened actual frozen refs support bounded source/record purge without scanning JSON/history.
 * proofKeySha256 is a metadata identity, not an invented content hash for authority-only records. */
export const delegatedInputRefs = aiSchema.table(
  'delegated_input_refs',
  {
    organizationId: uuid().notNull(),
    childRunId: uuid().notNull(),
    proofKeySha256: text().notNull(),
    refKind: text().notNull(),
    refId: uuid().notNull(),
    contentSha256: text(),
    classification: text().notNull(),
    sourceId: uuid(),
    documentId: uuid(),
    proofKind: text().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'delegated_input_refs_pk',
      columns: [t.organizationId, t.childRunId, t.proofKeySha256],
    }),
    foreignKey({
      name: 'delegated_input_refs_receipt_fk',
      columns: [t.organizationId, t.childRunId],
      foreignColumns: [delegatedInputReceipts.organizationId, delegatedInputReceipts.childRunId],
    }),
    index('delegated_input_refs_target_idx').on(t.organizationId, t.refKind, t.refId, t.childRunId),
    index('delegated_input_refs_source_idx').on(t.organizationId, t.sourceId, t.childRunId),
    check(
      'delegated_input_refs_shape',
      sql`${t.proofKeySha256} ~ '^[0-9a-f]{64}$' and (${t.contentSha256} is null or ${t.contentSha256} ~ '^[0-9a-f]{64}$') and ${t.refKind} in('work_unit','project','client','object_record','artifact','chunk','document','source','fact','evidence_package','model_call') and ${t.classification} in('public','internal','confidential','restricted') and ${t.proofKind} in('actual_content','read_authority','current_authority','model_metadata')`,
    ),
  ],
);
