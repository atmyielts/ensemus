// M5 tables: company knowledge (ADR-029). Roles, grants, RLS and the triggers that hold the access and
// purge rules are in reviewed SQL, migration 0201. Text from a document lives only in `chunks`,
// `document_staging`, `answers` and a few short columns that row-level security filters by source ACL.
import { sql, type SQL } from 'drizzle-orm';
import {
  bigint,
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
import { memberships, organizations } from './schema';
import { connections, externalResources, integrationsSchema } from './schema-integrations';
import { artifacts, clients, projects, teams, workSchema, workUnits } from './schema-work';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const tsvector = customType<{ data: string; driverData: string }>({ dataType: () => 'tsvector' });
/**
 * Deliberately has no dimension: one column holds several embedding spaces, and migration 0201 ties a
 * row's dimension to its space (QA-017). Values travel as pgvector's text form.
 */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) => JSON.parse(value) as number[],
});

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const tenantId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id);

export const knowledgeSchema = pgSchema('knowledge');

/**
 * One thing a person can be granted: an uploaded document, or one resource a connector found. It holds no
 * name, so a tenant-wide read reveals IDs and a class and no words: titles are on `documents`, under the
 * ACL. A revoked or deleted source never becomes active again (QA-025): a new source gets a new row.
 */
export const knowledgeSources = knowledgeSchema.table(
  'sources',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    kind: text().notNull(),
    connectionId: uuid(),
    externalResourceId: uuid(),
    classification: text().notNull(),
    state: text().notNull().default('active'),
    /** Moves on each grant change, and feeds any cache key. No retrieval cache exists yet (ADR-029 D8). */
    aclRevision: bigint({ mode: 'number' }).notNull().default(1),
    ownerMembershipId: uuid(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.externalResourceId],
      foreignColumns: [externalResources.organizationId, externalResources.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.ownerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    uniqueIndex('knowledge_sources_one_live_per_resource')
      .on(t.organizationId, t.externalResourceId)
      .where(sql`${t.state} = 'active' and ${t.externalResourceId} is not null`),
    index('knowledge_sources_state_idx').on(t.organizationId, t.state),
    check('knowledge_sources_kind_check', sql`${t.kind} in ('upload','connector')`),
    check(
      'knowledge_sources_shape',
      sql`(${t.kind} = 'connector') = (${t.connectionId} is not null) and (${t.kind} = 'connector') = (${t.externalResourceId} is not null)`,
    ),
    check('knowledge_sources_state_check', sql`${t.state} in ('active','revoked','deleted')`),
    check(
      'knowledge_sources_classification_check',
      sql`${t.classification} in ('public','internal','confidential','restricted')`,
    ),
    check('knowledge_sources_version_check', sql`${t.version} > 0`),
  ],
);

/**
 * Who may read an uploaded source. A connector's source never has rows here, and a trigger refuses them:
 * its permissions are read live from `integrations.external_resource_acl`, so a sync's commit is the
 * revoke, with nothing to copy and no lag (ADR-029 D2).
 */
export const knowledgeSourceGrants = knowledgeSchema.table(
  'source_grants',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    sourceId: uuid().notNull(),
    principalKind: text().notNull(),
    membershipId: uuid(),
    teamId: uuid(),
    grantedByMembershipId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.sourceId],
      foreignColumns: [knowledgeSources.organizationId, knowledgeSources.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.membershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.teamId],
      foreignColumns: [teams.organizationId, teams.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.grantedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    uniqueIndex('knowledge_source_grants_member')
      .on(t.organizationId, t.sourceId, t.membershipId)
      .where(sql`${t.membershipId} is not null`),
    uniqueIndex('knowledge_source_grants_team')
      .on(t.organizationId, t.sourceId, t.teamId)
      .where(sql`${t.teamId} is not null`),
    uniqueIndex('knowledge_source_grants_organization')
      .on(t.organizationId, t.sourceId)
      .where(sql`${t.principalKind} = 'organization'`),
    index('knowledge_source_grants_member_idx').on(t.organizationId, t.membershipId),
    index('knowledge_source_grants_team_idx').on(t.organizationId, t.teamId),
    check(
      'knowledge_source_grants_kind',
      sql`${t.principalKind} in ('membership','team','organization')`,
    ),
    check(
      'knowledge_source_grants_shape',
      sql`(${t.principalKind} = 'membership') = (${t.membershipId} is not null) and (${t.principalKind} = 'team') = (${t.teamId} is not null)`,
    ),
  ],
);

