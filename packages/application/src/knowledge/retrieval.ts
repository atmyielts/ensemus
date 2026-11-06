// Owned by the retrieve slice (KNOW-02). See docs/06-delivery/m5-slices.md and ADR-029 D2, D6. Every query
// names `knowledge.readable_source_ids` itself, inside the SQL, as well as row-level security doing so, so
// the planner can use it and a dropped policy would not fail open. Nothing is filtered afterwards.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { Classification } from '@ensemus/domain/policy';

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
export function searchLexical(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { query: string; limit?: number; sourceIds?: readonly string[] },
): Promise<readonly RetrievedPassage[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Full-text and exact vector search inside one space, fused by rank. A null vector, or a space with no
 * vectors for what is authorized, falls back to lexical and says so in `mode`. Vectors of another space
 * are never compared (QA-017). Only current, searchable documents of active sources qualify.
 */
export function retrieveHybrid(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    query: string;
    queryVector: { spaceId: string; vector: readonly number[] } | null;
    limit?: number;
    sourceIds?: readonly string[];
  },
): Promise<{ mode: 'hybrid' | 'lexical'; passages: readonly RetrievedPassage[] }> {
  throw new Error('NOT_IMPLEMENTED');
}
