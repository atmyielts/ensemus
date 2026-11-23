// M11A tables: stored business records and meetings (ADR-033). Roles, grants, RLS and the triggers that hold
// consent and provider approval are in reviewed SQL, migration 0601. Department packs add no tables: AGENT-14
// owns what an install records.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
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
import { memberships, organizations } from './schema';
import {
  connections,
  externalActions,
  externalResources,
  integrationsSchema,
} from './schema-integrations';
import { workUnits } from './schema-work';

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const tenantId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id);
const classificationCheck = (name: string, column: unknown) =>
  check(name, sql`${column} in ('public','internal','confidential','restricted')`);

/**
 * The fields a connector was allowed to keep, one row per record at its source. The source stays
 * authoritative, so this is a copy for showing and for proposing changes, and updates go through an external
 * action. Who may read it comes from external_resources and its grants, joined on the source key, so a
 * record whose resource row is not there yet is readable by nobody (ADR-033 D3).
 */
export const businessRecords = integrationsSchema.table(
  'business_records',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    connectionId: uuid().notNull(),
    stream: text().notNull(),
    externalId: text().notNull(),
    externalVersion: text(),
    displayName: text(),
    /** Only names on BUSINESS_STREAMS for this stream, and only scalars. */
    fields: jsonb().notNull(),
    fieldsSha256: text().notNull(),
    classification: text().notNull(),
    deletedAt: timestamp({ withTimezone: true }),
    firstSeenAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('business_records_source_key').on(t.organizationId, t.connectionId, t.externalId),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
    }),
    index('business_records_stream_idx').on(
      t.organizationId,
      t.connectionId,
      t.stream,
      t.updatedAt,
    ),
    classificationCheck('business_records_classification', t.classification),
    check('business_records_stream_format', sql`${t.stream} ~ '^[a-z0-9_.-]{1,64}$'`),
    check('business_records_sha_format', sql`${t.fieldsSha256} ~ '^[0-9a-f]{64}$'`),
    check('business_records_fields_size', sql`octet_length(${t.fields}::text) <= 65536`),
  ],
);

/** Which intents were proposed against which record, so a record's page can list them. */
export const businessRecordActions = integrationsSchema.table(
  'business_record_actions',
  {
    organizationId: uuid().notNull(),
    businessRecordId: uuid().notNull(),
    externalActionId: uuid().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.businessRecordId, t.externalActionId] }),
    uniqueIndex('business_record_actions_one_record').on(t.organizationId, t.externalActionId),
    foreignKey({
      columns: [t.organizationId, t.businessRecordId],
      foreignColumns: [businessRecords.organizationId, businessRecords.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.externalActionId],
      foreignColumns: [externalActions.organizationId, externalActions.id],
    }),
  ],
);

export const meetingsSchema = pgSchema('meetings');

/**
 * Meetings are off until an administrator turns them on and names the notice people are shown. The notice's
 * text is the organization's own, and this only holds a reference to which version is current, so nothing in
 * Ensemus states a legal term (ADR-033 D5).
 */
export const meetingSettings = meetingsSchema.table(
  'settings',
  {
    organizationId: tenantId(),
    enabled: boolean().notNull().default(false),
    noticeRef: text(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    updatedByMembershipId: uuid().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId] }),
    foreignKey({
      columns: [t.organizationId, t.updatedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check(
      'meeting_settings_notice_when_enabled',
      sql`not ${t.enabled} or ${t.noticeRef} is not null`,
    ),
    check(
      'meeting_settings_notice_length',
      sql`${t.noticeRef} is null or char_length(${t.noticeRef}) between 1 and 200`,
    ),
    check('meeting_settings_version', sql`${t.version} > 0`),
  ],
);

export const meetings = meetingsSchema.table(
  'meetings',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    title: text().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    organizerMembershipId: uuid().notNull(),
    /** Fixed once written. Names and terms can be trade secrets, so it starts at confidential. */
    classification: text().notNull().default('confidential'),
    status: text().notNull().default('open'),
    sourceKind: text().notNull().default('manual'),
    connectionId: uuid(),
    sourceResourceId: uuid(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    purgedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.organizerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.sourceResourceId],
      foreignColumns: [externalResources.organizationId, externalResources.id],
    }),
    index('meetings_organizer_idx').on(t.organizationId, t.organizerMembershipId, t.occurredAt),
    index('meetings_recent_idx').on(t.organizationId, t.occurredAt),
    classificationCheck('meetings_classification', t.classification),
    check('meetings_status_check', sql`${t.status} in ('open','purged')`),
    check('meetings_source_kind', sql`${t.sourceKind} in ('manual','connector')`),
    check(
      'meetings_source_whole',
      sql`(${t.sourceKind} = 'connector') = (${t.connectionId} is not null) and (${t.sourceKind} = 'connector') = (${t.sourceResourceId} is not null)`,
    ),
    check('meetings_title_length', sql`char_length(${t.title}) between 1 and 300`),
    check('meetings_version_check', sql`${t.version} > 0`),
  ],
);

