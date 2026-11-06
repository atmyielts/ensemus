// Source ACL mapping fails closed (ADR-027 D3). A grant nobody matches keeps its row and gives nothing.
import { aclStateOf, type SourceGrant } from '@ensemus/domain/connector';
import { describe, expect, it, vi } from 'vitest';
import type { PrincipalDirectory } from '../index';
import { mapSourceGrants } from './acl';

const user = (id: string, access: SourceGrant['access'] = 'read'): SourceGrant => ({
  principalKind: 'user',
  principalExternalId: id,
  access,
});

describe('mapSourceGrants', () => {
  it('maps each grant in order, and one nobody matches keeps its row with no target', async () => {
    const directory: PrincipalDirectory = {
      resolve: async ({ externalId }) =>
        externalId === 'known@example.invalid'
          ? { membershipId: 'member-1' }
          : externalId === 'team'
            ? { teamId: 'team-1' }
            : null,
    };
    await expect(
      mapSourceGrants(
        [
          user('nobody@example.invalid'),
          user('known@example.invalid', 'owner'),
          { principalKind: 'group', principalExternalId: 'team', access: 'write' },
        ],
        directory,
      ),
    ).resolves.toEqual([
      { ...user('nobody@example.invalid'), membershipId: null, teamId: null },
      { ...user('known@example.invalid', 'owner'), membershipId: 'member-1', teamId: null },
      {
        principalKind: 'group',
        principalExternalId: 'team',
        access: 'write',
        membershipId: null,
        teamId: 'team-1',
      },
    ]);
  });

  it.each(['domain', 'anyone'] as const)(
    'maps %s to nothing, even with a directory that would say yes',
    async (principalKind) => {
      const resolve = vi.fn(async () => ({ membershipId: 'member-1' }));
      await expect(
        mapSourceGrants(
          [{ principalKind, principalExternalId: 'example.invalid', access: 'read' }],
          { resolve },
        ),
      ).resolves.toEqual([
        {
          principalKind,
          principalExternalId: 'example.invalid',
          access: 'read',
          membershipId: null,
          teamId: null,
        },
      ]);
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it('asks about one principal once', async () => {
    const resolve = vi.fn(async () => null);
    await mapSourceGrants([user('a@example.invalid'), user('a@example.invalid', 'write')], {
      resolve,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('fails rather than guess when the directory cannot answer', async () => {
    await expect(
      mapSourceGrants([user('a@example.invalid')], {
        resolve: async () => {
          throw new Error('The directory is down');
        },
      }),
    ).rejects.toThrow();
  });

  it('gives nothing for a directory answer with neither target', async () => {
    const [grant] = await mapSourceGrants([user('a@example.invalid')], {
      resolve: async () => ({}) as never,
    });
    expect(grant).toMatchObject({ membershipId: null, teamId: null });
  });
});

describe('aclStateOf', () => {
  it('is mapped only when every grant found someone', () => {
    expect(aclStateOf(2, 2)).toBe('mapped');
    expect(aclStateOf(2, 1)).toBe('partial');
    expect(aclStateOf(2, 0)).toBe('unmapped');
    expect(aclStateOf(0, 0)).toBe('unmapped');
  });
});
