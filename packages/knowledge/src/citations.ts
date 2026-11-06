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
  answer: string,
  allowedKeys: ReadonlySet<string>,
  options?: { maxUncitedFraction?: number },
): CitationCheck {
  const max = options?.maxUncitedFraction ?? 0.25;
  if (!Number.isFinite(max) || max < 0 || max > 1)
    throw new RangeError('INVALID_CITATION_COVERAGE');
  if (answer.length > 65_536 || answer.includes('\0'))
    return { ok: false, code: 'CITATION_INVALID' };
  const markers: { key: string; offset: number }[] = [];
  let text = '',
    from = 0;
  for (const match of answer.matchAll(/\[[sS][^\]\r\n]*(?:\]|$)/g)) {
    const key = /^\[(S[1-9]\d*)\]$/.exec(match[0])?.[1];
    if (!key || !allowedKeys.has(key)) return { ok: false, code: 'CITATION_INVALID' };
    text += answer.slice(from, match.index);
    markers.push({ key, offset: text.length });
    from = match.index + match[0].length;
  }
  text += answer.slice(from);
  if (!markers.length || !text.trim()) return { ok: false, code: 'NOT_GROUNDED' };
  const sentences: { start: number; end: number; weight: number; cited: boolean }[] = [];
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  // A heading or bullet on a separate line must not inherit the next sentence's citation.
  let lineOffset = 0;
  for (const line of text.split('\n')) {
    for (const segment of segmenter.segment(line)) {
      const leading = segment.segment.length - segment.segment.trimStart().length;
      const trimmed = segment.segment.trim();
      if (trimmed)
        sentences.push({
          start: lineOffset + segment.index + leading,
          end: lineOffset + segment.index + leading + trimmed.length,
          weight: trimmed.replace(/\s/g, '').length,
          cited: false,
        });
    }
    lineOffset += line.length + 1;
  }
  const citations: ParsedCitation[] = [];
  const seen = new Set<string>();
  let sentenceIndex = 0;
  for (const marker of markers) {
    let before = marker.offset - 1;
    while (before >= 0 && /\s/.test(text[before]!)) before--;
    while (sentenceIndex + 1 < sentences.length && sentences[sentenceIndex + 1]!.start <= before)
      sentenceIndex++;
    const sentence = sentences[sentenceIndex];
    if (!sentence || before < sentence.start || before >= sentence.end)
      return { ok: false, code: 'CITATION_INVALID' };
    sentence.cited = true;
    const key = `${marker.key}:${sentence.start}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({ citationKey: marker.key, start: sentence.start, end: sentence.end });
    }
  }
  const total = sentences.reduce((sum, part) => sum + part.weight, 0);
  const uncited = sentences.reduce((sum, part) => sum + (part.cited ? 0 : part.weight), 0);
  // This is a structural grounding check. A model's citation is never proof that a claim is true.
  if (!total || uncited / total > max) return { ok: false, code: 'NOT_GROUNDED' };
  return { ok: true, text, citations };
}
