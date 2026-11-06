// Owned by the compile slice (KNOW-03). See docs/06-delivery/m5-slices.md. Fixed text and structured roles,
// so a poisoned document stays evidence and cannot become an instruction. Golden tests hold this.
import type { SelectedEvidence } from './evidence';
import type { KnowledgeMessage } from './ports';

/** Bumped when the fixed text changes, and recorded with each package's policy version. */
export const ANSWER_PROMPT_VERSION = 'v1';

/**
 * One `policy` message of fixed text that says evidence is data and never instructions, one `evidence`
 * message per item with `partId` as its citation key, and the question as `task`. Nothing from a document
 * or the question reaches the policy text. Interpolates no secret and has no way to.
 */
export function buildAnswerMessages(
  _question: string,
  _evidence: readonly SelectedEvidence[],
): readonly KnowledgeMessage[] {
  throw new Error('NOT_IMPLEMENTED');
}
