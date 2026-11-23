import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { RevealOpenedPanels } from '@/components/reveal-opened-panels';
import { ThemePreference } from '@/components/theme-toggle';
import { TooltipProvider } from '@/components/ui/tooltip';
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
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <ThemePreference />
        <TooltipProvider>{children}</TooltipProvider>
        <RevealOpenedPanels />
      </body>
    </html>
  );
}
