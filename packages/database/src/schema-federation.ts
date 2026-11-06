// M11C tables: cross-organization collaboration (ADR-035 D1 to D4). One explicit grant table, and a copy
// on each side of anything that crosses. Roles, grants, RLS and the triggers that hold both consents are in
// reviewed SQL, migration 0703.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { memberships, organizations } from './schema';
import { workUnits } from './schema-work';

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const when = () => timestamp({ withTimezone: true });

export const federationSchema = pgSchema('federation');

/** A tenant's own switch. No row means off. */
export const federationOrgSettings = federationSchema.table(
  'org_settings',
  {
    organizationId: uuid()
      .primaryKey()
      .references(() => organizations.id),
    enabled: boolean().notNull().default(false),
    version: bigint({ mode: 'number' }).notNull().default(1),
    changedByMembershipId: uuid().notNull(),
    changedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'org_settings_changed_by_fk',
      columns: [t.organizationId, t.changedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check('org_settings_version_check', sql`${t.version} > 0`),
  ],
);

/**
 * The only thing that lets anything cross between two tenants, and the only table both of them can read.
 * `terms` is the technical scope both owners agreed to, and `termsHash` covers it. It is not a contract:
 * no legal wording lives here. Nothing that crosses is stored on this row.
 */
export const federationGrants = federationSchema.table(
  'grants',
  {
    id: uuid().primaryKey().defaultRandom(),
    sharingOrganizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    /** Unknown until someone accepts the invitation, because nobody can look up another tenant. */
    receivingOrganizationId: uuid().references(() => organizations.id),
    status: text().notNull().default('proposed'),
    purpose: text().notNull(),
    maxClassification: text().notNull().default('internal'),
    terms: jsonb().notNull(),
    termsHash: text().notNull(),
    /** Only the hash. The token goes once to whoever the sharing owner chooses to give it to. */
    tokenHash: text().notNull(),
    invitationExpiresAt: timestamp({ withTimezone: true }).notNull(),
    /** Every grant ends by itself. There is no grant without a date. */
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /** Each side's real name when it consented, frozen, so neither needs to read the other's row. */
    sharingDisplayName: text().notNull(),
    receivingDisplayName: text(),
    proposedByMembershipId: uuid().notNull(),
    acceptedByMembershipId: uuid(),
    acceptedTermsHash: text(),
    acceptedAt: when(),
    confirmedByMembershipId: uuid(),
    confirmedTermsHash: text(),
    confirmedAt: when(),
    endedByOrganizationId: uuid().references(() => organizations.id),
    endedByMembershipId: uuid(),
    endReason: text(),
    endedAt: when(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('grants_token_hash_key').on(t.tokenHash),
    foreignKey({
      name: 'grants_proposed_by_fk',
      columns: [t.sharingOrganizationId, t.proposedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      name: 'grants_accepted_by_fk',
      columns: [t.receivingOrganizationId, t.acceptedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      name: 'grants_confirmed_by_fk',
      columns: [t.sharingOrganizationId, t.confirmedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      name: 'grants_ended_by_fk',
      columns: [t.endedByOrganizationId, t.endedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check(
      'grants_not_self',
      sql`${t.receivingOrganizationId} is distinct from ${t.sharingOrganizationId}`,
    ),
    check('grants_status_check', sql`${t.status} in ('proposed','accepted','active','ended')`),
    check('grants_purpose_check', sql`${t.purpose} in ('delegated_work','document_review')`),
    check(
      'grants_max_classification_check',
      sql`${t.maxClassification} in ('public','internal','confidential')`,
    ),
    check(
      'grants_end_reason_check',
      sql`${t.endReason} is null or ${t.endReason} in ('cancelled','declined','revoked','expired','disabled')`,
    ),
    check(
      'grants_ended_shape',
      sql`(${t.status} = 'ended') = (${t.endReason} is not null and ${t.endedAt} is not null and ${t.endedByOrganizationId} is not null)`,
    ),
    check(
      'grants_accepted_shape',
      sql`${t.status} not in ('accepted','active') or (${t.receivingOrganizationId} is not null and ${t.acceptedByMembershipId} is not null and ${t.acceptedTermsHash} is not null and ${t.acceptedAt} is not null and ${t.receivingDisplayName} is not null)`,
    ),
    check(
      'grants_active_shape',
      sql`${t.status} <> 'active' or (${t.confirmedByMembershipId} is not null and ${t.confirmedTermsHash} is not null and ${t.confirmedAt} is not null)`,
    ),
    check('grants_terms_hash_format', sql`${t.termsHash} ~ '^[0-9a-f]{64}$'`),
    check('grants_token_hash_format', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('grants_expiry_order', sql`${t.invitationExpiresAt} <= ${t.expiresAt}`),
    check('grants_version_check', sql`${t.version} > 0`),
  ],
);

/**
 * What one tenant chose to send, in that tenant. A copy holding only what a contract allows, so the bridge
 * never reads a source record. A file's key is fixed by a check to this tenant's own prefix, so no row can
 * point the worker at someone else's bytes.
 */
export const federationOutboundItems = federationSchema.table(
  'outbound_items',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    id: uuid().notNull().defaultRandom(),
    grantId: uuid()
      .notNull()
      .references(() => federationGrants.id),
    kind: text().notNull(),
    /** Where it came from, in this tenant, so deleting the source can withdraw it. */
    sourceType: text(),
    sourceId: uuid(),
    classification: text().notNull(),
    title: text().notNull(),
    body: jsonb().notNull().default({}),
    contentSha256: text().notNull(),
    fileObjectKey: text(),
    fileSha256: text(),
    fileSizeBytes: bigint({ mode: 'number' }),
    fileMimeType: text(),
    state: text().notNull().default('queued'),
    refuseCode: text(),
    createdByMembershipId: uuid().notNull(),
    createdAt: createdAt(),
    deliveredAt: when(),
    withdrawnAt: when(),
    version: bigint({ mode: 'number' }).notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      name: 'outbound_items_created_by_fk',
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('outbound_items_grant_idx').on(t.grantId, t.createdAt),
    index('outbound_items_source_idx').on(t.organizationId, t.sourceType, t.sourceId),
    check(
      'outbound_items_kind_check',
      sql`${t.kind} in ('work_summary','artifact','status_update')`,
    ),
    check(
      'outbound_items_source_type_check',
      sql`${t.sourceType} is null or ${t.sourceType} in ('work_unit','artifact')`,
    ),
    check(
      'outbound_items_classification_check',
      sql`${t.classification} in ('public','internal','confidential')`,
    ),
    check('outbound_items_title_length', sql`char_length(${t.title}) between 1 and 200`),
    check('outbound_items_body_size', sql`pg_column_size(${t.body}) <= 65536`),
    check(
      'outbound_items_state_check',
      sql`${t.state} in ('queued','delivered','refused','withdrawn')`,
    ),
    check(
      'outbound_items_refuse_code_format',
      sql`${t.refuseCode} is null or ${t.refuseCode} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
    ),
    check('outbound_items_content_hash_format', sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'outbound_items_file_hash_format',
      sql`${t.fileSha256} is null or ${t.fileSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'outbound_items_file_key_derived',
      sql`${t.fileObjectKey} is null or ${t.fileObjectKey} = 'federation/outbound/' || ${t.organizationId}::text || '/' || ${t.id}::text`,
    ),
    check(
      'outbound_items_file_complete',
      sql`(${t.fileObjectKey} is null) = (${t.fileSha256} is null) and (${t.fileObjectKey} is null) = (${t.fileSizeBytes} is null) and (${t.fileObjectKey} is null) = (${t.fileMimeType} is null)`,
    ),
    check(
      'outbound_items_artifact_has_file',
      sql`(${t.kind} = 'artifact') = (${t.fileObjectKey} is not null)`,
    ),
    check('outbound_items_version_check', sql`${t.version} > 0`),
  ],
);

/**
 * What arrived, in the receiving tenant, and only readable while the grant is open. Treated like an email
 * from a stranger: it is another company's words, so it is never an instruction to an agent.
 */
export const federationInboundItems = federationSchema.table(
  'inbound_items',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    /** The same as the outbound row's, so a repeated delivery finds the first. */
    id: uuid().notNull(),
    grantId: uuid()
      .notNull()
      .references(() => federationGrants.id),
    senderOrganizationId: uuid().notNull(),
    kind: text().notNull(),
    classification: text().notNull(),
    title: text().notNull(),
    body: jsonb().notNull().default({}),
    contentSha256: text().notNull(),
    fileObjectKey: text(),
    fileSha256: text(),
    fileSizeBytes: bigint({ mode: 'number' }),
    fileMimeType: text(),
    disposition: text().notNull().default('pending'),
    disposedByMembershipId: uuid(),
    disposedAt: when(),
    linkedWorkUnitId: uuid(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    version: bigint({ mode: 'number' }).notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      name: 'inbound_items_outbound_fk',
      columns: [t.senderOrganizationId, t.id],
      foreignColumns: [federationOutboundItems.organizationId, federationOutboundItems.id],
    }),
    foreignKey({
      name: 'inbound_items_disposed_by_fk',
      columns: [t.organizationId, t.disposedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      name: 'inbound_items_linked_work_fk',
      columns: [t.organizationId, t.linkedWorkUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    index('inbound_items_grant_idx').on(t.grantId),
    index('inbound_items_list_idx').on(t.organizationId, t.disposition, t.receivedAt),
    check('inbound_items_not_self', sql`${t.organizationId} <> ${t.senderOrganizationId}`),
    check(
      'inbound_items_kind_check',
      sql`${t.kind} in ('work_summary','artifact','status_update')`,
    ),
    check(
      'inbound_items_classification_check',
      sql`${t.classification} in ('public','internal','confidential')`,
    ),
    check(
      'inbound_items_disposition_check',
      sql`${t.disposition} in ('pending','accepted','rejected')`,
    ),
    check(
      'inbound_items_file_key_derived',
      sql`${t.fileObjectKey} is null or ${t.fileObjectKey} = 'federation/inbound/' || ${t.organizationId}::text || '/' || ${t.id}::text`,
    ),
    check('inbound_items_version_check', sql`${t.version} > 0`),
  ],
);

/** Everything that went over and everything removed after, for both parties. Kept as written. */
export const federationCrossings = federationSchema.table(
  'crossings',
  {
    id: uuid().primaryKey().defaultRandom(),
    grantId: uuid()
      .notNull()
      .references(() => federationGrants.id),
    itemId: uuid(),
    senderOrganizationId: uuid().notNull(),
    receiverOrganizationId: uuid().notNull(),
    kind: text(),
    outcome: text().notNull(),
    code: text(),
    contentSha256: text(),
    crossedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('crossings_grant_idx').on(t.grantId, t.crossedAt),
    index('crossings_sender_idx').on(t.senderOrganizationId, t.crossedAt),
    index('crossings_receiver_idx').on(t.receiverOrganizationId, t.crossedAt),
    check('crossings_outcome_check', sql`${t.outcome} in ('delivered','refused','purged')`),
    check('crossings_code_format', sql`${t.code} is null or ${t.code} ~ '^[A-Z][A-Z0-9_]{1,63}$'`),
  ],
);
