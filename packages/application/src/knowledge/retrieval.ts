// Owned by the retrieve slice (KNOW-02). See docs/06-delivery/m5-slices.md and ADR-029 D2, D6. Every query
// names `knowledge.readable_source_ids` itself, inside the SQL, as well as row-level security doing so, so
// the planner can use it and a dropped policy would not fail open. Nothing is filtered afterwards.
import {
  knowledgeEmbeddingSpaces,
  memberships,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  EXACT_VECTOR_SEARCH_MAX_ROWS,
  HNSW_INDEXED_DIMENSIONS,
  HNSW_SEARCH_SETTINGS,
  MAX_QUESTION_CHARS,
  RETRIEVAL_CANDIDATES,
  vectorSearchMode,
  type VectorSearchMode,
} from '@ensemus/domain/knowledge';
import type { Classification } from '@ensemus/domain/policy';
import { fuseRanks } from '@ensemus/knowledge/fusion';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { loadAgentReadScopeInTx } from '../ai/read-scope';

/** A passage with everything a citation shows: freshness, its class, and the way back to the source. */
export type RetrievedPassage = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  text: string;
  contentSha256: string;
  tokenEstimate: number;
  classification: Classification;
  title: string;
  sourceVersion: string | null;
  sourceUrl: string | null;
  sourceModifiedAt: Date | null;
  searchableAt: Date;
  score: number;
  lexicalRank: number | null;
  vectorRank: number | null;
};

/**
 * Full-text only, with no model, so the web tier can call it (it has no model path: ADR-024). Refuses a
 * service context, which is what would see everything: search is always on behalf of a person.
 */
export async function searchLexical(
  database: AppDatabase,
  context: TenantContext,
  input: {
    query: string;
    limit?: number;
    sourceIds?: readonly string[];
    maxClassification?: Classification;
  },
): Promise<readonly RetrievedPassage[]> {
  const result = await retrieveHybrid(database, context, { ...input, queryVector: null });
  return result.passages;
}

/**
 * Full-text and vector search inside one space, fused by rank. A null vector, or a space with no vectors
 * for what is authorized, falls back to lexical and says so in `mode`. Vectors of another space are never
 * compared (QA-017). Only current, searchable documents of active sources qualify. Vector search is exact
 * over the authorized rows unless the space has an HNSW index and the person can read more than
 * EXACT_VECTOR_SEARCH_MAX_ROWS of its vectors; then it walks the index with pgvector's iterative scan,
 * with the same ACL inside the same statement (ADR-029 D6 addendum). `vectorSearch` says which ran.
 */
