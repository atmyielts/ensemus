import { describe, expect, it } from 'vitest';
import {
  bearer,
  createScimLimiter,
  listQuery,
  patchActive,
  SCIM_PATCH,
} from '../../apps/web/src/lib/scim';
describe('bounded SCIM request subset', () => {
  it('accepts one strict bearer value without storing or normalizing its secret', () => {
    const token = `ens_scim_${'a'.repeat(43)}`;
    expect(bearer(new Headers({ authorization: `Bearer ${token}` }))).toBe(token);
    for (const value of [
      '',
      `Basic ${token}`,
      `Bearer ${token},other`,
      `Bearer ${token} other`,
      'Bearer ' + 'a'.repeat(500),
    ])
      expect(bearer(new Headers({ authorization: value }))).toBeNull();
  });
  it('supports bounded list pagination, count zero and only exact userName equality', () => {
    expect(listQuery(new URL('https://example.invalid/Users'))).toEqual({
      startIndex: 1,
      count: 100,
    });
    expect(listQuery(new URL('https://example.invalid/Users?count=0'))).toEqual({
      startIndex: 1,
      count: 0,
    });
    expect(
      listQuery(
        new URL(
          'https://example.invalid/Users?filter=userName%20eq%20%22person%40example.invalid%22&startIndex=2&count=5',
        ),
      ),
    ).toEqual({ filterUserName: 'person@example.invalid', startIndex: 2, count: 5 });
    for (const query of [
      'count=101',
      'startIndex=0',
      'startIndex=-1',
      'count=1&count=2',
      'filter=active%20eq%20true',
      'filter=userName%20co%20%22person%22',
      'filter=userName%20eq%20%22x%22',
      'sortBy=userName',
    ])
      expect(listQuery(new URL(`https://example.invalid/Users?${query}`)), query).toBeNull();
  });
  it('accepts only one explicit boolean active operation, including pathless RFC form', () => {
    for (const value of [true, false]) {
      expect(
        patchActive({
          schemas: [SCIM_PATCH],
          Operations: [{ op: 'Replace', path: 'active', value }],
        }),
      ).toBe(value);
      expect(
        patchActive({
          schemas: [SCIM_PATCH],
          Operations: [{ op: 'add', value: { active: value } }],
        }),
      ).toBe(value);
    }
    for (const operation of [
      { op: 'remove', path: 'active' },
      { op: 'replace', path: 'active', value: 'false' },
      { op: 'replace', path: 'roles', value: ['owner'] },
      { op: 'replace', value: { active: true, userName: 'forged' } },
      { op: 'replace', path: 'active', value: true, sessionId: 'forged' },
    ])
      expect(patchActive({ schemas: [SCIM_PATCH], Operations: [operation] })).toBeNull();
    expect(
      patchActive({
        schemas: [SCIM_PATCH],
        Operations: [
          { op: 'replace', path: 'active', value: true },
          { op: 'replace', path: 'active', value: false },
        ],
      }),
    ).toBeNull();
    expect(patchActive({ schemas: [], Operations: [] })).toBeNull();
  });
  it('limits before DB, bounds new peers, recovers expired windows and refuses clock rollback reuse', () => {
    const limiter = createScimLimiter({ max: 2, windowMs: 1000, maxKeys: 2 });
    expect(limiter.admit('one', 100)).toBe(true);
    expect(limiter.admit('one', 101)).toBe(true);
    expect(limiter.admit('one', 102)).toBe(false);
    expect(limiter.admit('one', 99)).toBe(false);
    expect(limiter.admit('two', 100)).toBe(true);
    expect(limiter.admit('three', 200)).toBe(false);
    expect(limiter.size()).toBe(2);
    expect(limiter.admit('three', 1200)).toBe(true);
    expect(limiter.size()).toBe(1);
  });
});
