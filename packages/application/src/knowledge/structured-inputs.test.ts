import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeStructuredInputs } from './artifact-provenance';
const work = randomUUID(),
  hash = 'a'.repeat(64),
  changed = 'b'.repeat(64);
describe('structured read inventory is explicit and historical', () => {
  it.each([undefined, null, [], [{ kind: 'client', id: randomUUID(), sha256: hash }]])(
    'refuses absent inventory or missing target Work',
    (input) => {
      expect(() => normalizeStructuredInputs(input, work)).toThrow();
    },
  );
  it('keeps actual rereads with different hashes and deduplicates identical observations', () => {
    const first = { kind: 'work_unit', id: work, sha256: hash },
      second = { ...first, sha256: changed };
    expect(normalizeStructuredInputs([second, first, first], work)).toEqual([first, second]);
  });
  it('rejects unknown record kinds, invalid IDs/hashes and an unbounded ledger', () => {
    for (const value of [
      { kind: 'artifact', id: work, sha256: hash },
      { kind: 'work_unit', id: 'invalid', sha256: hash },
      { kind: 'work_unit', id: work, sha256: 'not-a-hash' },
      { kind: 'work_unit', id: work, sha256: hash, classification: 'invented' },
    ])
      expect(() => normalizeStructuredInputs([value], work)).toThrow();
    expect(() =>
      normalizeStructuredInputs(
        Array.from({ length: 1001 }, () => ({ kind: 'work_unit', id: work, sha256: hash })),
        work,
      ),
    ).toThrow();
  });
  it('cannot weaken a previously captured class when the same historical material is read again', () => {
    const record = { kind: 'work_unit', id: work, sha256: hash };
    expect(
      normalizeStructuredInputs(
        [
          { ...record, classification: 'restricted' },
          { ...record, classification: 'public' },
          record,
        ],
        work,
      ),
    ).toEqual([{ ...record, classification: 'restricted' }]);
    expect(
      normalizeStructuredInputs(
        [
          { ...record, classification: 'public' },
          { ...record, classification: 'restricted' },
        ],
        work,
      ),
    ).toEqual([{ ...record, classification: 'restricted' }]);
  });
});
