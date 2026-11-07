// M4 tables: model profiles, agents, runs, usage, egress decisions and kill switches (ADR-028). Roles,
// grants, RLS and every trigger that holds a rule are in reviewed SQL, migration 0101. Money is bigint
// micro-USD. Nothing here holds a key: `secret_ref` points at a sealed secret. Only
// `ai.step_payloads.content` holds model text, and only the agent role can read it.
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
import {
  governanceSchema,
  memberships,
  organizations,
  orgSchema,
  platformSchema,
  sealedSecrets,
} from './schema';
import { externalActions } from './schema-integrations';
import { approvals, artifacts, workSchema, workUnits } from './schema-work';
import { modelCallAttempts, modelJobs } from './schema-model-jobs';

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const tenantId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id);
const micros = () => bigint({ mode: 'number' }).notNull();
const SHA256 = "'^[0-9a-f]{64}$'";
const CODE = "'^[A-Z][A-Z0-9_]{1,63}$'";
const classes = "('public','internal','confidential','restricted')";
const classificationCheck = (name: string, column: unknown) =>
  check(name, sql`${column} in ('public','internal','confidential','restricted')`);
const sha256Check = (name: string, column: unknown) =>
  check(name, sql`${column} ~ ${sql.raw(SHA256)}`);
const codeCheck = (name: string, column: unknown) => check(name, sql`${column} ~ ${sql.raw(CODE)}`);

export const aiSchema = pgSchema('ai');

/**
 * The identity an agent acts under in the audit trail. It grants nothing by itself: authority comes from
 * the run's initiator (ADR-028 FD-3). It always has a person who answers for it.
 */
export const serviceIdentities = orgSchema.table(
  'service_identities',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    ownerMembershipId: uuid().notNull(),
    purpose: text().notNull(),
    status: text().notNull().default('active'),
    expiresAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.ownerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check('service_identities_status_check', sql`${t.status} in ('active','disabled')`),
    check('service_identities_purpose_length', sql`char_length(${t.purpose}) between 1 and 200`),
  ],
);

/**
 * One approved model at one endpoint, for one tenant. Trigger `ai.check_model_profile_change` voids the
 * key and sends the row back to draft when the endpoint changes, and bumps `version` on any change a
 * pinned run must notice. Only the agent role can move a row to `active`, after a probe passed.
 */
