import type { ReactNode } from 'react';

// A template remounts on every navigation, so each page settles in as it arrives. The movement itself is
// opted in under prefers-reduced-motion: no-preference in globals.css; otherwise the page is simply there.
export default function OrganizationPageTemplate({ children }: { children: ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