export async function retrieveHybrid(
  database: AppDatabase,
  context: TenantContext,
  input: {
    query: string;
    queryVector: { spaceId: string; vector: readonly number[] } | null;
    limit?: number;
    sourceIds?: readonly string[];
    maxClassification?: Classification;
  },
): Promise<{
  mode: 'hybrid' | 'lexical';
  vectorSearch?: VectorSearchMode;
  passages: readonly RetrievedPassage[];
}> {
  if (context.actorType === 'service') throw new AppError('FORBIDDEN');
  const query = searchQuery(input.query);
  const limit = searchLimit(input.limit);
  if (
    input.maxClassification !== undefined &&
    !['public', 'internal', 'confidential', 'restricted'].includes(input.maxClassification)
  )
    throw new AppError('INVALID_INPUT');
  const sourceIds = input.sourceIds?.map((id) => {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) throw new AppError('INVALID_INPUT');
    return parsed.data;
  });
  if (sourceIds && sourceIds.length > 200) throw new AppError('INVALID_INPUT');
  const vector = input.queryVector;
  if (
    vector &&
    (!idSchema.safeParse(vector.spaceId).success ||
      !vector.vector.length ||
      vector.vector.length > 8192 ||
      vector.vector.some((n) => !Number.isFinite(n) || Math.abs(n) > 3.4028234663852886e38) ||
      !vector.vector.some((n) => Math.fround(n) !== 0))
  )
    throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    await requireSearchPerson(tx, context);
    if (!query || sourceIds?.length === 0) return { mode: 'lexical', passages: [] };
    let approvedVector: { spaceId: string; vector: readonly number[] } | null = null;
    if (vector) {
      const [space] = await tx
        .select()
        .from(knowledgeEmbeddingSpaces)
        .where(
          and(
            eq(knowledgeEmbeddingSpaces.id, vector.spaceId),
            eq(knowledgeEmbeddingSpaces.state, 'active'),
          ),
        );
      if (space) {
        if (space.dimension !== vector.vector.length) throw new AppError('INVALID_INPUT');
        approvedVector = { spaceId: space.id, vector: vector.vector };
      }
    }
    const vectorSearch = approvedVector
      ? await chooseVectorSearch(tx, context, approvedVector)
      : undefined;
    // Both rankings and the words they name come from one statement, so a concurrent revoke cannot
    // leave a rank, count or passage from an older ACL paired with a newer one.
    const rows = await rankedPassages(
      tx,
      context,
      query,
      sourceIds,
      approvedVector,
      input.maxClassification,
      vectorSearch,
    );
    const lexical = rows.filter((row) => row.channel === 'lexical');
    const vectors = rows.filter((row) => row.channel === 'vector');
    const byId = new Map(rows.map((row) => [row.chunkId, row]));
    const passages = fuseRanks(
      lexical.map((row) => ({ chunkId: row.chunkId, rank: Number(row.rank) })),
      vectors.map((row) => ({ chunkId: row.chunkId, rank: Number(row.rank) })),
      { limit },
    ).map((hit) => toRetrievedPassage(byId.get(hit.chunkId)!, hit));
    return {
      mode: vectors.length ? 'hybrid' : 'lexical',
      ...(vectorSearch ? { vectorSearch } : {}),
      passages,
    };
  });
}

/** Whether this database's pgvector has iterative index scans (0.8.0 and later). Read once a process. */
let iterativeScanSupported: boolean | undefined;

export function pgvectorHasIterativeScan(version: string | null | undefined): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(`${version ?? ''}.`);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 0 || minor >= 8;
}

/**
 * Exact unless approximate is both available and worth it. The count is bounded, so deciding costs at most
 * EXACT_VECTOR_SEARCH_MAX_ROWS + 1 index reads, and it uses the same ACL as the search.
 */
async function chooseVectorSearch(
  tx: Tx,
  context: TenantContext,
  vector: { spaceId: string; vector: readonly number[] },
): Promise<VectorSearchMode> {
  const dimension = vector.vector.length;
  if (!Object.hasOwn(HNSW_INDEXED_DIMENSIONS, dimension)) return 'exact';
  if (iterativeScanSupported === undefined) {
    const found = await tx.execute<{ version: string }>(
      sql`select extversion as version from pg_catalog.pg_extension where extname = 'vector'`,
    );
    iterativeScanSupported = pgvectorHasIterativeScan(found.rows[0]?.version);
  }
  if (!iterativeScanSupported) return 'exact';
  const counted = await tx.execute<{ rows: number }>(sql`
    select count(*)::integer as rows from (
      select 1 from knowledge.embeddings e
       where e.organization_id = ${context.organizationId}::uuid and e.space_id = ${vector.spaceId}::uuid
         and e.source_id in (select knowledge.readable_source_ids(app.current_membership_id()))
       limit ${EXACT_VECTOR_SEARCH_MAX_ROWS + 1}) authorized`);
  const mode = vectorSearchMode({ dimension, authorizedRows: Number(counted.rows[0]?.rows ?? 0) });
  if (mode === 'approximate') {
    // Transaction-local: these never outlive this search, and never reach another tenant's session.
    await tx.execute(sql`select
      set_config('hnsw.iterative_scan', ${HNSW_SEARCH_SETTINGS.iterativeScan}, true),
      set_config('hnsw.ef_search', ${String(HNSW_SEARCH_SETTINGS.efSearch)}, true),
      set_config('hnsw.max_scan_tuples', ${String(HNSW_SEARCH_SETTINGS.maxScanTuples)}, true),
      set_config('hnsw.scan_mem_multiplier', ${String(HNSW_SEARCH_SETTINGS.scanMemMultiplier)}, true)`);
  }
  return mode;
}

