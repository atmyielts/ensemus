'use client';
import { useEffect, useState } from 'react';
import { MoonIcon, SunIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
const KEY = 'ensemus.ui.theme';
const read = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
/** A display preference only; no theme value or cookie participates in authorization. */
export function ThemePreference() {
  useEffect(() => {
    document.documentElement.classList.toggle('dark', read() === 'dark');
  }, []);
  return null;
}
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
          localStorage.setItem(KEY, next ? 'dark' : 'light');
        } catch {
          /* The current page still changes if storage is disabled. */
        }
      }}
    >
      {dark ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
    </Button>
  );
}
