import { describe, expect, it } from 'vitest';
import { breakGlassInForce, signBreakGlass, withinCoverage, type BreakGlassFacts } from './support';
const now = new Date('2039-02-07T12:00:00.000Z');
const facts = (changes: Partial<BreakGlassFacts> = {}): BreakGlassFacts => ({
  state: 'requested',
  requestedBy: 'test-requester',
  requestedMinutes: 3,
  operatorAuthorizer: null,
  customerAuthorizerMembershipId: null,
  authorizedFrom: null,
  expiresAt: null,
  ...changes,
});
describe('support access record requires both sides and an explicit bounded duration', () => {
  it('is off by default and refuses a duration beyond the configured limit', () => {
    expect(
      signBreakGlass(
        facts(),
        { side: 'operator', operatorRef: 'test-operator' },
        { enabled: false },
        now,
      ),
    ).toEqual({ ok: false, code: 'BREAK_GLASS_DISABLED' });
    expect(
      signBreakGlass(
        facts(),
        { side: 'operator', operatorRef: 'test-operator' },
        { enabled: true, maxMinutes: 2 },
        now,
      ),
    ).toEqual({ ok: false, code: 'BREAK_GLASS_TOO_LONG' });
  });
  it('never authorizes the requester as operator', () => {
    expect(
      signBreakGlass(
        facts(),
        { side: 'operator', operatorRef: 'test-requester' },
        { enabled: true, maxMinutes: 3 },
        now,
      ),
    ).toEqual({ ok: false, code: 'BREAK_GLASS_SAME_PERSON' });
  });
  it('one signature records consent without starting the clock', () => {
    expect(
      signBreakGlass(
        facts(),
        { side: 'operator', operatorRef: 'test-operator' },
        { enabled: true, maxMinutes: 3 },
        now,
      ),
    ).toEqual({ ok: true, state: 'requested', expiresAt: null });
    expect(
      signBreakGlass(
        facts(),
        { side: 'customer', membershipId: 'test-owner' },
        { enabled: true, maxMinutes: 3 },
        now,
      ),
    ).toEqual({ ok: true, state: 'requested', expiresAt: null });
  });
  it('starts the full bounded period from the second signature in either order', () => {
    for (const [value, signature] of [
      [
        facts({ operatorAuthorizer: 'test-operator' }),
        { side: 'customer', membershipId: 'test-owner' },
      ],
      [
        facts({ customerAuthorizerMembershipId: 'test-owner' }),
        { side: 'operator', operatorRef: 'test-operator' },
      ],
    ] as const)
      expect(signBreakGlass(value, signature, { enabled: true, maxMinutes: 3 }, now)).toEqual({
        ok: true,
        state: 'authorized',
        expiresAt: new Date(now.getTime() + 3 * 60000),
      });
  });
  it('rejects replacing an existing signature and any terminal request', () => {
    expect(
      signBreakGlass(
        facts({ operatorAuthorizer: 'test-operator' }),
        { side: 'operator', operatorRef: 'test-other' },
        { enabled: true, maxMinutes: 3 },
        now,
      ),
    ).toEqual({ ok: false, code: 'BREAK_GLASS_NOT_REQUESTED' });
    for (const state of ['denied', 'revoked', 'expired'] as const)
      expect(
        signBreakGlass(
          facts({ state }),
          { side: 'operator', operatorRef: 'test-operator' },
          { enabled: true, maxMinutes: 3 },
          now,
        ).ok,
      ).toBe(false);
  });
  it('the clock, both signatures and the exact interval determine whether it remains in force', () => {
    const value = facts({
      state: 'authorized',
      operatorAuthorizer: 'test-operator',
      customerAuthorizerMembershipId: 'test-owner',
      authorizedFrom: now,
      expiresAt: new Date(now.getTime() + 3 * 60000),
    });
    expect(breakGlassInForce(value, now)).toBe(true);
    expect(breakGlassInForce(value, new Date(now.getTime() - 1))).toBe(false);
    expect(breakGlassInForce(value, value.expiresAt!)).toBe(false);
    expect(breakGlassInForce({ ...value, operatorAuthorizer: null }, now)).toBe(false);
    expect(breakGlassInForce({ ...value, state: 'revoked' }, now)).toBe(false);
  });
});
describe('published coverage uses the supplied timezone and windows only', () => {
  it('has no fallback hours or timezone', () => {
    expect(withinCoverage(null, null, now)).toBe(false);
    expect(withinCoverage([], 'UTC', now)).toBe(false);
    expect(withinCoverage([{ day: 1, from: '09:00', to: '17:00' }], null, now)).toBe(false);
  });
  it('includes the start and excludes the end of an explicit local window', () => {
    const windows = [{ day: 1, from: '09:00', to: '10:00' }];
    expect(withinCoverage(windows, 'UTC', new Date('2001-01-01T09:00:00Z'))).toBe(true);
    expect(withinCoverage(windows, 'UTC', new Date('2001-01-01T10:00:00Z'))).toBe(false);
    expect(withinCoverage(windows, 'Asia/Tokyo', new Date('2001-01-01T00:00:00Z'))).toBe(true);
  });
  it('handles an overnight window across the week boundary and refuses malformed data', () => {
    const windows = [{ day: 6, from: '23:00', to: '01:00' }];
    expect(withinCoverage(windows, 'UTC', new Date('2001-01-07T00:30:00Z'))).toBe(true);
    expect(withinCoverage(windows, 'UTC', new Date('2001-01-07T01:00:00Z'))).toBe(false);
    expect(withinCoverage([{ day: 7, from: '09:00', to: '10:00' }], 'UTC', now)).toBe(false);
    expect(withinCoverage(windows, 'not-a-timezone', now)).toBe(false);
  });
});
