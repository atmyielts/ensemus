// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md. Deterministic: the same text and
// version always give the same chunks, because evidence and citations rest on their hashes and offsets.
import { createHash } from 'node:crypto';
import { MAX_CHUNKS_PER_DOCUMENT } from '@ensemus/domain/knowledge';

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
export function chunkText(text: string, options: ChunkOptions = {}): readonly TextChunk[] {
  const target = options.targetTokens ?? 400;
  const overlap = options.overlapTokens ?? 40;
  if (
    !Number.isInteger(target) ||
    target < 1 ||
    !Number.isInteger(overlap) ||
    overlap < 0 ||
    overlap >= target
  ) {
    throw new Error('INVALID_CHUNK_OPTIONS');
  }
  // At most three UTF-8 bytes per UTF-16 unit, so this is inside the table's byte ceiling even for CJK.
  const width = Math.min(target * 4, 8192);
  const overlapChars = Math.min(overlap * 4, Math.floor(width / 3));
  const chunks: TextChunk[] = [];
  let start = 0;
  const length = text.trimEnd().length;
  while (start < length) {
    while (start < length && /\s/.test(text[start] ?? '')) start += 1;
    if (start >= length) break;
    let end = Math.min(start + width, length);
    if (end < length) {
      const candidate = text.slice(start, end);
      const halfway = Math.floor(candidate.length / 2);
      let boundary = -1;
      for (const pattern of [/\n\s*\n/g, /[.!?]\s+/g, /\s+/g]) {
        for (const match of candidate.matchAll(pattern)) {
          if ((match.index ?? 0) >= halfway) boundary = (match.index ?? 0) + match[0].length;
        }
        if (boundary > 0) break;
      }
      if (boundary > 0) end = start + boundary;
      if (isLow(text.charCodeAt(end))) end -= 1;
    }
    while (end > start && /\s/.test(text[end - 1] ?? '')) end -= 1;
    if (end <= start) end = Math.min(start + width, length);
    const part = text.slice(start, end);
    chunks.push({
      ordinal: chunks.length,
      text: part,
      sha256: createHash('sha256').update(part).digest('hex'),
      tokenEstimate: estimateTokens(part),
      charStart: start,
      charEnd: end,
    });
    if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) throw new Error('TOO_LARGE');
    if (end === length) break;
    let next = Math.max(start + 1, end - overlapChars);
    if (isLow(text.charCodeAt(next))) next += 1;
    start = next;
  }
  return chunks;
}

const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The one estimate every budget uses, so they agree: about 4 characters a token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
