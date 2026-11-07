// M7 tables: Agent Studio, process specs, custom objects, packs, Pulse, the outcome composer, onboarding,
// SSO and MFA (ADR-031). Roles, grants, RLS and the triggers that hold the rules are in reviewed SQL,
// migration 0401. Nothing here points at M4's `ai` tables or M5's knowledge tables by foreign key: those
// are written in parallel, and a port connects them at the final merge (ADR-031 D2).
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { identitySchema, memberships, orgSchema, organizations, sessions, users } from './schema';
import { artifacts, approvals, workUnits } from './schema-work';
import { agentDefinitions, agentRuns } from './schema-ai';
import { externalActions } from './schema-integrations';

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const tenantId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id);
const classificationCheck = (name: string, column: unknown) =>
  check(name, sql`${column} in ('public','internal','confidential','restricted')`);

export const studioSchema = pgSchema('studio');
export const objectsSchema = pgSchema('objects');
export const packsSchema = pgSchema('packs');
export const experienceSchema = pgSchema('experience');

// --- identity: reached by the auth role. Field names follow what Better Auth expects.

/** One person's TOTP enrolment. The plugin encrypts the secret and the backup codes (ADR-031 D8). */
export const twoFactors = identitySchema.table(
  'two_factors',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    verified: boolean().notNull().default(true),
    failedVerificationCount: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex('two_factors_one_per_user').on(t.userId)],
);

/**
 * A tenant's identity provider, in the shape the SSO plugin expects. SAML only: a tenant can never name
 * a host the server would connect to (ADR-031 D9). No secret lives here, only the provider's certificate.
 */
export const ssoProviders = identitySchema.table(
  'sso_providers',
  {
    id: uuid().primaryKey().defaultRandom(),
    providerId: text().notNull().unique(),
    issuer: text().notNull(),
    domain: text().notNull(),
    domainVerified: boolean().notNull().default(false),
    samlConfig: text(),
    oidcConfig: text(),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    organizationId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('sso_providers_no_oidc', sql`${t.oidcConfig} is null`),
    check('sso_providers_domain_format', sql`${t.domain} = lower(${t.domain})`),
  ],
);

/**
 * What a session has proven, and when. Written only by the auth role, after Better Auth accepted a code
 * or an assertion, so the application role can read this and cannot forge it. Gone with the session.
 */
export const sessionAssurances = identitySchema.table(
  'session_assurances',
  {
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ssoProviderId: text(),
    verifiedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.kind] }),
    index('session_assurances_user_idx').on(t.userId),
    check('session_assurances_kind', sql`${t.kind} in ('mfa_totp','mfa_backup_code','sso_saml')`),
    check(
      'session_assurances_sso_provider',
      sql`(${t.kind} = 'sso_saml') = (${t.ssoProviderId} is not null)`,
    ),
  ],
);

// --- org: one tenant's security settings.

/** How strict this tenant is. No row means the defaults in @ensemus/domain/product-policy. */
export const securityPolicies = orgSchema.table(
  'security_policies',
  {
    organizationId: tenantId().primaryKey(),
    /** Also ask for recent MFA on the M2 administrative actions. M7's actions always ask. */
    mfaForAdministration: boolean().notNull().default(false),
    mfaMaxAgeSeconds: integer().notNull(),
    ssoEnforcement: text().notNull().default('optional'),
    version: bigint({ mode: 'number' }).notNull().default(1),
    updatedByMembershipId: uuid(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.updatedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check('security_policies_mfa_age', sql`${t.mfaMaxAgeSeconds} between 60 and 3600`),
    check('security_policies_sso', sql`${t.ssoEnforcement} in ('optional','required')`),
  ],
);

/**
 * One tenant's link to one provider row. `domainState` can only be changed by the operator's command
 * (migration 0401), so no tenant can claim someone else's email domain and take over their accounts.
 */
export const ssoConnections = orgSchema.table(
  'sso_connections',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    providerId: text().notNull(),
    displayName: text().notNull(),
    domain: text().notNull(),
    domainState: text().notNull().default('unverified'),
    domainVerifiedAt: timestamp({ withTimezone: true }),
    state: text().notNull().default('draft'),
    /** Whether a verified person with no invitation joins as a member. Off unless an admin turns it on. */
    autoJoin: boolean().notNull().default(false),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdByMembershipId: uuid().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('sso_connections_provider_key').on(t.providerId),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    uniqueIndex('sso_connections_verified_domain_idx')
      .on(t.domain)
      .where(sql`${t.domainState} = 'verified'`),
    check('sso_connections_state', sql`${t.state} in ('draft','active','disabled')`),
    check('sso_connections_domain_state', sql`${t.domainState} in ('unverified','verified')`),
    check('sso_connections_domain_format', sql`${t.domain} = lower(${t.domain})`),
    check(
      'sso_connections_active_needs_domain',
      sql`${t.state} <> 'active' or ${t.domainState} = 'verified'`,
    ),
  ],
);

