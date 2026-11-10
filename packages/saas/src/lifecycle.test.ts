import { describe, expect, it } from 'vitest';
import { DATA_CATEGORIES, retentionCutoff } from './lifecycle';

describe('retention requires an explicit matching signed-off rule', () => {
  const now = new Date('2042-03-01T12:34:56.789Z');
  it('never supplies a cutoff for an absent rule, for any category or classification', () => {
    for (const category of DATA_CATEGORIES)
      for (const classification of ['public', 'internal', 'confidential', 'restricted'])
        expect(retentionCutoff([], category, classification, now)).toBeNull();
  });
  it('uses an exact classification before the wildcard, including an explicit indefinite rule', () => {
    const rules = [
      { dataCategory: 'raw_files', classification: '*', retainDays: 7 },
      { dataCategory: 'raw_files', classification: 'restricted', retainDays: null },
      { dataCategory: 'raw_files', classification: 'internal', retainDays: 2 },
    ];
    expect(retentionCutoff(rules, 'raw_files', 'restricted', now)).toBeNull();
    expect(retentionCutoff(rules, 'raw_files', 'internal', now)?.toISOString()).toBe(
      '2042-02-27T12:34:56.789Z',
    );
    expect(retentionCutoff(rules, 'raw_files', 'public', now)?.toISOString()).toBe(
      '2042-02-22T12:34:56.789Z',
    );
  });
  it('does not borrow another category or mutate the clock', () => {
    const before = now.getTime();
    expect(
      retentionCutoff(
        [{ dataCategory: 'model_outputs', classification: '*', retainDays: 1 }],
        'raw_files',
        'internal',
        now,
      ),
    ).toBeNull();
    expect(now.getTime()).toBe(before);
  });
  it('keeps categories whose retention is handled by another mechanism', () => {
    for (const category of ['audit_logs', 'transaction_records'] as const)
      expect(
        retentionCutoff(
          [{ dataCategory: category, classification: '*', retainDays: 1 }],
          category,
          'internal',
          now,
        ),
      ).toBeNull();
  });
  it('refuses an invalid rule instead of selecting a deletion date', () => {
    for (const retainDays of [0, -1, 1.5, NaN])
      expect(() =>
        retentionCutoff(
          [{ dataCategory: 'raw_files', classification: '*', retainDays }],
          'raw_files',
          'internal',
          now,
        ),
      ).toThrow('INVALID_RETENTION_RULE');
    expect(() => retentionCutoff([], 'raw_files', 'internal', new Date(NaN))).toThrow(
      'INVALID_RETENTION_CLOCK',
    );
  });
});
