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
  lexical: readonly RankedHit[],
  vector: readonly RankedHit[],
  options?: { k?: number; limit?: number },
): readonly FusedHit[] {
  const k = options?.k ?? 60;
  const limit = options?.limit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(k) || k < 0 || !Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError('INVALID_FUSION_OPTIONS');
  const hits = new Map<string, FusedHit>();
  for (const [channel, input] of [
    ['lexicalRank', lexical],
    ['vectorRank', vector],
  ] as const) {
    for (const { chunkId, rank } of input) {
      if (!chunkId || !Number.isSafeInteger(rank) || rank < 1)
        throw new RangeError('INVALID_FUSION_RANK');
      const hit = hits.get(chunkId) ?? { chunkId, score: 0, lexicalRank: null, vectorRank: null };
      const previous = hit[channel];
      // A duplicate contributes once, at its best rank. Input order cannot change its weight.
      if (previous === null || rank < previous) hit[channel] = rank;
      hits.set(chunkId, hit);
    }
  }
  for (const hit of hits.values()) {
    hit.score =
      (hit.lexicalRank === null ? 0 : 1 / (k + hit.lexicalRank)) +
      (hit.vectorRank === null ? 0 : 1 / (k + hit.vectorRank));
  }
  return [...hits.values()]
    .sort(
      (a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0),
    )
    .slice(0, limit);
}