export const modelProfiles = aiSchema.table(
  'model_profiles',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    version: integer().notNull().default(1),
    providerKind: text().notNull(),
    modelId: text().notNull(),
    alias: text().notNull(),
    endpointUrl: text().notNull(),
    /** A sealed secret whose purpose names this profile and endpoint. Null for a keyless local model. */
    secretRef: uuid(),
    billingOwner: text().notNull().default('customer'),
    region: text(),
    capabilities: text().array().notNull(),
    /** `{ maxInputTokens, maxOutputTokens }`. Integers, checked at the contract. */
    limits: jsonb().notNull(),
    allowedClasses: text()
      .array()
      .notNull()
      .default(sql`'{public}'::text[]`),
    allowedPurposes: text().array().notNull(),
    retentionBasis: text().notNull().default('unreviewed'),
    /** A person's record of the provider's terms. Without one, confidential data cannot be sent. */
    contractRef: text(),
    /** Off when empty. Each entry passes the full policy check again (FD-9). */
    fallbackProfileIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** A stored pre-approval for a fallback across `billing_owner`. Null means never. */
    crossBillingApprovedByMembershipId: uuid(),
    status: text().notNull().default('draft'),
    qualifiedAt: timestamp({ withTimezone: true }),
    /** Who last asked for a probe, for the audit row the probe writes. */
    probeRequestedByMembershipId: uuid(),
    /** Exact-version pending intent, retained independently of later session logout/deletion. */
    probeAuthorizedProfileVersion: integer(),
    probeAuthorizedMembershipId: uuid(),
    probeAuthorizedSessionId: uuid(),
    probeAuthorizedAt: timestamp({ withTimezone: true }),
    createdByMembershipId: uuid(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.secretRef],
      foreignColumns: [sealedSecrets.organizationId, sealedSecrets.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.probeRequestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      name: 'model_probe_authorization_member',
      columns: [t.organizationId, t.probeAuthorizedMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check(
      'model_probe_authorization_complete',
      sql`(
      (${t.probeAuthorizedProfileVersion} is null and ${t.probeAuthorizedMembershipId} is null
        and ${t.probeAuthorizedSessionId} is null and ${t.probeAuthorizedAt} is null)
      or (${t.probeAuthorizedProfileVersion} is not null and ${t.probeAuthorizedProfileVersion}>0
        and ${t.probeAuthorizedMembershipId} is not null and ${t.probeAuthorizedSessionId} is not null
        and ${t.probeAuthorizedAt} is not null))`,
    ),
    foreignKey({
      columns: [t.organizationId, t.crossBillingApprovedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    unique('model_profiles_alias_key').on(t.organizationId, t.alias),
    index('model_profiles_status_idx').on(t.organizationId, t.status),
    check(
      'model_profiles_kind_check',
      sql`${t.providerKind} in ('openai_hosted','anthropic_hosted','openai_compatible','local_openai_compatible')`,
    ),
    check(
      'model_profiles_status_check',
      sql`${t.status} in ('draft','probing','probe_failed','active','disabled')`,
    ),
    check('model_profiles_billing_check', sql`${t.billingOwner} in ('customer','ensemus')`),
    check(
      'model_profiles_retention_check',
      sql`${t.retentionBasis} in ('unreviewed','contract_recorded','self_hosted')`,
    ),
    check('model_profiles_version_check', sql`${t.version} > 0`),
    check(
      'model_profiles_classes_check',
      sql`${t.allowedClasses} <@ ARRAY['public','internal','confidential','restricted']::text[]`,
    ),
    check('model_profiles_alias_length', sql`char_length(${t.alias}) between 1 and 80`),
    check('model_profiles_model_length', sql`char_length(${t.modelId}) between 1 and 200`),
    check('model_profiles_url_length', sql`char_length(${t.endpointUrl}) between 8 and 500`),
  ],
);

/** What a model costs, as data. Immutable: a new price is a new row. No rate card denies the run. */
export const rateCards = aiSchema.table(
  'rate_cards',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    profileId: uuid().notNull(),
    version: integer().notNull(),
    inputMicrosPerMtok: micros(),
    outputMicrosPerMtok: micros(),
    source: text().notNull().default('tenant_estimate'),
    effectiveFrom: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdByMembershipId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.profileId],
      foreignColumns: [modelProfiles.organizationId, modelProfiles.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    unique('rate_cards_version_key').on(t.organizationId, t.profileId, t.version),
    check('rate_cards_source_check', sql`${t.source} in ('tenant_estimate','ensemus_card')`),
    check(
      'rate_cards_amounts_check',
      sql`${t.inputMicrosPerMtok} >= 0 AND ${t.outputMicrosPerMtok} >= 0`,
    ),
  ],
);

/** Results of probes and evaluation runs against a profile. Written only by the agent role. */
export const modelEvaluations = aiSchema.table(
  'model_evaluations',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    profileId: uuid().notNull(),
    profileVersion: integer().notNull(),
    /** `probe`, or an evaluation suite's reference. */
    suite: text().notNull(),
    passed: boolean().notNull(),
    /** Numbers and codes only, with the experiment's identity (07-evaluation §3). */
    metrics: jsonb().notNull().default({}),
    datasetVersion: text(),
    reportSha256: text(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.profileId],
      foreignColumns: [modelProfiles.organizationId, modelProfiles.id],
    }),
    index('model_evaluations_profile_idx').on(t.organizationId, t.profileId, t.createdAt),
  ],
);

export const agentDefinitions = aiSchema.table(
  'agent_definitions',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    /** The manifest's `id`, stable across versions. */
    slug: text().notNull(),
    name: text().notNull(),
    ownerMembershipId: uuid().notNull(),
    serviceIdentityId: uuid().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.ownerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.serviceIdentityId],
      foreignColumns: [serviceIdentities.organizationId, serviceIdentities.id],
    }),
    unique('agent_definitions_slug_key').on(t.organizationId, t.slug),
    check('agent_definitions_slug_format', sql`${t.slug} ~ '^[a-z][a-z0-9-]{2,80}$'`),
    check('agent_definitions_name_length', sql`char_length(${t.name}) between 1 and 120`),
  ],
);

/**
 * One published manifest. Immutable for every role: no UPDATE or DELETE grant, and a trigger as well.
 * "Signer" means the publishing membership plus the SHA-256 (ADR-028 FD-19).
 */