/** Who a membership is at the provider. Deprovisioning disables the membership and marks this. */
export const ssoMemberLinks = orgSchema.table(
  'sso_member_links',
  {
    organizationId: uuid().notNull(),
    membershipId: uuid().notNull(),
    connectionId: uuid().notNull(),
    externalSubject: text().notNull(),
    state: text().notNull().default('active'),
    lastLoginAt: timestamp({ withTimezone: true }),
    deprovisionedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.membershipId] }),
    unique('sso_member_links_subject_key').on(t.organizationId, t.connectionId, t.externalSubject),
    foreignKey({
      columns: [t.organizationId, t.membershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [ssoConnections.organizationId, ssoConnections.id],
    }),
    check('sso_member_links_state', sql`${t.state} in ('active','deprovisioned')`),
  ],
);

/** A provider's key for telling us someone left. Only the hash is kept, as with webhook endpoints. */
export const scimTokens = orgSchema.table(
  'scim_tokens',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    connectionId: uuid().notNull(),
    tokenHash: text().notNull().unique(),
    state: text().notNull().default('active'),
    createdByMembershipId: uuid().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [ssoConnections.organizationId, ssoConnections.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check('scim_tokens_state', sql`${t.state} in ('active','revoked')`),
  ],
);

// --- studio: drafts, simulations, reviews and process specs.

/** A guided agent setup while it is being written. Publishing turns it into M4's immutable version. */
export const agentDrafts = studioSchema.table(
  'agent_drafts',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    name: text().notNull(),
    ownerMembershipId: uuid().notNull(),
    /** The actual tenant-owned M4 definition this revises. */
    agentDefinitionId: uuid(),
    /** The guided answers, checked against `agentDraftAnswersSchema`. */
    answers: jsonb().notNull(),
    /** Hash of the spec these answers compile to. Simulations and reviews bind to this. */
    specSha256: text(),
    /** Exact compiled revision; a registry change cannot silently rebuild a reviewed spec. */
    compiledSpec: jsonb(),
    compiledSpecCanonical: text(),
    compilePolicyVersion: text(),
    status: text().notNull().default('editing'),
    fromPackInstallationId: uuid(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdByMembershipId: uuid().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.ownerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      name: 'agent_drafts_definition_fk',
      columns: [t.organizationId, t.agentDefinitionId],
      foreignColumns: [agentDefinitions.organizationId, agentDefinitions.id],
    }),
    index('agent_drafts_status_idx').on(t.organizationId, t.status, t.updatedAt),
    check(
      'agent_drafts_compilation',
      sql`(${t.compiledSpec} is null and ${t.compiledSpecCanonical} is null and ${t.compilePolicyVersion} is null)
      or (${t.compiledSpec} is not null and ${t.compiledSpecCanonical} is not null and ${t.compilePolicyVersion} is not null
        and ${t.specSha256} is not null and length(${t.compilePolicyVersion}) between 1 and 128
        and octet_length(${t.compiledSpecCanonical}) between 2 and 262144
        and ${t.compiledSpecCanonical}::jsonb=${t.compiledSpec}
        and ${t.specSha256}=encode(sha256(convert_to(${t.compiledSpecCanonical},'UTF8')),'hex'))`,
    ),
    check(
      'agent_drafts_status',
      sql`${t.status} in ('editing','in_review','published','archived')`,
    ),
  ],
);

