import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'Ensemus' };

// Every page depends on who is signed in, so nothing is cached or prerendered.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
