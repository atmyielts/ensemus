import { describe, expect, it } from 'vitest';
import {
  formatMoney,
  microsFromWire,
  microsToWire,
  minorUnitMicros,
  roundToMinorUnit,
} from './money';

describe('whole micro-unit money', () => {
  it.each([-1, 5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses exponent %s', (value) => {
    expect(() => minorUnitMicros(value)).toThrow('INVALID_MINOR_UNIT');
  });

  it('uses the exponent supplied as data', () => {
    expect([0, 1, 2, 3, 4].map(minorUnitMicros)).toEqual([
      1_000_000n,
      100_000n,
      10_000n,
      1_000n,
      100n,
    ]);
  });

  it('rounds half away from zero and keeps an exact rounding difference', () => {
    for (let exponent = 0; exponent <= 4; exponent += 1) {
      const unit = minorUnitMicros(exponent);
      expect(roundToMinorUnit(unit / 2n - 1n, exponent)).toBe(0n);
      expect(roundToMinorUnit(unit / 2n, exponent)).toBe(unit);
      expect(roundToMinorUnit(-unit / 2n, exponent)).toBe(-unit);
      for (let value = -37n; value <= 37n; value += 1n) {
        const exact = value * 23_789n;
        const rounded = roundToMinorUnit(exact, exponent);
        const roundingLine = rounded - exact;
        expect(exact + roundingLine).toBe(rounded);
        expect(rounded % unit).toBe(0n);
        expect(roundToMinorUnit(-exact, exponent)).toBe(-rounded);
      }
    }
  });

  it('round-trips wire values beyond JavaScript safe integers', () => {
    for (const value of [0n, 9_007_199_254_740_993n, -9_007_199_254_740_993n]) {
      expect(microsFromWire(microsToWire(value))).toBe(value);
    }
  });

  it.each(['', '01', '+1', '1.0', '1e3', ' 1', '1 ', '1\n', '99999999999999999999'])(
    'refuses noncanonical wire %s',
    (value) => {
      expect(() => microsFromWire(value)).toThrow('INVALID_AMOUNT');
    },
  );

  it('formats with the supplied code without changing arithmetic', () => {
    expect(formatMoney(-1_234_567n, 'XTS', 2)).toBe('-1.23 XTS');
    expect(formatMoney(1_234_567n, 'XTS', 0)).toBe('1 XTS');
    expect(formatMoney(1_234_567n, 'XTS', 4)).toBe('1.2345 XTS');
  });
});
