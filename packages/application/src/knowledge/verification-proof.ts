import { createHash } from 'node:crypto';

export const verificationHash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

export type CitationProof = {
  ordinal: number;
  chunkId: string;
  documentId: string;
  sourceId: string;
  contentSha256: string;
  artifactStart: number;
  artifactEnd: number;
  recordedByMembershipId: string | null;
};

/** Same length-unambiguous, fixed-field encoding as 0206's artifact_citation_digest. IDs are canonical. */
export function citationProofHash(citations: readonly CitationProof[]): string {
  return verificationHash(
    [...citations]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((item) =>
        [
          item.ordinal,
          item.chunkId,
          item.documentId,
          item.sourceId,
          item.contentSha256,
          item.artifactStart,
          item.artifactEnd,
          item.recordedByMembershipId ?? '-',
        ].join(':'),
      )
      .join('\n'),
  );
}

/** Structural attribution only. Human acceptance, not this coverage check, judges the claim's truth. */
export function artifactCoverage(
  bytes: Buffer,
  citations: readonly CitationProof[],
): 'NOT_GROUNDED' | 'CITATION_INVALID' | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return 'CITATION_INVALID';
  }
  if (!text.trim() || !citations.length) return 'NOT_GROUNDED';
  if (text.length > 65_536 || text.includes('\0')) return 'CITATION_INVALID';
  const covered = new Uint8Array(text.length);
  for (const item of citations) {
    if (
      !Number.isSafeInteger(item.artifactStart) ||
      !Number.isSafeInteger(item.artifactEnd) ||
      item.artifactStart < 0 ||
      item.artifactEnd <= item.artifactStart ||
      item.artifactEnd > text.length ||
      !text.slice(item.artifactStart, item.artifactEnd).trim()
    )
      return 'CITATION_INVALID';
    covered.fill(1, item.artifactStart, item.artifactEnd);
  }
  let total = 0,
    cited = 0;
  for (let at = 0; at < text.length; at++)
    if (!/\s/.test(text[at]!)) {
      total += 1;
      if (covered[at]) cited += 1;
    }
  return total && cited / total >= 0.75 ? null : 'NOT_GROUNDED';
}