/** One version of a source's content. Row-level security shows it only to people who can read the source. */
export const knowledgeDocuments = knowledgeSchema.table(
  'documents',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    sourceId: uuid().notNull(),
    versionNo: integer().notNull(),
    title: text().notNull(),
    /** The source's own revision, for freshness. Null for an upload. */
    sourceVersion: text(),
    /** Where the original lives. Always https, and shown only to people who can read the source. */
    sourceUrl: text(),
    sourceModifiedAt: timestamp({ withTimezone: true }),
    contentSha256: text().notNull(),
    sizeBytes: bigint({ mode: 'number' }).notNull(),
    mediaType: text().notNull(),
    objectKey: text(),
    classification: text().notNull(),
    /** `not_scanned` is what it says. Nothing here claims a scan that did not run (ADR-029 D4). */
    scanState: text().notNull().default('not_scanned'),
    state: text().notNull().default('received'),
    rejectCode: text(),
    parserVersion: text(),
    chunkerVersion: text(),
    embeddingState: text().notNull().default('pending'),
    /** A code from the fixed list in @ensemus/domain/knowledge, such as EGRESS_DENIED. */
    embeddingReason: text(),
    searchableAt: timestamp({ withTimezone: true }),
    supersededAt: timestamp({ withTimezone: true }),
    createdByMembershipId: uuid(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('knowledge_documents_version').on(t.organizationId, t.sourceId, t.versionNo),
    unique('knowledge_documents_id_source').on(t.organizationId, t.id, t.sourceId),
    foreignKey({
      columns: [t.organizationId, t.sourceId],
      foreignColumns: [knowledgeSources.organizationId, knowledgeSources.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    uniqueIndex('knowledge_documents_one_current')
      .on(t.organizationId, t.sourceId)
      .where(sql`${t.supersededAt} is null and ${t.state} <> 'purged'`),
    index('knowledge_documents_state_idx').on(t.organizationId, t.state, t.updatedAt),
    check(
      'knowledge_documents_state_check',
      sql`${t.state} in ('received','parsing','searchable','rejected','failed','purged')`,
    ),
    check(
      'knowledge_documents_embedding_check',
      sql`${t.embeddingState} in ('pending','embedding','embedded','denied','failed')`,
    ),
    check(
      'knowledge_documents_scan_check',
      sql`${t.scanState} in ('not_scanned','clean','flagged')`,
    ),
    check(
      'knowledge_documents_classification_check',
      sql`${t.classification} in ('public','internal','confidential','restricted')`,
    ),
    check('knowledge_documents_sha_check', sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'knowledge_documents_url_check',
      sql`${t.sourceUrl} is null or ${t.sourceUrl} ~ '^https://'`,
    ),
    check('knowledge_documents_title_size', sql`length(${t.title}) between 1 and 512`),
    check('knowledge_documents_size_check', sql`${t.sizeBytes} between 0 and 26214400`),
    check('knowledge_documents_version_check', sql`${t.version} > 0 and ${t.versionNo} > 0`),
  ],
);

/**
 * A connector's bytes on their way to the object store. The connector worker has no path to the store
 * (ADR-027 D5) and must not parse what it fetched, so it leaves them here for the knowledge worker, which
 * moves them and deletes this row. Only a service context can read it.
 */
export const knowledgeDocumentStaging = knowledgeSchema.table(
  'document_staging',
  {
    organizationId: uuid().notNull(),
    documentId: uuid().notNull(),
    body: bytea().notNull(),
    sizeBytes: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.documentId] }),
    foreignKey({
      columns: [t.organizationId, t.documentId],
      foreignColumns: [knowledgeDocuments.organizationId, knowledgeDocuments.id],
    }).onDelete('cascade'),
    check('knowledge_document_staging_bound', sql`octet_length(${t.body}) <= 26214400`),
  ],
);

