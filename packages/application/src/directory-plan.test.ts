import { describe, expect, it } from 'vitest';
import { DIRECTORY_MAX_NESTING, type DirectoryMember } from '@ensemus/domain/workspace-suites';
import {
  diffMembers,
  directoryEmail,
  directoryGraphOf,
  directoryTeamName,
  flattenDirectoryGroup,
} from './directory-plan';

const user = (email: string): DirectoryMember => ({ kind: 'user', externalId: email });
const group = (id: string): DirectoryMember => ({ kind: 'group', externalId: id });
const graph = (entries: Record<string, DirectoryMember[]>) => new Map(Object.entries(entries));

describe('directory flattening', () => {
  it('takes direct users, in one spelling, once each', () => {
    expect(
      flattenDirectoryGroup(
        'finance',
        graph({
          finance: [
            user(' Alex@Example.invalid '),
            user('alex@example.invalid'),
            user('not-an-address'),
            user('two@@example.invalid'),
            user('sam@example.invalid'),
          ],
        }),
      ),
    ).toEqual(['alex@example.invalid', 'sam@example.invalid']);
  });

  it('adds nested groups down to the limit and no further', () => {
    const levels: Record<string, DirectoryMember[]> = {};
    for (let depth = 0; depth <= DIRECTORY_MAX_NESTING + 1; depth += 1) {
      levels[`g${depth}`] = [user(`level${depth}@example.invalid`), group(`g${depth + 1}`)];
    }
    const emails = flattenDirectoryGroup('g0', graph(levels));
    expect(emails).toContain(`level${DIRECTORY_MAX_NESTING}@example.invalid`);
    expect(emails).not.toContain(`level${DIRECTORY_MAX_NESTING + 1}@example.invalid`);
    expect(emails).toHaveLength(DIRECTORY_MAX_NESTING + 1);
  });

  it('counts the nearest path to a group against the limit', () => {
    // g0 reaches deep both through a long chain and directly, and the direct route is what counts.
    const entries: Record<string, DirectoryMember[]> = {
      g0: [group('a1'), group('deep')],
      a1: [group('a2')],
      a2: [group('a3')],
      a3: [group('a4')],
      a4: [group('a5')],
      a5: [group('deep')],
      deep: [user('deep@example.invalid')],
    };
    expect(flattenDirectoryGroup('g0', graph(entries))).toEqual(['deep@example.invalid']);
  });

  it('cuts cycles, including a group inside itself', () => {
    const entries = graph({
      a: [user('a@example.invalid'), group('b'), group('a')],
      b: [user('b@example.invalid'), group('c')],
      c: [user('c@example.invalid'), group('a')],
    });
    expect(flattenDirectoryGroup('a', entries)).toEqual([
      'a@example.invalid',
      'b@example.invalid',
      'c@example.invalid',
    ]);
    expect(flattenDirectoryGroup('c', entries)).toEqual([
      'a@example.invalid',
      'b@example.invalid',
      'c@example.invalid',
    ]);
  });

  it('grants nothing through a nested group the page does not carry', () => {
    expect(
      flattenDirectoryGroup('a', graph({ a: [user('a@example.invalid'), group('elsewhere')] })),
    ).toEqual(['a@example.invalid']);
    expect(flattenDirectoryGroup('missing', graph({}))).toEqual([]);
  });

  it('builds the graph from a page', () => {
    const page = {
      groups: [
        { externalId: 'a', displayName: 'A', members: [group('b')] },
        { externalId: 'b', displayName: 'B', members: [user('b@example.invalid')] },
      ],
    };
    expect(flattenDirectoryGroup('a', directoryGraphOf(page))).toEqual(['b@example.invalid']);
  });
});

describe('directory membership diff', () => {
  it('adds what is wanted and removes what is not', () => {
    expect(diffMembers(['m1', 'm2', 'm2'], ['m3', 'm2', 'm3'])).toEqual({
      add: ['m3'],
      remove: ['m1'],
    });
    expect(diffMembers([], [])).toEqual({ add: [], remove: [] });
    expect(diffMembers(['m1'], [])).toEqual({ add: [], remove: ['m1'] });
  });
});

describe('directory names and emails', () => {
  it('normalizes an address and refuses what is not one', () => {
    expect(directoryEmail('Person@Example.invalid')).toBe('person@example.invalid');
    expect(directoryEmail('@example.invalid')).toBeNull();
    expect(directoryEmail('person@')).toBeNull();
    expect(directoryEmail('per son@example.invalid')).toBeNull();
  });

  it('tidies a team name and falls back to the external ID', () => {
    expect(directoryTeamName('  Finance\tTeam  ', 'finance@example.invalid')).toBe('Finance Team');
    expect(directoryTeamName('\u0007', 'finance@example.invalid')).toBe('finance@example.invalid');
    expect(directoryTeamName('x'.repeat(600), 'id')).toHaveLength(500);
  });
});
