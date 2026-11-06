// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md. Deterministic: the same text and
// version always give the same chunks, because evidence and citations rest on their hashes and offsets.

export type TextChunk = {
  ordinal: number;
  text: string;
  /** Lower-case hex SHA-256 of `text`, as stored in `knowledge.chunks.content_sha256`. */
  sha256: string;
  tokenEstimate: number;
  /** Offsets into the parsed text, in UTF-16 code units, with `charEnd` exclusive. */
  charStart: number;
  charEnd: number;
};

export type ChunkOptions = {
  /** Default 400. Chunks stay under 32 KiB of UTF-8, which the table's check also holds. */
  targetTokens?: number;
  /** Default 40, the overlap between neighbours. */
  overlapTokens?: number;
};

/** Splits on paragraph, then sentence, then word boundaries. Never returns an empty chunk. */
export function chunkText(_text: string, _options?: ChunkOptions): readonly TextChunk[] {
  throw new Error('NOT_IMPLEMENTED');
}

/** The one estimate every budget uses, so they agree: about 4 characters a token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
