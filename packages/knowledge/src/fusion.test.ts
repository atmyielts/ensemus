import { describe, expect, it } from 'vitest';
import { fuseRanks } from './fusion';

describe('reciprocal rank fusion', () => {
  it('adds each list once, keeps both ranks and breaks ties by ID', () => {
    const result = fuseRanks(
      [
        { chunkId: 'b', rank: 1 },
        { chunkId: 'a', rank: 2 },
      ],
      [
        { chunkId: 'a', rank: 1 },
        { chunkId: 'b', rank: 2 },
      ],
    );
    expect(result.map((hit) => hit.chunkId)).toEqual(['a', 'b']);
    expect(result[0]).toEqual({
      chunkId: 'a',
      score: 1 / 62 + 1 / 61,
      lexicalRank: 2,
      vectorRank: 1,
    });
  });
  it('does not let repeated candidates inflate their weight', () => {
    const result = fuseRanks(
      [
        { chunkId: 'a', rank: 3 },
        { chunkId: 'a', rank: 1 },
        { chunkId: 'a', rank: 1 },
      ],
      [{ chunkId: 'b', rank: 1 }],
      { k: 0 },
    );
    expect(result).toEqual([
      { chunkId: 'a', score: 1, lexicalRank: 1, vectorRank: null },
      { chunkId: 'b', score: 1, lexicalRank: null, vectorRank: 1 },
    ]);
  });
  it('is deterministic for input order, bounded, and does not mutate its inputs', () => {
    const lexical = Object.freeze([
      { chunkId: 'z', rank: 2 },
      { chunkId: 'a', rank: 1 },
    ]);
    expect(fuseRanks(lexical, [], { limit: 1 }).map((hit) => hit.chunkId)).toEqual(['a']);
    expect(fuseRanks(lexical, [])).toEqual(fuseRanks([...lexical].reverse(), []));
    expect(fuseRanks([], [])).toEqual([]);
    expect(fuseRanks(lexical, [], { limit: 0 })).toEqual([]);
  });
  it('refuses invalid ranks and options rather than producing NaN or infinity', () => {
    for (const rank of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => fuseRanks([{ chunkId: 'a', rank }], [])).toThrow();
    }
    for (const k of [-1, Infinity, NaN]) expect(() => fuseRanks([], [], { k })).toThrow();
    for (const limit of [-1, 1.5, Infinity]) expect(() => fuseRanks([], [], { limit })).toThrow();
  });
});
