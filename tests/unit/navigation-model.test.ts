import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  currentNavigation,
  isNavigationCurrent,
  visibleSettings,
  workspaceNavigation,
} from '../../apps/web/src/components/navigation-model';

const base = '/o/00000000-0000-4000-8000-000000000001';
const navigation = (role: string) => workspaceNavigation({ base, role, unread: 3, pending: 2 });

describe('working workspace navigation', () => {
  it('groups routine work, the builder and administration without future or dead destinations', () => {
    const groups = navigation('owner');
    expect(groups.map((group) => group.label)).toEqual(['Workspace', 'Build', 'Organization']);
    expect(groups.flatMap((group) => group.items)).toHaveLength(9);
    const items = groups.flatMap((group) =>
      group.items.flatMap((item) => [item, ...(item.children ?? [])]),
    );
    for (const item of items) {
      const path = item.href.slice(base.length);
      const page = new URL(
        `../../apps/web/src/app/o/[organizationId]${path}/page.tsx`,
        import.meta.url,
      );
      expect(existsSync(fileURLToPath(page)), item.href).toBe(true);
      expect(item.href).not.toBe(`${base}/agents`);
    }
    for (const item of visibleSettings('owner')) {
      expect(
        existsSync(
          fileURLToPath(
            new URL(
              `../../apps/web/src/app/o/[organizationId]/${item.path}/page.tsx`,
              import.meta.url,
            ),
          ),
        ),
        item.path,
      ).toBe(true);
    }
  });

  it.each(['owner', 'admin'])(
    '%s sees the actual permitted builder and administration destinations',
    (role) => {
      expect(navigation(role).at(-1)?.items[0]?.label).toBe('Administration');
      expect(visibleSettings(role).map((item) => item.path)).toContain('settings/budgets');
    },
  );

  it('does not advertise privileged pages to members or unknown roles', () => {
    for (const role of ['member', 'not-a-role']) {
      expect(navigation(role).map((group) => group.label)).toEqual(['Workspace']);
      expect(visibleSettings(role)).toEqual([]);
      expect(
        navigation(role)
          .flatMap((group) => group.items.flatMap((item) => item.children ?? []))
          .some((item) => item.href === `${base}/onboarding`),
      ).toBe(false);
    }
  });

  it.each([
    ['/work/a/run', 'Work'],
    ['/approvals/a', 'Approvals'],
    ['/external-actions/a', 'Approvals'],
    ['/studio', 'Automation Studio'],
    ['/settings/agents', 'Automation Studio'],
    ['/settings/models/a', 'Administration'],
    ['/connections', 'Administration'],
    ['/knowledge/sources/a', 'Knowledge'],
    ['/knowledge/facts/a', 'Knowledge'],
    ['/search', 'Knowledge'],
    ['/onboarding/a', 'Clients and projects'],
  ])('retains the correct section for %s', (path, label) => {
    const groups = navigation('owner');
    expect(currentNavigation(groups, `${base}${path}`)?.label).toBe(label);
    expect(
      groups
        .flatMap((group) => group.items)
        .filter((item) => isNavigationCurrent(item, `${base}${path}`)),
    ).toHaveLength(1);
  });

  it('matches complete path segments and the current organization', () => {
    expect(currentNavigation(navigation('owner'), `${base}/workforce`)).toBeNull();
    expect(currentNavigation(navigation('owner'), '/o/a-different-organization/work')).toBeNull();
    expect(currentNavigation(navigation('owner'), base)?.label).toBe('Home');
  });
});
