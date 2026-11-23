'use client';

import { MenuIcon, XIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';

export function MobileWorkspaceMenu({ children }: { children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const pathname = usePathname();
  const previousPathname = useRef(pathname);

  useEffect(() => {
    // The native disclosure can already be open before React takes over.
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    const disclosure = menu.current;
    if (disclosure?.open) {
      disclosure.open = false;
      trigger.current?.focus();
    }
  }, [pathname]);

  useEffect(() => {
    function closeOutside(event: PointerEvent) {
      const disclosure = menu.current;
      if (disclosure?.open && !event.composedPath().includes(disclosure)) {
        // Radix renders the workspace switcher in a portal outside the disclosure.
        if (
          event.target instanceof Element &&
          event.target.closest('[data-slot="dropdown-menu-content"]')
        )
          return;
        disclosure.open = false;
      }
    }

    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  return (
    <details
      ref={menu}
      className="mobile-navigation"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !event.currentTarget.open || event.defaultPrevented) return;
        event.preventDefault();
        event.currentTarget.open = false;
        trigger.current?.focus();
      }}
    >
      <summary ref={trigger} className="mobile-destination" aria-label="More workspace options">
        <MenuIcon aria-hidden="true" />
        <XIcon aria-hidden="true" />
        <span>More</span>
      </summary>
      <div className="mobile-navigation-panel">{children}</div>
    </details>
  );
}
