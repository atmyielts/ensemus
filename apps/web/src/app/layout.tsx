import type { ReactNode } from 'react';
import './globals.css';

// icon.svg, favicon.ico and apple-icon.png beside this file are Next's own metadata routes: they are built
// into the server, so they are served in the standalone image, which does not copy public/.
export const metadata = {
  title: 'Ensemus',
};

// Every page depends on who is signed in, so nothing is cached or prerendered.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
