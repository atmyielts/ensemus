// The ranked-passage query is a raw `tx.execute`, whose timestamptz columns drizzle's node-postgres
// session returns as PostgreSQL text. A passage must still carry Dates (the HTTP DTO formats them).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { toRetrievedPassage, type RankedPassage } from './retrieval';

const row = (times: Pick<RankedPassage, 'sourceModifiedAt' | 'searchableAt'>): RankedPassage => ({
  chunkId: randomUUID(),
  documentId: randomUUID(),
  sourceId: randomUUID(),
  text: 'Generated passage words.',
  contentSha256: 'a'.repeat(64),
  tokenEstimate: 4,
  classification: 'internal',
  title: 'Generated title',
  sourceVersion: null,
  sourceUrl: null,
  channel: 'lexical',
  rank: 1,
  ...times,
});
const hit = { score: 1, lexicalRank: 1, vectorRank: null };

describe('retrieved passage times', () => {
  it('turns raw PostgreSQL timestamptz text into Dates the API can format', () => {
    const passage = toRetrievedPassage(
      row({
        searchableAt: '2026-11-09 10:24:00.123+00',
        sourceModifiedAt: '2026-11-08 09:00:00+00',
      }),
      hit,
    );
    expect(passage.searchableAt).toBeInstanceOf(Date);
    expect(passage.searchableAt.toISOString()).toBe('2026-11-09T10:24:00.123Z');
    expect(passage.sourceModifiedAt?.toISOString()).toBe('2026-11-08T09:00:00.000Z');
  });
  it('keeps a missing source time missing and an already parsed Date unchanged', () => {
    const searchableAt = new Date('2026-11-09T10:24:00.000Z');
    const passage = toRetrievedPassage(row({ searchableAt, sourceModifiedAt: null }), hit);
    expect(passage.searchableAt.getTime()).toBe(searchableAt.getTime());
    expect(passage.sourceModifiedAt).toBeNull();
  });
  it('refuses a time it cannot read instead of passing it on', () => {
    expect(() =>
      toRetrievedPassage(row({ searchableAt: 'not a time', sourceModifiedAt: null }), hit),
    ).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
  });
});