/** A visual workflow while it is being drawn. Compiling it makes an immutable process spec. */
export const processDrafts = studioSchema.table(
  'process_drafts',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    name: text().notNull(),
    ownerMembershipId: uuid().notNull(),
    classification: text().notNull().default('internal'),
    graph: jsonb().notNull(),
    /** Hash of the spec this graph compiles to, or null while it does not compile. */
    specSha256: text(),
    status: text().notNull().default('editing'),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdByMembershipId: uuid().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.ownerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    classificationCheck('process_drafts_classification', t.classification),
    check(
      'process_drafts_status',
      sql`${t.status} in ('editing','in_review','published','archived')`,
    ),
  ],
);

/** A zero-side-effect rehearsal of exactly one spec hash. The report holds codes and never free text. */
export const simulationRuns = studioSchema.table(
  'simulation_runs',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    subjectKind: text().notNull(),
    /** A draft's ID, or null for a catalog workflow named by `subjectKey`. */
    subjectId: uuid(),
    subjectKey: text(),
    subjectSha256: text().notNull(),
    scenarioKey: text().notNull(),
    status: text().notNull().default('queued'),
    outcomeCode: text(),
    report: jsonb(),
    reportSha256: text(),
    requestedByMembershipId: uuid().notNull(),
    createdAt: createdAt(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.requestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('simulation_runs_subject_idx').on(t.organizationId, t.subjectKind, t.subjectId),
    check(
      'simulation_runs_kind',
      sql`${t.subjectKind} in ('agent_draft','process_draft','bundled_workflow')`,
    ),
    check('simulation_runs_subject', sql`(${t.subjectId} is null) <> (${t.subjectKey} is null)`),
    check(
      'simulation_runs_status',
      sql`${t.status} in ('queued','running','passed','failed','errored')`,
    ),
    check(
      'simulation_runs_report',
      sql`${t.status} not in ('passed','failed') or (${t.report} is not null and ${t.reportSha256} is not null)`,
    ),
  ],
);

/** A private immutable request-time snapshot. It is never portable execution authority. */
export const simulationInputs = studioSchema.table(
  'simulation_inputs',
  {
    organizationId: uuid().notNull(),
    simulationRunId: uuid().notNull(),
    sourceVersion: bigint({ mode: 'number' }).notNull(),
    specCanonical: text().notNull(),
    policyVersion: text().notNull(),
    requestedByMembershipId: uuid().notNull(),
    requestedSessionId: uuid().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.simulationRunId] }),
    foreignKey({
      name: 'simulation_inputs_run_fk',
      columns: [t.organizationId, t.simulationRunId],
      foreignColumns: [simulationRuns.organizationId, simulationRuns.id],
    }),
    foreignKey({
      name: 'simulation_inputs_requester_fk',
      columns: [t.organizationId, t.requestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check(
      'simulation_inputs_bounded',
      sql`${t.sourceVersion}>0 and octet_length(${t.specCanonical}) between 2 and 262144`,
    ),
  ],
);

/** Someone asking to publish one hash, and what was decided. Self-review is limited in SQL (D6). */
export const publishReviews = studioSchema.table(
  'publish_reviews',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    subjectKind: text().notNull(),
    subjectId: uuid().notNull(),
    subjectSha256: text().notNull(),
    simulationRunId: uuid().notNull(),
    riskLevel: text().notNull(),
    /** The capabilities the reader is asked to accept, as data. Fixed once written. */
    riskSummary: jsonb().notNull(),
    requestedByMembershipId: uuid().notNull(),
    reviewerMembershipId: uuid(),
    status: text().notNull().default('pending'),
    decidedByMembershipId: uuid(),
    decisionReason: text(),
    decidedAt: timestamp({ withTimezone: true }),
    /** What publishing produced: an M4 agent version, or a process spec. */
    publishedRef: uuid(),
    publishedAt: timestamp({ withTimezone: true }),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.simulationRunId],
      foreignColumns: [simulationRuns.organizationId, simulationRuns.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.requestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.reviewerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.decidedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    uniqueIndex('publish_reviews_one_open_idx')
      .on(t.organizationId, t.subjectKind, t.subjectId)
      .where(sql`${t.status} = 'pending'`),
    check('publish_reviews_kind', sql`${t.subjectKind} in ('agent_draft','process_draft')`),
    check('publish_reviews_risk', sql`${t.riskLevel} in ('standard','elevated')`),
    check(
      'publish_reviews_status',
      sql`${t.status} in ('pending','approved','rejected','cancelled','published')`,
    ),
  ],
);