export const agentVersions = aiSchema.table(
  'agent_versions',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    definitionId: uuid().notNull(),
    versionNumber: integer().notNull(),
    spec: jsonb().notNull(),
    specSha256: text().notNull(),
    evaluationReportSha256: text().notNull(),
    policyVersion: text().notNull(),
    maxCostMicros: micros(),
    publishedByMembershipId: uuid().notNull(),
    publishedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.definitionId],
      foreignColumns: [agentDefinitions.organizationId, agentDefinitions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.publishedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    unique('agent_versions_number_key').on(t.organizationId, t.definitionId, t.versionNumber),
    check('agent_versions_number_check', sql`${t.versionNumber} > 0`),
    check('agent_versions_cost_check', sql`${t.maxCostMicros} >= 0`),
    sha256Check('agent_versions_spec_sha', t.specSha256),
    sha256Check('agent_versions_report_sha', t.evaluationReportSha256),
  ],
);

/** Which version new runs get. A running Work Unit keeps the one it started on. */
export const agentPublications = aiSchema.table(
  'agent_publications',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    definitionId: uuid().notNull(),
    versionId: uuid().notNull(),
    activeFrom: timestamp({ withTimezone: true }).notNull().defaultNow(),
    activeUntil: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.definitionId],
      foreignColumns: [agentDefinitions.organizationId, agentDefinitions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.versionId],
      foreignColumns: [agentVersions.organizationId, agentVersions.id],
    }),
    uniqueIndex('agent_publications_one_active')
      .on(t.organizationId, t.definitionId)
      .where(sql`${t.activeUntil} IS NULL`),
  ],
);

/**
 * One execution attempt on a Work Unit. Limits and scopes are written once, and no role can update them,
 * so a run cannot raise its own. Status follows the table in @ensemus/domain/ai through a trigger.
 */
export const agentRuns = aiSchema.table(
  'agent_runs',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    workUnitId: uuid().notNull(),
    agentVersionId: uuid().notNull(),
    parentRunId: uuid(),
    depth: integer().notNull().default(0),
    /** The person whose authority this run has. Re-read from PostgreSQL at every step. */
    initiatorMembershipId: uuid().notNull(),
    serviceIdentityId: uuid().notNull(),
    status: text().notNull().default('queued'),
    stopCode: text(),
    /** Only rises (FD-13). */
    effectiveClassification: text().notNull(),
    boundProfileId: uuid(),
    boundProfileVersion: integer(),
    /** Limits, fixed at start. */
    maxModelTurns: integer().notNull(),
    maxToolCalls: integer().notNull(),
    maxTotalTokens: bigint({ mode: 'number' }).notNull(),
    maxCostMicros: micros(),
    timeoutSeconds: integer().notNull(),
    maxDelegationDepth: integer().notNull().default(0),
    /** The tools and resources this run may use: the intersection, for a child. */
    delegatedScopes: jsonb().notNull(),
    /** Counters. They only rise. */
    modelTurns: integer().notNull().default(0),
    toolCalls: integer().notNull().default(0),
    inputTokens: bigint({ mode: 'number' }).notNull().default(0),
    outputTokens: bigint({ mode: 'number' }).notNull().default(0),
    costMicros: bigint({ mode: 'number' }).notNull().default(0),
    activeMs: bigint({ mode: 'number' }).notNull().default(0),
    temporalRunId: text(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    startedAt: timestamp({ withTimezone: true }),
    endedAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.agentVersionId],
      foreignColumns: [agentVersions.organizationId, agentVersions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.parentRunId],
      foreignColumns: [t.organizationId, t.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.initiatorMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.serviceIdentityId],
      foreignColumns: [serviceIdentities.organizationId, serviceIdentities.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.boundProfileId],
      foreignColumns: [modelProfiles.organizationId, modelProfiles.id],
    }),
    // One live run per Work Unit, which is also one live workflow under its standard ID (FD-1).
    uniqueIndex('agent_runs_one_live_per_work')
      .on(t.organizationId, t.workUnitId)
      .where(
        sql`${t.status} in ('queued','preparing','running','paused','waiting_for_approval','waiting_for_child','verifying')`,
      ),
    index('agent_runs_work_idx').on(t.organizationId, t.workUnitId, t.createdAt),
    index('agent_runs_parent_idx').on(t.organizationId, t.parentRunId),
    check(
      'agent_runs_status_check',
      sql`${t.status} in ('queued','preparing','running','paused','waiting_for_approval','waiting_for_child','verifying','completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified')`,
    ),
    check('agent_runs_class_check', sql`${t.effectiveClassification} in ${sql.raw(classes)}`),
    check('agent_runs_stop_format', sql`${t.stopCode} IS NULL OR ${t.stopCode} ~ ${sql.raw(CODE)}`),
    check(
      'agent_runs_limits_check',
      sql`${t.maxModelTurns} >= 1 AND ${t.maxToolCalls} >= 0 AND ${t.maxTotalTokens} >= 1 AND ${t.maxCostMicros} >= 0 AND ${t.timeoutSeconds} >= 1 AND ${t.maxDelegationDepth} >= 0 AND ${t.depth} >= 0`,
    ),
  ],
);

