// One navigation model for the sidebar, mobile menu, page context and Administration index. Only
// working destinations belong here. Visibility helps discovery; every destination authorizes again.
import { can, isRole, type Capability } from '@ensemus/domain/policy';
import { canProduct, type ProductCapability } from '@ensemus/domain/product-policy';

export type NavigationIcon =
  | 'home'
  | 'work'
  | 'approvals'
  | 'knowledge'
  | 'records'
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
  productAny?: readonly ProductCapability[];
};

export const SETTINGS_DESTINATIONS: readonly SettingsDestination[] = [
  {
    path: 'get-started',
    label: 'Company setup',
    description: 'Follow the steps to prepare your workspace and rehearse your first workflow.',
    icon: 'home',
    any: [],
    productAny: ['onboarding.manage'],
  },
  {
    path: 'license',
    label: 'License and support',
    description: 'Read installed license documents and maintenance notices.',
    icon: 'usage',
    any: ['license.view'],
  },
  {
    path: 'data',
    label: 'Export and import',
    description: 'Prepare an encrypted archive or review data imported into a new organization.',
    icon: 'arrow',
    any: ['organization.export', 'organization.import'],
  },
  {
    path: 'security',
    label: 'Security and sign-in',
    description: 'Protect your account and manage company sign-in and provisioning.',
    icon: 'safety',
    any: [],
    productAny: ['security_policy.manage', 'sso.manage'],
  },
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
  {
    path: 'settings/egress',
    label: 'Model data sharing',
    description: 'Inspect recorded sharing decisions and compare a proposed provider.',
    icon: 'safety',
    any: ['egress.view'],
  },
];

export const visibleSettings = (role: string) =>
  SETTINGS_DESTINATIONS.filter(
    (item) =>
      item.any.some((capability) => can(role, capability)) ||
      item.productAny?.some((capability) => canProduct(role, capability)),
  );

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
        {
          href: base,
          label: 'Home',
          exact: true,
          icon: 'home',
          ...(isRole(role)
            ? {
                matches: [`${base}/pulse`],
                children: [
                  { href: base, label: 'Overview', icon: 'home' as const, exact: true },
                  { href: `${base}/pulse`, label: 'Company Pulse', icon: 'usage' as const },
                ],
              }
            : {}),
        },
        {
          href: `${base}/work`,
          label: 'Work',
          icon: 'work',
          matches: [`${base}/compose`, `${base}/studio/runs`],
          children: [
            { href: `${base}/work`, label: 'All work', icon: 'work' },
            { href: `${base}/compose`, label: 'Outcome drafts', icon: 'arrow' },
            { href: `${base}/studio/runs`, label: 'Workflow runs', icon: 'arrow' },
          ],
        },
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
        {
          href: `${base}/clients`,
          label: 'Clients and projects',
          icon: 'clients',
          ...(can(role, 'client_onboarding.start')
            ? {
                matches: [`${base}/onboarding`],
                children: [
                  { href: `${base}/clients`, label: 'Clients and projects', icon: 'clients' },
                  { href: `${base}/onboarding`, label: 'Client onboarding', icon: 'arrow' },
                ],
              }
            : {}),
        },
        { href: `${base}/inbox`, label: 'Inbox', icon: 'inbox', count: input.unread },
      ],
    },
  ];
  if (isRole(role))
    groups[0]!.items.splice(
      3,
      0,
      {
        href: `${base}/knowledge`,
        label: 'Knowledge',
        icon: 'knowledge',
        matches: [`${base}/search`],
      },
      { href: `${base}/objects`, label: 'Custom records', icon: 'records' },
      { href: `${base}/assistants`, label: 'Assistants', icon: 'studio' },
    );
  if (can(role, 'agent.publish') || can(role, 'agent.run'))
    groups.push({
      label: 'Build',
      items: [
        {
          href: `${base}/studio`,
          label: 'Automation Studio',
          icon: 'studio',
          excludes: [`${base}/studio/runs`],
          matches: [
            `${base}/settings/agents`,
            ...(canProduct(role, 'pack.manage') ? [`${base}/packs`] : []),
          ],
          ...(canProduct(role, 'pack.manage')
            ? {
                children: [
                  {
                    href: `${base}/studio`,
                    label: 'Overview',
                    icon: 'studio' as const,
                    exact: true,
                  },
                  {
                    href: `${base}/studio/agents`,
                    label: 'Assistant drafts',
                    icon: 'arrow' as const,
                  },
                  {
                    href: `${base}/studio/workflows`,
                    label: 'Workflow drafts',
                    icon: 'arrow' as const,
                  },
                  {
                    href: `${base}/studio/reviews`,
                    label: 'Publication reviews',
                    icon: 'approvals' as const,
                  },
                  {
                    href: `${base}/settings/agents`,
                    label: 'Assistant versions',
                    icon: 'arrow' as const,
                  },
                  { href: `${base}/packs`, label: 'Packs', icon: 'arrow' as const },
                ],
              }
            : {}),
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
          matches: [
            `${base}/connections`,
            `${base}/security`,
            `${base}/license`,
            `${base}/data`,
            `${base}/get-started`,
          ],
          excludes: [`${base}/settings/agents`, `${base}/settings/connections`],
        },
      ],
    });
  // Every member may connect their own mail and calendar (ADR-038 D5), so every member sees where.
  const account: NavItem[] = isRole(role)
    ? [{ href: `${base}/settings/connections`, label: 'My connections', icon: 'connections' }]
    : [];
  if (can(role, 'support.use'))
    account.push({ href: `${base}/account`, label: 'Account and support', icon: 'usage' });
  if (account.length > 0) groups.push({ label: 'Account', items: account });
  return groups;
}

/**
 * The destination the navigation's one live region names: the latest one on its way, until that one
 * arrives. A link that settles never clears another link that is still on its way.
 */
export function pendingDestination(current: string | null, label: string, pending: boolean) {
  if (pending) return label;
  return current === label ? null : current;
}

export const pendingDestinationText = (label: string | null) => (label ? `Loading ${label}` : '');

export function currentNavigation(groups: readonly NavGroup[], pathname: string) {
  for (const group of groups)
    for (const item of group.items) {
      if (isNavigationCurrent(item, pathname)) return item;
    }
  return null;
}
