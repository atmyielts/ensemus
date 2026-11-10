// Content-free, version-pinned model authority. A standalone Knowledge job is a genuine principal;
// it is never represented as an AgentRun or granted an agent's context. Only job_payloads has text.
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { memberships, organizations } from './schema';
import { agentRuns, executionSteps, modelProfiles, rateCards } from './schema-ai';
import { connections } from './schema-integrations';
import { knowledgeSources } from './schema-knowledge';

const ai = pgSchema('ai');
const tenant = () => uuid().notNull();
const at = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const micros = () => bigint({ mode: 'number' }).notNull();
const bounds = () => ({
  maxCalls: integer().notNull(),
  maxInputTokens: integer().notNull(),
  maxOutputTokens: integer().notNull(),
  maxTotalTokens: bigint({ mode: 'number' }).notNull(),
  maxCostMicros: micros(),
  timeoutSeconds: integer().notNull(),
});

export const modelOperationQualifications = ai.table(
  'model_operation_qualifications',
  {
    organizationId: tenant(),
    id: uuid().notNull().defaultRandom(),
    profileId: uuid().notNull(),
    profileVersion: integer().notNull(),
    purpose: text().notNull(),
    protocol: text().notNull(),
    dimension: integer(),
    vectorSpaceVersion: text(),
    state: text().notNull().default('requested'),
    requestedByMembershipId: uuid().notNull(),
    requestKey: uuid().notNull(),
    ...bounds(),
    resultDigest: text(),
    qualifiedAt: timestamp({ withTimezone: true }),
    createdAt: at(),
  },
  (t) => [
    primaryKey({ name: 'model_operation_qualifications_pk', columns: [t.organizationId, t.id] }),
    foreignKey({
      name: 'model_qualifications_org_fk',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }),
    foreignKey({
      name: 'model_operation_qualifications_profile_fk',
      columns: [t.organizationId, t.profileId],
      foreignColumns: [modelProfiles.organizationId, modelProfiles.id],
    }),
    foreignKey({
      name: 'model_operation_qualifications_requester_fk',
      columns: [t.organizationId, t.requestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    unique('model_operation_qualifications_request_key').on(
      t.organizationId,
      t.requestedByMembershipId,
      t.requestKey,
    ),
    index('model_operation_qualifications_profile_idx').on(
      t.organizationId,
      t.profileId,
      t.profileVersion,
      t.purpose,
    ),
    check(
      'model_operation_qualifications_state',
      sql`${t.state} in ('requested','passed','failed')`,
    ),
    check(
      'model_operation_qualifications_shape',
      sql`(${t.purpose}='embed' and ${t.protocol}='native_embedding_v1' and ${t.dimension} is not null and ${t.dimension} between 1 and 8192 and ${t.vectorSpaceVersion} is not null and char_length(${t.vectorSpaceVersion}) between 1 and 256) or (${t.purpose}='rerank' and ${t.protocol}='structured_ranking_v1' and ${t.dimension} is null and ${t.vectorSpaceVersion} is null) or (${t.purpose}='answer' and ${t.protocol}='text_answer_v1' and ${t.dimension} is null and ${t.vectorSpaceVersion} is null)`,
    ),
    check(
      'model_operation_qualifications_receipt',
      sql`(${t.state}='passed')=(${t.qualifiedAt} is not null) and (${t.resultDigest} is null or ${t.resultDigest} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      'model_operation_qualifications_bounds',
      sql`ai.valid_model_bounds(${t.maxCalls},${t.maxInputTokens},${t.maxOutputTokens},${t.maxTotalTokens},${t.maxCostMicros},${t.timeoutSeconds}) and ${t.maxCalls}=1`,
    ),
  ],
);

export const modelWorkloadApprovals = ai.table(
  'model_workload_approvals',
  {
    organizationId: tenant(),
    id: uuid().notNull().defaultRandom(),
    kind: text().notNull(),
    scope: text().notNull(),
    sourceId: uuid(),
    connectionId: uuid(),
    purposes: text().array().notNull(),
    maxClassification: text().notNull(),
    ...bounds(),
    approvedByMembershipId: uuid().notNull(),
    requestKey: uuid().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: at(),
  },
  (t) => [
    primaryKey({ name: 'model_workload_approvals_pk', columns: [t.organizationId, t.id] }),
    foreignKey({
      name: 'model_workload_approvals_org_fk',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }),
    foreignKey({
      name: 'model_workload_approvals_source_fk',
      columns: [t.organizationId, t.sourceId],
      foreignColumns: [knowledgeSources.organizationId, knowledgeSources.id],
    }),
    foreignKey({
      name: 'model_workload_approvals_connection_fk',
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
    }),
    foreignKey({
      name: 'model_workload_approvals_approver_fk',
      columns: [t.organizationId, t.approvedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    unique('model_workload_approvals_request_key').on(
      t.organizationId,
      t.approvedByMembershipId,
      t.requestKey,
    ),
    check(
      'model_workload_approvals_kind',
      sql`${t.kind} in ('document_embed','query','answer','agent_context')`,
    ),
    check(
      'model_workload_approvals_purposes',
      sql`cardinality(${t.purposes}) between 1 and 3 and ${t.purposes} <@ array['embed','rerank','answer']::text[]`,
    ),
    check(
      'model_workload_approvals_scope',
      sql`(${t.scope}='organization' and ${t.kind}<>'document_embed' and ${t.sourceId} is null and ${t.connectionId} is null) or (${t.scope}='source' and ${t.kind}='document_embed' and ${t.sourceId} is not null and ${t.connectionId} is null) or (${t.scope}='connection' and ${t.kind}='document_embed' and ${t.sourceId} is null and ${t.connectionId} is not null)`,
    ),
    check(
      'model_workload_approvals_class',
      sql`${t.maxClassification} in ('public','internal','confidential','restricted')`,
    ),
    check(
      'model_workload_approvals_bounds',
      sql`ai.valid_model_bounds(${t.maxCalls},${t.maxInputTokens},${t.maxOutputTokens},${t.maxTotalTokens},${t.maxCostMicros},${t.timeoutSeconds})`,
    ),
  ],
);

export const modelWorkloadProfiles = ai.table(
  'model_workload_profiles',
  {
    organizationId: uuid().notNull(),
    approvalId: uuid().notNull(),
    qualificationId: uuid().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'model_workload_profiles_pk',
      columns: [t.organizationId, t.approvalId, t.qualificationId],
    }),
    foreignKey({
      name: 'model_workload_profiles_approval_fk',
      columns: [t.organizationId, t.approvalId],
      foreignColumns: [modelWorkloadApprovals.organizationId, modelWorkloadApprovals.id],
    }),
    foreignKey({
      name: 'model_workload_profiles_qualification_fk',
      columns: [t.organizationId, t.qualificationId],
      foreignColumns: [
        modelOperationQualifications.organizationId,
        modelOperationQualifications.id,
      ],
    }),
  ],
);

export const modelJobs = ai.table(
  'model_jobs',
  {
    organizationId: tenant(),
    id: uuid().notNull().defaultRandom(),
    requesterMembershipId: uuid().notNull(),
    approvalId: uuid(),
    qualificationId: uuid(),
    kind: text().notNull(),
    documentId: uuid(),
    answerId: uuid(),
    requestKey: uuid().notNull(),
    requestHash: text().notNull(),
    classification: text().notNull(),
    ...bounds(),
    state: text().notNull().default('prepared'),
    deadlineAt: timestamp({ withTimezone: true }).notNull(),
    calls: integer().notNull().default(0),
    reservedMicros: bigint({ mode: 'number' }).notNull().default(0),
    spentMicros: bigint({ mode: 'number' }).notNull().default(0),
    reservedTokens: bigint({ mode: 'number' }).notNull().default(0),
    usedTokens: bigint({ mode: 'number' }).notNull().default(0),
    fencedAt: timestamp({ withTimezone: true }),
    fenceGeneration: integer().notNull().default(0),
    payloadsPurgedAt: timestamp({ withTimezone: true }),
    purgedFenceGeneration: integer(),
    refusalCode: text(),
    resultPackageId: uuid(),
    createdAt: at(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: 'model_jobs_pk', columns: [t.organizationId, t.id] }),
    foreignKey({
      name: 'model_jobs_org_fk',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }),
    foreignKey({
      name: 'model_jobs_requester_fk',
      columns: [t.organizationId, t.requesterMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      name: 'model_jobs_approval_fk',
      columns: [t.organizationId, t.approvalId],
      foreignColumns: [modelWorkloadApprovals.organizationId, modelWorkloadApprovals.id],
    }),
    foreignKey({
      name: 'model_jobs_qualification_fk',
      columns: [t.organizationId, t.qualificationId],
      foreignColumns: [
        modelOperationQualifications.organizationId,
        modelOperationQualifications.id,
      ],
    }),
    unique('model_jobs_request_key').on(t.organizationId, t.requesterMembershipId, t.requestKey),
    uniqueIndex('model_jobs_one_qualification')
      .on(t.organizationId, t.qualificationId)
      .where(sql`${t.qualificationId} is not null`),
    uniqueIndex('model_jobs_one_answer')
      .on(t.organizationId, t.answerId)
      .where(sql`${t.answerId} is not null`),
    uniqueIndex('model_jobs_one_document_approval')
      .on(t.organizationId, t.documentId, t.approvalId)
      .where(sql`${t.kind}='document_embed'`),
    index('model_jobs_active_idx').on(t.organizationId, t.state, t.deadlineAt),
    check(
      'model_jobs_shape',
      sql`(${t.kind}='qualification' and ${t.qualificationId} is not null and ${t.approvalId} is null and ${t.documentId} is null and ${t.answerId} is null) or (${t.kind}='document_embed' and ${t.approvalId} is not null and ${t.qualificationId} is null and ${t.documentId} is not null and ${t.answerId} is null) or (${t.kind}='answer' and ${t.approvalId} is not null and ${t.qualificationId} is null and ${t.documentId} is null and ${t.answerId} is not null) or (${t.kind}='query' and ${t.approvalId} is not null and ${t.qualificationId} is null and ${t.documentId} is null and ${t.answerId} is null)`,
    ),
    check(
      'model_jobs_state',
      sql`${t.state} in ('prepared','running','completed','refused','fenced')`,
    ),
    check('model_jobs_hash', sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'model_jobs_counters',
      sql`${t.calls}>=0 and ${t.reservedMicros}>=0 and ${t.spentMicros}>=0 and ${t.reservedTokens}>=0 and ${t.usedTokens}>=0`,
    ),
    check(
      'model_jobs_class',
      sql`${t.classification} in ('public','internal','confidential','restricted')`,
    ),
    check(
      'model_jobs_bounds',
      sql`ai.valid_model_bounds(${t.maxCalls},${t.maxInputTokens},${t.maxOutputTokens},${t.maxTotalTokens},${t.maxCostMicros},${t.timeoutSeconds})`,
    ),
    check(
      'model_jobs_refusal_code',
      sql`${t.refusalCode} is null or ${t.refusalCode} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
    ),
    check(
      'model_jobs_payload_receipt',
      sql`((${t.fencedAt} is null and ${t.fenceGeneration}=0)or(${t.fencedAt} is not null and ${t.fenceGeneration}=1)) and((${t.payloadsPurgedAt} is null and ${t.purgedFenceGeneration} is null)or(${t.payloadsPurgedAt} is not null and ${t.purgedFenceGeneration} is not null and ${t.purgedFenceGeneration}=${t.fenceGeneration} and ${t.fenceGeneration}=1))`,
    ),
  ],
);

export const modelCallAttempts = ai.table(
  'model_call_attempts',
  {
    organizationId: tenant(),
    id: uuid().notNull().defaultRandom(),
    jobId: uuid(),
    runId: uuid(),
    stepId: uuid(),
    operationKey: text().notNull(),
    requestHash: text().notNull(),
    inputInventoryHash: text().notNull(),
    purpose: text().notNull(),
    profileId: uuid().notNull(),
    profileVersion: integer().notNull(),
    qualificationId: uuid().notNull(),
    approvalId: uuid(),
    classification: text().notNull(),
    policyVersion: text().notNull(),
    rateCardId: uuid().notNull(),
    rateCardVersion: integer().notNull(),
    commercialMode: text().notNull(),
    billingOwner: text().notNull(),
    billingPeriod: text().notNull(),
    maxInputTokens: integer().notNull(),
    maxOutputTokens: integer().notNull(),
    reservedMicros: micros(),
    state: text().notNull().default('prepared'),
    inputTokens: bigint({ mode: 'number' }),
    outputTokens: bigint({ mode: 'number' }),
    costMicros: bigint({ mode: 'number' }),
    status: text(),
    reasonCode: text(),
    resultKind: text(),
    resultId: uuid(),
    createdAt: at(),
    dispatchedAt: timestamp({ withTimezone: true }),
    receivedAt: timestamp({ withTimezone: true }),
    acceptedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: 'model_call_attempts_pk', columns: [t.organizationId, t.id] }),
    foreignKey({
      name: 'model_call_attempts_org_fk',
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
    }),
    foreignKey({
      name: 'model_call_attempts_job_fk',
      columns: [t.organizationId, t.jobId],
      foreignColumns: [modelJobs.organizationId, modelJobs.id],
    }),
    foreignKey({
      name: 'model_call_attempts_run_fk',
      columns: [t.organizationId, t.runId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
    foreignKey({
      name: 'model_call_attempts_step_fk',
      columns: [t.organizationId, t.stepId],
      foreignColumns: [executionSteps.organizationId, executionSteps.id],
    }),
    foreignKey({
      name: 'model_call_attempts_profile_fk',
      columns: [t.organizationId, t.profileId],
      foreignColumns: [modelProfiles.organizationId, modelProfiles.id],
    }),
    foreignKey({
      name: 'model_call_attempts_qualification_fk',
      columns: [t.organizationId, t.qualificationId],
      foreignColumns: [
        modelOperationQualifications.organizationId,
        modelOperationQualifications.id,
      ],
    }),
    foreignKey({
      name: 'model_call_attempts_approval_fk',
      columns: [t.organizationId, t.approvalId],
      foreignColumns: [modelWorkloadApprovals.organizationId, modelWorkloadApprovals.id],
    }),
    foreignKey({
      name: 'model_call_attempts_rate_fk',
      columns: [t.organizationId, t.rateCardId],
      foreignColumns: [rateCards.organizationId, rateCards.id],
    }),
    uniqueIndex('model_call_attempts_job_key')
      .on(t.organizationId, t.jobId, t.operationKey)
      .where(sql`${t.jobId} is not null`),
    uniqueIndex('model_call_attempts_run_key')
      .on(t.organizationId, t.runId, t.stepId, t.operationKey)
      .where(sql`${t.runId} is not null`),
    check(
      'model_call_attempts_principal',
      sql`(${t.jobId} is not null and ${t.runId} is null and ${t.stepId} is null) or (${t.jobId} is null and ${t.runId} is not null and ${t.stepId} is not null and ${t.approvalId} is not null)`,
    ),
    check('model_call_attempts_purpose', sql`${t.purpose} in ('embed','rerank','answer')`),
    check(
      'model_call_attempts_state',
      sql`${t.state} in ('prepared','dispatched','response_received','accepted','unknown','refused')`,
    ),
    check(
      'model_call_attempts_hashes',
      sql`${t.operationKey} ~ '^[0-9a-f]{64}$' and ${t.requestHash} ~ '^[0-9a-f]{64}$' and ${t.inputInventoryHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'model_call_attempts_class',
      sql`${t.classification} in ('public','internal','confidential','restricted')`,
    ),
    check(
      'model_call_attempts_amounts',
      sql`${t.profileVersion}>0 and ${t.rateCardVersion}>0 and ${t.maxInputTokens}>=0 and ${t.maxOutputTokens}>=0 and ${t.reservedMicros} between 0 and 9007199254740991 and(${t.inputTokens} is null or ${t.inputTokens} between 0 and 9007199254740991) and(${t.outputTokens} is null or ${t.outputTokens} between 0 and 9007199254740991) and(${t.costMicros} is null or ${t.costMicros} between 0 and 9007199254740991)`,
    ),
    check(
      'model_call_attempts_billing',
      sql`${t.commercialMode} in('cloud','byom','sovereign') and ${t.billingOwner} in('customer','ensemus') and ${t.billingPeriod} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      'model_call_attempts_reason',
      sql`${t.reasonCode} is null or ${t.reasonCode} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
    ),
    check(
      'model_call_attempts_result',
      sql`(${t.state}='accepted' and ${t.acceptedAt} is not null and ${t.resultId} is not null and ${t.resultKind} is not null and ${t.resultKind} in('embeddings','answer','evidence','qualification'))or(${t.state}<>'accepted' and ${t.acceptedAt} is null and ${t.resultId} is null and ${t.resultKind} is null)`,
    ),
  ],
);

/** Source IDs and hashes survive body purge. A chunk reference has its actual source ID alongside it. */
export const modelCallInputs = ai.table(
  'model_call_inputs',
  {
    organizationId: uuid().notNull(),
    callId: uuid().notNull(),
    kind: text().notNull(),
    inputId: uuid().notNull(),
    sourceId: uuid(),
    sha256: text().notNull(),
    classification: text().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'model_call_inputs_pk',
      columns: [t.organizationId, t.callId, t.kind, t.inputId, t.sha256],
    }),
    foreignKey({
      name: 'model_call_inputs_call_fk',
      columns: [t.organizationId, t.callId],
      foreignColumns: [modelCallAttempts.organizationId, modelCallAttempts.id],
    }),
    foreignKey({
      name: 'model_call_inputs_source_fk',
      columns: [t.organizationId, t.sourceId],
      foreignColumns: [knowledgeSources.organizationId, knowledgeSources.id],
    }),
    index('model_call_inputs_source_idx').on(t.organizationId, t.sourceId, t.callId),
    check('model_call_inputs_kind', sql`${t.kind} in ('chunk','work_unit','project','client')`),
    check('model_call_inputs_source_shape', sql`(${t.kind}='chunk')=(${t.sourceId} is not null)`),
    check('model_call_inputs_hash', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'model_call_inputs_class',
      sql`${t.classification} in ('public','internal','confidential','restricted')`,
    ),
  ],
);

/** No SELECT grant for app/web, even for its own request. The model process alone reads and purges. */
export const modelJobPayloads = ai.table(
  'model_job_payloads',
  {
    organizationId: uuid().notNull(),
    jobId: uuid().notNull(),
    query: text().notNull(),
    createdAt: at(),
  },
  (t) => [
    primaryKey({ name: 'model_job_payloads_pk', columns: [t.organizationId, t.jobId] }),
    foreignKey({
      name: 'model_job_payloads_job_fk',
      columns: [t.organizationId, t.jobId],
      foreignColumns: [modelJobs.organizationId, modelJobs.id],
    }),
    check('model_job_payloads_size', sql`octet_length(${t.query}) between 1 and 8192`),
  ],
);
