'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import {
  currentNavigation,
  isNavigationCurrent,
  type NavGroup,
  type NavItem,
} from './navigation-model';
import { NavigationIcon } from './navigation-icon';

/** Shows the page is on its way, for the routes that cannot have a loading page. See error notes. */
function Pending() {
  const { pending } = useLinkStatus();
  return (
    <span className="pending" role="status">
      {pending ? 'Loading' : ''}
    </span>
  );
}

function NavigationLink({
  item,
  pathname,
  child = false,
}: {
  item: NavItem;
  pathname: string;
  child?: boolean;
}) {
  const current = isNavigationCurrent(item, pathname);
  return (
    <Link
      href={item.href}
      className={child ? 'nav-child-link' : 'nav-link'}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        // Native details already works without scripts. Closing it on an ordinary client navigation
        // keeps the destination in view, rather than leaving a tall mobile menu above the new page.
        const menu = event.currentTarget.closest('details.mobile-navigation');
        if (menu) {
          menu.removeAttribute('open');
          menu.querySelector('summary')?.focus();
        }
      }}
      aria-current={
        current
          ? !child && (item.children || pathname !== item.href)
            ? 'location'
            : 'page'
          : undefined
      }
    >
      {!child && <NavigationIcon name={item.icon} />}
      <span className="nav-label">{item.label}</span>
      {item.count ? (
        <span className="count" aria-label={`${item.count} waiting`}>
          {item.count}
        </span>
      ) : null}
      <Pending />
    </Link>
  );
}

export function MainNav({ groups, label = 'Main' }: { groups: NavGroup[]; label?: string }) {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label={label}>
      {groups.map((group) => (
        <div className="nav-group" key={group.label}>
          <span className="nav-group-label">{group.label}</span>
          <ul className="nav-items">
            {group.items.map((item) => (
              <li key={item.href}>
                <NavigationLink item={item} pathname={pathname} />
                {item.children && isNavigationCurrent(item, pathname) && (
                  <ul className="nav-children">
                    {item.children.map((child) => (
                      <li key={child.href}>
                        <NavigationLink item={child} pathname={pathname} child />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The shell's position marker stays identical across server pages, without another feature sidebar. */
export function WorkspaceContext({
  groups,
  organizationName,
  base,
}: {
  groups: NavGroup[];
  organizationName: string;
  base: string;
}) {
  const pathname = usePathname();
  const current = currentNavigation(groups, pathname);
  return (
    <div className="workspace-context" aria-label="Workspace location">
      <Link href={base}>{organizationName}</Link>
      <span aria-hidden="true">/</span>
      {current && pathname !== current.href ? (
        <Link href={current.href}>{current.label}</Link>
      ) : (
        <span>{current?.label ?? 'Workspace'}</span>
      )}
    </div>
  );
}