/** Everyone in the room. Fixed once notes exist, since a new person has agreed to nothing. */
export const meetingParticipants = meetingsSchema.table(
  'participants',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    meetingId: uuid().notNull(),
    kind: text().notNull(),
    membershipId: uuid(),
    /** How the organizer names someone with no account here. Never used to contact them. */
    externalLabel: text(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('meeting_participants_in_meeting').on(t.organizationId, t.meetingId, t.id),
    foreignKey({
      columns: [t.organizationId, t.meetingId],
      foreignColumns: [meetings.organizationId, meetings.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.membershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    uniqueIndex('meeting_participants_one_membership')
      .on(t.organizationId, t.meetingId, t.membershipId)
      .where(sql`${t.membershipId} is not null`),
    index('meeting_participants_member_idx').on(t.organizationId, t.membershipId),
    check('meeting_participants_kind', sql`${t.kind} in ('member','external')`),
    check(
      'meeting_participants_shape',
      sql`(${t.kind} = 'member' and ${t.membershipId} is not null and ${t.externalLabel} is null) or (${t.kind} = 'external' and ${t.membershipId} is null and ${t.externalLabel} is not null and char_length(${t.externalLabel}) between 1 and 200)`,
    ),
  ],
);

/** Every decision, as made, kept for good. The newest for a participant is what counts. */
export const meetingConsentRecords = meetingsSchema.table(
  'consent_records',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    seq: bigint({ mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    meetingId: uuid().notNull(),
    participantId: uuid().notNull(),
    decision: text().notNull(),
    basis: text().notNull(),
    /** Which version of the organization's notice was current when this was said. */
    noticeRef: text().notNull(),
    recordedByMembershipId: uuid().notNull(),
    recordedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.meetingId, t.participantId],
      foreignColumns: [
        meetingParticipants.organizationId,
        meetingParticipants.meetingId,
        meetingParticipants.id,
      ],
    }),
    foreignKey({
      columns: [t.organizationId, t.recordedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('meeting_consent_latest_idx').on(t.organizationId, t.participantId, t.seq),
    check('meeting_consent_decision', sql`${t.decision} in ('granted','declined','withdrawn')`),
    check('meeting_consent_basis', sql`${t.basis} in ('self','attested')`),
  ],
);

/**
 * An administrator saying one provider may do named things with meeting content up to one class, until a
 * date. `model` names a model profile from M4's registry and `source` names a connection. `terms_ref` points
 * at the organization's own record of the basis for it, and holds no terms.
 */
export const meetingProviderApprovals = meetingsSchema.table(
  'provider_approvals',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    kind: text().notNull(),
    targetRef: text().notNull(),
    purposes: text().array().notNull(),
    maxClassification: text().notNull(),
    termsRef: text().notNull(),
    approvedByMembershipId: uuid().notNull(),
    approvedAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    revokedByMembershipId: uuid(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.approvedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.revokedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('meeting_provider_approvals_target_idx').on(t.organizationId, t.targetRef, t.expiresAt),
    check('meeting_provider_kind', sql`${t.kind} in ('model','source')`),
    check(
      'meeting_provider_max_class',
      sql`${t.maxClassification} in ('public','internal','confidential')`,
    ),
    check(
      'meeting_provider_shape',
      sql`(${t.kind} = 'model' and ${t.targetRef} ~ '^model_profile:[0-9a-f-]{36}$' and cardinality(${t.purposes}) between 1 and 2 and ${t.purposes} <@ array['summarize','extract_items']::text[]) or (${t.kind} = 'source' and ${t.targetRef} ~ '^connection:[0-9a-f-]{36}$' and ${t.purposes} = array['import_notes']::text[])`,
    ),
    check('meeting_provider_terms_length', sql`char_length(${t.termsRef}) between 1 and 200`),
    check('meeting_provider_expiry', sql`${t.expiresAt} > ${t.approvedAt}`),
    check(
      'meeting_provider_revoke_whole',
      sql`(${t.revokedAt} is null) = (${t.revokedByMembershipId} is null)`,
    ),
  ],
);

/** Imported notes. A correction is a new version. The only change to a row is its text going for good. */
export const meetingNotes = meetingsSchema.table(
  'notes',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    meetingId: uuid().notNull(),
    version: integer().notNull(),
    sourceKind: text().notNull(),
    sourceApprovalId: uuid(),
    sourceExternalVersion: text(),
    body: text(),
    bodySha256: text().notNull(),
    sizeBytes: integer().notNull(),
    classification: text().notNull(),
    /** Null when the connector worker stored it, and then the import request says who asked. */
    importedByMembershipId: uuid(),
    createdAt: createdAt(),
    purgedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('meeting_notes_version').on(t.organizationId, t.meetingId, t.version),
    unique('meeting_notes_in_meeting').on(t.organizationId, t.meetingId, t.id),
    foreignKey({
      columns: [t.organizationId, t.meetingId],
      foreignColumns: [meetings.organizationId, meetings.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.sourceApprovalId],
      foreignColumns: [meetingProviderApprovals.organizationId, meetingProviderApprovals.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.importedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    classificationCheck('meeting_notes_classification', t.classification),
    check('meeting_notes_source_kind', sql`${t.sourceKind} in ('manual','connector')`),
    check('meeting_notes_version_check', sql`${t.version} > 0`),
    check('meeting_notes_sha_format', sql`${t.bodySha256} ~ '^[0-9a-f]{64}$'`),
    check('meeting_notes_size', sql`${t.sizeBytes} between 1 and 524288`),
    check('meeting_notes_body_size', sql`${t.body} is null or octet_length(${t.body}) <= 524288`),
    check('meeting_notes_purge_whole', sql`(${t.body} is null) = (${t.purgedAt} is not null)`),
  ],
);

/** One request to send one version of the notes to one approved provider for one purpose. */
export const meetingDerivationRuns = meetingsSchema.table(
  'derivation_runs',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    meetingId: uuid().notNull(),
    notesId: uuid().notNull(),
    providerApprovalId: uuid().notNull(),
    purpose: text().notNull(),
    status: text().notNull().default('requested'),
    statusCode: text(),
    /** A person always asks. A workflow carries it out and never starts one on its own. */
    requestedByMembershipId: uuid().notNull(),
    temporalRunId: text(),
    /** Stamped by the native model worker with its egress decision before any send. */
    dispatchStartedAt: timestamp({ withTimezone: true }),
    /** Which deployment answered, for the egress record. An ID and nothing it said. */
    modelRef: text(),
    inputTokens: integer(),
    outputTokens: integer(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('meeting_derivation_runs_in_meeting').on(t.organizationId, t.meetingId, t.id),
    foreignKey({
      columns: [t.organizationId, t.meetingId, t.notesId],
      foreignColumns: [meetingNotes.organizationId, meetingNotes.meetingId, meetingNotes.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.providerApprovalId],
      foreignColumns: [meetingProviderApprovals.organizationId, meetingProviderApprovals.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.requestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    uniqueIndex('meeting_derivation_runs_one_open')
      .on(t.organizationId, t.notesId, t.purpose)
      .where(sql`${t.status} in ('requested','running')`),
    index('meeting_derivation_runs_meeting_idx').on(t.organizationId, t.meetingId, t.createdAt),
    check('meeting_derivation_purpose', sql`${t.purpose} in ('summarize','extract_items')`),
    check(
      'meeting_derivation_status',
      sql`${t.status} in ('requested','running','completed','failed','refused','cancelled')`,
    ),
    check('meeting_derivation_version', sql`${t.version} > 0`),
  ],
);

/** What a model made of the notes. Labelled as that wherever it is shown, and never a fact. */
export const meetingSummaries = meetingsSchema.table(
  'summaries',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    meetingId: uuid().notNull(),
    runId: uuid().notNull(),
    body: text(),
    classification: text().notNull(),
    trust: text().notNull().default('model_generated'),
    sourceNotesSha256: text().notNull(),
    createdAt: createdAt(),
    purgedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('meeting_summaries_one_per_run').on(t.organizationId, t.runId),
    foreignKey({
      columns: [t.organizationId, t.meetingId, t.runId],
      foreignColumns: [
        meetingDerivationRuns.organizationId,
        meetingDerivationRuns.meetingId,
        meetingDerivationRuns.id,
      ],
    }),
    classificationCheck('meeting_summaries_classification', t.classification),
    check('meeting_summaries_trust', sql`${t.trust} = 'model_generated'`),
    check('meeting_summaries_sha_format', sql`${t.sourceNotesSha256} ~ '^[0-9a-f]{64}$'`),
    check('meeting_summaries_size', sql`${t.body} is null or octet_length(${t.body}) <= 131072`),
    check('meeting_summaries_purge_whole', sql`(${t.body} is null) = (${t.purgedAt} is not null)`),
  ],
);

/**
 * A decision or a piece of work a model thinks came out of the meeting. It starts `proposed` whoever writes
 * it, and only a named person can make it anything else. Accepting work is what creates a Work Unit, in that
 * person's name, from what they chose, and nothing else ever does (ADR-033 D7).
 */
export const meetingProposedItems = meetingsSchema.table(
  'proposed_items',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    meetingId: uuid().notNull(),
    runId: uuid().notNull(),
    ordinal: integer().notNull(),
    kind: text().notNull(),
    title: text(),
    detail: text(),
    /** A participant the model suggests. It assigns nothing, and the person accepting chooses. */
    suggestedOwnerMembershipId: uuid(),
    suggestedDueOn: date({ mode: 'string' }),
    classification: text().notNull(),
    status: text().notNull().default('proposed'),
    decidedByMembershipId: uuid(),
    decidedAt: timestamp({ withTimezone: true }),
    decisionReason: text(),
    workUnitId: uuid(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    purgedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('meeting_proposed_items_ordinal').on(t.organizationId, t.runId, t.ordinal),
    foreignKey({
      columns: [t.organizationId, t.meetingId, t.runId],
      foreignColumns: [
        meetingDerivationRuns.organizationId,
        meetingDerivationRuns.meetingId,
        meetingDerivationRuns.id,
      ],
    }),
    foreignKey({
      columns: [t.organizationId, t.suggestedOwnerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.decidedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    uniqueIndex('meeting_proposed_items_one_work')
      .on(t.organizationId, t.workUnitId)
      .where(sql`${t.workUnitId} is not null`),
    index('meeting_proposed_items_meeting_idx').on(t.organizationId, t.meetingId, t.status),
    classificationCheck('meeting_proposed_items_classification', t.classification),
    check('meeting_proposed_items_kind', sql`${t.kind} in ('decision','work')`),
    check(
      'meeting_proposed_items_status',
      sql`${t.status} in ('proposed','accepted','rejected','withdrawn')`,
    ),
    check('meeting_proposed_items_ordinal_range', sql`${t.ordinal} between 1 and 100`),
    check(
      'meeting_proposed_items_title',
      sql`${t.purgedAt} is not null or (${t.title} is not null and char_length(${t.title}) between 1 and 300)`,
    ),
    check(
      'meeting_proposed_items_detail',
      sql`${t.detail} is null or char_length(${t.detail}) <= 4000`,
    ),
    check(
      'meeting_proposed_items_reason',
      sql`${t.decisionReason} is null or char_length(${t.decisionReason}) <= 2000`,
    ),
    check('meeting_proposed_items_version', sql`${t.version} > 0`),
  ],
);

/** A person asking for a meeting's notes to be read from its source, after everyone has agreed. */
export const meetingImportRequests = meetingsSchema.table(
  'import_requests',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    meetingId: uuid().notNull(),
    sourceApprovalId: uuid().notNull(),
    status: text().notNull().default('requested'),
    statusCode: text(),
    requestedByMembershipId: uuid().notNull(),
    temporalRunId: text(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.meetingId],
      foreignColumns: [meetings.organizationId, meetings.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.sourceApprovalId],
      foreignColumns: [meetingProviderApprovals.organizationId, meetingProviderApprovals.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.requestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    uniqueIndex('meeting_import_requests_one_open')
      .on(t.organizationId, t.meetingId)
      .where(sql`${t.status} = 'requested'`),
    check(
      'meeting_import_requests_status',
      sql`${t.status} in ('requested','completed','failed','refused')`,
    ),
    check('meeting_import_requests_version', sql`${t.version} > 0`),
  ],
);