/** A passage. `lexemes` is generated, and `sourceId` is here so the ACL needs no join to find it. */
export const knowledgeChunks = knowledgeSchema.table(
  'chunks',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    documentId: uuid().notNull(),
    sourceId: uuid().notNull(),
    ordinal: integer().notNull(),
    textBody: text().notNull(),
    lexemes: tsvector().generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english'::regconfig, text_body)`,
    ),
    contentSha256: text().notNull(),
    tokenEstimate: integer().notNull(),
    charStart: integer().notNull(),
    charEnd: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('knowledge_chunks_ordinal').on(t.organizationId, t.documentId, t.ordinal),
    unique('knowledge_chunks_id_source').on(t.organizationId, t.id, t.sourceId),
    foreignKey({
      columns: [t.organizationId, t.documentId, t.sourceId],
      foreignColumns: [
        knowledgeDocuments.organizationId,
        knowledgeDocuments.id,
        knowledgeDocuments.sourceId,
      ],
    }).onDelete('cascade'),
    index('knowledge_chunks_lexemes_idx').using('gin', t.lexemes),
    index('knowledge_chunks_source_idx').on(t.organizationId, t.sourceId),
    check('knowledge_chunks_ordinal_check', sql`${t.ordinal} >= 0`),
    check('knowledge_chunks_size', sql`octet_length(${t.textBody}) between 1 and 32768`),
    check('knowledge_chunks_span', sql`${t.charStart} >= 0 and ${t.charEnd} > ${t.charStart}`),
    check('knowledge_chunks_sha_check', sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * One model's vectors, kept apart. A query names one space and vectors of different spaces are never
 * compared (QA-017). `modelProfileRef` is M4's `ai.model_profiles` ID, with no foreign key because M4's
 * table is built on its own branch. The final merge may add one.
 */
export const knowledgeEmbeddingSpaces = knowledgeSchema.table(
  'embedding_spaces',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    modelProfileRef: uuid(),
    modelProfileVersion: bigint({ mode: 'number' }),
    modelId: text().notNull(),
    dimension: integer().notNull(),
    vectorSpaceVersion: text().notNull(),
    distance: text().notNull().default('cosine'),
    state: text().notNull().default('active'),
    createdAt: createdAt(),
    retiredAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('knowledge_embedding_spaces_identity').on(
      t.organizationId,
      t.modelId,
      t.dimension,
      t.vectorSpaceVersion,
    ),
    unique('knowledge_embedding_spaces_dimension').on(t.organizationId, t.id, t.dimension),
    uniqueIndex('knowledge_embedding_spaces_one_active')
      .on(t.organizationId)
      .where(sql`${t.state} = 'active'`),
    check('knowledge_embedding_spaces_state', sql`${t.state} in ('active','retired')`),
    check('knowledge_embedding_spaces_dimension_range', sql`${t.dimension} between 1 and 8192`),
    check('knowledge_embedding_spaces_distance', sql`${t.distance} in ('cosine')`),
  ],
);

/**
 * A vector for one chunk in one space. The composite foreign key and the check make a wrong-sized vector
 * impossible to store. No approximate index exists yet: search is exact over authorized rows until the
 * recall script has measured an alternative (ADR-029 D6).
 */
