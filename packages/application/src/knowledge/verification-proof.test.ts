import { describe, expect, it } from 'vitest';
import { artifactCoverage, citationProofHash, type CitationProof } from './verification-proof';

const citation: CitationProof = {
  ordinal: 1,
  chunkId: '11111111-1111-4111-8111-111111111111',
  documentId: '22222222-2222-4222-8222-222222222222',
  sourceId: '33333333-3333-4333-8333-333333333333',
  contentSha256: 'a'.repeat(64),
  artifactStart: 0,
  artifactEnd: 4,
  recordedByMembershipId: '44444444-4444-4444-8444-444444444444',
};
describe('bounded artifact attribution proof', () => {
  it('accepts complete and threshold coverage, without claiming that attribution proves truth', () => {
    expect(artifactCoverage(Buffer.from('abcd'), [citation])).toBeNull();
    expect(artifactCoverage(Buffer.from('abcd'), [{ ...citation, artifactEnd: 3 }])).toBeNull();
    expect(artifactCoverage(Buffer.from('abcd'), [{ ...citation, artifactEnd: 2 }])).toBe(
      'NOT_GROUNDED',
    );
  });
  it('counts covered characters once, so repeating one small citation cannot manufacture coverage', () => {
    const small = { ...citation, artifactEnd: 2 };
    expect(
      artifactCoverage(
        Buffer.from('abcdefgh'),
        Array.from({ length: 20 }, () => small),
      ),
    ).toBe('NOT_GROUNDED');
    expect(
      artifactCoverage(Buffer.from('abcdefgh'), [
        small,
        { ...citation, artifactStart: 2, artifactEnd: 8 },
      ]),
    ).toBeNull();
  });
  it('ignores whitespace when measuring useful text and refuses whitespace-only spans', () => {
    expect(
      artifactCoverage(Buffer.from('a  b\nc\td'), [{ ...citation, artifactEnd: 8 }]),
    ).toBeNull();
    expect(
      artifactCoverage(Buffer.from('a  b'), [{ ...citation, artifactStart: 1, artifactEnd: 3 }]),
    ).toBe('CITATION_INVALID');
  });
  it.each([
    { artifactStart: -1, artifactEnd: 4 },
    { artifactStart: 0, artifactEnd: 5 },
    { artifactStart: 2, artifactEnd: 2 },
    { artifactStart: 3, artifactEnd: 1 },
    { artifactStart: 0.5, artifactEnd: 4 },
    { artifactStart: 0, artifactEnd: Infinity },
  ])('refuses malformed span $artifactStart..$artifactEnd', (span) => {
    expect(artifactCoverage(Buffer.from('abcd'), [{ ...citation, ...span }])).toBe(
      'CITATION_INVALID',
    );
  });
  it('refuses missing citations, invalid UTF-8, null characters and oversized text', () => {
    expect(artifactCoverage(Buffer.from('abcd'), [])).toBe('NOT_GROUNDED');
    expect(artifactCoverage(Buffer.from([255]), [citation])).toBe('CITATION_INVALID');
    expect(artifactCoverage(Buffer.from('abc\0'), [citation])).toBe('CITATION_INVALID');
    expect(artifactCoverage(Buffer.from('x'.repeat(65_537)), [citation])).toBe('CITATION_INVALID');
  });
  it('uses UTF-16 offsets consistently for non-ASCII artifact text', () => {
    const text = 'A😀文';
    expect(text.length).toBe(4);
    expect(artifactCoverage(Buffer.from(text), [citation])).toBeNull();
  });
  it('binds every provenance dimension and the named recording viewer', () => {
    const original = citationProofHash([citation]);
    const changes: Partial<CitationProof>[] = [
      { ordinal: 2 },
      { chunkId: citation.documentId },
      { documentId: citation.chunkId },
      { sourceId: citation.chunkId },
      { contentSha256: 'b'.repeat(64) },
      { artifactStart: 1 },
      { artifactEnd: 3 },
      { recordedByMembershipId: null },
    ];
    for (const change of changes)
      expect(citationProofHash([{ ...citation, ...change }])).not.toBe(original);
  });
  it('is independent of query result order while retaining authoritative citation ordinals', () => {
    const second = { ...citation, ordinal: 2, artifactStart: 4, artifactEnd: 8 };
    expect(citationProofHash([citation, second])).toBe(citationProofHash([second, citation]));
  });
});
