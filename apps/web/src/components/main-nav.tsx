'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';

export type NavItem = { href: string; label: string; count?: number; exact?: boolean };

/** Shows the page is on its way, for the routes that cannot have a loading page. See error notes. */
function Pending() {
  const { pending } = useLinkStatus();
  return pending ? (
    <span className="pending" role="status">
      Loading
    </span>
  ) : null;
}

/** The main navigation. It says which section you are in, both visibly and to a screen reader. */
export function MainNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {items.map((item) => {
        const current = item.exact
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link key={item.href} href={item.href} aria-current={current ? 'page' : undefined}>
            {item.label}
            <Pending />
            {item.count ? <span className="count">{item.count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