export const knowledgeEmbeddings = knowledgeSchema.table(
  'embeddings',
  {
    organizationId: uuid().notNull(),
    chunkId: uuid().notNull(),
    sourceId: uuid().notNull(),
    spaceId: uuid().notNull(),
    dimension: integer().notNull(),
    embedding: vector().notNull(),
    contentSha256: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.chunkId, t.spaceId] }),
    foreignKey({
      columns: [t.organizationId, t.chunkId, t.sourceId],
      foreignColumns: [
        knowledgeChunks.organizationId,
        knowledgeChunks.id,
        knowledgeChunks.sourceId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.spaceId, t.dimension],
      foreignColumns: [
        knowledgeEmbeddingSpaces.organizationId,
        knowledgeEmbeddingSpaces.id,
        knowledgeEmbeddingSpaces.dimension,
      ],
    }),
    index('knowledge_embeddings_space_source_idx').on(t.organizationId, t.spaceId, t.sourceId),
    check('knowledge_embeddings_size', sql`vector_dims(${t.embedding}) = ${t.dimension}`),
  ],
);

/**
 * A claim about something in the company, with evidence. `proposed` by a model or a person, and only a
 * named person with evidence can make it `verified`: a trigger holds this, so no code path, model or
 * service context can (KNOW-04, SEC-009). Changing a claim means a new row.
 */
export const knowledgeFacts = knowledgeSchema.table(
  'facts',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    subjectRef: text().notNull(),
    predicate: text().notNull(),
    claim: jsonb().notNull(),
    trustState: text().notNull().default('proposed'),
    origin: text().notNull(),
    classification: text().notNull(),
    proposedByMembershipId: uuid(),
    /** M4's `ai.agent_runs` ID when a run proposed it. No foreign key, for the same reason as above. */
    proposedByRunId: uuid(),
    /** The authoritative record this disagrees with, as `client:{id}`. Set only with `disputed`. */
    conflictRef: text(),
    reviewedByMembershipId: uuid(),
    reviewedAt: timestamp({ withTimezone: true }),
    reviewReason: text(),
    supersededById: uuid(),
    validFrom: timestamp({ withTimezone: true }),
    validUntil: timestamp({ withTimezone: true }),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.proposedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.reviewedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.supersededById],
      foreignColumns: [t.organizationId, t.id],
    }),
    index('knowledge_facts_subject_idx').on(t.organizationId, t.subjectRef, t.trustState),
    check(
      'knowledge_facts_trust_state',
      sql`${t.trustState} in ('proposed','verified','disputed','superseded','rejected')`,
    ),
    check('knowledge_facts_origin', sql`${t.origin} in ('model','person')`),
    check(
      'knowledge_facts_classification',
      sql`${t.classification} in ('public','internal','confidential','restricted')`,
    ),
    check(
      'knowledge_facts_subject_format',
      sql`${t.subjectRef} ~ '^(client|project|membership|team|work_unit|knowledge_source):[0-9a-f-]{36}$'`,
    ),
    check('knowledge_facts_predicate_format', sql`${t.predicate} ~ '^[a-z][a-z0-9_.]{0,63}$'`),
    check('knowledge_facts_claim_size', sql`octet_length(${t.claim}::text) <= 16384`),
    check('knowledge_facts_version_check', sql`${t.version} > 0`),
  ],
);

/**
 * The passages a fact rests on: IDs, offsets and a hash, and no words. A reader needs every source here
 * to be readable, or the fact is hidden (ADR-029 D7).
 */
export const knowledgeFactEvidence = knowledgeSchema.table(
  'fact_evidence',
  {
    organizationId: uuid().notNull(),
    factId: uuid().notNull(),
    chunkId: uuid().notNull(),
    sourceId: uuid().notNull(),
    contentSha256: text().notNull(),
    quoteStart: integer().notNull(),
    quoteEnd: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.factId, t.chunkId] }),
    foreignKey({
      columns: [t.organizationId, t.factId],
      foreignColumns: [knowledgeFacts.organizationId, knowledgeFacts.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.chunkId, t.sourceId],
      foreignColumns: [
        knowledgeChunks.organizationId,
        knowledgeChunks.id,
        knowledgeChunks.sourceId,
      ],
    }),
    index('knowledge_fact_evidence_source_idx').on(t.organizationId, t.sourceId),
    index('knowledge_fact_evidence_chunk_idx').on(t.organizationId, t.chunkId),
    check(
      'knowledge_fact_evidence_span',
      sql`${t.quoteStart} >= 0 and ${t.quoteEnd} > ${t.quoteStart}`,
    ),
  ],
);

