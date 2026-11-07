import { describe, it, expect } from 'vitest';
import { exportEpochMatches } from '@ensemus/application';

describe('an export epoch is an exact database pin, never an inferred default', () => {
  it.each([
    [null, '1'],
    ['1', null],
    [undefined, '1'],
    ['0', '0'],
    ['01', '01'],
    ['1', '2'],
    ['-1', '-1'],
  ])('closes a missing, invalid or changed pin (%s,%s)', (pinned, current) =>
    expect(exportEpochMatches(pinned, current)).toBe(false),
  );
  it('compares counters above JavaScript safe integers without rounding', () => {
    expect(exportEpochMatches('9007199254740993', '9007199254740993')).toBe(true);
    expect(exportEpochMatches('9007199254740993', '9007199254740992')).toBe(false);
  });
});