/** A compiled process, immutable. A run names one exact row and is never moved to another. */
export const processSpecs = studioSchema.table(
  'process_specs',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    processKey: text().notNull(),
    versionNumber: integer().notNull(),
    name: text().notNull(),
    classification: text().notNull(),
    spec: jsonb().notNull(),
    specSha256: text().notNull(),
    source: text().notNull(),
    sourceRef: text(),
    publishedByMembershipId: uuid().notNull(),
    publishedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('process_specs_version_key').on(t.organizationId, t.processKey, t.versionNumber),
    foreignKey({
      columns: [t.organizationId, t.publishedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    classificationCheck('process_specs_classification', t.classification),
    check('process_specs_source', sql`${t.source} in ('graph','bundled','pack')`),
    check('process_specs_key', sql`${t.processKey} ~ '^[a-z][a-z0-9_.-]{1,63}$'`),
  ],
);

/** One execution of one spec. `startedBy` is rechecked before each step (ADR-031 D7). */
export const processRuns = studioSchema.table(
  'process_runs',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    specId: uuid().notNull(),
    rootWorkUnitId: uuid().notNull(),
    status: text().notNull().default('queued'),
    stopCode: text(),
    startedByMembershipId: uuid().notNull(),
    temporalRunId: text(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.specId],
      foreignColumns: [processSpecs.organizationId, processSpecs.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.rootWorkUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.startedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('process_runs_status_idx').on(t.organizationId, t.status, t.updatedAt),
    check(
      'process_runs_status',
      sql`${t.status} in ('queued','running','waiting','completed','failed','cancelled')`,
    ),
  ],
);

/** Where each step of a run stands, and the real record it made. Reference columns are write-once. */
export const processRunSteps = studioSchema.table(
  'process_run_steps',
  {
    organizationId: uuid().notNull(),
    runId: uuid().notNull(),
    stepKey: text().notNull(),
    status: text().notNull().default('pending'),
    stopCode: text(),
    workUnitId: uuid(),
    approvalId: uuid(),
    externalActionId: uuid(),
    /** The actual M4 run bound atomically to this step. */
    agentRunId: uuid(),
    artifactId: uuid(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.runId, t.stepKey] }),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [processRuns.organizationId, processRuns.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.approvalId],
      foreignColumns: [approvals.organizationId, approvals.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifacts.organizationId, artifacts.id],
    }),
    check(
      'process_run_steps_status',
      sql`${t.status} in ('pending','ready','waiting','done','failed','skipped')`,
    ),
    foreignKey({
      name: 'process_step_agent_run_fk',
      columns: [t.organizationId, t.agentRunId],
      foreignColumns: [agentRuns.organizationId, agentRuns.id],
    }),
    foreignKey({
      name: 'process_step_external_action_fk',
      columns: [t.organizationId, t.externalActionId],
      foreignColumns: [externalActions.organizationId, externalActions.id],
    }),
  ],
);

// --- objects: typed custom records (KNOW-07).

export const objectTypes = objectsSchema.table(
  'types',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    slug: text().notNull(),
    displayName: text().notNull(),
    /** The floor for every record of this type. A record can be stricter and never looser. */
    classification: text().notNull().default('internal'),
    currentVersionNumber: integer().notNull().default(1),
    state: text().notNull().default('active'),
    fromPackInstallationId: uuid(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdByMembershipId: uuid().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('object_types_slug_key').on(t.organizationId, t.slug),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    classificationCheck('object_types_classification', t.classification),
    check('object_types_state', sql`${t.state} in ('active','archived')`),
    check('object_types_slug_format', sql`${t.slug} ~ '^[a-z][a-z0-9_]{1,63}$'`),
  ],
);