/**
 * The approximate query's distance expression: the index's own cast, so the planner can use it. The width
 * and type come only from HNSW_INDEXED_DIMENSIONS, never from input, so they are safe to write as SQL.
 */
export function hnswDistance(column: SQL, vectorText: string, dimension: number): SQL {
  const index = Object.hasOwn(HNSW_INDEXED_DIMENSIONS, dimension)
    ? HNSW_INDEXED_DIMENSIONS[dimension]
    : undefined;
  if (!index || !Number.isInteger(dimension)) throw new AppError('INVALID_STATE');
  const cast = sql.raw(`public.${index.type}(${dimension})`);
  return sql`(${column}::${cast}) <=> (${vectorText}::${cast})`;
}

/**
 * A raw `tx.execute` row carries timestamptz as PostgreSQL text: drizzle's node-postgres session
 * keeps those types unparsed for raw queries. The passage promises Dates, which every caller formats.
 */
export function toRetrievedPassage(
  row: RankedPassage,
  hit: { score: number; lexicalRank: number | null; vectorRank: number | null },
): RetrievedPassage {
  return {
    chunkId: row.chunkId,
    documentId: row.documentId,
    sourceId: row.sourceId,
    text: row.text,
    contentSha256: row.contentSha256,
    tokenEstimate: row.tokenEstimate,
    classification: row.classification,
    title: row.title,
    sourceVersion: row.sourceVersion,
    sourceUrl: row.sourceUrl,
    sourceModifiedAt: row.sourceModifiedAt === null ? null : passageTime(row.sourceModifiedAt),
    searchableAt: passageTime(row.searchableAt),
    score: hit.score,
    lexicalRank: hit.lexicalRank,
    vectorRank: hit.vectorRank,
  };
}

function passageTime(value: Date | string): Date {
  const time = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(time.getTime())) throw new AppError('INVALID_STATE');
  return time;
}

/** Shared by company search. A previously issued context does not keep a disabled member alive. */
export async function requireSearchPerson(tx: Tx, context: TenantContext): Promise<void> {
  if (context.actorType === 'service') throw new AppError('FORBIDDEN');
  const [member] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.id, context.membershipId), eq(memberships.status, 'active')))
    .for('share');
  if (!member) throw new AppError('FORBIDDEN');
  // Fact subject/source policies may consult scoped Work authority in this transaction. A scope
  // projection loaded by a previous transaction is neither inherited nor sufficient admission.
  if (context.actorType === 'agent') {
    if (!context.agentRunId) throw new AppError('FORBIDDEN');
    await loadAgentReadScopeInTx(tx, {
      ...context,
      actorType: 'agent',
      agentRunId: context.agentRunId,
    });
  }
}

export function searchQuery(query: string, max = MAX_QUESTION_CHARS): string {
  if (typeof query !== 'string' || query.length > max || query.includes('\0'))
    throw new AppError('INVALID_INPUT');
  return query.trim();
}

export function searchLimit(limit = 10): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > RETRIEVAL_CANDIDATES)
    throw new AppError('INVALID_INPUT');
  return limit;
}

export type RankedPassage = Omit<
  RetrievedPassage,
  'score' | 'lexicalRank' | 'vectorRank' | 'sourceModifiedAt' | 'searchableAt'
> & {
  /** Text from a raw query (see toRetrievedPassage); a Date only if a driver ever parses it. */
  sourceModifiedAt: Date | string | null;
  searchableAt: Date | string;
  channel: 'lexical' | 'vector';
  rank: number;
};