/**
 * A typed link the relational model does not already hold. Live relational links join these in the view
 * `knowledge.graph_links`. A trigger checks both ends exist in this tenant, because a polymorphic ID can
 * have no foreign key (KNOW-06).
 */
export const knowledgeEdges = knowledgeSchema.table(
  'edges',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    fromType: text().notNull(),
    fromId: uuid().notNull(),
    relation: text().notNull(),
    toType: text().notNull(),
    toId: uuid().notNull(),
    origin: text().notNull(),
    factId: uuid(),
    createdByMembershipId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('knowledge_edges_identity').on(
      t.organizationId,
      t.fromType,
      t.fromId,
      t.relation,
      t.toType,
      t.toId,
    ),
    foreignKey({
      columns: [t.organizationId, t.factId],
      foreignColumns: [knowledgeFacts.organizationId, knowledgeFacts.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('knowledge_edges_from_idx').on(t.organizationId, t.fromType, t.fromId),
    index('knowledge_edges_to_idx').on(t.organizationId, t.toType, t.toId),
    check(
      'knowledge_edges_from_type',
      sql`${t.fromType} in ('client','project','membership','team','work_unit','knowledge_source')`,
    ),
    check(
      'knowledge_edges_to_type',
      sql`${t.toType} in ('client','project','membership','team','work_unit','knowledge_source')`,
    ),
    check('knowledge_edges_relation_format', sql`${t.relation} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check('knowledge_edges_origin', sql`${t.origin} in ('person','fact')`),
    check('knowledge_edges_origin_shape', sql`(${t.origin} = 'fact') = (${t.factId} is not null)`),
  ],
);

/**
 * What one compiled context used: hashes, IDs and budgets, never text (05-context-compiler stage 8).
 * Append-only, like an audit row.
 */
export const knowledgeEvidencePackages = knowledgeSchema.table(
  'evidence_packages',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    purpose: text().notNull(),
    workUnitId: uuid(),
    runId: uuid(),
    viewerMembershipId: uuid().notNull(),
    querySha256: text().notNull(),
    policyVersion: text().notNull(),
    spaceId: uuid(),
    budgetTokens: integer().notNull(),
    usedTokens: integer().notNull(),
    strongestClassification: text().notNull(),
    packageSha256: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.viewerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    check('knowledge_evidence_packages_purpose', sql`${t.purpose} in ('answer','agent_turn')`),
    check(
      'knowledge_evidence_packages_class',
      sql`${t.strongestClassification} in ('public','internal','confidential','restricted')`,
    ),
    check(
      'knowledge_evidence_packages_budget',
      sql`${t.budgetTokens} > 0 and ${t.usedTokens} >= 0 and ${t.usedTokens} <= ${t.budgetTokens}`,
    ),
  ],
);

/** One passage in a package. IDs only, with no foreign key, so an audit row outlives a purge. */
export const knowledgeEvidenceItems = knowledgeSchema.table(
  'evidence_items',
  {
    organizationId: uuid().notNull(),
    packageId: uuid().notNull(),
    ordinal: integer().notNull(),
    chunkId: uuid().notNull(),
    documentId: uuid().notNull(),
    sourceId: uuid().notNull(),
    contentSha256: text().notNull(),
    classification: text().notNull(),
    tokenEstimate: integer().notNull(),
    lexicalRank: integer(),
    vectorRank: integer(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.packageId, t.ordinal] }),
    foreignKey({
      columns: [t.organizationId, t.packageId],
      foreignColumns: [knowledgeEvidencePackages.organizationId, knowledgeEvidencePackages.id],
    }),
    index('knowledge_evidence_items_source_idx').on(t.organizationId, t.sourceId),
    check(
      'knowledge_evidence_items_class',
      sql`${t.classification} in ('public','internal','confidential','restricted')`,
    ),
  ],
);

/**
 * A question and its cited answer. Both are derived company content: only the person who asked can read
 * them, and only while they can still read every source that went in. The worker reads the question from
 * here, because text never crosses Temporal.
 */
export const knowledgeAnswers = knowledgeSchema.table(
  'answers',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    requesterMembershipId: uuid().notNull(),
    question: text().notNull(),
    state: text().notNull().default('queued'),
    /** A code from the fixed list in @ensemus/domain/knowledge. Never provider text. */
    refusalCode: text(),
    packageId: uuid(),
    answerText: text(),
    modelProfileRef: uuid(),
    inputTokens: integer(),
    outputTokens: integer(),
    /** Micro-USD, labelled an estimate wherever shown (M4 FD-6). Null until the ledger says. */
    costMicros: bigint({ mode: 'number' }),
    strongestClassification: text(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.requesterMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.packageId],
      foreignColumns: [knowledgeEvidencePackages.organizationId, knowledgeEvidencePackages.id],
    }),
    index('knowledge_answers_requester_idx').on(
      t.organizationId,
      t.requesterMembershipId,
      t.createdAt,
    ),
    check(
      'knowledge_answers_state',
      sql`${t.state} in ('queued','running','answered','no_evidence','refused','failed')`,
    ),
    check('knowledge_answers_question_size', sql`length(${t.question}) between 1 and 4000`),
    check(
      'knowledge_answers_answer_size',
      sql`${t.answerText} is null or length(${t.answerText}) <= 65536`,
    ),
    check('knowledge_answers_version_check', sql`${t.version} > 0`),
  ],
);

/** Every source that went into an answer, cited or not. A purge finds an answer through this. */
export const knowledgeAnswerSources = knowledgeSchema.table(
  'answer_sources',
  {
    organizationId: uuid().notNull(),
    answerId: uuid().notNull(),
    sourceId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.answerId, t.sourceId] }),
    foreignKey({
      columns: [t.organizationId, t.answerId],
      foreignColumns: [knowledgeAnswers.organizationId, knowledgeAnswers.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.sourceId],
      foreignColumns: [knowledgeSources.organizationId, knowledgeSources.id],
    }),
    index('knowledge_answer_sources_source_idx').on(t.organizationId, t.sourceId),
  ],
);

/** Where in the answer a passage is cited. IDs and offsets only. */
export const knowledgeAnswerCitations = knowledgeSchema.table(
  'answer_citations',
  {
    organizationId: uuid().notNull(),
    answerId: uuid().notNull(),
    ordinal: integer().notNull(),
    chunkId: uuid().notNull(),
    documentId: uuid().notNull(),
    sourceId: uuid().notNull(),
    answerStart: integer().notNull(),
    answerEnd: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.answerId, t.ordinal] }),
    foreignKey({
      columns: [t.organizationId, t.answerId],
      foreignColumns: [knowledgeAnswers.organizationId, knowledgeAnswers.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.chunkId, t.sourceId],
      foreignColumns: [
        knowledgeChunks.organizationId,
        knowledgeChunks.id,
        knowledgeChunks.sourceId,
      ],
    }),
    check(
      'knowledge_answer_citations_span',
      sql`${t.answerStart} >= 0 and ${t.answerEnd} > ${t.answerStart}`,
    ),
  ],
);

/** The passages a produced artifact rests on (AGENT-07). IDs and a hash. Survives a purge as a record. */
export const knowledgeArtifactCitations = knowledgeSchema.table(
  'artifact_citations',
  {
    organizationId: uuid().notNull(),
    artifactId: uuid().notNull(),
    ordinal: integer().notNull(),
    chunkId: uuid().notNull(),
    documentId: uuid().notNull(),
    sourceId: uuid().notNull(),
    contentSha256: text().notNull(),
    artifactStart: integer().notNull(),
    artifactEnd: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.artifactId, t.ordinal] }),
    foreignKey({
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifacts.organizationId, artifacts.id],
    }).onDelete('cascade'),
    index('knowledge_artifact_citations_source_idx').on(t.organizationId, t.sourceId),
    check(
      'knowledge_artifact_citations_span',
      sql`${t.artifactStart} >= 0 and ${t.artifactEnd} > ${t.artifactStart}`,
    ),
  ],
);

/**
 * A grounding check by the system, or a person's acceptance, of exactly these bytes against exactly this
 * objective. Append-only. A person can accept only what passed grounding, which a trigger holds.
 */
export const knowledgeArtifactVerifications = knowledgeSchema.table(
  'artifact_verifications',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    artifactId: uuid().notNull(),
    workUnitId: uuid().notNull(),
    artifactSha256: text().notNull(),
    objectiveSha256: text().notNull(),
    kind: text().notNull(),
    verdict: text().notNull(),
    /** A code for the grounding check. A person's own words go in `reason`. */
    reasonCode: text(),
    reason: text(),
    decidedByMembershipId: uuid(),
    packageId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    // No foreign key to the artifact: this record has to outlive a deleted file (LIFE-01).
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.decidedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.packageId],
      foreignColumns: [knowledgeEvidencePackages.organizationId, knowledgeEvidencePackages.id],
    }),
    index('knowledge_artifact_verifications_artifact_idx').on(
      t.organizationId,
      t.artifactId,
      t.createdAt,
    ),
    check('knowledge_artifact_verifications_kind', sql`${t.kind} in ('grounding','human')`),
    check(
      'knowledge_artifact_verifications_verdict',
      sql`(${t.kind} = 'grounding' and ${t.verdict} in ('passed','failed')) or (${t.kind} = 'human' and ${t.verdict} in ('accepted','rejected'))`,
    ),
    check(
      'knowledge_artifact_verifications_person',
      sql`(${t.kind} = 'human') = (${t.decidedByMembershipId} is not null)`,
    ),
  ],
);

/**
 * The record that a source's derived data has gone, and when (Gate D: "eventually purge and report
 * completion"). Written in the same transaction as the source's revoke or delete.
 */
export const knowledgePurgeJobs = knowledgeSchema.table(
  'purge_jobs',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    sourceId: uuid().notNull(),
    reason: text().notNull(),
    state: text().notNull().default('pending'),
    documentsRemoved: integer().notNull().default(0),
    chunksRemoved: integer().notNull().default(0),
    embeddingsRemoved: integer().notNull().default(0),
    factsRemoved: integer().notNull().default(0),
    answersRemoved: integer().notNull().default(0),
    blobsRemoved: integer().notNull().default(0),
    attempts: integer().notNull().default(0),
    lastErrorCode: text(),
    requestedAt: createdAt(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('knowledge_purge_jobs_source').on(t.organizationId, t.sourceId),
    foreignKey({
      columns: [t.organizationId, t.sourceId],
      foreignColumns: [knowledgeSources.organizationId, knowledgeSources.id],
    }),
    index('knowledge_purge_jobs_state_idx').on(t.organizationId, t.state),
    check(
      'knowledge_purge_jobs_reason',
      sql`${t.reason} in ('deleted','revoked','connection_revoked','resource_gone','restore_reapply')`,
    ),
    check(
      'knowledge_purge_jobs_state_check',
      sql`${t.state} in ('pending','running','completed','failed')`,
    ),
    check(
      'knowledge_purge_jobs_completed',
      sql`(${t.state} = 'completed') = (${t.completedAt} is not null)`,
    ),
  ],
);

/**
 * Every decision to send company text to a model for knowledge work, allowed or denied, with no text.
 * Append-only. AGENT-10's ledger reads this alongside M4's `governance.egress_decisions`, which covers
 * run-bound calls: embedding a document has no run, so it has no row there (ADR-029 D9).
 */
export const knowledgeModelCalls = knowledgeSchema.table(
  'model_calls',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    purpose: text().notNull(),
    dataClass: text().notNull(),
    modelProfileRef: uuid(),
    modelProfileVersion: bigint({ mode: 'number' }),
    providerKind: text(),
    destinationHost: text(),
    decision: text().notNull(),
    reasonCode: text().notNull(),
    policyVersion: text().notNull(),
    requestSha256: text().notNull(),
    documentId: uuid(),
    answerId: uuid(),
    inputCount: integer().notNull().default(0),
    occurredAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    index('knowledge_model_calls_time_idx').on(t.organizationId, t.occurredAt, t.id),
    check('knowledge_model_calls_purpose', sql`${t.purpose} in ('embed','rerank','answer')`),
    check(
      'knowledge_model_calls_class',
      sql`${t.dataClass} in ('public','internal','confidential','restricted')`,
    ),
    check('knowledge_model_calls_decision', sql`${t.decision} in ('allow','deny')`),
    check(
      'knowledge_model_calls_shape',
      sql`${t.decision} = 'deny' or (${t.modelProfileRef} is not null and ${t.destinationHost} is not null)`,
    ),
  ],
);

/**
 * A tool an MCP server says it has. Everything it says is data for an admin to read: a tool can be called
 * only after a named admin approved exactly this definition and set its side-effect level themselves.
 * Nothing the server declares can set that, and a changed definition goes back to review (CONNECT-03).
 */
export const mcpTools = integrationsSchema.table(
  'mcp_tools',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    connectionId: uuid().notNull(),
    toolName: text().notNull(),
    /** The server's name, description, annotations and schemas, as sent. Never put in a prompt unreviewed. */
    definition: jsonb().notNull(),
    definitionSha256: text().notNull(),
    status: text().notNull().default('pending_review'),
    sideEffectLevel: text(),
    allowedClasses: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    reviewedByMembershipId: uuid(),
    reviewedAt: timestamp({ withTimezone: true }),
    version: bigint({ mode: 'number' }).notNull().default(1),
    firstSeenAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('mcp_tools_name').on(t.organizationId, t.connectionId, t.toolName),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [connections.organizationId, connections.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.reviewedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check(
      'mcp_tools_status',
      sql`${t.status} in ('pending_review','approved','rejected','removed')`,
    ),
    check(
      'mcp_tools_side_effect',
      sql`${t.sideEffectLevel} is null or ${t.sideEffectLevel} in ('read_only','external_write')`,
    ),
    check(
      'mcp_tools_approved_shape',
      sql`${t.status} <> 'approved' or (${t.sideEffectLevel} is not null and ${t.reviewedByMembershipId} is not null and ${t.reviewedAt} is not null)`,
    ),
    check('mcp_tools_name_size', sql`length(${t.toolName}) between 1 and 128`),
    check('mcp_tools_definition_size', sql`octet_length(${t.definition}::text) <= 65536`),
    check('mcp_tools_sha_check', sql`${t.definitionSha256} ~ '^[0-9a-f]{64}$'`),
    check('mcp_tools_version_check', sql`${t.version} > 0`),
  ],
);

/** The flagship: one deal won, taken to an onboarded client (AGENT-12). One run per deal. */
export const clientOnboardings = workSchema.table(
  'client_onboardings',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    /** The deal's ID in whatever system holds it. Unique, so a repeated "deal won" starts nothing new. */
    dealRef: text().notNull(),
    clientId: uuid().notNull(),
    projectId: uuid().notNull(),
    /** The parent Work Unit. Its children are the steps, with dependencies in `work_dependencies`. */
    workUnitId: uuid().notNull(),
    state: text().notNull().default('started'),
    stateCode: text(),
    costMicros: bigint({ mode: 'number' }),
    requestedByMembershipId: uuid().notNull(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique('client_onboardings_deal').on(t.organizationId, t.dealRef),
    foreignKey({
      columns: [t.organizationId, t.clientId],
      foreignColumns: [clients.organizationId, clients.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.requestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check(
      'client_onboardings_state',
      sql`${t.state} in ('started','waiting_for_brief','waiting_for_acceptance','waiting_for_send','completed','failed','unknown')`,
    ),
    check('client_onboardings_deal_size', sql`length(${t.dealRef}) between 1 and 128`),
    check('client_onboardings_version_check', sql`${t.version} > 0`),
  ],
);