/** One immutable shape of a type. Records name the version they were last checked against. */
export const objectTypeVersions = objectsSchema.table(
  'type_versions',
  {
    organizationId: uuid().notNull(),
    typeId: uuid().notNull(),
    versionNumber: integer().notNull(),
    fields: jsonb().notNull(),
    relations: jsonb().notNull(),
    schemaSha256: text().notNull(),
    createdByMembershipId: uuid().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.typeId, t.versionNumber] }),
    foreignKey({
      columns: [t.organizationId, t.typeId],
      foreignColumns: [objectTypes.organizationId, objectTypes.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
  ],
);

export const objectRecords = objectsSchema.table(
  'records',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    typeId: uuid().notNull(),
    typeVersionNumber: integer().notNull(),
    displayName: text().notNull(),
    attributes: jsonb().notNull(),
    classification: text().notNull(),
    ownerMembershipId: uuid().notNull(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdByMembershipId: uuid().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.typeId, t.typeVersionNumber],
      foreignColumns: [
        objectTypeVersions.organizationId,
        objectTypeVersions.typeId,
        objectTypeVersions.versionNumber,
      ],
    }),
    foreignKey({
      columns: [t.organizationId, t.ownerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('object_records_type_idx').on(t.organizationId, t.typeId, t.updatedAt),
    classificationCheck('object_records_classification', t.classification),
  ],
);

/** Only the fields a type marks as indexed. Filtering uses this, and never reaches into JSON. */
export const objectRecordValues = objectsSchema.table(
  'record_values',
  {
    organizationId: uuid().notNull(),
    recordId: uuid().notNull(),
    fieldKey: text().notNull(),
    valueText: text(),
    valueNumber: numeric(),
    valueTime: timestamp({ withTimezone: true }),
    valueBoolean: boolean(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.recordId, t.fieldKey] }),
    foreignKey({
      columns: [t.organizationId, t.recordId],
      foreignColumns: [objectRecords.organizationId, objectRecords.id],
    }).onDelete('cascade'),
    index('object_record_values_text_idx').on(t.organizationId, t.fieldKey, t.valueText),
    index('object_record_values_number_idx').on(t.organizationId, t.fieldKey, t.valueNumber),
    index('object_record_values_time_idx').on(t.organizationId, t.fieldKey, t.valueTime),
  ],
);

export const objectRelations = objectsSchema.table(
  'relations',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    relationKey: text().notNull(),
    fromRecordId: uuid().notNull(),
    toRecordId: uuid().notNull(),
    createdByMembershipId: uuid().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('object_relations_edge_key').on(
      t.organizationId,
      t.relationKey,
      t.fromRecordId,
      t.toRecordId,
    ),
    foreignKey({
      columns: [t.organizationId, t.fromRecordId],
      foreignColumns: [objectRecords.organizationId, objectRecords.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.toRecordId],
      foreignColumns: [objectRecords.organizationId, objectRecords.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('object_relations_to_idx').on(t.organizationId, t.toRecordId),
    check('object_relations_not_self', sql`${t.fromRecordId} <> ${t.toRecordId}`),
  ],
);

/** Moving a type's records from one version to the next, in batches, in the worker. */
export const objectMigrations = objectsSchema.table(
  'migrations',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    typeId: uuid().notNull(),
    fromVersionNumber: integer().notNull(),
    toVersionNumber: integer().notNull(),
    status: text().notNull().default('queued'),
    migratedCount: integer().notNull().default(0),
    failedCount: integer().notNull().default(0),
    errorCode: text(),
    requestedByMembershipId: uuid().notNull(),
    createdAt: createdAt(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.typeId],
      foreignColumns: [objectTypes.organizationId, objectTypes.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.requestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    uniqueIndex('object_migrations_one_open_idx')
      .on(t.organizationId, t.typeId)
      .where(sql`${t.status} in ('queued','running')`),
    check(
      'object_migrations_status',
      sql`${t.status} in ('queued','running','completed','failed')`,
    ),
    check('object_migrations_forward', sql`${t.toVersionNumber} > ${t.fromVersionNumber}`),
  ],
);

// --- packs: what was installed, and what an administrator said about each thing it asks for.

/** One pack at one version in one tenant. An upgrade is a new row, and a rollback reactivates an old one. */
export const packInstallations = packsSchema.table(
  'installations',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    packKey: text().notNull(),
    packVersion: text().notNull(),
    manifestSha256: text().notNull(),
    status: text().notNull().default('reviewing'),
    previousInstallationId: uuid(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    requestedByMembershipId: uuid().notNull(),
    activatedByMembershipId: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    activatedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.previousInstallationId],
      foreignColumns: [t.organizationId, t.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.requestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.activatedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    uniqueIndex('pack_installations_one_active_idx')
      .on(t.organizationId, t.packKey)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex('pack_installations_one_open_idx')
      .on(t.organizationId, t.packKey)
      .where(sql`${t.status} = 'reviewing'`),
    check(
      'pack_installations_status',
      sql`${t.status} in ('reviewing','active','superseded','rolled_back','cancelled')`,
    ),
  ],
);

/** Each thing a pack asks for, with who said what. A decision grants nothing by itself (D10). */
export const packCapabilityReviews = packsSchema.table(
  'capability_reviews',
  {
    organizationId: uuid().notNull(),
    installationId: uuid().notNull(),
    capabilityKey: text().notNull(),
    decision: text().notNull().default('pending'),
    decidedByMembershipId: uuid(),
    decidedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.installationId, t.capabilityKey] }),
    foreignKey({
      columns: [t.organizationId, t.installationId],
      foreignColumns: [packInstallations.organizationId, packInstallations.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.decidedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check('pack_capability_decision', sql`${t.decision} in ('pending','accepted','declined')`),
  ],
);

/** What an installation made, so an upgrade can compare and a rollback can undo. */
export const packInstalledItems = packsSchema.table(
  'installed_items',
  {
    organizationId: uuid().notNull(),
    installationId: uuid().notNull(),
    itemKind: text().notNull(),
    itemKey: text().notNull(),
    itemId: uuid().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.installationId, t.itemKind, t.itemKey] }),
    foreignKey({
      columns: [t.organizationId, t.installationId],
      foreignColumns: [packInstallations.organizationId, packInstallations.id],
    }),
    check(
      'pack_installed_item_kind',
      sql`${t.itemKind} in ('object_type','agent_draft','process_draft','process_spec')`,
    ),
  ],
);