async function rankedPassages(
  tx: Tx,
  context: TenantContext,
  query: string,
  sourceIds: readonly string[] | undefined,
  vector: { spaceId: string; vector: readonly number[] } | null,
  maxClassification?: Classification,
  vectorSearch?: VectorSearchMode,
): Promise<readonly RankedPassage[]> {
  const scope = sourceIds
    ? sql`and c.source_id in (${sql.join(
        sourceIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;
  const approximate = vector && vectorSearch === 'approximate' ? vector : null;
  const distance = approximate
    ? hnswDistance(sql`e.embedding`, JSON.stringify(approximate.vector), approximate.vector.length)
    : null;
  const vectorQuery: SQL =
    approximate && distance
      ? // The ACL and every visibility rule are in the WHERE clause, so pgvector's iterative scan keeps
        // walking the graph past rows this person may not read, instead of returning fewer of them.
        sql`
    select n."chunkId", 'vector'::text as channel,
           row_number() over (order by n.distance, n."chunkId")::integer as rank
      from (
        select e.chunk_id as "chunkId", ${distance} as distance
          from knowledge.embeddings e
         where e.organization_id = ${context.organizationId}::uuid
           and e.space_id = ${approximate.spaceId}::uuid
           and e.dimension = ${sql.raw(String(approximate.vector.length))}
           and e.source_id in (select knowledge.readable_source_ids(app.current_membership_id()))
           and exists (select 1 from knowledge.embedding_spaces sp
                        where sp.organization_id = ${context.organizationId}::uuid
                          and sp.id = ${approximate.spaceId}::uuid and sp.state = 'active')
           and exists (select 1 from visible v where v."chunkId" = e.chunk_id and v."sourceId" = e.source_id)
         order by ${distance}
         limit ${RETRIEVAL_CANDIDATES}) n`
      : vector
        ? sql`
    select v."chunkId", 'vector'::text as channel,
           row_number() over (order by e.embedding <=> ${JSON.stringify(vector.vector)}::vector, v."chunkId")::integer as rank
      from visible v
      join knowledge.embeddings e on e.organization_id = ${context.organizationId}::uuid and e.chunk_id = v."chunkId" and e.source_id = v."sourceId"
      join knowledge.embedding_spaces sp on sp.organization_id = e.organization_id and sp.id = e.space_id and sp.state = 'active'
     where e.space_id = ${vector.spaceId}::uuid and e.dimension = ${vector.vector.length}
     order by e.embedding <=> ${JSON.stringify(vector.vector)}::vector, v."chunkId"
     limit ${RETRIEVAL_CANDIDATES}`
        : sql`select null::uuid as "chunkId", 'vector'::text as channel, 0::integer as rank where false`;
  const result = await tx.execute<RankedPassage>(sql`
    with visible as not materialized (
      select c.id as "chunkId", c.document_id as "documentId", c.source_id as "sourceId",
             c.text_body as text, c.content_sha256 as "contentSha256", c.token_estimate as "tokenEstimate",
             case when knowledge.class_rank(s.classification) > knowledge.class_rank(d.classification)
                  then s.classification else d.classification end as classification,
             d.title, d.source_version as "sourceVersion", d.source_url as "sourceUrl",
             d.source_modified_at as "sourceModifiedAt", d.searchable_at as "searchableAt", c.lexemes
        from knowledge.chunks c
        join knowledge.documents d on d.organization_id = c.organization_id and d.id = c.document_id and d.source_id = c.source_id
        join knowledge.sources s on s.organization_id = c.organization_id and s.id = c.source_id
       where c.organization_id = ${context.organizationId}::uuid and s.state = 'active'
         and d.state = 'searchable' and d.superseded_at is null and d.searchable_at is not null
         and c.source_id in (select knowledge.readable_source_ids(app.current_membership_id()))
         ${scope}
         ${maxClassification ? sql`and greatest(knowledge.class_rank(s.classification),knowledge.class_rank(d.classification))<=knowledge.class_rank(${maxClassification})` : sql``}
    ), lexical as (
      select "chunkId", 'lexical'::text as channel,
             row_number() over (order by ts_rank_cd(lexemes, websearch_to_tsquery('english', ${query})) desc, "chunkId")::integer as rank
        from visible where lexemes @@ websearch_to_tsquery('english', ${query})
       order by ts_rank_cd(lexemes, websearch_to_tsquery('english', ${query})) desc, "chunkId"
       limit ${RETRIEVAL_CANDIDATES}
    ), vectors as (${vectorQuery}), ranked as (select * from lexical union all select * from vectors)
    select v."chunkId", v."documentId", v."sourceId", v.text, v."contentSha256", v."tokenEstimate",
           v.classification, v.title, v."sourceVersion", v."sourceUrl", v."sourceModifiedAt", v."searchableAt",
           r.channel, r.rank
      from ranked r join visible v on v."chunkId" = r."chunkId"
     order by r.channel, r.rank
  `);
  return result.rows;
}
