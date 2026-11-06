import { describe, expect, it } from 'vitest';
import { checkCitations } from './citations';

describe('untrusted citation markers and sentence coverage', () => {
  const keys = new Set(['S1', 'S2']);
  it('refuses unknown, malformed, prefixed and absent citations', () => {
    for (const answer of [
      'Claim.[S3]',
      'Claim.[S0]',
      'Claim.[S01]',
      'Claim.[s1]',
      'Claim.[S1,S2]',
      'Claim.[S1',
      '[S1] Claim.',
    ])
      expect(checkCitations(answer, keys)).toEqual({ ok: false, code: 'CITATION_INVALID' });
    expect(checkCitations('No evidence here.', keys)).toEqual({ ok: false, code: 'NOT_GROUNDED' });
    expect(checkCitations('', keys)).toEqual({ ok: false, code: 'NOT_GROUNDED' });
  });
  it('returns exact UTF-16 spans after markers are removed, including multiple keys per sentence', () => {
    const answer = '😀 First claim.[S1][S2] Second claim![S2]';
    expect(checkCitations(answer, keys)).toEqual({
      ok: true,
      text: '😀 First claim. Second claim!',
      citations: [
        { citationKey: 'S1', start: 0, end: 15 },
        { citationKey: 'S2', start: 0, end: 15 },
        { citationKey: 'S2', start: 16, end: 29 },
      ],
    });
  });
  it('does not let one marker cover earlier unsupported sentences', () => {
    expect(checkCitations('Unsupported claims are a very long sentence. Brief.[S1]', keys)).toEqual(
      { ok: false, code: 'NOT_GROUNDED' },
    );
    expect(
      checkCitations('Heading\nA sufficiently long supported generated claim.[S1]', keys),
    ).toMatchObject({ ok: true });
    expect(
      checkCitations('Heading\nA sufficiently long supported generated claim.[S1]', keys, {
        maxUncitedFraction: 0,
      }),
    ).toEqual({ ok: false, code: 'NOT_GROUNDED' });
  });
  it('bounds output and does not accept invalid coverage settings', () => {
    expect(checkCitations('a'.repeat(65_537) + '[S1]', keys)).toEqual({
      ok: false,
      code: 'CITATION_INVALID',
    });
    expect(() => checkCitations('Claim.[S1]', keys, { maxUncitedFraction: NaN })).toThrow();
  });
});
