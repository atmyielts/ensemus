'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/** Follow a durable background result by repeating the authorized server read, never its mutation.
 * A bounded watch avoids endlessly polling a stopped worker. The page always retains a native link. */
export function ResourceRefresh({ active }: { active: boolean }) {
  const router = useRouter(),
    [watching, setWatching] = useState(false);
  useEffect(() => {
    if (!active) return;
    let count = 0;
    setWatching(true);
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      router.refresh();
      if (++count >= 60) {
        clearInterval(timer);
        setWatching(false);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [active, router]);
  if (!active) return null;
  return (
    <p className="muted" role="status">
      {watching
        ? 'Checking for progress automatically.'
        : 'Use the progress link to check the latest state.'}
    </p>
  );
}