// --- experience: small per-person and per-tenant state behind the pages.

/** One person's dismissal or snooze of one Pulse signal. The signal itself is always recomputed. */
export const pulseSignalStates = experienceSchema.table(
  'pulse_signal_states',
  {
    organizationId: uuid().notNull(),
    membershipId: uuid().notNull(),
    signalKey: text().notNull(),
    state: text().notNull(),
    until: timestamp({ withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.membershipId, t.signalKey] }),
    foreignKey({
      columns: [t.organizationId, t.membershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }).onDelete('cascade'),
    check('pulse_signal_state', sql`${t.state} in ('dismissed','snoozed')`),
    check('pulse_signal_until', sql`(${t.state} = 'snoozed') = (${t.until} is not null)`),
  ],
);

/** An objective, what it was read as, and whether anyone has said yes. Nothing runs from here alone. */
export const outcomeDrafts = experienceSchema.table(
  'outcome_drafts',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    objective: text().notNull(),
    preview: jsonb().notNull(),
    previewSha256: text().notNull(),
    status: text().notNull().default('draft'),
    workUnitId: uuid(),
    authorizedByMembershipId: uuid(),
    authorizedAt: timestamp({ withTimezone: true }),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdByMembershipId: uuid().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.authorizedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    index('outcome_drafts_author_idx').on(t.organizationId, t.createdByMembershipId, t.updatedAt),
    check('outcome_drafts_status', sql`${t.status} in ('draft','authorized','discarded')`),
    check(
      'outcome_drafts_authorized',
      sql`(${t.status} = 'authorized') = (${t.workUnitId} is not null and ${t.authorizedByMembershipId} is not null)`,
    ),
  ],
);

/** Only what cannot be read from the real records: that someone chose to skip or acknowledged a step. */
export const onboardingSteps = experienceSchema.table(
  'onboarding_steps',
  {
    organizationId: tenantId(),
    stepKey: text().notNull(),
    status: text().notNull(),
    decidedByMembershipId: uuid().notNull(),
    decidedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.stepKey] }),
    foreignKey({
      columns: [t.organizationId, t.decidedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check('onboarding_step_status', sql`${t.status} in ('acknowledged','skipped')`),
  ],
);
