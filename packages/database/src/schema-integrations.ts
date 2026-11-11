// M3 tables: connections, sync, verified external actions and webhooks (ADR-027). Roles, grants, RLS and
// the triggers that hold the at-most-one-effect rule are in reviewed SQL, migration 0013. Workspace suites'
// consent attempts and directory groups (ADR-038) are in 0560, and their rules in 0561.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
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
import { memberships, organizations, sealedSecrets } from './schema';
import { approvals, teams, workUnits } from './schema-work';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const tenantId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id);

export const integrationsSchema = pgSchema('integrations');

/**
 * One configured connector in one tenant. Holds a reference to a sealed credential, never the
 * credential, and settings that are safe to show. A tenant cannot name a host: where a connector may
 * connect is an operator's setting on the egress gateway (ADR-027 D5).
 */
export const connections = integrationsSchema.table(
  'connections',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    connectorType: text().notNull(),
    displayName: text().notNull(),
    state: text().notNull().default('active'),
    credentialSecretId: uuid(),
    /** Settings checked against the connector's own schema. Never a secret and never a host. */
    config: jsonb().notNull().default({}),
    grantedScopes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    version: bigint({ mode: 'number' }).notNull().default(1),
    /** A code from a fixed list, for the admin's page. Provider text never goes here. */
    lastErrorCode: text(),
    lastErrorAt: timestamp({ withTimezone: true }),
    createdByMembershipId: uuid(),
    /**
     * Null for the organization's connection, set for one member's own (ADR-038 D5, migration 0560).
     * Fixed once written, and only that member's consent can set it.
     */
    ownerMembershipId: uuid(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.credentialSecretId],
      foreignColumns: [sealedSecrets.organizationId, sealedSecrets.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.ownerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('connections_type_idx').on(t.organizationId, t.connectorType, t.state),
    index('connections_owner_idx')
      .on(t.organizationId, t.ownerMembershipId)
      .where(sql`${t.ownerMembershipId} is not null`),
    check('connections_state_check', sql`${t.state} in ('active','disabled','revoked')`),
    check('connections_type_format', sql`${t.connectorType} ~ '^[a-z][a-z0-9_]{1,63}$'`),
    check('connections_version_check', sql`${t.version} > 0`),
  ],
);

/**
 * Something a connector found at its source. Unique per connection and source ID, so applying the same
 * page twice changes nothing (CONNECT-01). `seenGeneration` lets a full sync mark what has gone.
 */
export const externalResources = integrationsSchema.table(
  'external_resources',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    connectionId: uuid().notNull(),
    /** Which stream found it. A full sync decides what has gone one stream at a time, by this. */
    stream: text().notNull(),
    resourceType: text().notNull(),
    externalId: text().notNull(),
    externalVersion: text(),
    displayName: text(),
    contentSha256: text(),
    classification: text().notNull().default('internal'),
    /** `mapped` only when every source grant found a person or team here. Anything else denies. */
    aclState: text().notNull().default('unmapped'),
    seenGeneration: bigint({ mode: 'number' }).notNull().default(0),
    deletedAt: timestamp({ withTimezone: true }),
    firstSeenAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('external_resources_source_key').on(t.organizationId, t.connectionId, t.externalId),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
    }),
    index('external_resources_generation_idx').on(
      t.organizationId,
      t.connectionId,
      t.stream,
      t.seenGeneration,
    ),
    check('external_resources_stream_format', sql`${t.stream} ~ '^[a-z0-9_.-]{1,64}$'`),
    check('external_resources_acl_state', sql`${t.aclState} in ('mapped','partial','unmapped')`),
    check(
      'external_resources_classification',
      sql`${t.classification} in ('public','internal','confidential','restricted')`,
    ),
  ],
);

/**
 * Who the source says may see a resource, and who that is here. A principal that maps to nobody keeps
 * its row with both targets empty, so it can be shown and retried, and it grants nothing.
 */
