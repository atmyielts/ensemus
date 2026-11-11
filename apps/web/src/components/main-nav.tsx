'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  currentNavigation,
  isNavigationCurrent,
  pendingDestination,
  pendingDestinationText,
  type NavGroup,
  type NavItem,
} from './navigation-model';
import { NavigationIcon } from './navigation-icon';

type Announce = (label: string, pending: boolean) => void;
const NavigationPending = createContext<Announce | null>(null);

/**
 * The navigation's one polite live region, shared by the desktop and mobile menus. It stays in the page
 * while empty, outside either menu, so a screen reader is listening before anything is announced and
 * still hears it after the mobile menu closes. A status region in every link would make each page hold a
 * dozen empty ones, and a person hear nothing that says which page is coming.
 */
export function NavigationPendingRegion({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState<string | null>(null);
  const announce = useCallback<Announce>((label, pending) => {
    setLoading((current) => pendingDestination(current, label, pending));
  }, []);
  return (
    <NavigationPending.Provider value={announce}>
      {children}
      <span className="visually-hidden" role="status" data-navigation-status="">
        {pendingDestinationText(loading)}
      </span>
    </NavigationPending.Provider>
  );
}

/** Shows the page is on its way, for the routes that cannot have a loading page. See error notes. */
function Pending({ label }: { label: string }) {
  const { pending } = useLinkStatus();
  const announce = useContext(NavigationPending);
  useEffect(() => {
    if (!announce) return;
    announce(label, pending);
    return () => announce(label, false);
  }, [announce, label, pending]);
  // Seen beside the link only. The region above says it, so the link's own name never changes.
  return (
    <span className="pending" aria-hidden="true">
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
      <Pending label={item.label} />
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
      <Link className="workspace-search" href={`${base}/search`}>
        <NavigationIcon name="search" />
        Search the company
      </Link>
    </div>
  );
}
