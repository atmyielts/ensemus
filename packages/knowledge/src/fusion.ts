// Owned by the retrieve slice (KNOW-02). See docs/06-delivery/m5-slices.md.

export type RankedHit = { chunkId: string; rank: number };

export type FusedHit = {
  chunkId: string;
  score: number;
  lexicalRank: number | null;
  vectorRank: number | null;
};

/**
 * Reciprocal rank fusion, `1 / (k + rank)` summed over both lists, with `k` default 60. It is the merge
 * step, and needs no model. Ties break by chunk ID, so the same inputs give the same order, which is what
 * makes a compiled context reproducible. Both inputs are already authorized: this never filters.
 */
export function fuseRanks(
  _lexical: readonly RankedHit[],
  _vector: readonly RankedHit[],
  _options?: { k?: number; limit?: number },
): readonly FusedHit[] {
  throw new Error('NOT_IMPLEMENTED');
}