export const externalResourceAcl = integrationsSchema.table(
  'external_resource_acl',
  {
    organizationId: uuid().notNull(),
    resourceId: uuid().notNull(),
    principalKind: text().notNull(),
    principalExternalId: text().notNull(),
    access: text().notNull(),
    membershipId: uuid(),
    teamId: uuid(),
    syncedGeneration: bigint({ mode: 'number' }).notNull().default(0),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.organizationId, t.resourceId, t.principalKind, t.principalExternalId, t.access],
    }),
    foreignKey({
      columns: [t.organizationId, t.resourceId],
      foreignColumns: [externalResources.organizationId, externalResources.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.membershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.teamId],
      foreignColumns: [teams.organizationId, teams.id],
    }).onDelete('cascade'),
    index('external_resource_acl_member_idx').on(t.organizationId, t.membershipId),
    check(
      'external_resource_acl_kind',
      sql`${t.principalKind} in ('user','group','domain','anyone')`,
    ),
    check('external_resource_acl_access', sql`${t.access} in ('read','write','owner')`),
    check(
      'external_resource_acl_one_target',
      sql`num_nonnulls(${t.membershipId}, ${t.teamId}) <= 1`,
    ),
  ],
);

/**
 * How far one stream of one connection has read. The cursor is the provider's opaque text, kept here
 * and never put in Temporal. `generation` is compare-and-swap: a page commits with the cursor it was
 * read from, or not at all (CONNECT-01).
 */
export const syncCursors = integrationsSchema.table(
  'sync_cursors',
  {
    organizationId: uuid().notNull(),
    connectionId: uuid().notNull(),
    stream: text().notNull(),
    cursor: text(),
    watermark: timestamp({ withTimezone: true }),
    generation: bigint({ mode: 'number' }).notNull().default(0),
    /** Moves on each full sync. Resources not seen in the latest full one have gone at the source. */
    fullSyncGeneration: bigint({ mode: 'number' }).notNull().default(0),
    /** From a full sync's first read until its last page commits, however many passes that takes. */
    fullSyncInProgress: boolean().notNull().default(false),
    /** How the last pass stands. `resync_required` means a full sync is owed and has not started. */
    state: text().notNull().default('idle'),
    leaseUntil: timestamp({ withTimezone: true }),
    lastSyncedAt: timestamp({ withTimezone: true }),
    lastErrorCode: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.connectionId, t.stream] }),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
    }),
    check(
      'sync_cursors_state_check',
      sql`${t.state} in ('idle','running','failed','resync_required')`,
    ),
    check('sync_cursors_stream_format', sql`${t.stream} ~ '^[a-z0-9_.-]{1,64}$'`),
  ],
);

/**
 * One consent attempt at Google or Microsoft (ADR-038 D1, migrations 0560 and 0561). It holds references to
 * sealed values and the SHA-256 of the state, never the values. Everything but its progress is fixed once
 * written, a trigger holds the status to OAUTH_TRANSITIONS, and the database sets its ten-minute expiry.
 */
