// Owned by the compile slice (KNOW-03). See docs/06-delivery/m5-slices.md and 05-context-compiler. Pure
// steps of the compiler, so a test can reach them with no database: dedupe, trim to budget, and hash.
import type { Classification } from '@ensemus/domain/policy';

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
  _candidates: readonly EvidenceCandidate[],
  _budgetTokens: number,
): EvidenceSelection {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The hash of a package: query hash, policy version, and each item's chunk ID and content hash, in order,
 * as canonical JSON. The same pinned inputs give the same hash (05-context-compiler, "reproducible").
 */
export function packageHash(_input: {
  querySha256: string;
  policyVersion: string;
  items: readonly { chunkId: string; contentSha256: string }[];
}): string {
  throw new Error('NOT_IMPLEMENTED');
}