/** A person's stop, pause or resume. Append-only, and each step rechecks it before acting. */
export const runControls = aiSchema.table(
  'run_controls',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    runId: uuid().notNull(),
    kind: text().notNull(),
    byMembershipId: uuid().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.byMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('run_controls_run_idx').on(t.organizationId, t.runId, t.createdAt),
    check('run_controls_kind_check', sql`${t.kind} in ('stop','pause','resume')`),
  ],
);

/**
 * What a run did, in codes and counters. There is no free-text column on purpose: this is what the
 * timeline reads, so a model's words cannot reach a page (ADR-028 FD-5). The web tier may read it.
 */
export const executionSteps = aiSchema.table(
  'execution_steps',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    runId: uuid().notNull(),
    stepNumber: integer().notNull(),
    kind: text().notNull(),
    state: text().notNull(),
    outcome: text(),
    labelCode: text().notNull(),
    decisionCode: text(),
    attempt: integer().notNull().default(1),
    startedAt: createdAt(),
    endedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
    unique('execution_steps_number_key').on(t.organizationId, t.runId, t.stepNumber),
    check(
      'execution_steps_kind_check',
      sql`${t.kind} in ('prepare','model_turn','tool_call','approval_wait','delegation','verification')`,
    ),
    check(
      'execution_steps_state_check',
      sql`${t.state} in ('in_flight','completed','failed','cancelled')`,
    ),
    check('execution_steps_number_check', sql`${t.stepNumber} >= 0 AND ${t.attempt} >= 1`),
    codeCheck('execution_steps_label_format', t.labelCode),
    check(
      'execution_steps_decision_format',
      sql`${t.decisionCode} IS NULL OR ${t.decisionCode} ~ ${sql.raw(CODE)}`,
    ),
    check(
      'execution_steps_outcome_format',
      sql`${t.outcome} IS NULL OR ${t.outcome} ~ '^[a-z][a-z_]{1,40}$'`,
    ),
  ],
);

/**
 * The transcript the next turn needs. The agent role alone can read or write this (ADR-028 FD-4, FD-5),
 * so the web tier can never show a prompt, whatever a page does. Deleted when the run ends.
 */
export const stepPayloads = aiSchema.table(
  'step_payloads',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    stepId: uuid().notNull(),
    kind: text().notNull(),
    classification: text().notNull(),
    content: text().notNull(),
    contentSha256: text().notNull(),
    purgeAfter: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.stepId],
      foreignColumns: [executionSteps.organizationId, executionSteps.id],
    }),
    index('step_payloads_step_idx').on(t.organizationId, t.stepId),
    check(
      'step_payloads_kind_check',
      sql`${t.kind} in ('prompt','completion','tool_args','tool_output')`,
    ),
    classificationCheck('step_payloads_class_check', t.classification),
    sha256Check('step_payloads_sha', t.contentSha256),
    check('step_payloads_size_check', sql`octet_length(${t.content}) <= 4194304`),
  ],
);