export const oauthAuthorizations = integrationsSchema.table(
  'oauth_authorizations',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    connectorType: text().notNull(),
    displayName: text().notNull(),
    /** The connection's settings, checked like any connection's. Never a secret and never a host. */
    config: jsonb().notNull().default({}),
    /** `platform` is the operator's app, whose secret only the connector worker holds (ADR-038 D2). */
    clientKind: text().notNull(),
    /** Public. The web tier needs it to build the provider's authorize URL. */
    clientId: text().notNull(),
    /** Sealed `{client_id, client_secret}` of a customer's own app. Null for the operator's. */
    customerClientSecretId: uuid(),
    requestedCapabilities: text().array().notNull(),
    requestedScopes: text().array().notNull(),
    ownerMembershipId: uuid(),
    startedByMembershipId: uuid().notNull(),
    /** Hex SHA-256 of the state parameter. The state itself is never stored. */
    stateSha256: text().notNull(),
    verifierSecretId: uuid().notNull(),
    codeSecretId: uuid(),
    status: text().notNull().default('pending'),
    /** A code from OAUTH_ERROR_CODES. Provider text never goes here. */
    errorCode: text(),
    connectionId: uuid(),
    /** Set by the database to ten minutes after the row is written, whatever the caller sends. */
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.customerClientSecretId],
      foreignColumns: [sealedSecrets.organizationId, sealedSecrets.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.verifierSecretId],
      foreignColumns: [sealedSecrets.organizationId, sealedSecrets.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.codeSecretId],
      foreignColumns: [sealedSecrets.organizationId, sealedSecrets.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.ownerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.startedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
    }),
    index('oauth_authorizations_status_idx').on(t.organizationId, t.status, t.expiresAt),
    index('oauth_authorizations_started_by_idx').on(
      t.organizationId,
      t.startedByMembershipId,
      t.createdAt,
    ),
    uniqueIndex('oauth_authorizations_one_per_connection')
      .on(t.organizationId, t.connectionId)
      .where(sql`${t.connectionId} is not null`),
    check(
      'oauth_authorizations_connector_type',
      sql`${t.connectorType} in ('google_workspace','microsoft_365')`,
    ),
    check(
      'oauth_authorizations_display_name',
      sql`char_length(${t.displayName}) between 1 and 200`,
    ),
    check(
      'oauth_authorizations_config_size',
      sql`jsonb_typeof(${t.config}) = 'object' and octet_length(${t.config}::text) <= 4096`,
    ),
    check('oauth_authorizations_client_kind', sql`${t.clientKind} in ('platform','customer')`),
    check('oauth_authorizations_client_id', sql`char_length(${t.clientId}) between 1 and 512`),
    check(
      'oauth_authorizations_customer_secret',
      sql`(${t.clientKind} = 'customer') = (${t.customerClientSecretId} is not null)`,
    ),
    check(
      'oauth_authorizations_capabilities',
      sql`cardinality(${t.requestedCapabilities}) between 1 and 6 and ${t.requestedCapabilities} <@ array['files','directory','mail','calendar','documents','chat']::text[]`,
    ),
    check('oauth_authorizations_scopes', sql`cardinality(${t.requestedScopes}) between 1 and 64`),
    check(
      'oauth_authorizations_owner_self',
      sql`${t.ownerMembershipId} is null or ${t.ownerMembershipId} = ${t.startedByMembershipId}`,
    ),
    check('oauth_authorizations_state_sha256', sql`${t.stateSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'oauth_authorizations_status',
      sql`${t.status} in ('pending','code_received','exchanging','connected','denied','failed','expired')`,
    ),
    check(
      'oauth_authorizations_error_code',
      sql`${t.errorCode} is null or ${t.errorCode} ~ '^[A-Z][A-Z0-9_]{2,63}$'`,
    ),
    check(
      'oauth_authorizations_error_when_refused',
      sql`(${t.status} in ('denied','failed')) = (${t.errorCode} is not null)`,
    ),
    check(
      'oauth_authorizations_connection_when_connected',
      sql`(${t.status} = 'connected') = (${t.connectionId} is not null)`,
    ),
    check(
      'oauth_authorizations_code_when_received',
      sql`${t.status} not in ('code_received','exchanging','connected') or ${t.codeSecretId} is not null`,
    ),
    check(
      'oauth_authorizations_expiry',
      sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '10 minutes'`,
    ),
  ],
);

/**
 * A provider group mirrored as a team (ADR-038 D4, migrations 0560 and 0561). Only the directory sync for
 * this connection may write it, or change the team and its members. Google groups are keyed by email and
 * Microsoft groups by object ID, which is what each one's file permissions carry.
 */
export const directoryGroups = integrationsSchema.table(
  'directory_groups',
  {
    organizationId: tenantId(),
    connectionId: uuid().notNull(),
    externalId: text().notNull(),
    teamId: uuid().notNull(),
    displayName: text().notNull(),
    /** The directory pass that last saw it. A completed full pass removes groups it did not see. */
    seenGeneration: bigint({ mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.connectionId, t.externalId] }),
    unique('directory_groups_team').on(t.organizationId, t.teamId),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.teamId],
      foreignColumns: [teams.organizationId, teams.id],
    }).onDelete('cascade'),
    index('directory_groups_generation_idx').on(t.organizationId, t.connectionId, t.seenGeneration),
    check('directory_groups_external_id', sql`char_length(${t.externalId}) between 1 and 1024`),
    check('directory_groups_display_name', sql`char_length(${t.displayName}) between 1 and 500`),
    check('directory_groups_generation', sql`${t.seenGeneration} >= 0`),
  ],
);

