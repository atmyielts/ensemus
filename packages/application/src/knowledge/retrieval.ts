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
import { MAX_QUESTION_CHARS, RETRIEVAL_CANDIDATES } from '@ensemus/domain/knowledge';
import type { Classification } from '@ensemus/domain/policy';
import { fuseRanks } from '@ensemus/knowledge/fusion';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { AppError } from '../errors';
import { idSchema } from '../ids';

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
 * Full-text and exact vector search inside one space, fused by rank. A null vector, or a space with no
 * vectors for what is authorized, falls back to lexical and says so in `mode`. Vectors of another space
 * are never compared (QA-017). Only current, searchable documents of active sources qualify.
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
): Promise<{ mode: 'hybrid' | 'lexical'; passages: readonly RetrievedPassage[] }> {
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
    // Both rankings and the words they name come from one statement, so a concurrent revoke cannot
    // leave a rank, count or passage from an older ACL paired with a newer one.
    const rows = await rankedPassages(
      tx,
      context,
      query,
      sourceIds,
      approvedVector,
      input.maxClassification,
    );
    const lexical = rows.filter((row) => row.channel === 'lexical');
    const vectors = rows.filter((row) => row.channel === 'vector');
    const byId = new Map(rows.map((row) => [row.chunkId, row]));
    const passages = fuseRanks(
      lexical.map((row) => ({ chunkId: row.chunkId, rank: Number(row.rank) })),
      vectors.map((row) => ({ chunkId: row.chunkId, rank: Number(row.rank) })),
      { limit },
    ).map((hit): RetrievedPassage => {
      const row = byId.get(hit.chunkId)!;
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
        sourceModifiedAt: row.sourceModifiedAt,
        searchableAt: row.searchableAt,
        score: hit.score,
        lexicalRank: hit.lexicalRank,
        vectorRank: hit.vectorRank,
      };
    });
    return { mode: vectors.length ? 'hybrid' : 'lexical', passages };
  });
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

type RankedPassage = Omit<RetrievedPassage, 'score' | 'lexicalRank' | 'vectorRank'> & {
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
): Promise<readonly RankedPassage[]> {
  const scope = sourceIds
    ? sql`and c.source_id in (${sql.join(
        sourceIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;
  const vectorQuery: SQL = vector
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
