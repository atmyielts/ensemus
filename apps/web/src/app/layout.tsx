import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import './globals.css';

// icon.svg, favicon.ico and apple-icon.png beside this file are Next's own metadata routes: they are built
// into the server, so they are served in the standalone image, which does not copy public/.
export const metadata = {
  title: 'Ensemus',
};

// Every page depends on who is signed in, so nothing is cached or prerendered.
export const dynamic = 'force-dynamic';

// Page titles are set in Instrument Serif, the wordmark's own face (SIL OFL 1.1, fonts/OFL.txt). It is
// shipped inside the app and served from it, so nothing is fetched from another host (ADR-021).
const serif = localFont({
  src: './fonts/instrument-serif-latin-400-normal.woff2',
  weight: '400',
  style: 'normal',
  display: 'swap',
  variable: '--font-serif',
  fallback: ['Iowan Old Style', 'Palatino Linotype', 'Georgia', 'serif'],
  adjustFontFallback: 'Times New Roman',
});

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={serif.variable}>
      <body>{children}</body>
    </html>
  );
}