/**
 * An external action intent: one exact proposed effect (ADR-027 D1). Everything that defines the effect
 * is fixed when the row is written, and no role can update it, so changing a recipient means a new row
 * with a new hash and a new approval. A trigger holds the status to the state machine.
 */
export const externalActions = integrationsSchema.table(
  'external_actions',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    workUnitId: uuid().notNull(),
    connectionId: uuid().notNull(),
    toolName: text().notNull(),
    toolVersion: text().notNull(),
    targetRef: text().notNull(),
    /** The exact payload, under the Work Unit's access rules. Never in Temporal, events or audit. */
    payload: jsonb().notNull(),
    /** `actionHash` of tool name, version, target and payload. Rechecked before each send. */
    requestHash: text().notNull(),
    /** The same for every attempt, and handed to the provider where it takes one. */
    idempotencyKey: text().notNull(),
    classification: text().notNull(),
    requiresApproval: boolean().notNull().default(true),
    approvalId: uuid(),
    /** This intent replaces that one: its recipients or text changed. */
    supersedesId: uuid(),
    /** A person decided that one did not happen, and asked for it again. */
    retryOfId: uuid(),
    status: text().notNull(),
    /** A code from the fixed list in @ensemus/domain/external-action. Never provider text. */
    statusReason: text(),
    /** What the provider calls it, or for email the Message-ID we set. */
    externalId: text(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdByMembershipId: uuid(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ withTimezone: true }),
    /** Only a person leaves `unknown` without a provider's word. Who, what they found, and why. */
    resolvedByMembershipId: uuid(),
    resolution: text(),
    resolutionReason: text(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('external_actions_idempotency_key').on(t.organizationId, t.idempotencyKey),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.approvalId],
      foreignColumns: [approvals.organizationId, approvals.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.supersedesId],
      foreignColumns: [t.organizationId, t.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.retryOfId],
      foreignColumns: [t.organizationId, t.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.resolvedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    // One approval authorizes one effect, so it cannot be spent twice.
    uniqueIndex('external_actions_one_per_approval')
      .on(t.organizationId, t.approvalId)
      .where(sql`${t.approvalId} is not null`),
    index('external_actions_work_idx').on(t.organizationId, t.workUnitId, t.createdAt),
    index('external_actions_status_idx').on(t.organizationId, t.status, t.updatedAt),
    check(
      'external_actions_status_check',
      sql`${t.status} in ('awaiting_approval','ready','sending','reconciling','sent','failed','unknown','cancelled')`,
    ),
    check(
      'external_actions_classification',
      sql`${t.classification} in ('public','internal','confidential')`,
    ),
    check(
      'external_actions_approval_required',
      sql`not ${t.requiresApproval} or ${t.approvalId} is not null`,
    ),
    check(
      'external_actions_resolution_check',
      sql`${t.resolution} in ('confirmed_sent','confirmed_not_sent')`,
    ),
    check(
      'external_actions_resolution_whole',
      sql`(${t.resolution} is null) = (${t.resolvedByMembershipId} is null) and (${t.resolution} is null) = (${t.resolutionReason} is null)`,
    ),
    check('external_actions_version_check', sql`${t.version} > 0`),
    check('external_actions_payload_size', sql`octet_length(${t.payload}::text) <= 262144`),
  ],
);

/**
 * One try at the effect, written and committed before any byte leaves (ADR-027 D2). The row is the
 * claim: a trigger refuses another while an earlier one could have reached the provider.
 */
export const externalActionAttempts = integrationsSchema.table(
  'external_action_attempts',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    externalActionId: uuid().notNull(),
    attemptNo: integer().notNull(),
    requestHash: text().notNull(),
    idempotencyKey: text().notNull(),
    /** The Temporal run that claimed this. An ID only, for tracing a run to its effect. */
    runId: text().notNull(),
    recordedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Null means it may still be in flight, which is not the same as not sent. */
    outcome: text(),
    /** A code from the fixed list, such as SMTP_TIMEOUT_AFTER_DATA. Never provider text. */
    outcomeCode: text(),
    providerStatus: integer(),
    externalId: text(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('external_action_attempts_number').on(t.organizationId, t.externalActionId, t.attemptNo),
    foreignKey({
      columns: [t.organizationId, t.externalActionId],
      foreignColumns: [externalActions.organizationId, externalActions.id],
    }),
    check(
      'external_action_attempts_outcome',
      sql`${t.outcome} in ('accepted','rejected','not_sent','indeterminate')`,
    ),
    check('external_action_attempts_no_range', sql`${t.attemptNo} between 1 and 5`),
  ],
);

