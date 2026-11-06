import { CLASSIFICATIONS } from '@ensemus/domain/ai';
import { describe, expect, it } from 'vitest';
import { strongest } from './classification';

describe('classes', () => {
  it('take the strongest when mixed', () => {
    expect(strongest('public', 'confidential')).toBe('confidential');
  });

  it('mixed in any order come to the same class', () => {
    for (const a of CLASSIFICATIONS) {
      for (const b of CLASSIFICATIONS) {
        expect(strongest(a, b)).toBe(strongest(b, a));
      }
    }
  });

  it('never lower: the result is at least as strong as both', () => {
    for (const a of CLASSIFICATIONS) {
      for (const b of CLASSIFICATIONS) {
        const mixed = CLASSIFICATIONS.indexOf(strongest(a, b));
        expect(mixed).toBeGreaterThanOrEqual(CLASSIFICATIONS.indexOf(a));
        expect(mixed).toBeGreaterThanOrEqual(CLASSIFICATIONS.indexOf(b));
      }
    }
  });

  it('stay restricted once restricted, whatever is mixed in', () => {
    for (const other of CLASSIFICATIONS) {
      expect(strongest('restricted', other)).toBe('restricted');
    }
  });

  it('do not change when mixed with themselves', () => {
    for (const each of CLASSIFICATIONS) expect(strongest(each, each)).toBe(each);
  });
});
