import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { factClaim, factPage, factReason, factSubject } from './fact-input';

describe('bounded fact inputs', () => {
  it('requires an allowlisted subject type and a valid identifier', () => {
    const id = randomUUID();
    expect(factSubject(`client:${id}`)).toEqual({ type: 'client', id, ref: `client:${id}` });
    for (const value of [`secret:${id}`, `client:${id}:extra`, 'client:not-an-id', ''])
      expect(() => factSubject(value)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
  it('copies JSON claims and refuses invalid, cyclic, oversized or null-character data', () => {
    const value = { amount: 3, nested: ['generated'] };
    expect(factClaim(value)).toEqual(value);
    expect(factClaim(value)).not.toBe(value);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const claim of [
      undefined,
      1n,
      cyclic,
      NaN,
      Infinity,
      { missing: undefined },
      'x'.repeat(16_001),
      '\0',
    ])
      expect(() => factClaim(claim)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
  it('keeps review reasons bounded and requires meaningful text', () => {
    expect(factReason(' reviewed evidence ')).toBe('reviewed evidence');
    expect(() => factReason(' ')).toThrow(expect.objectContaining({ code: 'REASON_REQUIRED' }));
    for (const value of ['x'.repeat(2001), 'reason\0']) expect(() => factReason(value)).toThrow();
  });
  it('rejects malformed cursors and unbounded pages', () => {
    for (const after of [
      'garbage',
      Buffer.from(JSON.stringify(['not-a-date', randomUUID()])).toString('base64url'),
      Buffer.from(JSON.stringify([new Date().toISOString(), 'foreign-shape'])).toString(
        'base64url',
      ),
    ])
      expect(() => factPage({ after })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    for (const limit of [0, -1, 51, 1.5, Infinity]) expect(() => factPage({ limit })).toThrow();
    expect(() => factPage({ trustState: 'automatically_verified' })).toThrow();
  });
  it('round-trips a millisecond cursor with its UUID tie-break', () => {
    const at = new Date('2026-11-06T12:13:14.123Z');
    const id = randomUUID();
    const after = Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');
    expect(factPage({ after, limit: 2 })).toEqual({ limit: 2, after: { at, id } });
  });
});
