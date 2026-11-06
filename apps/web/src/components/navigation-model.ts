// One navigation model for the sidebar, mobile menu, page context and Administration index. Only
// working destinations belong here. Visibility helps discovery; every destination authorizes again.
import { can, type Capability } from '@ensemus/domain/policy';

export type NavigationIcon =
  | 'home'
  | 'work'
  | 'approvals'
  | 'people'
  | 'clients'
  | 'inbox'
  | 'studio'
  | 'settings'
  | 'connections'
  | 'models'
  | 'usage'
  | 'safety'
  | 'arrow';
export type NavItem = {
  href: string;
  label: string;
  icon: NavigationIcon;
  count?: number;
  exact?: boolean;
  matches?: string[];
  excludes?: string[];
  children?: NavItem[];
};
export type NavGroup = { label: string; items: NavItem[] };
export type SettingsDestination = {
  path: string;
  label: string;
  description: string;
  icon: NavigationIcon;
  any: readonly Capability[];
};

export const SETTINGS_DESTINATIONS: readonly SettingsDestination[] = [
  {
    path: 'people',
    label: 'People and access',
    description: 'Invite teammates and manage who can work in this organization.',
    icon: 'people',
    any: ['member.manage', 'member.invite'],
  },
  {
    path: 'connections',
    label: 'Connected tools',
    description: 'Connect your tools and review their access to company work.',
    icon: 'connections',
    any: ['connection.manage'],
  },
  {
    path: 'settings/models',
    label: 'Models',
    description: 'Choose which models may receive company information.',
    icon: 'models',
    any: ['model.manage', 'model.activate'],
  },
  {
    path: 'settings/budgets',
    label: 'Budgets and usage',
    description: 'See model usage and set spending limits before work runs.',
    icon: 'usage',
    any: ['usage.view', 'budget.manage'],
  },
  {
    path: 'settings/safety',
    label: 'AI safety controls',
    description: 'Pause model activity when something needs attention.',
    icon: 'safety',
    any: ['ai.halt'],
  },
];

export const visibleSettings = (role: string) =>
  SETTINGS_DESTINATIONS.filter((item) => item.any.some((capability) => can(role, capability)));

const matchesPath = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);
export function isNavigationCurrent(item: NavItem, pathname: string) {
  if (item.excludes?.some((path) => matchesPath(pathname, path))) return false;
  if (item.exact && pathname === item.href) return true;
  return (
    (!item.exact && matchesPath(pathname, item.href)) ||
    (item.matches?.some((path) => matchesPath(pathname, path)) ?? false)
  );
}

export function workspaceNavigation(input: {
  base: string;
  role: string;
  unread: number;
  pending: number;
}): NavGroup[] {
  const { base, role } = input;
  const groups: NavGroup[] = [
    {
      label: 'Workspace',
      items: [
        { href: base, label: 'Home', exact: true, icon: 'home' },
        { href: `${base}/work`, label: 'Work', icon: 'work' },
        {
          href: `${base}/approvals`,
          label: 'Approvals',
          icon: 'approvals',
          count: input.pending,
          matches: [`${base}/external-actions`],
          children: [
            { href: `${base}/approvals`, label: 'Review requests', icon: 'approvals' },
            { href: `${base}/external-actions`, label: 'External actions', icon: 'arrow' },
          ],
        },
        { href: `${base}/people`, label: 'People and teams', icon: 'people' },
        { href: `${base}/clients`, label: 'Clients and projects', icon: 'clients' },
        { href: `${base}/inbox`, label: 'Inbox', icon: 'inbox', count: input.unread },
      ],
    },
  ];
  if (can(role, 'agent.publish') || can(role, 'agent.run'))
    groups.push({
      label: 'Build',
      items: [
        {
          href: `${base}/studio`,
          label: 'Automation Studio',
          icon: 'studio',
          matches: [`${base}/settings/agents`],
        },
      ],
    });
  if (visibleSettings(role).length > 0)
    groups.push({
      label: 'Organization',
      items: [
        {
          href: `${base}/settings`,
          label: 'Administration',
          icon: 'settings',
          matches: [`${base}/connections`],
          excludes: [`${base}/settings/agents`],
        },
      ],
    });
  return groups;
}

export function currentNavigation(groups: readonly NavGroup[], pathname: string) {
  for (const group of groups)
    for (const item of group.items) {
      if (isNavigationCurrent(item, pathname)) return item;
    }
  return null;
}
