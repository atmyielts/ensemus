import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { packageHash, selectEvidence, type EvidenceCandidate } from './evidence';

const candidate = (
  chunkId: string,
  text: string,
  score: number,
  tokens = 10,
): EvidenceCandidate => ({
  chunkId,
  documentId: `doc-${chunkId}`,
  sourceId: `source-${chunkId}`,
  text,
  contentSha256: createHash('sha256').update(text).digest('hex'),
  classification: 'internal',
  tokenEstimate: tokens,
  score,
  lexicalRank: 1,
  vectorRank: null,
  title: 'Generated',
  sourceVersion: 'v1',
  sourceModifiedAt: null,
});

describe('bounded and reproducible evidence', () => {
  it('deduplicates by bytes, ranks ties by chunk ID and never cuts a passage', () => {
    const input = [
      candidate('z', 'same', 1),
      candidate('b', 'different', 1),
      candidate('a', 'same', 1),
      candidate('c', 'too expensive', 2, 100),
    ];
    const result = selectEvidence(input, 20);
    expect(result.items.map((item) => [item.chunkId, item.citationKey])).toEqual([
      ['a', 'S1'],
      ['b', 'S2'],
    ]);
    expect(result.usedTokens).toBe(20);
    expect(result.dropped).toBe(2);
    expect(selectEvidence(input.toReversed(), 20)).toEqual(result);
  });
  it('preserves the strongest included class and refuses invalid budgets or corrupt evidence', () => {
    const confidential = { ...candidate('b', 'secret', 2), classification: 'restricted' as const };
    expect(
      selectEvidence([candidate('a', 'ordinary', 1), confidential], 20).strongestClassification,
    ).toBe('restricted');
    expect(selectEvidence([], 1)).toMatchObject({
      usedTokens: 0,
      items: [],
      strongestClassification: 'public',
    });
    for (const budget of [0, -1, NaN, Infinity, 1.5])
      expect(() => selectEvidence([], budget)).toThrow();
    expect(() =>
      selectEvidence([{ ...confidential, contentSha256: '0'.repeat(64) }], 100),
    ).toThrow();
  });
  it('does not trust an understated token estimate and caps the evidence budget', () => {
    expect(selectEvidence([candidate('a', 'x'.repeat(100), 1, 1)], 24).items).toEqual([]);
    expect(selectEvidence([candidate('a', 'x'.repeat(48_004), 1, 12_001)], 100_000).items).toEqual(
      [],
    );
  });
  it('hashes canonical pinned inputs, and only changes when their content or order changes', () => {
    const input = {
      querySha256: '1'.repeat(64),
      policyVersion: 'v1',
      items: [{ chunkId: 'a', contentSha256: '2'.repeat(64) }],
    };
    const expected = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    expect(packageHash(input)).toBe(expected);
    expect(
      packageHash({ items: input.items, policyVersion: 'v1', querySha256: input.querySha256 }),
    ).toBe(expected);
    expect(packageHash({ ...input, policyVersion: 'v2' })).not.toBe(expected);
  });
  it('pins fact IDs and claim hashes while making their input order immaterial', () => {
    const input = {
      querySha256: '1'.repeat(64),
      policyVersion: 'v1',
      items: [],
      facts: [
        { factId: 'b', contentSha256: '2'.repeat(64) },
        { factId: 'a', contentSha256: '3'.repeat(64) },
      ],
    };
    expect(packageHash(input)).toBe(packageHash({ ...input, facts: input.facts.toReversed() }));
    expect(packageHash(input)).not.toBe(packageHash({ ...input, facts: [] }));
  });
});