/** A tool a model asked for. The proposed arguments live in `step_payloads`, and this holds the hash. */
export const toolProposals = aiSchema.table(
  'tool_proposals',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    runId: uuid().notNull(),
    stepId: uuid().notNull(),
    toolId: text().notNull(),
    toolVersion: text().notNull(),
    payloadHash: text().notNull(),
    idempotencyKey: text().notNull(),
    approvalId: uuid(),
    /** The M3 intent carrying this effect. Everything about sending it lives there (ADR-027). */
    externalActionId: uuid(),
    status: text().notNull().default('proposed'),
    decisionCode: text(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.stepId],
      foreignColumns: [executionSteps.organizationId, executionSteps.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.approvalId],
      foreignColumns: [approvals.organizationId, approvals.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.externalActionId],
      foreignColumns: [externalActions.organizationId, externalActions.id],
    }),
    unique('tool_proposals_step_key').on(t.organizationId, t.stepId),
    unique('tool_proposals_idempotency_key').on(t.organizationId, t.idempotencyKey),
    uniqueIndex('tool_proposals_approval_idx')
      .on(t.organizationId, t.approvalId)
      .where(sql`${t.approvalId} IS NOT NULL`),
    check(
      'tool_proposals_status_check',
      sql`${t.status} in ('proposed','denied','awaiting_approval','approved','running','done','failed','unknown_external_state','cancelled')`,
    ),
    sha256Check('tool_proposals_hash', t.payloadHash),
    check(
      'tool_proposals_decision_format',
      sql`${t.decisionCode} IS NULL OR ${t.decisionCode} ~ ${sql.raw(CODE)}`,
    ),
  ],
);

/** Where a draft's claims came from: `work_unit` and `artifact` in M4, and knowledge in M5. */
export const artifactEvidence = aiSchema.table(
  'artifact_evidence',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    artifactId: uuid().notNull(),
    sourceType: text().notNull(),
    sourceId: uuid().notNull(),
    sourceSha256: text(),
    runId: uuid().notNull(),
    stepId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifacts.organizationId, artifacts.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.stepId],
      foreignColumns: [executionSteps.organizationId, executionSteps.id],
    }),
    index('artifact_evidence_artifact_idx').on(t.organizationId, t.artifactId),
    check('artifact_evidence_source_check', sql`${t.sourceType} in ('work_unit','artifact')`),
  ],
);

/** That an agent is working on a Work Unit. It grants nobody access to anything (ADR-028 G13). */
export const agentAssignments = workSchema.table(
  'agent_assignments',
  {
    organizationId: tenantId(),
    workUnitId: uuid().notNull(),
    serviceIdentityId: uuid().notNull(),
    agentRunId: uuid().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.workUnitId, t.agentRunId] }),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.serviceIdentityId],
      foreignColumns: [serviceIdentities.organizationId, serviceIdentities.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.agentRunId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
  ],
);

