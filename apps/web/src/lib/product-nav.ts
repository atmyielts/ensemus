// Compatibility for recovered M7 callers. The shared grouped model owns labels and visibility;
// unimplemented foundations never become destinations simply because a milestone named them.
import { workspaceNavigation, visibleSettings } from '@/components/navigation-model';

export type ProductNavItem = { href: string; label: string };

export function productNavItems(base: string, role: string): ProductNavItem[] {
  const destinations = workspaceNavigation({ base, role, unread: 0, pending: 0 }).flatMap((group) =>
    group.items.flatMap((item) => [item, ...(item.children ?? [])]),
  );
  const items: ProductNavItem[] = [
    ...destinations,
    ...visibleSettings(role).map((item) => ({ href: `${base}/${item.path}`, label: item.label })),
  ];
  return items
    .filter((item) =>
      ['assistants', 'packs', 'security'].some((path) => item.href === `${base}/${path}`),
    )
    .map(({ href, label }) => ({ href, label }));
}
