// 0416: exact pre-network input prefixes and trusted result/proposal identity. Metadata only.
// No cascades: a delegated derived sink must not outlive the proof needed to close and erase it.
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { aiSchema, agentRuns, executionSteps, modelProfiles, toolProposals } from './schema-ai';
import { knowledgeEvidencePackages } from './schema-knowledge';

export const mainInputSnapshots = aiSchema.table(
  'main_input_snapshots',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull(),
    runId: uuid().notNull(),
    stepId: uuid().notNull(),
    attempt: integer().notNull(),
    reservationAttempt: integer().notNull(),
    writerToken: uuid().notNull(),
    requestHash: text().notNull(),
    profileId: uuid().notNull(),
    profileVersion: integer().notNull(),
    viewerMembershipId: uuid().notNull(),
    inputInventory: jsonb().notNull(),
    inventorySha256: text().notNull(),
    state: text().notNull().default('prepared'),
    resultKind: text(),
    resultToolId: text(),
    resultPayloadHash: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'main_input_snapshots_pk', columns: [t.organizationId, t.id] }),
    unique('main_input_snapshots_attempt_key').on(
      t.organizationId,
      t.runId,
      t.stepId,
      t.attempt,
      t.reservationAttempt,
    ),
    foreignKey({
      name: 'main_input_snapshots_run_fk',
      columns: [t.organizationId, t.runId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
    foreignKey({
      name: 'main_input_snapshots_step_fk',
      columns: [t.organizationId, t.stepId],
      foreignColumns: [executionSteps.organizationId, executionSteps.id],
    }),
    foreignKey({
      name: 'main_input_snapshots_profile_fk',
      columns: [t.organizationId, t.profileId],
      foreignColumns: [modelProfiles.organizationId, modelProfiles.id],
    }),
    check(
      'main_input_snapshots_identity',
      sql`${t.attempt}>0 and ${t.reservationAttempt}>=${t.attempt} and ${t.profileVersion}>0 and ${t.requestHash} ~ '^[0-9a-f]{64}$' and ${t.inventorySha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'main_input_snapshots_inventory',
      sql`jsonb_typeof(${t.inputInventory})='array' and jsonb_array_length(${t.inputInventory}) between 1 and 1000 and octet_length(${t.inputInventory}::text)<=1048576`,
    ),
    check(
      'main_input_snapshots_state',
      sql`(${t.state} in('prepared','dispatched') and ${t.resultKind} is null and ${t.resultToolId} is null and ${t.resultPayloadHash} is null) or (${t.state}='response_received' and ${t.resultPayloadHash} is not null and ${t.resultPayloadHash} ~ '^[0-9a-f]{64}$' and ${t.resultKind} is not null and ((${t.resultKind}='final' and ${t.resultToolId} is null) or (${t.resultKind}='tool_call' and ${t.resultToolId} is not null)))`,
    ),
  ],
);

export const modelProposalInputs = aiSchema.table(
  'model_proposal_inputs',
  {
    organizationId: uuid().notNull(),
    proposalId: uuid().notNull(),
    snapshotId: uuid().notNull(),
    /** Trusted Work-kernel transform of the actual delegate result. Legacy NULL is not repaired. */
    transformVersion: text(),
    derivedBodySha256: text(),
  },
  (t) => [
    primaryKey({ name: 'model_proposal_inputs_pk', columns: [t.organizationId, t.proposalId] }),
    foreignKey({
      name: 'model_proposal_inputs_proposal_fk',
      columns: [t.organizationId, t.proposalId],
      foreignColumns: [toolProposals.organizationId, toolProposals.id],
    }),
    foreignKey({
      name: 'model_proposal_inputs_snapshot_fk',
      columns: [t.organizationId, t.snapshotId],
      foreignColumns: [mainInputSnapshots.organizationId, mainInputSnapshots.id],
    }),
    check(
      'model_proposal_inputs_title_transform',
      sql`(${t.transformVersion} is null and ${t.derivedBodySha256} is null) or (${t.transformVersion} is not null and ${t.transformVersion}='work-title-v1' and ${t.derivedBodySha256} is not null and ${t.derivedBodySha256} ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

/** Actual compiler claim hashes before publication. No FK to mutable/deletable facts: a source purge
 * must retain the dependency proof after removing those bodies. No legacy reconstruction. */
export const evidencePackageFacts = pgSchema('knowledge').table(
  'evidence_package_facts',
  {
    organizationId: uuid().notNull(),
    packageId: uuid().notNull(),
    factId: uuid().notNull(),
    // NULL only on legacy receipts; never reconstructed from a later mutable/deleted fact row.
    subjectRef: text(),
    contentSha256: text().notNull(),
    classification: text().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'evidence_package_facts_pk',
      columns: [t.organizationId, t.packageId, t.factId],
    }),
    foreignKey({
      name: 'evidence_package_facts_package_fk',
      columns: [t.organizationId, t.packageId],
      foreignColumns: [knowledgeEvidencePackages.organizationId, knowledgeEvidencePackages.id],
    }),
    check('evidence_package_facts_hash', sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'evidence_package_facts_subject',
      sql`${t.subjectRef} is null or ${t.subjectRef} ~ '^(client|project|membership|team|work_unit|knowledge_source):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    check(
      'evidence_package_facts_class',
      sql`${t.classification} in('public','internal','confidential','restricted')`,
    ),
  ],
);
