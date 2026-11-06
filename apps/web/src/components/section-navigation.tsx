'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isNavigationCurrent, type NavItem } from './navigation-model';

/** Native links preserve every section without scripts; the current section is also named to AT. */
export function SectionNavigation({
  label,
  items,
}: {
  label: string;
  items: Pick<NavItem, 'href' | 'label' | 'exact' | 'matches'>[];
}) {
  const pathname = usePathname();
  return (
    <nav className="section-navigation" aria-label={label}>
      {items.map((item) => (
        <Link
          href={item.href}
          key={item.href}
          aria-current={
            isNavigationCurrent({ ...item, icon: 'arrow' }, pathname)
              ? pathname === item.href
                ? 'page'
                : 'location'
              : undefined
          }
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
