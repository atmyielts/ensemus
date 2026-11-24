import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { RevealOpenedPanels } from '@/components/reveal-opened-panels';
import { TooltipProvider } from '@/components/ui/tooltip';
import { THEME_STORAGE_KEY } from '@/lib/workspace-preferences';
import './globals.css';
export const metadata = { title: 'Ensemus' };
export const dynamic = 'force-dynamic';
// All font bytes and licenses ship inside the app; private and offline installs contact no font host.
const display = localFont({
  src: './fonts/space-grotesk/space-grotesk-latin-wght-normal.woff2',
  weight: '300 700',
  display: 'swap',
  variable: '--font-tech-display',
  fallback: ['Arial', 'sans-serif'],
});
const sans = localFont({
  src: './fonts/ibm-plex-sans/ibm-plex-sans-latin-wght-normal.woff2',
  weight: '100 700',
  display: 'swap',
  variable: '--font-tech-sans',
  fallback: ['Arial', 'sans-serif'],
});
const mono = localFont({
  src: './fonts/ibm-plex-mono/ibm-plex-mono-latin-400-normal.woff2',
  weight: '400',
  display: 'swap',
  variable: '--font-tech-mono',
  fallback: ['Consolas', 'monospace'],
});
// Apply the display preference before painting. The key is a source constant and no stored
// value is interpolated into the script.
const initializeTheme = `try{if(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})==='dark')document.documentElement.classList.add('dark')}catch{}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: initializeTheme }} />
      </head>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <RevealOpenedPanels />
      </body>
    </html>
  );
}