/** What a person is shown as having happened, and on whose word. Append-only for everyone. */
export const externalActionReceipts = integrationsSchema.table(
  'external_action_receipts',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    externalActionId: uuid().notNull(),
    attemptId: uuid(),
    outcome: text().notNull(),
    /** `provider` and `reconciliation` are the outside system's word, and `person` is someone's own. */
    basis: text().notNull(),
    code: text(),
    providerStatus: integer(),
    externalId: text(),
    requestHash: text().notNull(),
    actorMembershipId: uuid(),
    recordedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.externalActionId],
      foreignColumns: [externalActions.organizationId, externalActions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.attemptId],
      foreignColumns: [externalActionAttempts.organizationId, externalActionAttempts.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.actorMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('external_action_receipts_action_idx').on(
      t.organizationId,
      t.externalActionId,
      t.recordedAt,
    ),
    // A retried Activity writing the same result finds it already there.
    uniqueIndex('external_action_receipts_once_per_attempt')
      .on(t.organizationId, t.attemptId, t.outcome)
      .where(sql`${t.attemptId} is not null`),
    check(
      'external_action_receipts_outcome',
      sql`${t.outcome} in ('sent','failed','unknown','cancelled')`,
    ),
    check(
      'external_action_receipts_basis',
      sql`${t.basis} in ('provider','reconciliation','person','system')`,
    ),
    check(
      'external_action_receipts_person_named',
      sql`${t.basis} <> 'person' or ${t.actorMembershipId} is not null`,
    ),
  ],
);

/**
 * A public callback address (ADR-024 D4's `webhook_routes`). The URL holds an opaque token and only its
 * hash is stored. Limits are held here so admitting a delivery is one atomic update (ADR-027 D4).
 */
export const webhookEndpoints = integrationsSchema.table(
  'webhook_endpoints',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    connectionId: uuid().notNull(),
    tokenHash: text().notNull().unique(),
    signingSecretId: uuid().notNull(),
    /** The secret being replaced, accepted until the time below so a rotation drops nothing. */
    previousSigningSecretId: uuid(),
    previousSecretValidUntil: timestamp({ withTimezone: true }),
    signatureScheme: text().notNull(),
    state: text().notNull().default('active'),
    maxBodyBytes: integer().notNull().default(262_144),
    ratePerMinute: integer().notNull().default(120),
    maxBytesPerMinute: bigint({ mode: 'number' }).notNull().default(16_777_216),
    maxPendingBytes: bigint({ mode: 'number' }).notNull().default(268_435_456),
    timestampToleranceSeconds: integer().notNull().default(300),
    windowStartedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    windowDeliveries: integer().notNull().default(0),
    windowBytes: bigint({ mode: 'number' }).notNull().default(0),
    pendingBytes: bigint({ mode: 'number' }).notNull().default(0),
    createdByMembershipId: uuid(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.signingSecretId],
      foreignColumns: [sealedSecrets.organizationId, sealedSecrets.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.previousSigningSecretId],
      foreignColumns: [sealedSecrets.organizationId, sealedSecrets.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('webhook_endpoints_connection_idx').on(t.organizationId, t.connectionId),
    check('webhook_endpoints_state_check', sql`${t.state} in ('active','disabled','revoked')`),
    check('webhook_endpoints_body_limit', sql`${t.maxBodyBytes} between 1024 and 1048576`),
    check('webhook_endpoints_rate_limit', sql`${t.ratePerMinute} between 1 and 600`),
    check('webhook_endpoints_byte_rate', sql`${t.maxBytesPerMinute} between 1024 and 67108864`),
    check('webhook_endpoints_pending', sql`${t.maxPendingBytes} between 1024 and 1073741824`),
    check('webhook_endpoints_window', sql`${t.timestampToleranceSeconds} between 30 and 900`),
    check('webhook_endpoints_pending_positive', sql`${t.pendingBytes} >= 0`),
  ],
);