/** A spending limit a person set. There is no default: no budget means no run. */
export const budgets = platformSchema.table(
  'budgets',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    scope: text().notNull(),
    /** Null for the organization's own budget. */
    agentVersionId: uuid(),
    /** `YYYY-MM`. A new month is a new row. */
    period: text().notNull(),
    limitMicros: micros(),
    reservedMicros: bigint({ mode: 'number' }).notNull().default(0),
    spentMicros: bigint({ mode: 'number' }).notNull().default(0),
    createdByMembershipId: uuid(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.agentVersionId],
      foreignColumns: [agentVersions.organizationId, agentVersions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    uniqueIndex('budgets_scope_key').on(
      t.organizationId,
      t.scope,
      sql`coalesce(${t.agentVersionId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.period,
    ),
    check('budgets_scope_check', sql`${t.scope} in ('organization','agent_version')`),
    check(
      'budgets_scope_target_check',
      sql`(${t.scope} = 'organization') = (${t.agentVersionId} IS NULL)`,
    ),
    check('budgets_period_format', sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      'budgets_amounts_check',
      sql`${t.limitMicros} >= 0 AND ${t.reservedMicros} >= 0 AND ${t.spentMicros} >= 0`,
    ),
  ],
);

export const budgetReservations = platformSchema.table(
  'budget_reservations',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    budgetId: uuid().notNull(),
    runId: uuid(),
    stepId: uuid(),
    modelJobId: uuid(),
    modelCallId: uuid(),
    attempt: integer().notNull().default(1),
    amountMicros: micros(),
    status: text().notNull().default('held'),
    createdAt: createdAt(),
    settledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.budgetId],
      foreignColumns: [budgets.organizationId, budgets.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.stepId],
      foreignColumns: [executionSteps.organizationId, executionSteps.id],
    }),
    uniqueIndex('budget_reservations_step_key')
      .on(t.organizationId, t.budgetId, t.stepId, t.attempt)
      .where(sql`${t.modelCallId} is null`),
    unique('budget_reservations_call_key').on(t.organizationId, t.budgetId, t.modelCallId),
    foreignKey({
      name: 'budget_reservations_model_job_fk',
      columns: [t.organizationId, t.modelJobId],
      foreignColumns: [modelJobs.organizationId, modelJobs.id],
    }),
    foreignKey({
      name: 'budget_reservations_model_call_fk',
      columns: [t.organizationId, t.modelCallId],
      foreignColumns: [modelCallAttempts.organizationId, modelCallAttempts.id],
    }),
    check(
      'budget_reservations_principal',
      sql`(${t.modelCallId} is null and ${t.modelJobId} is null and ${t.runId} is not null and ${t.stepId} is not null) or (${t.modelCallId} is not null and ((${t.modelJobId} is not null and ${t.runId} is null and ${t.stepId} is null) or (${t.modelJobId} is null and ${t.runId} is not null and ${t.stepId} is not null)))`,
    ),
    index('budget_reservations_run_idx').on(t.organizationId, t.runId),
    check('budget_reservations_status_check', sql`${t.status} in ('held','settled','released')`),
    check('budget_reservations_amount_check', sql`${t.amountMicros} >= 0`),
  ],
);

/** Append-only for every role, the owner included. A wrong row is corrected by another row. */
export const usageLedger = platformSchema.table(
  'usage_ledger',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    idempotencyKey: text().notNull(),
    meter: text().notNull(),
    quantity: bigint({ mode: 'number' }).notNull(),
    unit: text().notNull(),
    costMicros: micros(),
    rateCardId: uuid(),
    rateCardVersion: integer(),
    /** `YYYY-MM`. */
    billingPeriod: text().notNull(),
    commercialMode: text().notNull(),
    reservationId: uuid(),
    workUnitId: uuid(),
    runId: uuid(),
    modelJobId: uuid(),
    modelCallId: uuid(),
    stepId: uuid(),
    profileId: uuid(),
    profileVersion: integer(),
    providerKind: text(),
    requestHash: text(),
    status: text().notNull(),
    billable: boolean().notNull(),
    correctsId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('usage_ledger_idempotency_key').on(t.organizationId, t.idempotencyKey),
    foreignKey({
      columns: [t.organizationId, t.rateCardId],
      foreignColumns: [rateCards.organizationId, rateCards.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.reservationId],
      foreignColumns: [budgetReservations.organizationId, budgetReservations.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.stepId],
      foreignColumns: [executionSteps.organizationId, executionSteps.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.profileId],
      foreignColumns: [modelProfiles.organizationId, modelProfiles.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.correctsId],
      foreignColumns: [t.organizationId, t.id],
    }),
    index('usage_ledger_run_idx').on(t.organizationId, t.runId),
    index('usage_ledger_model_job_idx').on(t.organizationId, t.modelJobId),
    foreignKey({
      name: 'usage_ledger_model_job_fk',
      columns: [t.organizationId, t.modelJobId],
      foreignColumns: [modelJobs.organizationId, modelJobs.id],
    }),
    foreignKey({
      name: 'usage_ledger_model_call_fk',
      columns: [t.organizationId, t.modelCallId],
      foreignColumns: [modelCallAttempts.organizationId, modelCallAttempts.id],
    }),
    check(
      'usage_ledger_principal',
      sql`(${t.modelJobId} is null and ${t.runId} is not null and ${t.workUnitId} is not null) or (${t.modelJobId} is not null and ${t.modelCallId} is not null and ${t.runId} is null and ${t.workUnitId} is null and ${t.stepId} is null)`,
    ),
    index('usage_ledger_period_idx').on(t.organizationId, t.billingPeriod),
    check(
      'usage_ledger_meter_check',
      sql`${t.meter} in ('model_input_tokens','model_output_tokens','tool_call')`,
    ),
    check('usage_ledger_status_check', sql`${t.status} in ('estimated','final','correction')`),
    check('usage_ledger_mode_check', sql`${t.commercialMode} in ('cloud','byom','sovereign')`),
    check('usage_ledger_period_format', sql`${t.billingPeriod} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      'usage_ledger_correction_check',
      sql`(${t.status} = 'correction') = (${t.correctsId} IS NOT NULL)`,
    ),
    check(
      'usage_ledger_hash_format',
      sql`${t.requestHash} IS NULL OR ${t.requestHash} ~ ${sql.raw(SHA256)}`,
    ),
  ],
);

