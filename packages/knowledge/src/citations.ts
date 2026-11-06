// Owned by the compile slice (KNOW-03). See docs/06-delivery/m5-slices.md. A model's citations are claims,
// and this is what checks them. A model's output is untrusted, so anything that fails here is refused
// rather than repaired, and nothing a model writes can name a passage it was not given.

export type ParsedCitation = {
  citationKey: string;
  /** Offsets of the cited sentence in the answer with markers removed, with `end` exclusive. */
  start: number;
  end: number;
};

export type CitationCheck =
  | { ok: true; text: string; citations: readonly ParsedCitation[] }
  | { ok: false; code: 'CITATION_INVALID' | 'NOT_GROUNDED' };

/**
 * Reads `[S1]` style markers. Returns the text with them removed and where each one applied. A key not in
 * `allowedKeys` is `CITATION_INVALID`. An answer with no citation is `NOT_GROUNDED`, as is one where more
 * than `maxUncitedFraction` (default 0.25) of its characters sit in sentences with no marker.
 */
export function checkCitations(
  _answer: string,
  _allowedKeys: ReadonlySet<string>,
  _options?: { maxUncitedFraction?: number },
): CitationCheck {
  throw new Error('NOT_IMPLEMENTED');
}
