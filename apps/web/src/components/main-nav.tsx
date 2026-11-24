'use client';
import { WorkspaceSearch } from '@/components/workspace-search';

import Link, { useLinkStatus } from 'next/link';
import {
  SidebarTrigger,
  useSidebar,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarGroup,
  SidebarGroupLabel,
} from '@/components/ui/sidebar';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  currentNavigation,
  isNavigationCurrent,
  navigationCurrentState,
  pendingDestination,
  pendingDestinationText,
  type NavGroup,
  type NavItem,
} from './navigation-model';
import { NavigationIcon } from './navigation-icon';
import { BrandMark } from './brand-identity';

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
function Pending({ label, showLabel = true }: { label: string; showLabel?: boolean }) {
  const { pending } = useLinkStatus();
  const announce = useContext(NavigationPending);
  useEffect(() => {
    if (!announce) return;
    announce(label, pending);
    return () => announce(label, false);
  }, [announce, label, pending]);
  // Seen beside the link only. The region above says it, so the link's own name never changes.
  return (
    <span className={showLabel ? 'pending' : 'visually-hidden'} aria-hidden="true">
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
  const current = navigationCurrentState(item, pathname);
  const { hydrated, open, isMobile } = useSidebar();
  return (
    <SidebarMenuButton
      asChild
      isActive={Boolean(current)}
      className="h-auto min-h-8 w-full whitespace-normal font-normal"
    >
      <Link
        href={item.href}
        className={child ? 'nav-child-link' : 'nav-link'}
        title={hydrated && !open && !isMobile && !child ? item.label : undefined}
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          // Native details already works without scripts. Closing it on an ordinary client navigation
          // keeps the destination in view, rather than leaving a tall mobile menu above the new page.
          const menu = event.currentTarget.closest('details.mobile-navigation');
          if (menu) {
            menu.removeAttribute('open');
            menu.querySelector('summary')?.focus();
          }
        }}
        aria-current={current}
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
    </SidebarMenuButton>
  );
}

export function MainNav({ groups, label = 'Main' }: { groups: NavGroup[]; label?: string }) {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label={label}>
      {groups.map((group) => (
        <SidebarGroup className="nav-group p-0" key={group.label}>
          <SidebarGroupLabel className="nav-group-label h-6 px-3">{group.label}</SidebarGroupLabel>
          <SidebarMenu className="nav-items">
            {group.items.map((item) => (
              <SidebarMenuItem key={item.href}>
                <NavigationLink item={item} pathname={pathname} />
                {item.children && isNavigationCurrent(item, pathname) && (
                  <ul className="nav-children">
                    {item.children
                      .filter((child) => child.href !== item.href)
                      .map((child) => (
                        <li key={child.href}>
                          <NavigationLink item={child} pathname={pathname} child />
                        </li>
                      ))}
                  </ul>
                )}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </nav>
  );
}

/** Shortcuts use the same destinations and active state as the full navigation. */
export function MobileWorkspaceNavigation({
  groups,
  children,
}: {
  groups: NavGroup[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const items = groups.flatMap((group) => group.items);
  const shortcuts = ['home', 'work', 'approvals', 'inbox'] as const;

  return (
    <div className="mobile-tabbar">
      <nav className="mobile-shortcuts" aria-label="Workspace shortcuts">
        {shortcuts.map((icon) => {
          const item = items.find((entry) => entry.icon === icon);
          if (!item) return null;
          const current = navigationCurrentState(item, pathname);
          return (
            <Button
              asChild
              variant="ghost"
              className="mobile-destination text-[11px] text-muted-foreground"
              key={item.href}
            >
              <Link href={item.href} aria-current={current}>
                <span className="mobile-destination-icon">
                  <NavigationIcon name={item.icon} />
                  {item.count ? (
                    <span className="mobile-destination-count" aria-hidden="true">
                      {item.count > 99 ? '99+' : item.count}
                    </span>
                  ) : null}
                </span>
                <span>{item.label}</span>
                {item.count ? <span className="visually-hidden">{item.count} waiting</span> : null}
                <Pending label={item.label} showLabel={false} />
              </Link>
            </Button>
          );
        })}
      </nav>
      {children}
    </div>
  );
}

/** Position and workspace tools share the same header across desktop and mobile. */
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
  const { open, hydrated } = useSidebar();
  return (
    <header className="workspace-context" aria-label="Workspace header">
      {hydrated && (
        <SidebarTrigger
          className="-ms-1.5 hidden shrink-0 text-muted-foreground min-[768px]:inline-flex"
          aria-controls="workspace-sidebar"
          aria-expanded={open}
          aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
          title={open ? 'Collapse sidebar' : 'Expand sidebar'}
        />
      )}
      <Link className="mobile-workspace-home" href={base}>
        <BrandMark />
        <span className="workspace-name" title={organizationName}>
          {organizationName}
        </span>
      </Link>
      <div className="workspace-location">
        <Link className="workspace-name" href={base} title={organizationName}>
          {organizationName}
        </Link>
        <span aria-hidden="true">/</span>
        {current && pathname !== current.href ? (
          <Link href={current.href}>{current.label}</Link>
        ) : (
          <span>{current?.label ?? 'Workspace'}</span>
        )}
      </div>
      <div className="workspace-tools">
        <WorkspaceSearch base={base} />
        <ThemeToggle />
      </div>
    </header>
  );
}
