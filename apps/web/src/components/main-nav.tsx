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
  // Home is the organization's own address, and External actions sits after Approvals: both are where
  // someone goes for a decision (ADR-027 D6). Everyone can open it, and it shows only what they can read.
  const approvals = items.findIndex((item) => item.label === 'Approvals');
  const base = items[0]?.href;
  const all =
    approvals >= 0 && base
      ? [
          ...items.slice(0, approvals + 1),
          { href: `${base}/external-actions`, label: 'External actions' },
          ...items.slice(approvals + 1),
        ]
      : items;
  return (
    <nav className="nav" aria-label="Main">
      {all.map((item: NavItem) => {
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