/**
 * What arrived, stored exactly and not yet believed. The web tier cannot verify it (ADR-027 D4), so
 * nothing reads the body until the worker has checked its signature, and the bytes go when that ends.
 */
export const webhookDeliveries = integrationsSchema.table(
  'webhook_deliveries',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    endpointId: uuid().notNull(),
    /** SHA-256 of the signature headers and the body. The same request stored once. */
    requestDigest: text().notNull(),
    body: bytea(),
    bodySha256: text().notNull(),
    sizeBytes: integer().notNull(),
    /** Only the headers on the allowlist in @ensemus/domain/webhook, each of them bounded. */
    headers: jsonb(),
    state: text().notNull().default('received'),
    rejectCode: text(),
    /** The sender's event ID, once the signature has proved they are who sent it. */
    providerEventId: text(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('webhook_deliveries_request').on(t.organizationId, t.endpointId, t.requestDigest),
    foreignKey({
      columns: [t.organizationId, t.endpointId],
      foreignColumns: [webhookEndpoints.organizationId, webhookEndpoints.id],
    }),
    index('webhook_deliveries_state_idx').on(t.organizationId, t.state, t.receivedAt),
    check(
      'webhook_deliveries_state_check',
      sql`${t.state} in ('received','applied','duplicate','rejected','failed')`,
    ),
    check('webhook_deliveries_size_check', sql`${t.sizeBytes} between 0 and 1048576`),
    check(
      'webhook_deliveries_body_bound',
      sql`${t.body} is null or octet_length(${t.body}) <= 1048576`,
    ),
    check(
      'webhook_deliveries_headers_bound',
      sql`${t.headers} is null or octet_length(${t.headers}::text) <= 8192`,
    ),
  ],
);

/**
 * One suite read an agent asked for (ADR-038 D6, migration 0563). The agent role writes the request, the
 * connector worker answers it, and the agent role collects the answer into the step's transcript, which
 * clears `output` here. Only the agent role and the worker's service context see a row, and only the agent
 * role reads `output`.
 */
export const suiteReads = integrationsSchema.table(
  'suite_reads',
  {
    organizationId: uuid().notNull(),
    proposalId: uuid().notNull(),
    runId: uuid().notNull(),
    stepId: uuid().notNull(),
    connectionId: uuid().notNull(),
    toolId: text().notNull(),
    toolVersion: text().notNull(),
    /** A model's arguments. Data for the connector, never instructions. */
    args: jsonb().notNull(),
    resourceExternalId: text(),
    status: text().notNull().default('requested'),
    resultCode: text(),
    output: bytea(),
    outputMediaType: text(),
    outputClassification: text(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.proposalId] }),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
    }),
    index('suite_reads_run_idx').on(t.organizationId, t.runId),
    check(
      'suite_reads_status_check',
      sql`${t.status} in ('requested','read','refused','collected')`,
    ),
    check(
      'suite_reads_result_format',
      sql`${t.resultCode} IS NULL OR ${t.resultCode} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
    ),
    check(
      'suite_reads_output_size',
      sql`${t.output} IS NULL OR octet_length(${t.output}) <= 1048576`,
    ),
    check(
      'suite_reads_output_class',
      sql`${t.outputClassification} IS NULL OR ${t.outputClassification} in ('public','internal','confidential','restricted')`,
    ),
    check(
      'suite_reads_output_only_when_read',
      sql`(${t.output} IS NOT NULL) = (${t.status} = 'read')`,
    ),
    check('suite_reads_tool_format', sql`${t.toolId} ~ '^[a-z][a-z0-9_.]{1,63}$'`),
  ],
);

/**
 * What members may connect with their own account (ADR-038 D5, migration 0563). No row means the default,
 * mail and calendar. Only a person with connection.manage changes it.
 */
export const suiteSettings = integrationsSchema.table(
  'suite_settings',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    memberCapabilities: text()
      .array()
      .notNull()
      .default(sql`'{mail,calendar}'::text[]`),
    updatedByMembershipId: uuid().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId] }),
    foreignKey({
      columns: [t.organizationId, t.updatedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }).onDelete('no action'),
    check(
      'suite_settings_member_capabilities',
      sql`${t.memberCapabilities} <@ ARRAY['mail','calendar','documents','chat']::text[]`,
    ),
  ],
);
