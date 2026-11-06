// Owned by the compile slice (KNOW-03). See docs/06-delivery/m5-slices.md and 05-context-compiler. Pure
// steps of the compiler, so a test can reach them with no database: dedupe, trim to budget, and hash.
import type { Classification } from '@ensemus/domain/policy';
import { MAX_EVIDENCE_TOKENS, strongestClass } from '@ensemus/domain/knowledge';
import { createHash } from 'node:crypto';

export type EvidenceCandidate = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  text: string;
  contentSha256: string;
  classification: Classification;
  tokenEstimate: number;
  score: number;
  lexicalRank: number | null;
  vectorRank: number | null;
  title: string;
  sourceVersion: string | null;
  sourceModifiedAt: Date | null;
};

export type SelectedEvidence = EvidenceCandidate & { citationKey: string };

export type EvidenceSelection = {
  items: readonly SelectedEvidence[];
  usedTokens: number;
  /** Candidates dropped for being over budget or near-duplicates. A count, for the package's record. */
  dropped: number;
  strongestClassification: Classification;
};

/**
 * Keeps the best candidates that fit, dropping exact duplicates by hash and never cutting a passage in
 * half. `citationKey` is `S1`, `S2` and so on, in selection order, and is what a model cites by.
 */
export function selectEvidence(
  candidates: readonly EvidenceCandidate[],
  budgetTokens: number,
): EvidenceSelection {
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1)
    throw new RangeError('INVALID_EVIDENCE_BUDGET');
  const budget = Math.min(budgetTokens, MAX_EVIDENCE_TOKENS);
  for (const candidate of candidates) {
    if (
      !Number.isFinite(candidate.score) ||
      !Number.isSafeInteger(candidate.tokenEstimate) ||
      candidate.tokenEstimate < 1 ||
      !candidate.chunkId ||
      !candidate.text ||
      createHash('sha256').update(candidate.text).digest('hex') !== candidate.contentSha256 ||
      !['public', 'internal', 'confidential', 'restricted'].includes(candidate.classification)
    )
      throw new Error('INVALID_EVIDENCE');
  }
  const ranked = [...candidates].sort(
    (a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0),
  );
  const hashes = new Set<string>();
  const chunks = new Set<string>();
  const items: SelectedEvidence[] = [];
  let usedTokens = 0;
  for (const candidate of ranked) {
    const tokenEstimate = Math.max(candidate.tokenEstimate, Math.ceil(candidate.text.length / 4));
    if (
      hashes.has(candidate.contentSha256) ||
      chunks.has(candidate.chunkId) ||
      usedTokens + tokenEstimate > budget
    )
      continue;
    hashes.add(candidate.contentSha256);
    chunks.add(candidate.chunkId);
    items.push({ ...candidate, tokenEstimate, citationKey: `S${items.length + 1}` });
    usedTokens += tokenEstimate;
  }
  return {
    items,
    usedTokens,
    dropped: candidates.length - items.length,
    strongestClassification: strongestClass(items.map((item) => item.classification)),
  };
}

/**
 * The hash of a package: query hash, policy version, and each item's chunk ID and content hash, in order,
 * as canonical JSON. The same pinned inputs give the same hash (05-context-compiler, "reproducible").
 */
export function packageHash(input: {
  querySha256: string;
  policyVersion: string;
  items: readonly { chunkId: string; contentSha256: string }[];
  facts?: readonly { factId: string; contentSha256: string }[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        querySha256: input.querySha256,
        policyVersion: input.policyVersion,
        items: input.items.map((item) => ({
          chunkId: item.chunkId,
          contentSha256: item.contentSha256,
        })),
        ...(input.facts?.length
          ? {
              facts: input.facts
                .map((fact) => ({ factId: fact.factId, contentSha256: fact.contentSha256 }))
                .sort((a, b) => (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0)),
            }
          : {}),
      }),
    )
    .digest('hex');
}