/** What a tenant may use, once something issues this. Unsigned until M6. */
export const entitlements = platformSchema.table(
  'entitlements',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    mode: text().notNull(),
    version: integer().notNull(),
    period: text().notNull(),
    features: text().array().notNull(),
    capacities: jsonb().notNull().default({}),
    signature: text(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('entitlements_version_key').on(t.organizationId, t.version),
    check('entitlements_mode_check', sql`${t.mode} in ('cloud','byom','sovereign')`),
  ],
);

/** One decision about whether data may leave, with or without a model call. Append-only. */
export const egressDecisions = governanceSchema.table(
  'egress_decisions',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    runId: uuid(),
    stepId: uuid(),
    profileId: uuid(),
    dataClass: text().notNull(),
    purpose: text().notNull(),
    destinationHost: text(),
    decision: text().notNull(),
    reasonCode: text().notNull(),
    policyVersion: text().notNull(),
    requestHash: text(),
    expiresAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.stepId],
      foreignColumns: [executionSteps.organizationId, executionSteps.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.profileId],
      foreignColumns: [modelProfiles.organizationId, modelProfiles.id],
    }),
    index('egress_decisions_run_idx').on(t.organizationId, t.runId),
    index('egress_decisions_time_idx').on(t.organizationId, t.createdAt),
    classificationCheck('egress_decisions_class_check', t.dataClass),
    check('egress_decisions_decision_check', sql`${t.decision} in ('allow','deny')`),
    codeCheck('egress_decisions_reason_format', t.reasonCode),
    check(
      'egress_decisions_hash_format',
      sql`${t.requestHash} IS NULL OR ${t.requestHash} ~ ${sql.raw(SHA256)}`,
    ),
  ],
);

/** A tenant's tightening of the default matrix. A document can only tighten: S1 enforces that. */
export const policyBundles = governanceSchema.table(
  'policy_bundles',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    version: integer().notNull(),
    sha256: text().notNull(),
    document: jsonb().notNull(),
    active: boolean().notNull().default(false),
    createdByMembershipId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    unique('policy_bundles_version_key').on(t.organizationId, t.version),
    uniqueIndex('policy_bundles_one_active')
      .on(t.organizationId)
      .where(sql`${t.active}`),
    sha256Check('policy_bundles_sha', t.sha256),
  ],
);

/**
 * An emergency stop (ADR-028 FD-15). `organization_id` is null for an operator's global or provider
 * switch, which only the migrator role can write. Every tenant reads them, and none can change them.
 */
export const killSwitches = governanceSchema.table(
  'kill_switches',
  {
    id: uuid().notNull().defaultRandom().primaryKey(),
    organizationId: uuid().references(() => organizations.id),
    scope: text().notNull(),
    /** A provider kind for `provider`, an agent version's ID for `agent_version`, else null. */
    targetRef: text(),
    reasonCode: text().notNull(),
    /** A membership for a tenant's switch, and null for an operator's. */
    engagedByMembershipId: uuid(),
    engagedAt: createdAt(),
    releasedAt: timestamp({ withTimezone: true }),
    releasedByMembershipId: uuid(),
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.engagedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.releasedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('kill_switches_live_idx')
      .on(t.organizationId, t.scope)
      .where(sql`${t.releasedAt} IS NULL`),
    check(
      'kill_switches_scope_check',
      sql`${t.scope} in ('global','organization','provider','agent_version')`,
    ),
    // An operator's switch has no tenant, and a tenant's own switch has to have one.
    check(
      'kill_switches_tenant_check',
      sql`(${t.scope} IN ('global','provider') AND ${t.organizationId} IS NULL) OR (${t.scope} IN ('organization','agent_version') AND ${t.organizationId} IS NOT NULL)`,
    ),
    check(
      'kill_switches_target_check',
      sql`(${t.scope} IN ('provider','agent_version')) = (${t.targetRef} IS NOT NULL)`,
    ),
    codeCheck('kill_switches_reason_format', t.reasonCode),
  ],
);
