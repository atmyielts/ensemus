'use client';
import { useEffect, useState } from 'react';
import { MoonIcon, SunIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { THEME_STORAGE_KEY } from '@/lib/workspace-preferences';
const read = () => {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
};
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(read() === 'dark');
  }, []);
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <Button
      variant="ghost"
      size="icon"
      className="theme-control"
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        const next = !dark;
        setDark(next);
        document.documentElement.classList.toggle('dark', next);
        try {
          localStorage.setItem(THEME_STORAGE_KEY, next ? 'dark' : 'light');
        } catch {
          /* The current page still changes if storage is disabled. */
        }
      }}
    >
      {dark ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
    </Button>
  );
}
